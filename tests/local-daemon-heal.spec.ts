/**
 * Local-daemon startup self-heal (缺陷: dsh 重启后没有任何组件重新启动 vectr
 * daemon — `~/.vectr/instances.json` 与 `~/.dsh/vectr-codebases.json` 都留着死
 * pid/`up` 状态, 每个工作区永远显示 "daemon offline")。
 *
 * Everything is injected: a recording fake `spawnRunner`, a fake liveness probe,
 * and a temp metadata file. No real vectr, no sockets, no harness imports — so
 * this spec runs even where the `@deepseek-ai/*` links are broken.
 *
 * Guards that keep an EXISTING session's MCP URL alive across the heal:
 *  - `vectr start` is called WITHOUT `--port` and WITHOUT `--strict-port`, so
 *    vectr's own `find_free_port` reuses the port the dead registry entry still
 *    records (UPG-RESTART-PORT-WALK-BREAKS-MCP) instead of walking to a new one.
 *  - A daemon that still answers is NEVER restarted (that would steal the port
 *    from the sessions currently using it).
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveInstance, resolveInstanceExact } from '../src/registry.ts'
import {
  healLocalCodebase,
  loadCodebases,
  saveCodebases,
  startLocalDaemon,
  type CodebaseDeps,
  type CodebaseEntry,
  type SpawnHandle,
  type SpawnRunner,
} from '../src/codebases.ts'

/** One recorded `vectr` invocation plus the outcome its handle resolves with. */
interface Recorded {
  args: string[]
  result: { code: number; stdout: string; stderr: string; signal: NodeJS.Signals | null }
}

/** Recording spawn runner: every call is captured, outcomes are per-call. */
function recordingSpawnRunner(outcomes: Array<Partial<Recorded['result']>> = [{}]): {
  runner: SpawnRunner
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  let index = 0
  const runner: SpawnRunner = (_command, args) => {
    const outcome = outcomes[Math.min(index, outcomes.length - 1)] ?? {}
    index += 1
    const recorded: Recorded = {
      args,
      result: {
        code: outcome.code ?? 0,
        stdout: outcome.stdout ?? JSON.stringify({ status: 'ready', port: 8766 }),
        stderr: outcome.stderr ?? '',
        signal: outcome.signal ?? null,
      },
    }
    calls.push(recorded)
    const handle: SpawnHandle = {
      promise: Promise.resolve(recorded.result),
      kill() {},
    }
    return handle
  }
  return { runner, calls }
}

/** Build the injected deps with a recording runner and a warn spy. */
function makeDeps(outcomes?: Array<Partial<Recorded['result']>>): {
  deps: CodebaseDeps
  calls: Recorded[]
  warn: ReturnType<typeof vi.fn>
} {
  const { runner, calls } = recordingSpawnRunner(outcomes)
  const warn = vi.fn()
  const deps: CodebaseDeps = {
    spawnRunner: runner,
    sshRunner: () => {
      throw new Error('ssh must not be used by the local heal path')
    },
    credStore: { set: () => {}, get: () => undefined, unset: () => {} },
    warn,
  }
  return { deps, calls, warn }
}

/** A persisted LOCAL entry as the metadata file holds it. */
function localEntry(overrides: Partial<CodebaseEntry> = {}): CodebaseEntry {
  return {
    id: 'demo',
    slug: 'demo',
    type: 'local',
    path: '/home/csy/Work/demo',
    serverName: 'vectr_b5b2266ddc64_demo',
    localPort: 8766,
    status: 'up',
    ...overrides,
  }
}

/** `localEntry` with the optional `localPort` field ABSENT — `exactOptionalPropertyTypes`
 * rejects an explicit `undefined` as an override value. */
function withoutLocalPort(overrides: Partial<CodebaseEntry> = {}): CodebaseEntry {
  const copy = { ...localEntry(overrides) }
  delete copy.localPort
  return copy
}

/** `localEntry` with no `workspace` field at all. */
function withoutWorkspace(overrides: Partial<CodebaseEntry> = {}): CodebaseEntry {
  const copy = { ...localEntry(overrides) }
  delete copy.workspace
  return copy
}

let dir: string
let metaPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vectr-local-heal-'))
  metaPath = join(dir, 'codebases.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('startLocalDaemon — port stability is the contract', () => {
  it('starts the daemon WITHOUT --port / --strict-port so vectr may reuse the recorded port', async () => {
    const { deps, calls } = makeDeps()
    await startLocalDaemon(deps, metaPath, localEntry())

    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(['start', '--path', '/home/csy/Work/demo', '--json'])
    // The whole point: no forced port, no strict-port failure mode.
    expect(calls[0]?.args).not.toContain('--port')
    expect(calls[0]?.args).not.toContain('--strict-port')
  })

  it('persists the bound port and reports no drift when the port is unchanged', async () => {
    saveCodebases(metaPath, [localEntry({ status: 'down', error: 'daemon offline' })])
    const { deps, warn } = makeDeps([{ stdout: JSON.stringify({ status: 'ready', port: 8766 }) }])

    const outcome = await startLocalDaemon(deps, metaPath, localEntry({ status: 'down' }))

    expect(outcome).toEqual({ slug: 'demo', port: 8766, portChanged: false, previousPort: 8766 })
    expect(warn).not.toHaveBeenCalled()
    const [written] = loadCodebases(metaPath)
    expect(written?.localPort).toBe(8766)
    expect(written?.status).toBe('up')
    expect(written?.error).toBeUndefined()
  })

  it('warns (and records the new port) when the daemon drifted to a different port', async () => {
    saveCodebases(metaPath, [localEntry()])
    const { deps, warn } = makeDeps([{ stdout: JSON.stringify({ status: 'ready', port: 8770 }) }])

    const outcome = await startLocalDaemon(deps, metaPath, localEntry())

    expect(outcome.portChanged).toBe(true)
    expect(outcome.previousPort).toBe(8766)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('8770')
    expect(String(warn.mock.calls[0]?.[0])).toContain('8766')
    expect(loadCodebases(metaPath)[0]?.localPort).toBe(8770)
  })

  it('records the port without a drift warning when the entry had no recorded port', async () => {
    const { deps, warn } = makeDeps([{ stdout: JSON.stringify({ status: 'ready', port: 8766 }) }])
    const outcome = await startLocalDaemon(deps, metaPath, withoutLocalPort())

    expect(outcome).toEqual({ slug: 'demo', port: 8766, portChanged: false, previousPort: undefined })
    expect(warn).not.toHaveBeenCalled()
  })

  it('never claims success when the child was signaled', async () => {
    const { deps } = makeDeps([{ code: 0, signal: 'SIGTERM' }])
    await expect(startLocalDaemon(deps, metaPath, localEntry())).rejects.toThrow(/killed \(SIGTERM\)/)
  })

  it('throws with stderr on a non-zero exit and leaves the metadata untouched', async () => {
    saveCodebases(metaPath, [localEntry({ status: 'down' })])
    const { deps } = makeDeps([{ code: 2, stderr: 'vectr: boom' }])

    await expect(startLocalDaemon(deps, metaPath, localEntry({ status: 'down' })))
      .rejects.toThrow(/exit 2.*vectr: boom/s)
    const [unchanged] = loadCodebases(metaPath)
    expect(unchanged?.status).toBe('down')
  })

  it('throws when vectr reports failed status', async () => {
    const { deps } = makeDeps([{ stdout: JSON.stringify({ status: 'failed' }), stderr: 'no port' }])
    await expect(startLocalDaemon(deps, metaPath, localEntry())).rejects.toThrow(/failed status/)
  })

  it('throws on non-JSON stdout', async () => {
    const { deps } = makeDeps([{ stdout: 'not json' }])
    await expect(startLocalDaemon(deps, metaPath, localEntry())).rejects.toThrow(/non-JSON stdout/)
  })

  it('throws when vectr did not report a port', async () => {
    const { deps } = makeDeps([{ stdout: JSON.stringify({ status: 'ready' }) }])
    await expect(startLocalDaemon(deps, metaPath, localEntry())).rejects.toThrow(/did not report a port/)
  })

  it('refuses a remote entry (no local daemon to start)', async () => {
    const { deps, calls } = makeDeps()
    await expect(startLocalDaemon(deps, metaPath, localEntry({ type: 'remote' })))
      .rejects.toThrow(/not a local codebase/)
    expect(calls).toHaveLength(0)
  })

  it('refuses an entry with no path', async () => {
    const { deps, calls } = makeDeps()
    await expect(startLocalDaemon(deps, metaPath, localEntry({ path: '' })))
      .rejects.toThrow(/has no path/)
    expect(calls).toHaveLength(0)
  })
})

describe('healLocalCodebase — probe first, start only when dead', () => {
  it('does not touch a daemon that still answers (an existing session keeps its port)', async () => {
    const { deps, calls } = makeDeps()
    const probe = vi.fn(async () => true)

    const result = await healLocalCodebase(deps, metaPath, localEntry(), probe)

    expect(result).toBe('alive')
    expect(probe).toHaveBeenCalledWith({ host: '127.0.0.1', port: 8766 })
    expect(calls).toHaveLength(0)
    expect(existsSync(metaPath)).toBe(false)
  })

  it('starts the daemon and reports `started` when the recorded endpoint is dead', async () => {
    saveCodebases(metaPath, [localEntry()])
    const { deps, calls } = makeDeps([{ stdout: JSON.stringify({ status: 'ready', port: 8766 }) }])
    const probe = vi.fn(async () => false)

    const result = await healLocalCodebase(deps, metaPath, localEntry(), probe)

    expect(result).toBe('started')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args[0]).toBe('start')
    expect(loadCodebases(metaPath)[0]?.status).toBe('up')
  })

  it('starts the daemon without probing when no port was ever recorded', async () => {
    const { deps, calls } = makeDeps()
    const probe = vi.fn(async () => true)

    const result = await healLocalCodebase(deps, metaPath, withoutLocalPort(), probe)

    expect(result).toBe('started')
    expect(probe).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
  })

  it('propagates a start failure instead of reporting a heal', async () => {
    const { deps } = makeDeps([{ code: 1, stderr: 'spawn vectr ENOENT' }])
    await expect(healLocalCodebase(deps, metaPath, localEntry(), async () => false))
      .rejects.toThrow(/ENOENT/)
  })

  it('refuses a remote entry', async () => {
    const { deps } = makeDeps()
    await expect(healLocalCodebase(deps, metaPath, localEntry({ type: 'remote' }), async () => false))
      .rejects.toThrow(/not a local codebase/)
  })
})

describe('healLocalCodebase — port reconciliation against the daemon registry', () => {
  it('rewrites a drifted metadata port to the registry port without restarting the daemon', async () => {
    // The observed production defect: `demo_twoplus` recorded 8765 while 8765
    // actually served `/home/csy`; the real twoplus daemon was on 8766.
    saveCodebases(metaPath, [localEntry({ localPort: 8765 })])
    const { deps, calls, warn } = makeDeps()
    const probe = vi.fn(async () => true)

    const result = await healLocalCodebase(deps, metaPath, localEntry({ localPort: 8765 }), probe, () => 8766)

    expect(result).toBe('reconciled')
    expect(loadCodebases(metaPath)[0]?.localPort).toBe(8766)
    expect(probe).toHaveBeenCalledWith({ host: '127.0.0.1', port: 8766 })
    expect(calls).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('8765')
    expect(String(warn.mock.calls[0]?.[0])).toContain('8766')
  })

  it('reconciles and then starts the daemon when the registry port is also dead', async () => {
    saveCodebases(metaPath, [localEntry({ localPort: 8765 })])
    const { deps, calls } = makeDeps([{ stdout: JSON.stringify({ status: 'ready', port: 8766 }) }])
    const probe = vi.fn(async ({ port }: { port: number }) => port !== 8766)

    const result = await healLocalCodebase(deps, metaPath, localEntry({ localPort: 8765 }), probe, () => 8766)

    expect(result).toBe('started')
    expect(calls).toHaveLength(1)
    expect(loadCodebases(metaPath)[0]?.localPort).toBe(8766)
  })

  it('leaves the entry alone when the registry agrees with the metadata', async () => {
    saveCodebases(metaPath, [localEntry({ localPort: 8766 })])
    const { deps, calls, warn } = makeDeps()

    const result = await healLocalCodebase(deps, metaPath, localEntry({ localPort: 8766 }), async () => true, () => 8766)

    expect(result).toBe('alive')
    expect(warn).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('does not reconcile when the registry has no record for the workspace', async () => {
    saveCodebases(metaPath, [localEntry({ localPort: 8765 })])
    const { deps, warn } = makeDeps()

    const result = await healLocalCodebase(deps, metaPath, localEntry({ localPort: 8765 }), async () => true, () => undefined)

    expect(result).toBe('alive')
    expect(loadCodebases(metaPath)[0]?.localPort).toBe(8765)
    expect(warn).not.toHaveBeenCalled()
  })

  it('keys the lookup on the owning workspace, falling back to the path', async () => {
    const { deps } = makeDeps()
    const lookup = vi.fn(() => undefined)
    await healLocalCodebase(deps, metaPath, localEntry({ workspace: '/home/csy/Work/demo' }), async () => true, lookup)
    expect(lookup).toHaveBeenCalledWith('/home/csy/Work/demo')

    const second = vi.fn(() => undefined)
    await healLocalCodebase(deps, metaPath, withoutWorkspace(), async () => true, second)
    expect(second).toHaveBeenCalledWith('/home/csy/Work/demo')
  })
})

describe('resolveInstanceExact — exact matching only', () => {
  it('hits the sha256 workspace key', () => {
    const key = createHash('sha256').update('/home/csy/Work/twoplus').digest('hex').slice(0, 12)
    const instances = { [key]: { workspace: '/home/csy/Work/twoplus', port: 8766 } }
    expect(resolveInstanceExact(instances, '/home/csy/Work/twoplus')?.port).toBe(8766)
  })

  it('matches on the stored workspace path with trailing-slash tolerance', () => {
    const instances = { deadbeef: { workspace: '/home/csy/Work/twoplus/', port: 8766 } }
    expect(resolveInstanceExact(instances, '/home/csy/Work/twoplus')?.port).toBe(8766)
  })

  it('never returns the enclosing workspace record (the prefix-match trap)', () => {
    // `resolveInstance` WOULD return this for a nested path; that would rewrite
    // every record-less codebase to /home/csy's port.
    const instances = { 476237743879: { workspace: '/home/csy', port: 8765 } }
    expect(resolveInstanceExact(instances, '/home/csy/Work/twoplus')).toBeUndefined()
    expect(resolveInstance(instances, '/home/csy/Work/twoplus')?.port).toBe(8765)
  })

  it('returns undefined when nothing matches', () => {
    expect(resolveInstanceExact({}, '/home/csy/Work/twoplus')).toBeUndefined()
  })
})
