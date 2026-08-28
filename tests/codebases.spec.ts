/**
 * Feature B tests for `src/codebases.ts` (pure logic) and the host integration
 * seams. Everything is injected: a fake `spawnRunner` / `sshRunner`, an
 * in-memory `CredentialStore`, and a temp metadata file. No real vectr daemon,
 * no real ssh, no external network. The 41 existing feature-A specs stay green.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetServerNameRegistry,
  createCodebase,
  deleteCodebase,
  deriveServerName,
  FileCredentialStore,
  findFreePort,
  loadCodebases,
  migrateCodebases,
  saveCodebases,
  testCodebase,
  cleanupStaleTunnelSockets,
  safeRemove,
  type CodebaseDeps,
  type CodebaseEntry,
  type CodebaseSpec,
  type CredentialStore,
  type SpawnHandle,
  type SpawnRunner,
  type SshRunner,
} from '../src/codebases.ts'

/** A fake process record: what command it represents + scripted outcome. */
interface FakeProc {
  command: string
  args: string[]
  /** stdout returned on exit. */
  stdout: string
  /** stderr returned on exit. */
  stderr: string
  /** exit code. */
  code: number
  /** When set, the runner records the process here instead of auto-exiting. */
  record?: (proc: SpawnHandle) => void
  /** When true, the handle never resolves (used to simulate a hang). */
  hang?: boolean
}

/** Build a fake spawn runner that matches by command name. */
function makeSpawnRunner(scripts: Map<string, FakeProc>): SpawnRunner & { procs: SpawnHandle[] } {
  const procs: SpawnHandle[] = []
  const runner = ((command: string, args: string[]): SpawnHandle => {
    const script = scripts.get(command)
    if (script === undefined) {
      throw new Error(`unexpected spawn: ${command} ${args.join(' ')}`)
    }
    const handle: SpawnHandle = {
      promise: script.hang
        ? new Promise<{ code: number; stdout: string; stderr: string }>(() => {})
        : Promise.resolve({ code: script.code, stdout: script.stdout, stderr: script.stderr }),
      kill() {},
    }
    procs.push(handle)
    script.record?.(handle)
    return handle
  }) as SpawnRunner & { procs: SpawnHandle[] }
  ;(runner as { procs: SpawnHandle[] }).procs = procs
  return runner
}

/** Build a fake ssh runner that matches by a key token in the args (e.g. 'true', 'uv', host). */
function makeSshRunner(
  scripts: Array<{ match: (args: string[]) => boolean; proc: Omit<FakeProc, 'command' | 'args'> }>,
): SshRunner & { calls: string[][]; auths: Array<SshAuthContext | undefined> } {
  const calls: string[][] = []
  const auths: Array<SshAuthContext | undefined> = []
  const runner = ((args: string[], auth?: SshAuthContext): SpawnHandle => {
    calls.push(args)
    auths.push(auth)
    const hit = scripts.find((s) => s.match(args))
    if (hit === undefined) {
      throw new Error(`unexpected ssh: ${args.join(' ')}`)
    }
    const handle: SpawnHandle = {
      promise: Promise.resolve({ code: hit.proc.code, stdout: hit.proc.stdout, stderr: hit.proc.stderr }),
      kill() {},
    }
    return handle
  }) as SshRunner & { calls: string[][]; auths: Array<SshAuthContext | undefined> }
  ;(runner as { calls: string[][] }).calls = calls
  ;(runner as { auths: Array<SshAuthContext | undefined> }).auths = auths
  return runner
}

/** In-memory credential store for tests. */
function makeCredStore(): CredentialStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    set: (ref, value) => { data.set(ref, value) },
    get: (ref) => data.get(ref),
    unset: (ref) => { data.delete(ref) },
  }
}

let dir: string
let metaPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codebases-test-'))
  metaPath = join(dir, 'codebases.json')
  _resetServerNameRegistry()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('load/save', () => {
  it('returns [] when file missing', () => {
    expect(loadCodebases(metaPath)).toEqual([])
  })

  it('throws on malformed JSON', async () => {
    await writeFile(metaPath, '{not json', 'utf8')
    expect(() => loadCodebases(metaPath)).toThrow(/failed to parse/)
  })

  it('persists and reloads entries (atomic write)', async () => {
    const entry: CodebaseEntry = {
      id: 'a', slug: 'a', type: 'local', path: '/p', serverName: 'vectr_a', localPort: 1, status: 'up',
    }
    saveCodebases(metaPath, [entry])
    const loaded = loadCodebases(metaPath)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.serverName).toBe('vectr_a')
    // The 0600 mode is applied (best-effort across platforms).
    // Reload must not throw and must equal what we wrote.
    expect(loaded[0]?.localPort).toBe(1)
  })
})

describe('create local', () => {
  it('parses --json stdout and records entry', async () => {
    const scripts = new Map<string, FakeProc>([
      ['vectr', { command: 'vectr', args: [], code: 0, stdout: JSON.stringify({ status: 'ok', port: 8731, pid: 42 }), stderr: '' }],
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(scripts),
      sshRunner: makeSshRunner([]),
      credStore: makeCredStore(),
    }
    const spec: CodebaseSpec = { type: 'local', path: '/work', slug: 'alpha' }
    const entry = await createCodebase(deps, metaPath, spec)
    expect(entry.localPort).toBe(8731)
    expect(entry.serverName).toBe(deriveServerName('/work', 'alpha'))
    expect(entry.status).toBe('up')
    expect(loadCodebases(metaPath)[0]?.slug).toBe('alpha')
  })

  it('throws on exit code 1', async () => {
    const scripts = new Map<string, FakeProc>([
      ['vectr', { command: 'vectr', args: [], code: 1, stdout: '', stderr: 'boom' }],
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(scripts),
      sshRunner: makeSshRunner([]),
      credStore: makeCredStore(),
    }
    await expect(createCodebase(deps, metaPath, { type: 'local', path: '/w', slug: 'x' }))
      .rejects.toThrow(/exit 1/)
    expect(loadCodebases(metaPath)).toEqual([])
  })

  it('throws when status is failed', async () => {
    const scripts = new Map<string, FakeProc>([
      ['vectr', { command: 'vectr', args: [], code: 0, stdout: JSON.stringify({ status: 'failed' }), stderr: 'nope' }],
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(scripts),
      sshRunner: makeSshRunner([]),
      credStore: makeCredStore(),
    }
    await expect(createCodebase(deps, metaPath, { type: 'local', path: '/w', slug: 'x' }))
      .rejects.toThrow(/failed status/)
  })
})

describe('create remote', () => {
  it('throws when ssh probe fails', async () => {
    const ssh = makeSshRunner([
      { match: (a) => a.includes('true'), proc: { code: 255, stdout: '', stderr: 'no route' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    await expect(createCodebase(deps, metaPath, { type: 'remote', path: '/w', host: 'h', workspace: '/local/w', slug: 'r' }))
      .rejects.toThrow(/cannot reach/)
  })

  it('throws when install fails', async () => {
    const ssh = makeSshRunner([
      { match: (a) => a.includes('true'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('uv'), proc: { code: 1, stdout: '', stderr: 'install failed' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    await expect(createCodebase(deps, metaPath, { type: 'remote', path: '/w', host: 'h', workspace: '/local/w', slug: 'r' }))
      .rejects.toThrow(/install vectr/)
  })

  it('records tunnel PID + ctl and stores password ref (never in meta)', async () => {
    const ssh = makeSshRunner([
      { match: (a) => a.includes('true'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('uv'), proc: { code: 0, stdout: 'installed', stderr: '' } },
      { match: (a) => a.includes('start'), proc: { code: 0, stdout: '{"port":8760}', stderr: '' } },
      { match: (a) => a.includes('cat'), proc: { code: 0, stdout: JSON.stringify({ k1: { workspace: '/w', port: 8760 } }), stderr: '' } },
      { match: (a) => a.includes('-L') || a.includes('-M'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('-O'), proc: { code: 0, stdout: 'Master running (pid=12345)', stderr: '' } },
    ])
    const creds = makeCredStore()
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: creds,
    }
    const spec: CodebaseSpec = { type: 'remote', path: '/w', host: 'h', workspace: '/local/w', slug: 'r', auth: 'password', password: 'secret123' }
    const entry = await createCodebase(deps, metaPath, spec)
    expect(entry.tunnelPid).toBe(12345)
    expect(entry.tunnelCtl).toBeDefined()
    expect(entry.credentialRef).toBe('VECTR_SSH_R')
    // password is injected into every ssh call (consumed via sshpass in prod)
    expect(ssh.auths.some((a) => a?.password === 'secret123')).toBe(true)
    // secret stored under ref, not in metadata file
    expect(creds.get('VECTR_SSH_R')).toBe('secret123')
    const metaText = JSON.stringify(loadCodebases(metaPath))
    expect(metaText).not.toContain('secret123')
    expect(metaText).toContain('VECTR_SSH_R')
  })

  it('throws when password auth is requested but no password provided (P8)', async () => {
    const ssh = makeSshRunner([
      { match: (a) => a.includes('true'), proc: { code: 0, stdout: '', stderr: '' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(), // empty: get() returns undefined
    }
    await expect(createCodebase(deps, metaPath, { type: 'remote', path: '/w', host: 'h', workspace: '/local/w', slug: 'p8', auth: 'password' }))
      .rejects.toThrow(/no password was provided/)
    // Must NOT silently downgrade to key auth and probe — no ssh issued at all.
    expect(ssh.calls).toHaveLength(0)
  })

  it('resolves remote port from instances.json (cat), not stdout', async () => {
    const ssh = makeSshRunner([
      { match: (a) => a.includes('true'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('uv'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('start'), proc: { code: 0, stdout: '{"port":9999}', stderr: '' } },
      { match: (a) => a.includes('cat'), proc: { code: 0, stdout: JSON.stringify({ k2: { workspace: '/w', port: 8762 } }), stderr: '' } },
      { match: (a) => a.includes('-L') || a.includes('-M'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('-O'), proc: { code: 0, stdout: 'Master running (pid=7)', stderr: '' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    const entry = await createCodebase(deps, metaPath, { type: 'remote', path: '/w', host: 'h', workspace: '/local/w', slug: 'p5' })
    expect(entry.remotePort).toBe(8762) // from instances.json, overrides stdout 9999
    expect(entry.localPort).toBeGreaterThan(0)
    // P1 anti-false-green: the cat argument must be the REMOTE home
    // (`~/.vectr/instances.json`), not the local `homedir()` path. A local
    // path would point `cat` at a non-existent file on the remote and silently
    // fall back to stdout/8760.
    const catCall = ssh.calls.find(c => c.includes('cat'))
    expect(catCall).toBeDefined()
    expect(catCall?.[0]).toBe('h') // host first
    expect(catCall?.[2]).toBe('~/.vectr/instances.json') // remote home, expanded by remote shell
    expect(catCall?.[2]).not.toContain('/home/csy') // must NOT leak local home
  })

  it('falls back to stdout port when remote instances.json is absent', async () => {
    // The remote file does not exist (or is unreadable) -> cat exits non-zero.
    const ssh = makeSshRunner([
      { match: (a) => a.includes('true'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('uv'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('start'), proc: { code: 0, stdout: '{"port":9999}', stderr: '' } },
      { match: (a) => a.includes('cat'), proc: { code: 1, stdout: '', stderr: 'No such file or directory' } },
      { match: (a) => a.includes('-L') || a.includes('-M'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('-O'), proc: { code: 0, stdout: 'Master running (pid=7)', stderr: '' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    const entry = await createCodebase(deps, metaPath, { type: 'remote', path: '/w', host: 'h', workspace: '/local/w', slug: 'p5fb' })
    // cat failed -> resolveRemotePort returns undefined -> falls back to the
    // `vectr start` stdout port (9999), never the silent 8760 default.
    expect(entry.remotePort).toBe(9999)
    const catCall = ssh.calls.find(c => c.includes('cat'))
    expect(catCall?.[2]).toBe('~/.vectr/instances.json')
  })

  it('rejects (no silent 8760) when cat fails AND stdout carries no port (改动3)', async () => {
    // Both resolvers fail -> the create must REJECT with an explicit error that
    // names host + workspace, and must NOT silently bind remotePort 8760 (which
    // would create a tunnel to a port with no daemon).
    const ssh = makeSshRunner([
      { match: (a) => a.includes('true'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('uv'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('start'), proc: { code: 0, stdout: 'vectr started ok', stderr: '' } },
      { match: (a) => a.includes('cat'), proc: { code: 1, stdout: '', stderr: 'No such file or directory' } },
      { match: (a) => a.includes('-L') || a.includes('-M'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('-O'), proc: { code: 0, stdout: 'Master running (pid=7)', stderr: '' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    await expect(createCodebase(deps, metaPath, { type: 'remote', path: '/w', host: 'h', workspace: '/local/w', slug: 'p5fb8760' }))
      .rejects.toThrow(/could not resolve remote vectr daemon port on h for workspace \/w/)
    // The tunnel/port step never ran, so nothing was persisted.
    expect(loadCodebases(metaPath)).toEqual([])
  })

  it('rejects and unsets the stored credential when port cannot be resolved (改动3)', async () => {
    // Password-auth path: if the port cannot be resolved, the already-stored
    // secret must be unset and the create must reject (no orphaned credential).
    const ssh = makeSshRunner([
      { match: (a) => a.includes('true'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('uv'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('start'), proc: { code: 0, stdout: 'vectr started ok', stderr: '' } },
      { match: (a) => a.includes('cat'), proc: { code: 1, stdout: '', stderr: 'No such file or directory' } },
      { match: (a) => a.includes('-L') || a.includes('-M'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('-O'), proc: { code: 0, stdout: 'Master running (pid=7)', stderr: '' } },
    ])
    const creds = makeCredStore()
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: creds,
    }
    await expect(createCodebase(deps, metaPath, { type: 'remote', path: '/w', host: 'h', workspace: '/local/w', slug: 'p5cred', auth: 'password', password: 'secret123' }))
      .rejects.toThrow(/could not resolve remote vectr daemon port on h for workspace \/w/)
    expect(creds.get('VECTR_SSH_P5CRED')).toBeUndefined()
    expect(loadCodebases(metaPath)).toEqual([])
  })

  it('retries ssh -O check once on transient failure and still captures PID', async () => {
    // P3: ssh -f -N -M may not have finished the master handshake when the
    // first `ssh -O check` runs, so it fails once; the retry must recover.
    let checkCalls = 0
    const ssh: SshRunner = (args) => {
      if (args.includes('-O') && args.includes('check')) {
        checkCalls += 1
        const ok = checkCalls >= 2
        return { promise: Promise.resolve({ code: ok ? 0 : 1, stdout: ok ? 'Master running (pid=4321)' : '', stderr: '' }), kill() {} }
      }
      let proc = { code: 0, stdout: '', stderr: '' }
      if (args.includes('start')) proc = { code: 0, stdout: '{"port":8760}', stderr: '' }
      else if (args.includes('cat')) proc = { code: 0, stdout: JSON.stringify({ k1: { workspace: '/w', port: 8760 } }), stderr: '' }
      return { promise: Promise.resolve(proc), kill() {} }
    }
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    const entry = await createCodebase(deps, metaPath, { type: 'remote', path: '/w', host: 'h', workspace: '/local/w', slug: 'retry' })
    expect(checkCalls).toBeGreaterThanOrEqual(2) // retried after the first failure
    expect(entry.tunnelPid).toBe(4321)
    expect(entry.tunnelCtl).toBeDefined()
  })
})

describe('delete', () => {
  it('kills tunnel and stops remote daemon', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const ssh = makeSshRunner([
      { match: (a) => a.includes('stop'), proc: { code: 0, stdout: '', stderr: '' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    const entry: CodebaseEntry = {
      id: 'r', slug: 'r', type: 'remote', path: '/w', host: 'h', serverName: 'vectr_r',
      localPort: 8761, remotePort: 8760, tunnelPid: 999, credentialRef: 'VECTR_SSH_R', status: 'up',
    }
    saveCodebases(metaPath, [entry])
    await deleteCodebase(deps, metaPath, entry)
    expect(killSpy).toHaveBeenCalledWith(999, 'SIGTERM')
    expect(ssh.calls.some((c) => c.includes('stop'))).toBe(true)
    expect(loadCodebases(metaPath)).toEqual([])
    killSpy.mockRestore()
  })

  it('exits tunnel via control socket when present', async () => {
    const ssh = makeSshRunner([
      { match: (a) => a.includes('stop'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('-O'), proc: { code: 0, stdout: '', stderr: '' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    const entry: CodebaseEntry = {
      id: 'r', slug: 'r', type: 'remote', path: '/w', host: 'h', serverName: 'vectr_r',
      localPort: 8761, remotePort: 8760, tunnelPid: 999, tunnelCtl: '/tmp/vectr-tunnel-r.sock', credentialRef: 'VECTR_SSH_R', status: 'up',
    }
    saveCodebases(metaPath, [entry])
    await deleteCodebase(deps, metaPath, entry)
    expect(ssh.calls.some((c) => c.includes('-O') && c.includes('exit'))).toBe(true)
    expect(loadCodebases(metaPath)).toEqual([])
  })

  it('exits tunnel via control socket even when tunnelPid is missing (P3)', async () => {
    // P3: a transient -O check race can leave tunnelPid undefined while the
    // master (and its socket) is alive. Teardown must still run `ssh -O exit`.
    const ssh = makeSshRunner([
      { match: (a) => a.includes('stop'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('-O'), proc: { code: 0, stdout: '', stderr: '' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    const entry: CodebaseEntry = {
      id: 'r', slug: 'r', type: 'remote', path: '/w', host: 'h', serverName: 'vectr_r',
      localPort: 8761, remotePort: 8760, tunnelCtl: '/tmp/vectr-tunnel-r.sock', credentialRef: 'VECTR_SSH_R', status: 'up',
      // intentionally NO tunnelPid
    }
    saveCodebases(metaPath, [entry])
    await deleteCodebase(deps, metaPath, entry)
    expect(ssh.calls.some((c) => c.includes('-O') && c.includes('exit'))).toBe(true)
    expect(loadCodebases(metaPath)).toEqual([])
  })

  it('stops local daemon via vectr stop --port', async () => {
    let stopArgs: string[] | undefined
    const scripts = new Map<string, FakeProc>([
      ['vectr', { command: 'vectr', args: [], code: 0, stdout: '', stderr: '', record: (h) => { void h; } }],
    ])
    const runner = makeSpawnRunner(scripts)
    // Wrap spawnRunner to capture the args of the vectr stop call.
    const capturingSpawn: SpawnRunner = (command, args) => {
      if (command === 'vectr' && args.includes('stop')) stopArgs = args
      return runner(command, args)
    }
    const deps: CodebaseDeps = {
      spawnRunner: capturingSpawn,
      sshRunner: makeSshRunner([]),
      credStore: makeCredStore(),
    }
    const entry: CodebaseEntry = {
      id: 'a', slug: 'a', type: 'local', path: '/w', serverName: 'vectr_a', localPort: 8731, status: 'up',
    }
    saveCodebases(metaPath, [entry])
    await deleteCodebase(deps, metaPath, entry)
    expect(stopArgs).toBeDefined()
    expect(stopArgs).toContain('--port')
    expect(stopArgs).toContain('8731')
    expect(loadCodebases(metaPath)).toEqual([])
  })

  it('stops remote daemon on remotePort (not localPort) via PATH-injected vectr stop', async () => {
    // Regression for the conan-rerun / dev-fix5 bug: remote delete must stop the
    // daemon on `entry.remotePort` (the port the conan daemon actually binds),
    // NOT `entry.localPort` (our local tunnel endpoint). Stopping on localPort is
    // a silent no-op that orphans the remote daemon + its instances.json entry.
    const ssh = makeSshRunner([
      { match: (a) => a.includes('stop'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('-O'), proc: { code: 0, stdout: '', stderr: '' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    const entry: CodebaseEntry = {
      id: 'r', slug: 'r', type: 'remote', path: '/w', host: 'h', serverName: 'vectr_r',
      localPort: 8760, remotePort: 8767, tunnelPid: 999, tunnelCtl: '/tmp/vectr-tunnel-r.sock', credentialRef: 'VECTR_SSH_R', status: 'up',
    }
    saveCodebases(metaPath, [entry])
    await deleteCodebase(deps, metaPath, entry)
    const stopCall = ssh.calls.find((c) => c.includes('stop'))
    expect(stopCall).toBeDefined()
    const portIdx = stopCall!.indexOf('--port')
    expect(portIdx).toBeGreaterThanOrEqual(0)
    expect(stopCall![portIdx + 1]).toBe('8767') // remotePort, NOT localPort 8760
    expect(stopCall![portIdx + 1]).not.toBe('8760')
    // PATH injected so non-interactive ssh resolves the uv-installed vectr.
    expect(stopCall).toContain('PATH=$HOME/.local/bin:$PATH')
    expect(stopCall?.[1]).toBe('export')
    expect(loadCodebases(metaPath)).toEqual([])
  })

  it('tears down tunnel before stopping the remote daemon', async () => {
    // Spec order: ssh -O exit (tunnel) -> vectr stop (remote daemon) -> metadata delete.
    const ssh = makeSshRunner([
      { match: (a) => a.includes('stop'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('-O'), proc: { code: 0, stdout: '', stderr: '' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    const entry: CodebaseEntry = {
      id: 'r', slug: 'r', type: 'remote', path: '/w', host: 'h', serverName: 'vectr_r',
      localPort: 8760, remotePort: 8767, tunnelPid: 999, tunnelCtl: '/tmp/vectr-tunnel-r.sock', credentialRef: 'VECTR_SSH_R', status: 'up',
    }
    saveCodebases(metaPath, [entry])
    await deleteCodebase(deps, metaPath, entry)
    const exitIdx = ssh.calls.findIndex((c) => c.includes('-O') && c.includes('exit'))
    const stopIdx = ssh.calls.findIndex((c) => c.includes('stop'))
    expect(exitIdx).toBeGreaterThanOrEqual(0)
    expect(stopIdx).toBeGreaterThan(exitIdx) // tunnel teardown precedes remote stop
  })
})

describe('remote vectr PATH + idempotent install', () => {
  /** Capture all ssh calls whose command words include `vectr` as a token. */
  const vectrCalls = (calls: string[][]) =>
    calls.filter((c) => c.includes('vectr'))

  it('injects PATH so remote vectr resolves without the remote shell PATH', async () => {
    // Regression for the conan trial: non-interactive ssh PATH lacks
    // ~/.local/bin, so a bare `vectr` failed with 'command not found'.
    const ssh = makeSshRunner([
      { match: (a) => a.includes('true'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('tool'), proc: { code: 0, stdout: 'vectr v1.11.0', stderr: '' } },
      { match: (a) => a.includes('start'), proc: { code: 0, stdout: '{"port":8760}', stderr: '' } },
      { match: (a) => a.includes('cat'), proc: { code: 0, stdout: JSON.stringify({ k1: { workspace: '/w', port: 8760 } }), stderr: '' } },
      { match: (a) => a.includes('-L') || a.includes('-M'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('-O'), proc: { code: 0, stdout: 'Master running (pid=12345)', stderr: '' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    await createCodebase(deps, metaPath, { type: 'remote', path: '/w', host: 'h', workspace: '/local/w', slug: 'p' })
    const calls = vectrCalls(ssh.calls)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      // PATH export present as explicit tokens; `vectr` must NOT be the bare
      // 2nd element (that was the broken form [host, 'vectr', ...]).
      expect(call).toContain('export')
      expect(call).toContain('PATH=$HOME/.local/bin:$PATH')
      expect(call).toContain('&&')
      expect(call[1]).toBe('export')
    }
    // No call is the old bare `vectr` invocation.
    expect(ssh.calls.some((c) => c.length >= 3 && c[0] === 'h' && c[1] === 'vectr')).toBe(false)
  })

  it('stops the remote daemon with a PATH-injected vectr stop', async () => {
    const ssh = makeSshRunner([
      { match: (a) => a.includes('stop'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('-O'), proc: { code: 0, stdout: '', stderr: '' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    const entry: CodebaseEntry = {
      id: 'r', slug: 'r', type: 'remote', path: '/w', host: 'h', serverName: 'vectr_r',
      localPort: 8761, remotePort: 8760, tunnelPid: 999, tunnelCtl: '/tmp/vectr-tunnel-r.sock', credentialRef: 'VECTR_SSH_R', status: 'up',
    }
    saveCodebases(metaPath, [entry])
    await deleteCodebase(deps, metaPath, entry)
    const stopCall = vectrCalls(ssh.calls).find((c) => c.includes('stop'))
    expect(stopCall).toBeDefined()
    expect(stopCall).toContain('PATH=$HOME/.local/bin:$PATH')
    expect(stopCall?.[1]).toBe('export')
    expect(loadCodebases(metaPath)).toEqual([])
  })

  it('skips install when uv tool list already reports vectr (idempotent)', async () => {
    // Retried create must not re-run `uv tool install` (which fails when
    // already installed) — it should detect the existing install and proceed.
    const ssh = makeSshRunner([
      { match: (a) => a.includes('true'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('tool') && a.includes('list'), proc: { code: 0, stdout: 'vectr v1.11.0\n', stderr: '' } },
      { match: (a) => a.includes('start'), proc: { code: 0, stdout: '{"port":8760}', stderr: '' } },
      { match: (a) => a.includes('cat'), proc: { code: 0, stdout: JSON.stringify({ k1: { workspace: '/w', port: 8760 } }), stderr: '' } },
      { match: (a) => a.includes('-L') || a.includes('-M'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('-O'), proc: { code: 0, stdout: 'Master running (pid=12345)', stderr: '' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    const entry = await createCodebase(deps, metaPath, { type: 'remote', path: '/w', host: 'h', workspace: '/local/w', slug: 'idem' })
    expect(entry.status).toBe('up')
    // `uv tool install` must NOT have been issued (only `uv tool list`).
    expect(ssh.calls.some((c) => c.join(' ').includes('uv tool install'))).toBe(false)
  })

  it('tolerates uv tool install non-zero exit that means already installed', async () => {
    // When vectr is absent per `uv tool list` but install still exits non-zero
    // with an 'already installed' message, the create must proceed (not throw).
    const ssh = makeSshRunner([
      { match: (a) => a.includes('true'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('tool') && a.includes('list'), proc: { code: 0, stdout: 'other-tool v0.1', stderr: '' } },
      { match: (a) => a.includes('tool') && a.includes('install'), proc: { code: 1, stdout: '', stderr: 'ERROR: package vectr is already installed' } },
      { match: (a) => a.includes('start'), proc: { code: 0, stdout: '{"port":8760}', stderr: '' } },
      { match: (a) => a.includes('cat'), proc: { code: 0, stdout: JSON.stringify({ k1: { workspace: '/w', port: 8760 } }), stderr: '' } },
      { match: (a) => a.includes('-L') || a.includes('-M'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('-O'), proc: { code: 0, stdout: 'Master running (pid=12345)', stderr: '' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    const entry = await createCodebase(deps, metaPath, { type: 'remote', path: '/w', host: 'h', workspace: '/local/w', slug: 'tol' })
    expect(entry.status).toBe('up')
  })

  it('still throws on a genuine install failure (not already-installed)', async () => {
    const ssh = makeSshRunner([
      { match: (a) => a.includes('true'), proc: { code: 0, stdout: '', stderr: '' } },
      { match: (a) => a.includes('tool'), proc: { code: 1, stdout: '', stderr: 'some real network error' } },
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()),
      sshRunner: ssh,
      credStore: makeCredStore(),
    }
    await expect(createCodebase(deps, metaPath, { type: 'remote', path: '/w', host: 'h', workspace: '/local/w', slug: 'fail' }))
      .rejects.toThrow(/install vectr/)
  })
})

describe('test', () => {
  it('returns ok on 200 with status json', async () => {
    const server = await startProbe(200, { ready: true })
    const entry: CodebaseEntry = { id: 'a', slug: 'a', type: 'local', path: '/w', serverName: 'vectr_a', localPort: server.port, status: 'up' }
    const result = await testCodebase(entry)
    expect(result.ok).toBe(true)
    expect(result.status).toEqual({ ready: true })
    await server.close()
  })

  it('returns ok:false on 503', async () => {
    const server = await startProbe(503, null)
    const entry: CodebaseEntry = { id: 'a', slug: 'a', type: 'local', path: '/w', serverName: 'vectr_a', localPort: server.port, status: 'up' }
    const result = await testCodebase(entry)
    expect(result.ok).toBe(false)
    await server.close()
  })

  it('returns ok:false on timeout (abort)', async () => {
    const server = await startProbe(200, { ready: true }, 5000)
    const entry: CodebaseEntry = { id: 'a', slug: 'a', type: 'local', path: '/w', serverName: 'vectr_a', localPort: server.port, status: 'up' }
    const result = await testCodebase(entry)
    expect(result.ok).toBe(false)
    await server.close()
  })

  it('returns ok:false when no local port', async () => {
    const entry: CodebaseEntry = { id: 'a', slug: 'a', type: 'local', path: '/w', serverName: 'vectr_a', status: 'up' }
    const result = await testCodebase(entry)
    expect(result.ok).toBe(false)
  })
})

describe('serverName validation + uniqueness', () => {
  it('rejects invalid slug', async () => {
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(new Map()), sshRunner: makeSshRunner([]), credStore: makeCredStore(),
    }
    await expect(createCodebase(deps, metaPath, { type: 'local', path: '/w', slug: 'bad slug!' }))
      .rejects.toThrow(/invalid slug/)
  })

  it('rejects duplicate serverName', async () => {
    const scripts = new Map<string, FakeProc>([
      ['vectr', { command: 'vectr', args: [], code: 0, stdout: JSON.stringify({ status: 'ok', port: 8731 }), stderr: '' }],
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(scripts), sshRunner: makeSshRunner([]), credStore: makeCredStore(),
    }
    await createCodebase(deps, metaPath, { type: 'local', path: '/w', slug: 'dup' })
    await expect(createCodebase(deps, metaPath, { type: 'local', path: '/w', slug: 'dup' }))
      .rejects.toThrow(/already in use/)
  })
})

describe('concurrency + port guards (P4)', () => {
  it('only one concurrent create of the same slug succeeds; the other fails', async () => {
    const scripts = new Map<string, FakeProc>([
      ['vectr', { command: 'vectr', args: [], code: 0, stdout: JSON.stringify({ status: 'ok', port: 8731 }), stderr: '' }],
    ])
    const deps: CodebaseDeps = {
      spawnRunner: makeSpawnRunner(scripts),
      sshRunner: makeSshRunner([]),
      credStore: makeCredStore(),
    }
    const spec: CodebaseSpec = { type: 'local', path: '/w', slug: 'dupslug' }
    const results = await Promise.allSettled([
      createCodebase(deps, metaPath, spec),
      createCodebase(deps, metaPath, spec),
    ])
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    // exactly one entry persisted (no double registration / serverName clash)
    expect(loadCodebases(metaPath)).toHaveLength(1)
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/already in use|conflicts/)
  })

  it('findFreePort skips ports listed in the exclude set', async () => {
    const all = new Set<number>()
    for (let p = 8760; p <= 8799; p++) all.add(p)
    expect(await findFreePort(8760, 8799, all)).toBeUndefined()
    expect(await findFreePort(8760, 8799, new Set([8760]))).not.toBe(8760)
  })
})

describe('FileCredentialStore', () => {
  it('stores, reads, and unsets (atomic 0600)', async () => {
    const path = join(dir, 'secrets.json')
    const store = new FileCredentialStore(path)
    store.set('K', 'v')
    expect(store.get('K')).toBe('v')
    store.unset('K')
    expect(store.get('K')).toBeUndefined()
  })
})

describe('cleanupStaleTunnelSockets (P6)', () => {
  let sockDir: string
  beforeEach(async () => {
    sockDir = await mkdtemp(join(tmpdir(), 'sock-cleanup-'))
  })
  afterEach(async () => {
    await rm(sockDir, { recursive: true, force: true })
  })

  it('removes sockets whose owning pid is dead (ESRCH); keeps live / current / EPERM', async () => {
    // ponytail: pid-based heuristic — only the *owning node process* liveness is
    // checked. Mirror that here: dead pid -> removed; live pid / current pid /
    // EPERM -> kept. Orphaned ssh masters are intentionally out of scope.
    const deadPid = 12345
    const livePid = 67890
    const epermPid = 55555
    const curPid = process.pid
    await writeFile(join(sockDir, `vectr-tunnel-host-${deadPid}.sock`), '')
    await writeFile(join(sockDir, `vectr-tunnel-host-${livePid}.sock`), '')
    await writeFile(join(sockDir, `vectr-tunnel-host-${epermPid}.sock`), '')
    await writeFile(join(sockDir, `vectr-tunnel-host-${curPid}.sock`), '')
    await writeFile(join(sockDir, 'not-a-sock.txt'), '') // ignored by regex

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pidArg: number, _sig?: string | number): boolean => {
      const pid = pidArg as number
      if (pid === livePid || pid === curPid) return true // alive -> keep
      if (pid === deadPid) {
        const e = new Error('esrch') as NodeJS.ErrnoException
        e.code = 'ESRCH'
        throw e
      }
      if (pid === epermPid) {
        const e = new Error('eperm') as NodeJS.ErrnoException
        e.code = 'EPERM'
        throw e
      }
      return true
    })

    const removed = cleanupStaleTunnelSockets(sockDir)
    expect(removed).toBe(1)
    expect(existsSync(join(sockDir, `vectr-tunnel-host-${deadPid}.sock`))).toBe(false)
    expect(existsSync(join(sockDir, `vectr-tunnel-host-${livePid}.sock`))).toBe(true)
    expect(existsSync(join(sockDir, `vectr-tunnel-host-${epermPid}.sock`))).toBe(true)
    expect(existsSync(join(sockDir, `vectr-tunnel-host-${curPid}.sock`))).toBe(true)
    killSpy.mockRestore()
  })

  it('returns 0 when the dir cannot be read', () => {
    expect(cleanupStaleTunnelSockets('/nonexistent/path/that/does/not/exist')).toBe(0)
  })
})

describe('migrateCodebases (N2 null guard)', () => {
  it('returns no-op when instances is null', () => {
    expect(migrateCodebases('/tmp/no-such-meta.json', null as unknown as never)).toEqual({
      changed: false,
      migrated: 0,
    })
  })

  it('returns no-op when instances is undefined', () => {
    expect(migrateCodebases('/tmp/no-such-meta.json', undefined as unknown as never)).toEqual({
      changed: false,
      migrated: 0,
    })
  })
})

describe('safeRemove (N1 base-dir guard)', () => {
  it('throws when target equals the controlled base itself', () => {
    const base = join(tmpdir(), `safe-remove-base-${process.pid}`)
    expect(() => safeRemove(base, base)).toThrow(/outside controlled dir/)
  })

  it('throws when target is outside the controlled base', () => {
    const base = join(tmpdir(), `safe-remove-base-${process.pid}-2`)
    const outside = join(tmpdir(), `safe-remove-other-${process.pid}`)
    expect(() => safeRemove(outside, base)).toThrow(/outside controlled dir/)
  })

  it('removes a file strictly inside the controlled base', async () => {
    const base = join(tmpdir(), `safe-remove-base-${process.pid}-3`)
    await mkdir(base, { recursive: true })
    const file = join(base, 'sock')
    await writeFile(file, '')
    expect(existsSync(file)).toBe(true)
    expect(() => safeRemove(file, base)).not.toThrow()
    expect(existsSync(file)).toBe(false)
  })
})

/** Minimal probe server for testCodebase. */
async function startProbe(
  status: number,
  body: unknown,
  delayMs = 0,
): Promise<{ port: number; close: () => Promise<void> }> {
  const { createServer } = await import('node:http')
  const server = createServer((_req, res) => {
    if (delayMs > 0) {
      setTimeout(() => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(body === null ? '' : JSON.stringify(body))
      }, delayMs)
      return
    }
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(body === null ? '' : JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? (addr as { port: number }).port : 0
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}
