/**
 * 问题1B tests: tunnel health probe + self-heal (ensureTunnelUp) + truthful
 * status + testCodebase heal short-circuit.
 *
 * Everything is injected (fake ssh runner / in-memory cred store / temp meta);
 * no real ssh, no real network. The real TCP `isPortListening` probe is exercised
 * against ports we bind (or leave free) inside the test so the "occupied →
 * findFreePort reallocate" branch is covered deterministically.
 */
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, mkdir, chmod, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureTunnelUp,
  findFreePort,
  loadCodebases,
  probeTunnel,
  saveCodebases,
  testCodebase,
  TUNNEL_PORT_MIN,
  TUNNEL_PORT_MAX,
  type CodebaseDeps,
  type CodebaseEntry,
  type CredentialStore,
  type SshAuthContext,
  type SshRunner,
  type SpawnHandle,
} from '../src/codebases.ts'

interface FakeSshOpts {
  /** Per-call exit codes for `-O check` (probe then confirm). Last wins. */
  checkSequence?: number[]
  /** Exit code of the `-f` reopen attempt. */
  openCode?: number
  /** PID reported in `-O check` stdout when alive. */
  pid?: number
  /** When true (default), a successful `-f` reopen binds the forwarded local
   * port so the post-reopen `isPortListening` force-check passes (faithful to
   * real ssh -L). Set false to simulate the silent-dead case: the reopen "succeeds"
   * but the forward never actually binds. */
  bindOnOpen?: boolean
}

/** Real listeners opened by fake reopens, closed in afterEach. */
const boundServers: Server[] = []

function makeSsh(opts: FakeSshOpts = {}): SshRunner & { calls: string[][]; auths: Array<SshAuthContext | undefined>; opens: string[][] } {
  const checkCodes = opts.checkSequence ?? [1]
  let checkIdx = 0
  const calls: string[][] = []
  const auths: Array<SshAuthContext | undefined> = []
  const opens: string[][] = []
  const runner = ((args: string[], auth?: SshAuthContext): SpawnHandle => {
    calls.push(args)
    auths.push(auth)
    if (args.includes('-f')) {
      opens.push(args)
      const code = opts.openCode ?? 0
      // A failed reopen (or an explicit no-bind) must NOT pretend to have bound.
      if (opts.bindOnOpen === false || code !== 0) {
        return { promise: Promise.resolve({ code, stdout: '', stderr: '', signal: null }), kill() {} }
      }
      // Parse `-L 127.0.0.1:<port>:...` and bind a real listener so the
      // post-reopen `isPortListening` force-check reflects the real forward.
      const lIdx = args.indexOf('-L')
      const spec = lIdx >= 0 ? (args[lIdx + 1] ?? '') : ''
      const m = /127\.0\.0\.1:(\d+):/.exec(spec)
      const port = m !== null ? Number(m[1]) : undefined
      const p = new Promise<{ code: number; stdout: string; stderr: string; signal: NodeJS.Signals | null }>((resolveOpen) => {
        if (port !== undefined) {
          const s = createServer((_q, res) => res.end())
          s.listen(port, '127.0.0.1', () => {
            boundServers.push(s)
            resolveOpen({ code, stdout: '', stderr: '', signal: null })
          })
        } else {
          resolveOpen({ code, stdout: '', stderr: '', signal: null })
        }
      })
      return { promise: p, kill() {} }
    }
    if (args.includes('-O') && args.includes('check')) {
      const code = checkCodes[Math.min(checkIdx, checkCodes.length - 1)] ?? 1
      checkIdx += 1
      const stdout = code === 0 && opts.pid !== undefined ? `Master running (pid=${opts.pid})` : ''
      return { promise: Promise.resolve({ code, stdout, stderr: '', signal: null }), kill() {} }
    }
    return { promise: Promise.resolve({ code: 0, stdout: '', stderr: '', signal: null }), kill() {} }
  }) as SshRunner & { calls: string[][]; auths: Array<SshAuthContext | undefined>; opens: string[][] }
  ;(runner as { calls: string[][] }).calls = calls
  ;(runner as { auths: Array<SshAuthContext | undefined> }).auths = auths
  ;(runner as { opens: string[][] }).opens = opens
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
// Dynamically-free local tunnel port for fixtures. The test host may already
// have a real daemon/tunnel bound on 8760 (e.g. a live vnm_gui), so we never
// hardcode it; every fixture entry uses this port which is free at test time.
let testPort = TUNNEL_PORT_MIN

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tunnel-heal-'))
  metaPath = join(dir, 'codebases.json')
  testPort = (await findFreePort(TUNNEL_PORT_MIN, TUNNEL_PORT_MAX)) ?? TUNNEL_PORT_MIN
})

afterEach(async () => {
  await Promise.all(boundServers.map((s) => new Promise<void>((r) => s.close(() => r()))))
  boundServers.length = 0
  await rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const remoteEntry = (over: Partial<CodebaseEntry> = {}): CodebaseEntry => ({
  id: 'vnm', slug: 'vnm', type: 'remote', path: '/w', host: 'conan',
  serverName: 'vectr_vnm', localPort: testPort, remotePort: 8767,
  tunnelCtl: '/tmp/vectr-tunnel-vnm.sock', status: 'up', ...over,
})

describe('probeTunnel', () => {
  it('reports alive when ssh -O check succeeds', async () => {
    const ssh = makeSsh({ checkSequence: [0], pid: 123 })
    expect(await probeTunnel(remoteEntry(), deps(ssh))).toEqual({ alive: true })
  })

  it('reports dead when -O check fails and no local port is bound', async () => {
    const ssh = makeSsh({ checkSequence: [1] })
    const res = await probeTunnel(remoteEntry({ localPort: undefined }), deps(ssh))
    expect(res).toEqual({ alive: false, reason: 'tunnel-down' })
  })

  it('returns not-remote for local entries (nothing to heal)', async () => {
    const ssh = makeSsh()
    expect(await probeTunnel({ ...remoteEntry(), type: 'local' }, deps(ssh)))
      .toEqual({ alive: false, reason: 'not-remote' })
  })

  it('returns no-tunnel-config when neither ctl nor localPort exist', async () => {
    const ssh = makeSsh()
    expect(await probeTunnel(remoteEntry({ tunnelCtl: undefined, localPort: undefined }), deps(ssh)))
      .toEqual({ alive: false, reason: 'no-tunnel-config' })
  })
})

describe('ensureTunnelUp', () => {
  it('B1: master up but forward port dead reopens instead of reusing the dead port', async () => {
    // masterUp true (checkSequence [0]), but NOTHING is bound on testPort, so
    // isPortListening fails -> the stale master is exited and the forward reopened.
    const ssh = makeSsh({ checkSequence: [0], pid: 1 })
    const entry = remoteEntry() // localPort = testPort, nothing listening
    saveCodebases(metaPath, [entry])
    const res = await ensureTunnelUp(deps(ssh), metaPath, entry)
    expect(res.healed).toBe(true) // reopened, not reused
    expect(ssh.opens).toHaveLength(1)
    // The fake reopen binds a real listener, so the post-reopen force-check passes.
    expect(res.entry.status).toBe('up')
    expect(loadCodebases(metaPath)[0]?.status).toBe('up')
  })

  it('does NOT reopen when the tunnel is already alive (master up + forward listening)', async () => {
    // B1 invariant: healthy means BOTH the master answers `-O check` AND the
    // forwarded local port is listening. Here we bind the port so both hold.
    const server = createServer((_q, res) => res.end())
    await new Promise<void>((r) => server.listen(testPort, '127.0.0.1', () => r()))
    const ssh = makeSsh({ checkSequence: [0], pid: 123 })
    const entry = remoteEntry() // localPort = testPort (now bound)
    saveCodebases(metaPath, [entry])
    try {
      const res = await ensureTunnelUp(deps(ssh), metaPath, entry)
      expect(res.healed).toBe(false)
      expect(ssh.opens).toHaveLength(0) // no reopen attempt
      expect(res.entry.localPort).toBe(testPort)
      expect(loadCodebases(metaPath)[0]?.localPort).toBe(testPort)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('reopens a dead tunnel, reusing the free localPort, and persists up', async () => {
    // checkSequence: [1 (probe dead), 0 (confirm alive)].
    const ssh = makeSsh({ checkSequence: [1, 0], pid: 555 })
    const entry = remoteEntry() // localPort 8760 is free in the test env
    saveCodebases(metaPath, [entry])
    const res = await ensureTunnelUp(deps(ssh), metaPath, entry)
    expect(res.healed).toBe(true)
    expect(res.error).toBeUndefined()
    expect(res.entry.status).toBe('up')
    expect(res.entry.localPort).toBe(testPort) // reused, not reallocated
    // The reopen argv must be the exact forward tuple.
    const open = ssh.opens[0]
    expect(open).toContain('-f')
    expect(open).toContain('-M')
    expect(open).toContain('-S')
    expect(open).toContain('-L')
    const lIdx = open.indexOf('-L')
    expect(open[lIdx + 1]).toBe(`127.0.0.1:${testPort}:127.0.0.1:8767`)
    // Meta reflects the healed status.
    const meta = loadCodebases(metaPath)
    expect(meta[0]?.status).toBe('up')
    expect(meta[0]?.localPort).toBe(testPort)
  })

  it('reallocates a fresh localPort via findFreePort when the old one is occupied', async () => {
    // Bind a real (foreign) listener on the entry's localPort so the bind is
    // occupied; ensureTunnelUp must move to a different free port. Liveness is
    // derived from `ssh -O check` (dead here), so the occupied port triggers
    // reallocation rather than a false 'alive'. Bind on port 0 to get a free
    // ephemeral port deterministically.
    const server: Server = createServer((_req, res) => { res.end('x') })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const occupied = (server.address() as { port: number }).port
    const ssh = makeSsh({ checkSequence: [1, 0], pid: 9 })
    const entry = remoteEntry({ localPort: occupied })
    saveCodebases(metaPath, [entry])
    try {
      const res = await ensureTunnelUp(deps(ssh), metaPath, entry)
      expect(res.healed).toBe(true)
      // The reopened port must differ from the occupied one.
      expect(res.entry.localPort).not.toBe(occupied)
      const open = ssh.opens[0]
      const lIdx = open.indexOf('-L')
      expect(open[lIdx + 1]).toBe(`127.0.0.1:${res.entry.localPort}:127.0.0.1:8767`)
      const meta = loadCodebases(metaPath)
      expect(meta[0]?.localPort).toBe(res.entry.localPort)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('downgrades status to error (no lying) when the reopen ssh fails', async () => {
    const ssh = makeSsh({ openCode: 1 }) // reopen itself fails
    const entry = remoteEntry()
    saveCodebases(metaPath, [entry])
    const res = await ensureTunnelUp(deps(ssh), metaPath, entry)
    expect(res.healed).toBe(false)
    expect(res.error).toMatch(/^tunnel down:/)
    expect(res.entry.status).toBe('error')
    const meta = loadCodebases(metaPath)
    expect(meta[0]?.status).toBe('error')
    expect(meta[0]?.error).toMatch(/^tunnel down:/)
  })

  it('resolves the password credential for password-auth reopens', async () => {
    const ssh = makeSsh({ checkSequence: [1, 0], pid: 7 })
    const creds = makeCredStore()
    creds.set('VECTR_SSH_VNM', 's3cret')
    const entry = remoteEntry({ credentialRef: 'VECTR_SSH_VNM', tunnelCtl: undefined })
    saveCodebases(metaPath, [entry])
    const res = await ensureTunnelUp(deps(ssh, creds), metaPath, entry)
    expect(res.healed).toBe(true)
    // The reopen ssh call must have been issued with the resolved password.
    expect(ssh.auths.some((a) => a?.password === 's3cret')).toBe(true)
    // No tunnelCtl in meta -> a fresh tmp ctl socket path is allocated.
    expect(ssh.opens[0]).toContain('-S')
  })

  it('downgrades to error when remotePort is missing (cannot forward)', async () => {
    const ssh = makeSsh()
    const entry = remoteEntry({ remotePort: undefined })
    saveCodebases(metaPath, [entry])
    const res = await ensureTunnelUp(deps(ssh), metaPath, entry)
    expect(res.healed).toBe(false)
    expect(res.error).toMatch(/no remotePort/)
    expect(loadCodebases(metaPath)[0]?.status).toBe('error')
  })
})

describe('ensureTunnelUp port-reuse P0 fix (阶段1)', () => {
  it('master alive + port listening reuses localPort without reopening or reallocating', async () => {
    // The real defect: a listening localPort was treated as "occupied" and the
    // tunnel was reopened on a fresh port (silent dead). The fix treats the
    // master's `-O check` as authoritative: alive => reuse, never reopen.
    const server = createServer((_q, res) => res.end())
    await new Promise<void>((r) => server.listen(testPort, '127.0.0.1', () => r()))
    const ssh = makeSsh({ checkSequence: [0], pid: 1 })
    const entry = remoteEntry() // localPort 8760
    saveCodebases(metaPath, [entry])
    try {
      const res = await ensureTunnelUp(deps(ssh), metaPath, entry)
      expect(res.healed).toBe(false)
      expect(ssh.opens).toHaveLength(0) // no reopen attempt
      expect(res.entry.localPort).toBe(testPort) // unchanged
      expect(loadCodebases(metaPath)[0]?.localPort).toBe(testPort)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('reopen succeeds but the forward port never binds -> downgrade error (silent dead caught)', async () => {
    // P0 addition: after a seemingly-successful reopen, the forwarded port MUST
    // actually be listening; otherwise the persisted 'up' is a lie.
    const ssh = makeSsh({ checkSequence: [1, 0], pid: 2, bindOnOpen: false })
    const entry = remoteEntry() // localPort 8760, nothing listening
    saveCodebases(metaPath, [entry])
    const res = await ensureTunnelUp(deps(ssh), metaPath, entry)
    expect(res.healed).toBe(false)
    expect(res.error).toMatch(new RegExp(`forward on 127\.0\.0\.1:${testPort} did not bind after reopen`))
    expect(res.entry.status).toBe('error')
    expect(loadCodebases(metaPath)[0]?.status).toBe('error')
  })
})

describe('testCodebase heal (问题1B route path)', () => {
  it('short-circuits with a diagnostic when the tunnel cannot be reopened', async () => {
    const ssh = makeSsh({ openCode: 1 })
    const entry = remoteEntry()
    saveCodebases(metaPath, [entry])
    const result = await testCodebase(entry, { deps: deps(ssh), metaPath, heal: true })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^tunnel down:/)
    // The persisted false 'up' was corrected.
    expect(loadCodebases(metaPath)[0]?.status).toBe('error')
  })

  it('reopens a dead tunnel then proceeds to fetch (not a bare ECONNREFUSED)', async () => {
    // Probe dead, then reopen succeeds, then confirm alive.
    const ssh = makeSsh({ checkSequence: [1, 0], pid: 3 })
    const entry = remoteEntry() // 8760 free -> reused, nothing listening there
    saveCodebases(metaPath, [entry])
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ready: true }),
    } as unknown as Response)
    try {
      const result = await testCodebase(entry, { deps: deps(ssh), metaPath, heal: true })
      // heal happened (open attempted) and fetch was reached.
      expect(ssh.opens).toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledWith(`http://127.0.0.1:${testPort}/v1/status`, expect.anything())
      // With our mocked fetch the probe reports ok.
      expect(result.ok).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('still works without heal (backward-compatible signature)', async () => {
    const entry = remoteEntry({ localPort: undefined })
    const result = await testCodebase(entry)
    expect(result).toEqual({ ok: false, error: 'no local port configured' })
  })
})

describe('ensureTunnelUp defect regressions', () => {
  it('A2: reopen argv carries ConnectTimeout=5 + ExitOnForwardFailure=yes', async () => {
    const ssh = makeSsh({ checkSequence: [1, 0], pid: 1 })
    const entry = remoteEntry()
    saveCodebases(metaPath, [entry])
    const res = await ensureTunnelUp(deps(ssh), metaPath, entry)
    expect(res.healed).toBe(true)
    const open = ssh.opens[0]
    expect(open).toContain('ConnectTimeout=5')
    expect(open).toContain('ExitOnForwardFailure=yes')
    // confirm `ssh -O check` also carries ConnectTimeout=5
    const checkCall = ssh.calls.find((c) => c.includes('-O') && c.includes('check'))
    expect(checkCall).toBeDefined()
    expect(checkCall).toContain('ConnectTimeout=5')
  })

  it('A1: two concurrent heals of the same slug open the tunnel only once', async () => {
    const ssh = makeSsh({ checkSequence: [1, 0], pid: 42 })
    const entry = remoteEntry() // localPort 8760 free in test env
    saveCodebases(metaPath, [entry])
    const [a, b] = await Promise.all([
      ensureTunnelUp(deps(ssh), metaPath, entry),
      ensureTunnelUp(deps(ssh), metaPath, entry),
    ])
    // Only one reopen was ever attempted (the loser shared the winner's result).
    expect(ssh.opens).toHaveLength(1)
    expect(a.healed).toBe(true)
    expect(a.error).toBeUndefined()
    expect(b.healed).toBe(true)
    expect(b.error).toBeUndefined()
    const meta = loadCodebases(metaPath)
    expect(meta[0]?.status).toBe('up')
  })

  it('reopen succeeds but master never comes up -> diagnostic, status error', async () => {
    // Reopen exits 0, but all 3 `ssh -O check` confirms are non-zero.
    const ssh = makeSsh({ openCode: 0, checkSequence: [1, 1, 1] })
    const entry = remoteEntry()
    saveCodebases(metaPath, [entry])
    const res = await ensureTunnelUp(deps(ssh), metaPath, entry)
    expect(res.healed).toBe(false)
    expect(res.error).toBe('tunnel down: ssh master did not come up after reopen')
    expect(res.entry.status).toBe('error')
    expect(loadCodebases(metaPath)[0]?.status).toBe('error')
  })

  it('B3: persist failure (read-only dir) returns diagnostic instead of throwing', async () => {
    const roDir = join(dir, 'ro')
    await mkdir(roDir, { recursive: true })
    await chmod(roDir, 0o444)
    const roMeta = join(roDir, 'codebases.json')
    const ssh = makeSsh()
    // remotePort missing -> downgrade path that must survive a persist throw.
    const entry = remoteEntry({ remotePort: undefined })
    let threw = false
    let res
    try {
      res = await ensureTunnelUp(deps(ssh), roMeta, entry)
    } catch (err) {
      threw = true
      // eslint-disable-next-line no-console
      console.error(err)
    } finally {
      await chmod(roDir, 0o755) // restore so afterEach can rm
    }
    expect(threw).toBe(false)
    expect(res?.error).toMatch(/^tunnel down:/)
    expect(res?.entry.status).toBe('error')
  })
})

describe('ensureTunnelUp F1: surviving master killed before socket unlink', () => {
  // The incident: host process dies, its ssh master survives, the socket is
  // later unlinked by the heal path. Without the pre-unlink SIGTERM the master
  // becomes permanently uncontrollable and leaks its port on every restart.
  let sockDir: string
  beforeEach(async () => {
    sockDir = await mkdtemp(join(tmpdir(), 'heal-f1-'))
  })
  afterEach(async () => {
    await rm(sockDir, { recursive: true, force: true })
  })

  it('SIGTERMs the recorded tunnelPid when the probe reports the master dead', async () => {
    const K = 987654
    const ctl = join(sockDir, 'vectr-tunnel-vnm-ctl.sock')
    await writeFile(ctl, '')
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pidArg: number, _sig?: string | number): boolean => {
      // Only the recorded pid may be touched; anything else is a test bug.
      expect(pidArg).toBe(K)
      return true
    })
    const ssh = makeSsh({ checkSequence: [1, 0], pid: 555 })
    const entry = remoteEntry({ tunnelPid: K, tunnelCtl: ctl })
    saveCodebases(metaPath, [entry])
    const res = await ensureTunnelUp(deps(ssh), metaPath, entry)
    expect(res.healed).toBe(true)
    // The kill is the regression proof: SIGTERM to the recorded pid, and
    // only AFTER the kill is the stale socket cleared.
    expect(killSpy).toHaveBeenCalledWith(K, 'SIGTERM')
    expect(existsSync(ctl)).toBe(false)
  })

  it('ignores ESRCH (pid already gone) and still heals', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const e = new Error('kill ESRCH') as NodeJS.ErrnoException
      e.code = 'ESRCH'
      throw e
    })
    const ssh = makeSsh({ checkSequence: [1, 0], pid: 555 })
    const entry = remoteEntry({ tunnelPid: 987654 })
    saveCodebases(metaPath, [entry])
    const res = await ensureTunnelUp(deps(ssh), metaPath, entry)
    expect(res.healed).toBe(true)
    expect(killSpy).toHaveBeenCalledWith(987654, 'SIGTERM')
  })

  it('warns with the pid on EPERM and still heals', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const e = new Error('kill EPERM') as NodeJS.ErrnoException
      e.code = 'EPERM'
      throw e
    })
    const warn = vi.fn()
    const ssh = makeSsh({ checkSequence: [1, 0], pid: 555 })
    const entry = remoteEntry({ tunnelPid: 987654 })
    saveCodebases(metaPath, [entry])
    const res = await ensureTunnelUp(deps(ssh, makeCredStore(), warn), metaPath, entry)
    expect(res.healed).toBe(true)
    expect(killSpy).toHaveBeenCalledWith(987654, 'SIGTERM')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('987654')
  })
})
