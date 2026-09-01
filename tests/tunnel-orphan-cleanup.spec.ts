/**
 * Tests for the four tunnel-management fixes:
 *
 *   a) cleanupStaleTunnelSockets matches `/tmp/vectr-tunnel-<slug>-*.sock`
 *      by codebase name prefix (unrelated slugs are never touched), keeping
 *      the encoded-pid liveness guard only to protect LIVE tunnels: sockets
 *      of the current process or of any other live process are left alone,
 *      stale ones (dead encoded pid) are removed. The orphan-master sweep
 *      (cleanupOrphanedTunnelsForCodebases / cleanupOrphanedTunnelBySlug)
 *      terminates surviving masters via `ssh -O exit` on the slug-matched
 *      socket, so a host restart with a different pid does not leave
 *      orphaned ssh masters alive.
 *
 *   c) findFreePort warns (via injected warner) when the preferred port is
 *      occupied and a later port in the reserved window is selected.
 *
 *   d) deleteCodebase falls back to a slug-prefix scan of
 *      `/tmp/vectr-tunnel-<slug>-*.sock` when the persisted tunnelCtl is
 *      missing / stale and the recorded tunnelPid is unknown, terminating
 *      any surviving ssh master through the existing ssh runner.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupStaleTunnelSockets,
  deleteCodebase,
  findFreePort,
  TUNNEL_PORT_MAX,
  TUNNEL_PORT_MIN,
  type CodebaseDeps,
  type CodebaseEntry,
  type CredentialStore,
  type SshAuthContext,
  type SshRunner,
  type SpawnHandle,
} from '../src/codebases.ts'

/** Ports the fake `node:net` probe reports as EADDRINUSE (see vi.mock below).
 * Lets the (c) tests assert port-migration behavior deterministically without
 * depending on the test host's real port occupancy (the 8760-8799 window has
 * live listeners — vnm_gui / pythons — which made the old real-bind version
 * flaky). */
const mockFailPorts = new Set<number>()

vi.mock('node:net', async () => {
  const actual = await vi.importActual<typeof import('node:net')>('node:net')
  return {
    ...actual,
    // Deterministic probe: ports in mockFailPorts report EADDRINUSE, all
    // others report free. Never binds a real socket.
    createServer: () => {
      let errorCb: ((e?: Error) => void) | undefined
      return {
        once(ev: string, cb: (e?: Error) => void) {
          if (ev === 'error') errorCb = cb
          return this
        },
        listen(port: number, _host: string, cb: () => void) {
          queueMicrotask(() => {
            if (mockFailPorts.has(port)) {
              errorCb?.(new Error(`listen EADDRINUSE 127.0.0.1:${port}`))
            } else {
              cb()
            }
          })
          return this
        },
        close(cb: () => void) {
          queueMicrotask(cb)
          return this
        },
      }
    },
  }
})

interface FakeSshOpts {
  /** Exit code of the `-O exit` teardown. */
  exitCode?: number
  /** Exit code of the `-O check` liveness probe. */
  checkCode?: number
  /** Exit code of any other ssh call (default 0). */
  defaultCode?: number
  /** Optional log of every arg list seen. */
  calls?: string[][]
}

function makeSsh(opts: FakeSshOpts = {}): SshRunner & { calls: string[][] } {
  const calls = opts.calls ?? []
  const runner = ((args: string[]): SpawnHandle => {
    calls.push(args)
    let code = opts.defaultCode ?? 0
    if (args.includes('-O') && args.includes('exit')) code = opts.exitCode ?? 0
    else if (args.includes('-O') && args.includes('check')) code = opts.checkCode ?? 0
    return { promise: Promise.resolve({ code, stdout: '', stderr: '' }), kill() {} }
  }) as SshRunner & { calls: string[][] }
  runner.calls = calls
  return runner
}

function makeCredStore(): CredentialStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    set: (ref, value) => { data.set(ref, value) },
    get: (ref) => data.get(ref),
    unset: (ref) => { data.delete(ref) },
  }
}

function deps(ssh: SshRunner, creds: CredentialStore = makeCredStore()): CodebaseDeps {
  return {
    spawnRunner: () => ({ promise: Promise.resolve({ code: 0, stdout: '', stderr: '' }), kill() {} }),
    sshRunner: ssh,
    credStore: creds,
  }
}

let dir: string
let metaPath: string
let workdir: string

beforeEach(async () => {
  mockFailPorts.clear()
  dir = await mkdtemp(join(tmpdir(), 'orphan-cleanup-'))
  workdir = await mkdtemp(join(tmpdir(), 'orphan-workdir-'))
  metaPath = join(dir, 'codebases.json')
})

afterEach(async () => {
  vi.restoreAllMocks()
  mockFailPorts.clear()
  await rm(dir, { recursive: true, force: true })
  await rm(workdir, { recursive: true, force: true })
})

// ─── (a) cleanupStaleTunnelSockets — slug-prefix matching ────────────────────

describe('cleanupStaleTunnelSockets (a)', () => {
  it('removes sockets whose filename pid no longer matches a live process', async () => {
    // Encoded pid 999999 is virtually never alive on a test host -> stale.
    const sock = join(tmpdir(), 'vectr-tunnel-vnm-999999.sock')
    await writeFile(sock, '')
    const removed = cleanupStaleTunnelSockets(tmpdir(), ['vnm'])
    expect(removed).toBeGreaterThanOrEqual(1)
  })

  it('leaves sockets for live pids untouched (current process is always live)', async () => {
    // A socket whose encoded pid equals process.pid must NOT be removed,
    // because the host owning the master is alive.
    const sock = join(tmpdir(), `vectr-tunnel-vnm-${process.pid}.sock`)
    await writeFile(sock, '')
    const removed = cleanupStaleTunnelSockets(tmpdir(), ['vnm'])
    // We may still remove other stale ones from /tmp, but never this one.
    // Strongest assertion: the file still exists.
    const { existsSync } = await import('node:fs')
    expect(existsSync(sock)).toBe(true)
    expect(removed).toBeGreaterThanOrEqual(0)
  })

  it('matches sockets by codebase slug prefix, not by encoded pid', async () => {
    // Same slug, fake pid 424242 (not alive) -> must be removed even though
    // the pid is not encoded for our process. This is the regression proof
    // for the old pid-based regex / host-restart case.
    const sock = join(tmpdir(), 'vectr-tunnel-vnm-424242.sock')
    await writeFile(sock, '')
    const removed = cleanupStaleTunnelSockets(tmpdir(), ['vnm'])
    const { existsSync } = await import('node:fs')
    expect(existsSync(sock)).toBe(false)
    expect(removed).toBeGreaterThanOrEqual(1)
  })

  it('does not remove sockets for unknown slugs (no implicit kill)', async () => {
    const sock = join(tmpdir(), 'vectr-tunnel-other-999999.sock')
    await writeFile(sock, '')
    const removed = cleanupStaleTunnelSockets(tmpdir(), ['vnm'])
    const { existsSync } = await import('node:fs')
    expect(existsSync(sock)).toBe(true)
    expect(removed).toBeGreaterThanOrEqual(0)
  })

  it('swallows errors and returns 0 on read failures (hygiene is never fatal)', () => {
    // Pass an unreadable directory: readdirSync will throw, function must swallow.
    const removed = cleanupStaleTunnelSockets('/proc/this/does/not/exist', ['vnm'])
    expect(removed).toBe(0)
  })
})

// ─── (c) findFreePort — warn on preferred-port collision ────────────────────

describe('findFreePort (c)', () => {
  it('warns when the preferred port is occupied and a later port is selected', async () => {
    // Mock probe: preferred port reports EADDRINUSE, next one is free, so
    // findFreePort must bump and surface the migration via the injected warner.
    mockFailPorts.add(TUNNEL_PORT_MIN)
    const warn = vi.fn()
    const port = await findFreePort(TUNNEL_PORT_MIN, TUNNEL_PORT_MAX, undefined, warn)
    expect(port).toBe(TUNNEL_PORT_MIN + 1)
    expect(warn).toHaveBeenCalledTimes(1)
    const [msg] = warn.mock.calls[0] ?? []
    expect(String(msg)).toMatch(String(TUNNEL_PORT_MIN))
  })

  it('does NOT warn when the preferred port is already free', async () => {
    const warn = vi.fn()
    const port = await findFreePort(TUNNEL_PORT_MIN, TUNNEL_PORT_MIN, undefined, warn)
    expect(port).toBe(TUNNEL_PORT_MIN)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does NOT warn when ports are excluded by the caller (expected occupancy)', async () => {
    const warn = vi.fn()
    const port = await findFreePort(TUNNEL_PORT_MIN, TUNNEL_PORT_MIN, new Set([TUNNEL_PORT_MIN]), warn)
    // TUNNEL_PORT_MIN is excluded so the loop returns undefined without trying a bind.
    expect(port).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })
})

// ─── (d) deleteCodebase — slug-prefix fallback ────────────────────

describe('deleteCodebase (d)', () => {
  it('falls back to a slug-prefix scan when tunnelCtl/tunnelPid are unknown', async () => {
    // Persist an entry with NO tunnelCtl / NO tunnelPid (orphaned record).
    const entry: CodebaseEntry = {
      id: 'vnm', slug: 'vnm', type: 'remote', path: '/w', host: 'conan',
      serverName: 'vectr_vnm', localPort: 8760, remotePort: 8767, status: 'up',
    }
    const { saveCodebases, loadCodebases } = await import('../src/codebases.ts')
    saveCodebases(metaPath, [entry])

    // Lay a stray socket file matching the slug so the fallback has work to do.
    const stray = join(tmpdir(), 'vectr-tunnel-vnm-999999.sock')
    await writeFile(stray, '')

    const ssh = makeSsh({ exitCode: 0 })
    await deleteCodebase(deps(ssh), metaPath, entry)
    // The remote stop ssh call goes through the runner too; what matters is
    // that a `-O exit -S <stray>` (or the equivalent ssh op) was attempted
    // against the slug-prefixed socket. We assert the stray socket was unlinked.
    const { existsSync } = await import('node:fs')
    expect(existsSync(stray)).toBe(false)
    // And the metadata entry was removed.
    expect(loadCodebases(metaPath)).toEqual([])
  })

  it('still prefers the recorded tunnelCtl when present (compatibility)', async () => {
    const entry: CodebaseEntry = {
      id: 'vnm', slug: 'vnm', type: 'remote', path: '/w', host: 'conan',
      serverName: 'vectr_vnm', localPort: 8760, remotePort: 8767,
      tunnelCtl: '/tmp/vectr-tunnel-vnm-recorded.sock', status: 'up',
    }
    const { saveCodebases } = await import('../src/codebases.ts')
    saveCodebases(metaPath, [entry])
    const ssh = makeSsh({ exitCode: 0 })
    await deleteCodebase(deps(ssh), metaPath, entry)
    // The recorded ctl must have been targeted first.
    const sawRecorded = ssh.calls.some((args) => args.includes('/tmp/vectr-tunnel-vnm-recorded.sock'))
    expect(sawRecorded).toBe(true)
  })
})