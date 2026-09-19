/**
 * Tests for the startup-tunnel-heal scope fix (b).
 *
 * The previous logic only healed entries whose `status === 'up'`, which made
 * a `status === 'error'` entry a permanent deadlock (the user-facing route
 * surfaced the diagnostic but no automatic recovery was ever attempted).
 *
 * The fix widens the predicate to heal both `up` AND `error` remote entries,
 * gated by a per-slug cooldown so a persistently unreachable host does not
 * get hammered on every host restart.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureTunnelUp,
  saveCodebases,
  loadCodebases,
  findFreePort,
  TUNNEL_PORT_MIN,
  TUNNEL_PORT_MAX,
  type CodebaseDeps,
  type CodebaseEntry,
  type CredentialStore,
  type SshRunner,
  type SpawnHandle,
} from '../src/codebases.ts'
import { startupHealEligible } from '../src/index.ts'

/** Real listeners opened by fake reopens, closed in afterEach. */
const boundServers: Server[] = []

function makeSsh(): SshRunner & { opens: string[][]; checks: number[] } {
  const opens: string[][] = []
  const checks: number[] = []
  let checkIdx = 0
  const codes = [1, 0] // probe dead, confirm alive
  const runner = ((args: string[]): SpawnHandle => {
    if (args.includes('-f')) {
      opens.push(args)
      // Faithful fake: actually bind the forwarded local port so the
      // post-reopen `isPortListening` force-check passes. Without this, the
      // test host's real ssh/python listeners (e.g. 8765-8767, 8761) make the
      // probe too flaky to be deterministic.
      const lIdx = args.indexOf('-L')
      const spec = lIdx >= 0 ? (args[lIdx + 1] ?? '') : ''
      const m = /127\.0\.0\.1:(\d+):/.exec(spec)
      const port = m !== null ? Number(m[1]) : undefined
      if (port !== undefined && !boundServers.some((s) => (s.address() as { port: number } | null)?.port === port)) {
        const p = new Promise<{ code: number; stdout: string; stderr: string; signal: NodeJS.Signals | null }>((resolveOpen) => {
          const s = createServer((_q, res) => res.end())
          s.listen(port, '127.0.0.1', () => {
            boundServers.push(s)
            resolveOpen({ code: 0, stdout: '', stderr: '', signal: null })
          })
          s.once('error', () => resolveOpen({ code: 0, stdout: '', stderr: '', signal: null }))
        })
        return { promise: p, kill() {} }
      }
      return { promise: Promise.resolve({ code: 0, stdout: '', stderr: '', signal: null }), kill() {} }
    }
    if (args.includes('-O') && args.includes('check')) {
      const code = codes[Math.min(checkIdx, codes.length - 1)] ?? 1
      checks.push(code)
      checkIdx += 1
      return {
        promise: Promise.resolve({ code, stdout: code === 0 ? 'Master running (pid=7)' : '', stderr: '', signal: null }),
        kill() {},
      }
    }
    return { promise: Promise.resolve({ code: 0, stdout: '', stderr: '', signal: null }), kill() {} }
  }) as SshRunner & { opens: string[][]; checks: number[] }
  runner.opens = opens
  runner.checks = checks
  return runner
}

function deps(ssh: SshRunner): CodebaseDeps {
  return {
    spawnRunner: () => ({ promise: Promise.resolve({ code: 0, stdout: '', stderr: '', signal: null }), kill() {} }),
    sshRunner: ssh,
    credStore: { set() {}, get: () => undefined, unset() {} } satisfies CredentialStore,
  }
}

let dir: string
let metaPath: string
// Dynamically-free local tunnel port for fixtures (the test host may have
// real listeners on TUNNEL_PORT_MIN..MAX — e.g. vnm_gui/pythons — so the
// fixtures never hardcode one).
let testPort = TUNNEL_PORT_MIN

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'startup-heal-'))
  metaPath = join(dir, 'codebases.json')
  testPort = (await findFreePort(TUNNEL_PORT_MIN, TUNNEL_PORT_MAX)) ?? TUNNEL_PORT_MIN
})

afterEach(async () => {
  await Promise.all(boundServers.map((s) => new Promise<void>((r) => s.close(() => r()))))
  boundServers.length = 0
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('startupHealEligible — (b) heal predicate', () => {
  // Type-independent on purpose: BOTH shapes are healable now. `remote` goes to
  // `ensureTunnelUp`; `local` goes to `healLocalCodebase` (probe → `vectr start`,
  // which reuses the port the dead registry entry still records). Before this,
  // local daemons were excluded and a host restart left every workspace with a
  // permanently offline daemon and no recovery path.
  it('heals persisted entries in up (legacy), down, and error states, for local and remote alike', () => {
    for (const status of ['up', 'down', 'error'] as const) {
      expect(startupHealEligible({ status })).toBe(true)
    }
  })
})

describe('ensureTunnelUp — error entries are also healable (b)', () => {
  it('reopens a tunnel whose persisted status is "error"', async () => {
    const ssh = makeSsh()
    const entry: CodebaseEntry = {
      id: 'vnm', slug: 'vnm', type: 'remote', path: '/w', host: 'conan',
      serverName: 'vectr_vnm', localPort: testPort, remotePort: 8767,
      status: 'error', error: 'tunnel down: previous attempt failed',
    }
    saveCodebases(metaPath, [entry])
    const res = await ensureTunnelUp(deps(ssh), metaPath, entry)
    // The dead-then-alive check sequence means a real reopen happened.
    expect(ssh.opens).toHaveLength(1)
    expect(res.entry.status).toBe('up')
    expect(loadCodebases(metaPath)[0]?.status).toBe('up')
  })

  it('reopened "error" entry drops the previous diagnostic', async () => {
    const ssh = makeSsh()
    const entry: CodebaseEntry = {
      id: 'vnm', slug: 'vnm', type: 'remote', path: '/w', host: 'conan',
      serverName: 'vectr_vnm', localPort: testPort, remotePort: 8767,
      status: 'error', error: 'tunnel down: previous attempt failed',
    }
    saveCodebases(metaPath, [entry])
    const res = await ensureTunnelUp(deps(ssh), metaPath, entry)
    expect(res.entry.error).toBeUndefined()
    expect(loadCodebases(metaPath)[0]?.error).toBeUndefined()
  })
})