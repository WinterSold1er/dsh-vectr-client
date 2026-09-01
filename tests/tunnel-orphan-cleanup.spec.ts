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
 *
 * C3: every filesystem fixture lives in a per-test mkdtemp dir (cleaned in
 * afterEach) and `process.kill` liveness is mocked per the P6 pattern
 * (tests/codebases.spec.ts) so the suite never reads, unlinks, or probes
 * real /tmp sockets or real pids. The slug fallback sweep hardcodes
 * `tmpdir()` internally, so the (d)/(F2) tests redirect it with a
 * `vi.mock('node:os')` tmpdir getter into the same fixture dir instead of
 * writing stray sockets into the real /tmp.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupStaleTunnelSockets,
  deleteCodebase,
  findFreePort,
  loadCodebases,
  saveCodebases,
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

// C3: the slug fallback sweep (cleanupOrphanedTunnelBySlug) hardcodes
// tmpdir() inside src. ESM module exports cannot be spied on
// (`vi.spyOn(os, 'tmpdir')` throws: namespace not configurable), so the whole
// node:os module is mocked with a getter that redirects `tmpdir()` to the
// per-test fixture dir while `sweptTmpdir` is set. The 255-exit test below
// fails loudly if this redirect ever stops reaching the src binding.
let sweptTmpdir: string | undefined
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    get tmpdir() {
      return sweptTmpdir !== undefined ? () => sweptTmpdir : actual.tmpdir
    },
  }
})

interface FakeSshOpts {
  /** Exit code of the `-O exit` teardown. */
  exitCode?: number
  /** Signal of the `-O exit` teardown (null = clean exit). */
  exitSignal?: NodeJS.Signals | null
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
    let signal: NodeJS.Signals | null = null
    if (args.includes('-O') && args.includes('exit')) {
      code = opts.exitCode ?? 0
      signal = opts.exitSignal ?? null
    }
    else if (args.includes('-O') && args.includes('check')) code = opts.checkCode ?? 0
    return { promise: Promise.resolve({ code, stdout: '', stderr: '', signal }), kill() {} }
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

function deps(ssh: SshRunner, creds: CredentialStore = makeCredStore(), warn?: (message: string) => void): CodebaseDeps {
  return {
    spawnRunner: () => ({ promise: Promise.resolve({ code: 0, stdout: '', stderr: '', signal: null }), kill() {} }),
    sshRunner: ssh,
    credStore: creds,
    warn,
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

// C3: fixture dir per test + mocked liveness (P6 pattern) — never touch the
// real /tmp or real pids. `alivePids` decides which encoded pids the mocked
// `process.kill(pid, 0)` reports as alive.
function mockKillLiveness(alivePids: Set<number>): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'kill').mockImplementation((pidArg: number, _sig?: string | number): boolean => {
    if (alivePids.has(pidArg)) return true
    const e = new Error('esrch') as NodeJS.ErrnoException
    e.code = 'ESRCH'
    throw e
  })
}

describe('cleanupStaleTunnelSockets (a)', () => {
  let sockDir: string
  beforeEach(async () => {
    sockDir = await mkdtemp(join(tmpdir(), 'orphan-sock-'))
  })
  afterEach(async () => {
    await rm(sockDir, { recursive: true, force: true })
  })

  it('removes sockets whose filename pid no longer matches a live process', async () => {
    // Encoded pid 999999 reported dead by the mocked liveness probe -> stale.
    const sock = join(sockDir, 'vectr-tunnel-vnm-999999.sock')
    await writeFile(sock, '')
    mockKillLiveness(new Set())
    const removed = cleanupStaleTunnelSockets(sockDir, ['vnm'])
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(existsSync(sock)).toBe(false)
  })

  it('leaves sockets for live pids untouched (current process is always live)', async () => {
    // A socket whose encoded pid equals process.pid must NOT be removed,
    // because the host owning the master is alive. No spy here: this is the
    // one REAL liveness assertion in the suite (kill(process.pid, 0) and the
    // identity guard both succeed on the fixture file).
    const sock = join(sockDir, `vectr-tunnel-vnm-${process.pid}.sock`)
    await writeFile(sock, '')
    cleanupStaleTunnelSockets(sockDir, ['vnm'])
    expect(existsSync(sock)).toBe(true)
  })

  it('matches sockets by codebase slug prefix, not by encoded pid', async () => {
    // Same slug, fake pid 424242 (mocked dead) -> must be removed even though
    // the pid is not encoded for our process. Regression proof for the old
    // pid-based regex / host-restart case.
    const sock = join(sockDir, 'vectr-tunnel-vnm-424242.sock')
    await writeFile(sock, '')
    mockKillLiveness(new Set())
    const removed = cleanupStaleTunnelSockets(sockDir, ['vnm'])
    expect(existsSync(sock)).toBe(false)
    expect(removed).toBeGreaterThanOrEqual(1)
  })

  it('does not remove sockets for unknown slugs (no implicit kill)', async () => {
    const sock = join(sockDir, 'vectr-tunnel-other-999999.sock')
    await writeFile(sock, '')
    mockKillLiveness(new Set())
    const removed = cleanupStaleTunnelSockets(sockDir, ['vnm'])
    expect(existsSync(sock)).toBe(true)
    expect(removed).toBe(0)
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

// C3: run fn with the hardcoded tmpdir() inside src redirected into a
// per-test fixture dir, so the suite never writes to (or unlinks from) the
// real /tmp.
async function withSweepDir<T>(fn: (sweepDir: string) => Promise<T>): Promise<T> {
  const sweepDir = await mkdtemp(join(tmpdir(), 'orphan-sweep-'))
  sweptTmpdir = sweepDir
  try {
    return await fn(sweepDir)
  } finally {
    sweptTmpdir = undefined
    await rm(sweepDir, { recursive: true, force: true })
  }
}

describe('deleteCodebase (d)', () => {
  it('falls back to a slug-prefix scan when tunnelCtl/tunnelPid are unknown', async () => {
    await withSweepDir(async (sweepDir) => {
      // Persist an entry with NO tunnelCtl / NO tunnelPid (orphaned record).
      const entry: CodebaseEntry = {
        id: 'vnm', slug: 'vnm', type: 'remote', path: '/w', host: 'conan',
        serverName: 'vectr_vnm', localPort: 8760, remotePort: 8767, status: 'up',
      }
      saveCodebases(metaPath, [entry])

      // Lay a stray socket file matching the slug so the fallback has work to do.
      const stray = join(sweepDir, 'vectr-tunnel-vnm-999999.sock')
      await writeFile(stray, '')

      const ssh = makeSsh({ exitCode: 0 })
      await deleteCodebase(deps(ssh), metaPath, entry)
      // A `-O exit -S <stray>` was attempted against the slug-prefixed socket
      // and the socket was unlinked.
      expect(ssh.calls.some((args) => args.includes('-O') && args.includes('exit') && args.includes(stray))).toBe(true)
      expect(existsSync(stray)).toBe(false)
      // And the metadata entry was removed.
      expect(loadCodebases(metaPath)).toEqual([])
    })
  })

  it('still prefers the recorded tunnelCtl when present (compatibility)', async () => {
    const entry: CodebaseEntry = {
      id: 'vnm', slug: 'vnm', type: 'remote', path: '/w', host: 'conan',
      serverName: 'vectr_vnm', localPort: 8760, remotePort: 8767,
      tunnelCtl: '/tmp/vectr-tunnel-vnm-recorded.sock', status: 'up',
    }
    saveCodebases(metaPath, [entry])
    const ssh = makeSsh({ exitCode: 0 })
    await deleteCodebase(deps(ssh), metaPath, entry)
    // The recorded ctl must have been targeted first.
    const sawRecorded = ssh.calls.some((args) => args.includes('/tmp/vectr-tunnel-vnm-recorded.sock'))
    expect(sawRecorded).toBe(true)
  })
})

// ─── (F2) deleteCodebase — recorded-teardown failure detection ─────────

describe('deleteCodebase teardown failure (F2)', () => {
  const remoteEntryFor = (tunnelCtl: string): CodebaseEntry => ({
    id: 'vnm', slug: 'vnm', type: 'remote', path: '/w', host: 'conan',
    serverName: 'vectr_vnm', localPort: 8760, remotePort: 8767,
    tunnelCtl, status: 'up',
  })

  it('recorded -O exit with non-zero code triggers the slug fallback', async () => {
    await withSweepDir(async (sweepDir) => {
      const entry = remoteEntryFor(join(sweepDir, 'vectr-tunnel-vnm-recorded.sock'))
      saveCodebases(metaPath, [entry])
      // A surviving master's socket the recorded teardown cannot reach.
      const stray = join(sweepDir, 'vectr-tunnel-vnm-999999.sock')
      await writeFile(stray, '')

      const ssh = makeSsh({ exitCode: 255 })
      await deleteCodebase(deps(ssh), metaPath, entry)

      // F2: the promise RESOLVED (it never rejects), but code 255 means the
      // recorded teardown did not reach the master -> recordedTeardownOk must
      // stay false -> the slug sweep ran, targeted the surviving socket, and
      // unlinked it.
      expect(ssh.calls.some((args) => args.includes('-O') && args.includes('exit') && args.includes(stray))).toBe(true)
      expect(existsSync(stray)).toBe(false)
      expect(loadCodebases(metaPath)).toEqual([])
    })
  })

  it('recorded -O exit killed by a signal (code 0, SIGTERM) triggers the slug fallback', async () => {
    await withSweepDir(async (sweepDir) => {
      const entry = remoteEntryFor(join(sweepDir, 'vectr-tunnel-vnm-recorded.sock'))
      saveCodebases(metaPath, [entry])
      const stray = join(sweepDir, 'vectr-tunnel-vnm-999999.sock')
      await writeFile(stray, '')

      const ssh = makeSsh({ exitCode: 0, exitSignal: 'SIGTERM' })
      await deleteCodebase(deps(ssh), metaPath, entry)

      // F2: even code 0 is not a clean exit when a signal is present.
      expect(ssh.calls.some((args) => args.includes('-O') && args.includes('exit') && args.includes(stray))).toBe(true)
      expect(existsSync(stray)).toBe(false)
    })
  })

  it('clean recorded -O exit (code 0, no signal) does NOT trigger the fallback', async () => {
    await withSweepDir(async (sweepDir) => {
      const entry = remoteEntryFor(join(sweepDir, 'vectr-tunnel-vnm-recorded.sock'))
      saveCodebases(metaPath, [entry])
      const stray = join(sweepDir, 'vectr-tunnel-vnm-999999.sock')
      await writeFile(stray, '')

      const ssh = makeSsh({ exitCode: 0 })
      await deleteCodebase(deps(ssh), metaPath, entry)

      // ok=true -> no sweep -> the same-slug stray is left untouched.
      expect(ssh.calls.some((args) => args.includes(stray))).toBe(false)
      expect(existsSync(stray)).toBe(true)
      expect(loadCodebases(metaPath)).toEqual([])
    })
  })

  it('N3: a successful PID kill does NOT suppress the slug fallback after a failed ctl exit', async () => {
    await withSweepDir(async (sweepDir) => {
      const entry = {
        ...remoteEntryFor(join(sweepDir, 'vectr-tunnel-vnm-recorded.sock')),
        // The recorded pid still points at a live process: the SIGTERM succeeds.
        tunnelPid: 987654,
      }
      saveCodebases(metaPath, [entry])
      // A surviving master's socket the recorded teardown cannot reach.
      const stray = join(sweepDir, 'vectr-tunnel-vnm-999999.sock')
      await writeFile(stray, '')

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const ssh = makeSsh({ exitCode: 255 }) // the recorded ctl exit FAILED
      await deleteCodebase(deps(ssh), metaPath, entry)

      // The kill was attempted (best-effort)...
      expect(killSpy).toHaveBeenCalledWith(987654, 'SIGTERM')
      // ...but a successful kill must NOT mark the teardown ok: the ctl exit
      // failed, so the sweep still ran, targeted the surviving socket, and
      // unlinked it (master cleaned).
      expect(ssh.calls.some((args) => args.includes('-O') && args.includes('exit') && args.includes(stray))).toBe(true)
      expect(existsSync(stray)).toBe(false)
      expect(loadCodebases(metaPath)).toEqual([])
      killSpy.mockRestore()
    })
  })
})