/**
 * L2 — every `vectr start` this plugin issues must carry the mode flag the plugin
 * itself remembers for that workspace.
 *
 * The incident this covers: a workspace had been downgraded to `memory_only`. That
 * mode lives ONLY as a runtime field of `~/.vectr/instances.json`; a harness restart
 * (KillMode=control-group) killed the daemons, `prune_dead()` dropped the record, and
 * the plugin's own auto sweep then re-ran `vectr start --path <ws> --json` with no
 * mode flag at all -> vectr's default (`full`) -> a 146k-file re-index of a workspace
 * the user had deliberately put into memory-only mode.
 *
 * The plugin cannot make vectr remember anything (no vectr-side change), so it keeps
 * its own record (`src/modes.ts`) and puts the matching flag on each spawn:
 *   memory_only -> `--memory-only`, search_only -> `--search-only`,
 *   `full` / no record -> NO flag (behaviour identical to before this change).
 *
 * Covered here: the startup-heal chain (healLocalCodebase -> startLocalDaemon), the
 * start-all sweep after the registry record has been pruned, discovery-only
 * workspaces, the explicit-write triggers (and the non-writes), and the runner's
 * `--search-only` support including its mutual exclusion.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ICodebaseService, IInstanceResolver, IVectrApiClient, IVectrCliRunner } from '../src/domain'
import type { InstanceEntry, InstancesFile, VectrStartOptions } from '../src/domain/types.ts'
import {
  healLocalCodebase,
  startLocalDaemon,
  _resetLocalDaemonLockForTests,
  type CodebaseDeps,
  type CodebaseEntry,
  type SpawnHandle,
  type SpawnRunner,
} from '../src/codebases.ts'
import { buildStartAllDeps, Config as ConfigSchema, reportModeHarvest, startAllDaemons, type Config, type StartAllDeps } from '../src/index.ts'
import { WORKSPACE_KEY_LENGTH } from '../src/registry.ts'
import { VectrCliRunner } from '../src/infra'
import { SessionVectrService } from '../src/bridge/session-service'
import { DEFAULT_MODES_FILE, lookupMode, readModes, writeMode, type PersistedMode } from '../src/modes.ts'

let dir = ''
let modesPath = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vt-flags-'))
  modesPath = join(dir, 'vectr-modes.json')
  _resetLocalDaemonLockForTests()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Shared recording runner (same shape as tests/local-daemon-heal.spec.ts)
// ---------------------------------------------------------------------------

interface Recorded {
  args: string[]
  result: { code: number; stdout: string; stderr: string; signal: NodeJS.Signals | null }
}

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
    const handle: SpawnHandle = { promise: Promise.resolve(recorded.result), kill() {} }
    return handle
  }
  return { runner, calls }
}

function makeDeps(
  outcomes: Array<Partial<Recorded['result']>> | undefined,
  modeLookup?: (dir: string) => PersistedMode | undefined,
): { deps: CodebaseDeps; calls: Recorded[] } {
  const { runner, calls } = recordingSpawnRunner(outcomes)
  const deps: CodebaseDeps = {
    spawnRunner: runner,
    sshRunner: () => {
      throw new Error('ssh must not be used by the local heal path')
    },
    credStore: { set: () => {}, get: () => undefined, unset: () => {} },
    warn: () => {},
    ...(modeLookup !== undefined ? { modeLookup } : {}),
  }
  return { deps, calls }
}

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

/** A probe that always reports the daemon as dead, so the heal path must (re)start it. */
const deadProbe = async () => false

describe('startup heal -> `vectr start` argv honors the remembered mode', () => {
  it('reads the mode off the real store file and emits --memory-only (the incident path)', async () => {
    const metaPath = join(dir, 'codebases.json')
    const entry = localEntry()
    // Production wires `modeLookup` straight to the store file (buildCodebaseDeps).
    writeMode(modesPath, entry.path, 'memory_only')
    const { deps, calls } = makeDeps(undefined, d => lookupMode(modesPath, d))

    const verdict = await healLocalCodebase(deps, metaPath, entry, deadProbe)

    expect(verdict).toBe('started')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(['start', '--path', '/home/csy/Work/demo', '--memory-only', '--json'])
  })

  it('carries the flag through the heal chain, not just a direct startLocalDaemon call', async () => {
    const metaPath = join(dir, 'codebases.json')
    const entry = localEntry()
    writeMode(modesPath, entry.path, 'memory_only')
    const { deps, calls } = makeDeps(undefined, d => lookupMode(modesPath, d))

    await startLocalDaemon(deps, metaPath, entry)

    expect(calls[0]?.args).toEqual(['start', '--path', '/home/csy/Work/demo', '--memory-only', '--json'])
  })

  it('emits --search-only for a remembered search_only workspace', async () => {
    const metaPath = join(dir, 'codebases.json')
    const entry = localEntry()
    writeMode(modesPath, entry.path, 'search_only')
    const { deps, calls } = makeDeps(undefined, d => lookupMode(modesPath, d))

    await healLocalCodebase(deps, metaPath, entry, deadProbe)

    expect(calls[0]?.args).toEqual(['start', '--path', '/home/csy/Work/demo', '--search-only', '--json'])
  })

  it('behaviour parity: with no mode record anywhere, NO flag is emitted at all', async () => {
    const metaPath = join(dir, 'codebases.json')
    const entry = localEntry()

    // (a) no modeLookup seam at all (tests / direct use).
    const plain = makeDeps(undefined)
    await healLocalCodebase(plain.deps, metaPath, entry, deadProbe)
    expect(plain.calls[0]?.args).toEqual(['start', '--path', '/home/csy/Work/demo', '--json'])

    // (b) modeLookup wired to an empty store — still no flag.
    const empty = makeDeps(undefined, d => lookupMode(modesPath, d))
    await healLocalCodebase(empty.deps, metaPath, entry, deadProbe)
    expect(empty.calls[0]?.args).toEqual(['start', '--path', '/home/csy/Work/demo', '--json'])
    expect(readModes(modesPath)).toEqual({})
  })

  it('keys on the DAEMON DIRECTORY (path || workspace), so a mode is never leaked to another workspace', async () => {
    const metaPath = join(dir, 'codebases.json')
    writeMode(modesPath, '/home/csy/Work/other', 'memory_only')
    const { deps, calls } = makeDeps(undefined, d => lookupMode(modesPath, d))

    await startLocalDaemon(deps, metaPath, localEntry({ path: '/home/csy/Work/demo' }))

    expect(calls[0]?.args).not.toContain('--memory-only')
    expect(calls[0]?.args).toEqual(['start', '--path', '/home/csy/Work/demo', '--json'])
  })

  it('a `full` record also produces no flag (the store may say full explicitly)', async () => {
    const metaPath = join(dir, 'codebases.json')
    writeMode(modesPath, '/home/csy/Work/demo', 'full')
    const { deps, calls } = makeDeps(undefined, d => lookupMode(modesPath, d))

    await startLocalDaemon(deps, metaPath, localEntry())

    expect(calls[0]?.args).toEqual(['start', '--path', '/home/csy/Work/demo', '--json'])
  })
})

// ---------------------------------------------------------------------------
// Start-all sweep after the registry record was pruned
// ---------------------------------------------------------------------------

interface SweepCalls {
  starts: VectrStartOptions[]
  records: Array<{ workspace: string; mode: PersistedMode }>
  warns: string[]
}

function makeSweepDeps(
  registrySeed: InstancesFile,
  discovered: Array<{ workspace: string }>,
  opts: {
    modeLookup?: (workspace: string) => PersistedMode | undefined
    alive?: boolean
    /** How `deps.start` fails: a reported failure or a throw. Default: it succeeds. */
    startFailure?: 'failed' | 'throws'
    /** Spawn reports ok, but the daemon never answers the post-start probe. */
    postStartAlive?: boolean
  } = {},
): { deps: StartAllDeps; calls: SweepCalls } {
  const calls: SweepCalls = { starts: [], records: [], warns: [] }
  // A fake registry the fake `vectr start` writes into, exactly like the real CLI
  // does: the sweep re-reads it after the spawn to confirm the daemon was recorded.
  const registry: InstancesFile = { ...registrySeed }
  const live = new Set<string>()
  if (opts.alive === true) {
    for (const entry of Object.values(registrySeed)) live.add(entry.workspace)
  }
  const deps: StartAllDeps = {
    readInstances: () => registry,
    probe: async entry =>
      live.has(entry.workspace) ? { alive: true } : { alive: false, reason: 'PROCESS_DEAD_ESRCH' },
    start: async options => {
      calls.starts.push(options)
      if (opts.startFailure === 'throws') throw new Error('vectr start exploded: daemon binary missing')
      if (opts.startFailure === 'failed') {
        return { ok: false, error: 'vectr start failed: the daemon refused to come up' }
      }
      if (opts.postStartAlive !== false) live.add(options.workspace)
      const key = createHash('sha256').update(options.workspace).digest('hex').slice(0, WORKSPACE_KEY_LENGTH)
      registry[key] = { workspace: options.workspace, port: 8766, pid: 4242, started_at: Date.now() }
      return { ok: true, port: 8766 }
    },
    discover: () => discovered,
    warn: message => {
      calls.warns.push(message)
    },
    ...(opts.modeLookup !== undefined ? { modeLookup: opts.modeLookup } : {}),
    // Production `recordMode` writes the real store file (buildCodebaseDeps wires
    // `writeMode` + a warn). The fake must be a real file too: with an in-memory
    // array there is no way to assert what a FAILED start left behind in the store.
    recordMode: (workspace, mode) => {
      calls.records.push({ workspace, mode })
      writeMode(modesPath, workspace, mode)
    },
  }
  return { deps, calls }
}

describe('start-all sweep replays the remembered mode after the registry lost it', () => {
  /** A registry record as it looks right after `prune_dead()` + a fresh `vectr start`:
   *  workspace + port present, `mode` gone. This is the exact state that caused the
   *  full re-index; the plugin store is what closes the hole. */
  function prunedRecord(workspace: string, port: number): InstanceEntry {
    return { workspace, port, pid: 4242, started_at: Date.now() }
  }

  it('pruned record (no `mode` field) + memory_only store -> starts it memory_only', async () => {
    const ws = '/home/csy/Work/demo'
    writeMode(modesPath, ws, 'memory_only')
    const { deps, calls } = makeSweepDeps(
      { aaaa: prunedRecord(ws, 8766) },
      [],
      { modeLookup: w => lookupMode(modesPath, w) },
    )

    const res = await startAllDaemons(deps, {})

    expect(res.started).toBe(1)
    expect(calls.starts).toHaveLength(1)
    expect(calls.starts[0]?.workspace).toBe(ws)
    expect(calls.starts[0]?.memoryOnly).toBe(true)
    expect(calls.starts[0]?.searchOnly).toBeUndefined()
  })

  it('pruned record + search_only store -> starts it search_only', async () => {
    const ws = '/home/csy/Work/demo'
    writeMode(modesPath, ws, 'search_only')
    const { deps, calls } = makeSweepDeps(
      { aaaa: prunedRecord(ws, 8766) },
      [],
      { modeLookup: w => lookupMode(modesPath, w) },
    )

    await startAllDaemons(deps, {})

    expect(calls.starts[0]?.searchOnly).toBe(true)
    expect(calls.starts[0]?.memoryOnly).toBe(false)
  })

  it('no store record and no registry mode -> no mode flag requested, and the plain start is remembered as `full`', async () => {
    const ws = '/home/csy/Work/demo'
    const { deps, calls } = makeSweepDeps(
      { aaaa: prunedRecord(ws, 8766) },
      [],
      { modeLookup: w => lookupMode(modesPath, w) },
    )

    await startAllDaemons(deps, {})

    // Nothing asked, nothing known: `vectr start` is called with no mode flag,
    // exactly as before (`memoryOnly: false` is what `modeStartFlags` renders as
    // an empty argv — see the real-argv test below).
    expect(calls.starts[0]?.memoryOnly).toBe(false)
    expect(calls.starts[0]?.searchOnly).toBeUndefined()
    // What the sweep does now is write down the mode it ended up with, so the next
    // boot is not guessing: an empty store is what let a memory-only workspace come
    // back as a full re-index.
    expect(readModes(modesPath)).toEqual({ [ws]: 'full' })
  })

  it('a live registry mode still wins over the store (the store is a fallback, not an override)', async () => {
    const ws = '/home/csy/Work/demo'
    writeMode(modesPath, ws, 'memory_only')
    const { deps, calls } = makeSweepDeps(
      { aaaa: { ...prunedRecord(ws, 8766), mode: 'full' } },
      [],
      { modeLookup: w => lookupMode(modesPath, w) },
    )

    await startAllDaemons(deps, {})

    expect(calls.starts[0]?.memoryOnly).toBe(false)
  })

  it('discovery-only workspace (never in the codebase file) is covered by the store too', async () => {
    // e.g. the bare `/home/csy` session workspace: known to DSH's workspace list,
    // absent from `~/.dsh/vectr-codebases.json` and, after a prune, absent from the
    // registry as well.
    const ws = await mkdtemp(join(dir, 'discovered-'))
    writeMode(modesPath, ws, 'memory_only')
    const { deps, calls } = makeSweepDeps({}, [{ workspace: ws }], {
      modeLookup: w => lookupMode(modesPath, w),
    })

    const res = await startAllDaemons(deps, {})

    expect(res.started).toBe(1)
    expect(calls.starts[0]?.workspace).toBe(resolve(ws))
    expect(calls.starts[0]?.memoryOnly).toBe(true)
  })

  it('an explicit panel choice is written to the REAL store file once the sweep started the workspace', async () => {
    const ws = '/home/csy/Work/demo'
    const { deps, calls } = makeSweepDeps({ aaaa: prunedRecord(ws, 8766) }, [])

    const res = await startAllDaemons(deps, { memoryOnly: true })

    expect(res.started).toBe(1)
    expect(calls.records).toEqual([{ workspace: ws, mode: 'memory_only' }])
    expect(calls.starts[0]?.memoryOnly).toBe(true)
    // The file, not the recording array: this is what a later boot actually reads.
    expect(readModes(modesPath)).toEqual({ [ws]: 'memory_only' })
  })

  it('an explicit memoryOnly:false is recorded as full (an explicit intent, not an assumption)', async () => {
    const ws = '/home/csy/Work/demo'
    writeMode(modesPath, ws, 'memory_only')
    const { deps, calls } = makeSweepDeps({ aaaa: prunedRecord(ws, 8766) }, [], {
      modeLookup: w => lookupMode(modesPath, w),
    })

    const res = await startAllDaemons(deps, { memoryOnly: false })

    expect(res.started).toBe(1)
    expect(calls.records).toEqual([{ workspace: ws, mode: 'full' }])
    expect(calls.starts[0]?.memoryOnly).toBe(false)
    // A successful start DOES correct the store.
    expect(lookupMode(modesPath, ws)).toBe('full')
    // And the override of a remembered mode is stated out loud, not silent.
    expect(calls.warns).toHaveLength(1)
    expect(calls.warns[0]).toContain('explicit full mode overrides the remembered memory_only')
    expect(calls.warns[0]).toContain(ws)
  })

  it('a failed spawn leaves the store byte-for-byte as it was (the D1 counter-example)', async () => {
    const ws = '/home/csy/Work/demo'
    // Store says memory_only; the panel explicitly asks for full; the daemon is down.
    writeMode(modesPath, ws, 'memory_only')
    const { deps, calls } = makeSweepDeps({ aaaa: prunedRecord(ws, 8766) }, [], {
      modeLookup: w => lookupMode(modesPath, w),
      startFailure: 'failed',
    })

    const res = await startAllDaemons(deps, { memoryOnly: false })

    expect(res.failed).toBe(1)
    expect(res.started).toBe(0)
    expect(res.ok).toBe(false)
    expect(calls.records).toEqual([])
    // The old order wrote `full` here BEFORE spawning; the spawn failed, and the
    // next boot read `full` out of the store, emitted no flag, and re-indexed a
    // workspace the user had deliberately put into memory-only mode.
    expect(readModes(modesPath)).toEqual({ [ws]: 'memory_only' })
    expect(readFileSync(modesPath, 'utf-8')).toBe(JSON.stringify({ [ws]: 'memory_only' }, null, 2))
  })

  it('a spawn that throws writes nothing to the store either', async () => {
    const ws = '/home/csy/Work/demo'
    writeMode(modesPath, ws, 'search_only')
    const { deps, calls } = makeSweepDeps({ aaaa: prunedRecord(ws, 8766) }, [], {
      modeLookup: w => lookupMode(modesPath, w),
      startFailure: 'throws',
    })

    const res = await startAllDaemons(deps, { memoryOnly: false })

    expect(res.failed).toBe(1)
    expect(res.results[0]?.error).toContain('daemon binary missing')
    expect(calls.records).toEqual([])
    expect(lookupMode(modesPath, ws)).toBe('search_only')
  })

  it('a start that reports ok but whose daemon never answers the probe is NOT success: no mode remembered', async () => {
    const ws = '/home/csy/Work/demo'
    writeMode(modesPath, ws, 'memory_only')
    const { deps, calls } = makeSweepDeps({ aaaa: prunedRecord(ws, 8766) }, [], {
      modeLookup: w => lookupMode(modesPath, w),
      postStartAlive: false,
    })

    const res = await startAllDaemons(deps, { memoryOnly: false })

    expect(res.started).toBe(0)
    expect(res.failed).toBe(1)
    expect(res.results[0]?.status).toBe('failed')
    expect(res.results[0]?.error).toContain('post-start probe')
    expect(calls.starts[0]?.memoryOnly).toBe(false) // the flag WAS asked for…
    expect(calls.records).toEqual([]) // …but it was never proven on a live daemon
    expect(lookupMode(modesPath, ws)).toBe('memory_only')
  })

  it('nothing is written when the store already says exactly the mode that was applied', async () => {
    const ws = '/home/csy/Work/demo'
    writeMode(modesPath, ws, 'memory_only')
    const before = readFileSync(modesPath, 'utf-8')
    const { deps, calls } = makeSweepDeps({ aaaa: prunedRecord(ws, 8766) }, [], {
      modeLookup: w => lookupMode(modesPath, w),
    })

    const res = await startAllDaemons(deps, {})

    expect(res.started).toBe(1)
    // The sweep replayed the remembered mode; re-writing the same value would be a
    // disk write for no information gained.
    expect(calls.records).toEqual([])
    expect(readFileSync(modesPath, 'utf-8')).toBe(before)
    expect(lookupMode(modesPath, ws)).toBe('memory_only')
  })

  it('an already-running daemon is not spawned and its mode is not recorded', async () => {
    const ws = '/home/csy/Work/demo'
    const { deps, calls } = makeSweepDeps({ aaaa: prunedRecord(ws, 8766) }, [], { alive: true })

    const res = await startAllDaemons(deps, { memoryOnly: true })

    expect(calls.starts).toEqual([])
    expect(calls.records).toEqual([])
    expect(readModes(modesPath)).toEqual({})
    expect(existsSync(modesPath)).toBe(false)
    expect(res.alreadyRunning).toBe(1)
    expect(res.started).toBe(0)
  })

  it('a discovery-only workspace records its mode only after the spawn is proven alive', async () => {
    const ws = await mkdtemp(join(dir, 'discovered-'))
    const { deps, calls } = makeSweepDeps({}, [{ workspace: ws }], {
      modeLookup: w => lookupMode(modesPath, w),
    })

    const res = await startAllDaemons(deps, { memoryOnly: true })

    expect(res.started).toBe(1)
    expect(calls.records).toEqual([{ workspace: resolve(ws), mode: 'memory_only' }])
    expect(lookupMode(modesPath, ws)).toBe('memory_only')
  })

  it('a failed discovery-only spawn leaves the store as it was (same rule, second branch)', async () => {
    const ws = await mkdtemp(join(dir, 'discovered-'))
    writeMode(modesPath, ws, 'memory_only')
    const { deps, calls } = makeSweepDeps({}, [{ workspace: ws }], {
      modeLookup: w => lookupMode(modesPath, w),
      startFailure: 'failed',
    })

    const res = await startAllDaemons(deps, { memoryOnly: false })

    expect(res.failed).toBe(1)
    expect(calls.records).toEqual([])
    expect(readModes(modesPath)).toEqual({ [resolve(ws)]: 'memory_only' })
  })

  it('a discovery-only spawn that reports ok but never answers the probe records nothing', async () => {
    const ws = await mkdtemp(join(dir, 'discovered-'))
    writeMode(modesPath, ws, 'search_only')
    const { deps, calls } = makeSweepDeps({}, [{ workspace: ws }], {
      modeLookup: w => lookupMode(modesPath, w),
      postStartAlive: false,
    })

    const res = await startAllDaemons(deps, { memoryOnly: false })

    expect(res.started).toBe(0)
    expect(res.failed).toBe(1)
    expect(calls.records).toEqual([])
    expect(lookupMode(modesPath, ws)).toBe('search_only')
  })
})

// ---------------------------------------------------------------------------
// N1/N4: the store remembers the mode that was APPLIED, not only the mode the
// request body named — and an explicit downgrade says out loud what it overrode
// ---------------------------------------------------------------------------

describe('start-all sweep remembers the mode it actually applied', () => {
  /**
   * Sweep deps whose `start` is the REAL {@link VectrCliRunner} with a recording
   * `spawnFn`: the assertions read the argv that would have reached `vectr start`,
   * not a fake's opinion about it. The registry and the probe stay fakes — no
   * child process and no socket are created here either.
   */
  function sweepWithRealArgv(registrySeed: InstancesFile): {
    deps: StartAllDeps
    argv: string[][]
    records: Array<{ workspace: string; mode: PersistedMode }>
    warns: string[]
  } {
    const argv: string[][] = []
    const registry: InstancesFile = { ...registrySeed }
    const live = new Set<string>()
    const records: Array<{ workspace: string; mode: PersistedMode }> = []
    const warns: string[] = []
    const spawnFn = (cmd: string, args: string[]): ChildProcess => {
      argv.push(args)
      const child = new EventEmitter() as unknown as ChildProcess
      const stdout = new EventEmitter()
      const stderr = new EventEmitter()
      ;(child as { stdout?: EventEmitter }).stdout = stdout
      ;(child as { stderr?: EventEmitter }).stderr = stderr
      ;(child as { kill?: unknown }).kill = vi.fn()
      setTimeout(() => {
        stdout.emit('data', Buffer.from(JSON.stringify({ status: 'ready', port: 8766 })))
        child.emit('close', 0, null)
      }, 5)
      return child
    }
    const runner = new VectrCliRunner({ cliPath: 'vectr', spawnFn: spawnFn as never })
    const deps: StartAllDeps = {
      readInstances: () => registry,
      probe: async entry => (live.has(entry.workspace) ? { alive: true } : { alive: false, reason: 'PROCESS_DEAD_ESRCH' }),
      start: async options => {
        const res = await runner.start(options)
        if (res.ok) {
          live.add(options.workspace)
          const key = createHash('sha256').update(options.workspace).digest('hex').slice(0, WORKSPACE_KEY_LENGTH)
          registry[key] = { workspace: options.workspace, port: 8766, pid: 4242, started_at: Date.now() }
        }
        return res
      },
      discover: () => [],
      warn: message => { warns.push(message) },
      modeLookup: workspace => lookupMode(modesPath, workspace),
      recordMode: (workspace, mode) => {
        records.push({ workspace, mode })
        writeMode(modesPath, workspace, mode)
      },
    }
    return { deps, argv, records, warns }
  }

  /** A live registry record that still carries its runtime `mode` (the daemon wrote it). */
  function recordWithMode(workspace: string, port: number, mode: string): InstanceEntry {
    return { workspace, port, pid: 4242, started_at: Date.now(), mode }
  }

  /** The same record as it looks after `prune_dead()` + a plain `vectr start`: `mode` is gone. */
  function pruned(workspace: string, port: number): InstanceEntry {
    return { workspace, port, pid: 4242, started_at: Date.now() }
  }

  it('a mode only the registry knew (empty store, no request body) lands in the store once the daemon is proven up', async () => {
    const ws = '/home/csy/Work/demo'
    const { deps, argv, records } = sweepWithRealArgv({ aaaa: recordWithMode(ws, 8766, 'memory-only') })

    const res = await startAllDaemons(deps, {})

    expect(res.started).toBe(1)
    expect(argv[0]).toEqual(['start', '--path', ws, '--memory-only'])
    expect(records).toEqual([{ workspace: ws, mode: 'memory_only' }])
    // The store is a real file, so this is what the next boot would read.
    expect(lookupMode(modesPath, ws)).toBe('memory_only')
  })

  it('that remembered mode is what the next boot replays after the registry record was pruned', async () => {
    const ws = '/home/csy/Work/demo'
    // Boot 1: the plugin learns `memory_only` from the registry and remembers it.
    const first = sweepWithRealArgv({ aaaa: recordWithMode(ws, 8766, 'memory-only') })
    await startAllDaemons(first.deps, {})
    expect(lookupMode(modesPath, ws)).toBe('memory_only')

    // The host restart kills the daemon; `prune_dead()` erases the record's mode.
    // Boot 2 asks for nothing and the registry says nothing: only the store knows.
    const second = sweepWithRealArgv({ aaaa: pruned(ws, 8766) })
    const res = await startAllDaemons(second.deps, {})

    expect(res.started).toBe(1)
    expect(second.argv[0]).toEqual(['start', '--path', ws, '--memory-only'])
  })

  it('with no record anywhere the store says `full` — and `full` still emits no flag in the real argv', async () => {
    const ws = resolve(dir)
    const { deps, argv, records } = sweepWithRealArgv({ aaaa: pruned(ws, 8766) })

    const res = await startAllDaemons(deps, {})

    expect(res.started).toBe(1)
    // Recording the real state is not the same as asking for a rebuild: `full` is
    // stored, and `vectr start` is still called with no mode flag at all.
    expect(readModes(modesPath)).toEqual({ [ws]: 'full' })
    expect(records).toEqual([{ workspace: ws, mode: 'full' }])
    expect(argv).toHaveLength(1)
    expect(argv[0]).toEqual(['start', '--path', ws])
    expect(argv[0]).not.toContain('--memory-only')
    expect(argv[0]).not.toContain('--search-only')
    expect(argv[0]).not.toContain('--full')
  })

  it('a registry-sourced mode is NOT remembered when the spawn failed', async () => {
    const ws = '/home/csy/Work/demo'
    const { deps, calls } = makeSweepDeps(
      { aaaa: recordWithMode(ws, 8766, 'memory-only') },
      [],
      { modeLookup: w => lookupMode(modesPath, w), startFailure: 'failed' },
    )

    const res = await startAllDaemons(deps, {})

    expect(res.failed).toBe(1)
    expect(calls.records).toEqual([])
    expect(existsSync(modesPath)).toBe(false)
  })

  it('a registry-sourced mode is NOT remembered when the daemon never answers the post-start probe', async () => {
    const ws = '/home/csy/Work/demo'
    const { deps, calls } = makeSweepDeps(
      { aaaa: recordWithMode(ws, 8766, 'search_only') },
      [],
      { modeLookup: w => lookupMode(modesPath, w), postStartAlive: false },
    )

    const res = await startAllDaemons(deps, {})

    expect(res.failed).toBe(1)
    expect(calls.records).toEqual([])
    expect(existsSync(modesPath)).toBe(false)
  })

  it('an already-running daemon writes nothing, even when the registry names a mode', async () => {
    const ws = '/home/csy/Work/demo'
    const { deps, calls } = makeSweepDeps(
      { aaaa: recordWithMode(ws, 8766, 'memory-only') },
      [],
      { modeLookup: w => lookupMode(modesPath, w), alive: true },
    )

    const res = await startAllDaemons(deps, {})

    expect(res.alreadyRunning).toBe(1)
    expect(calls.records).toEqual([])
    expect(existsSync(modesPath)).toBe(false)
  })

  it('no disk write when the store already says exactly what was applied', async () => {
    const ws = '/home/csy/Work/demo'
    writeMode(modesPath, ws, 'memory_only')
    const before = readFileSync(modesPath, 'utf-8')
    const { deps, calls } = makeSweepDeps(
      { aaaa: recordWithMode(ws, 8766, 'memory-only') },
      [],
      { modeLookup: w => lookupMode(modesPath, w) },
    )

    const res = await startAllDaemons(deps, {})

    expect(res.started).toBe(1)
    expect(calls.records).toEqual([])
    expect(readFileSync(modesPath, 'utf-8')).toBe(before)
  })

  it('an explicit downgrade of a registry-only memory_only warns with the source named', async () => {
    const ws = '/home/csy/Work/demo'
    const { deps, argv, records, warns } = sweepWithRealArgv({ aaaa: recordWithMode(ws, 8766, 'memory-only') })

    const res = await startAllDaemons(deps, { memoryOnly: false })

    // The explicit request still wins — that precedence is unchanged.
    expect(res.started).toBe(1)
    expect(argv[0]).toEqual(['start', '--path', ws])
    expect(records).toEqual([{ workspace: ws, mode: 'full' }])
    expect(lookupMode(modesPath, ws)).toBe('full')
    // …but silently rebuilding a memory-only workspace as full is what the warn exists for.
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('overrides the daemon registry\'s memory_only mode')
    expect(warns[0]).toContain(ws)
    expect(warns[0]).toContain('mode store has no record')
  })

  it('an explicit upgrade of a registry-only search_only warns too, and the store records the new mode', async () => {
    const ws = '/home/csy/Work/demo'
    const { deps, calls } = makeSweepDeps(
      { aaaa: recordWithMode(ws, 8766, 'search_only') },
      [],
      { modeLookup: w => lookupMode(modesPath, w) },
    )

    const res = await startAllDaemons(deps, { memoryOnly: true })

    expect(res.started).toBe(1)
    expect(calls.starts[0]?.memoryOnly).toBe(true)
    expect(calls.records).toEqual([{ workspace: ws, mode: 'memory_only' }])
    expect(calls.warns).toHaveLength(1)
    expect(calls.warns[0]).toContain('overrides the daemon registry\'s search_only mode')
  })

  it('no warn when the explicit choice agrees with the registry (nothing was overridden)', async () => {
    const ws = '/home/csy/Work/demo'
    writeMode(modesPath, ws, 'full')
    const { deps, calls } = makeSweepDeps(
      { aaaa: recordWithMode(ws, 8766, 'memory-only') },
      [],
      { modeLookup: w => lookupMode(modesPath, w) },
    )

    const res = await startAllDaemons(deps, { memoryOnly: true })

    expect(res.started).toBe(1)
    // A stale `full` in the store is corrected against the live registry…
    expect(calls.records).toEqual([{ workspace: ws, mode: 'memory_only' }])
    expect(lookupMode(modesPath, ws)).toBe('memory_only')
    // …and that correction is not a downgrade of the user's choice, so it is silent.
    expect(calls.warns).toEqual([])
  })

  it('the store wording is kept for a remembered mode and the registry wording for a registry-only one', async () => {
    const ws = '/home/csy/Work/demo'
    writeMode(modesPath, ws, 'memory_only')
    const fromStore = makeSweepDeps({ aaaa: pruned(ws, 8766) }, [], {
      modeLookup: w => lookupMode(modesPath, w),
    })

    await startAllDaemons(fromStore.deps, { memoryOnly: false })

    expect(fromStore.calls.warns).toHaveLength(1)
    expect(fromStore.calls.warns[0]).toContain('overrides the remembered memory_only mode')

    const fromRegistry = sweepWithRealArgv({ aaaa: recordWithMode(ws, 8766, 'memory-only') })
    await startAllDaemons(fromRegistry.deps, { memoryOnly: false })

    expect(fromRegistry.warns).toHaveLength(1)
    expect(fromRegistry.warns[0]).toContain('overrides the daemon registry\'s memory_only mode')
  })
})

// ---------------------------------------------------------------------------
// CLI runner: `--search-only` really reaches argv, and the two flags are exclusive
// ---------------------------------------------------------------------------

describe('VectrCliRunner.start mode flags', () => {
  function fakeRunner() {
    const seen: { cmd: string; args: string[] }[] = []
    const spawnFn = (cmd: string, args: string[]): ChildProcess => {
      seen.push({ cmd, args })
      const child = new EventEmitter() as unknown as ChildProcess
      const stdout = new EventEmitter()
      const stderr = new EventEmitter()
      ;(child as { stdout?: EventEmitter }).stdout = stdout
      ;(child as { stderr?: EventEmitter }).stderr = stderr
      ;(child as { kill?: unknown }).kill = vi.fn()
      setTimeout(() => {
        stdout.emit('data', Buffer.from(JSON.stringify({ status: 'ready', port: 8766 })))
        child.emit('close', 0, null)
      }, 5)
      return child
    }
    return { runner: new VectrCliRunner({ cliPath: 'vectr', spawnFn: spawnFn as never }), seen }
  }

  it('searchOnly emits --search-only and no --memory-only', async () => {
    const { runner, seen } = fakeRunner()

    const res = await runner.start({ workspace: resolve(dir), searchOnly: true })

    expect(res.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.args).toContain('start')
    expect(seen[0]?.args).toContain('--search-only')
    expect(seen[0]?.args).not.toContain('--memory-only')
  })

  it('memoryOnly still emits --memory-only', async () => {
    const { runner, seen } = fakeRunner()

    await runner.start({ workspace: resolve(dir), memoryOnly: true })

    expect(seen[0]?.args).toContain('--memory-only')
    expect(seen[0]?.args).not.toContain('--search-only')
  })

  it('refuses both flags at once rather than shipping a contradictory argv', async () => {
    const { runner, seen } = fakeRunner()

    const res = await runner.start({ workspace: resolve(dir), memoryOnly: true, searchOnly: true })

    expect(res.ok).toBe(false)
    expect(res.error).toContain('mutually exclusive')
    expect(seen).toEqual([])
  })

  it('no mode requested -> no mode flag', async () => {
    const { runner, seen } = fakeRunner()

    await runner.start({ workspace: resolve(dir) })

    expect(seen[0]?.args).not.toContain('--memory-only')
    expect(seen[0]?.args).not.toContain('--search-only')
    expect(seen[0]?.args).not.toContain('--full')
  })
})

// ---------------------------------------------------------------------------
// Mode writes: verified transitions only
// ---------------------------------------------------------------------------

interface ServiceFakes {
  service: SessionVectrService
  init: ReturnType<typeof vi.fn>
  restart: ReturnType<typeof vi.fn>
}

function makeService(
  workspace: string,
  daemonMode: string,
  opts: { modesPath?: string; initOk?: boolean; restartOk?: boolean; warn?: (message: string) => void },
): ServiceFakes {
  const instance: InstanceEntry = { workspace, port: 8766, mode: daemonMode }
  const instanceResolver: IInstanceResolver = {
    resolveForWorkspace: vi.fn(async () => instance),
    getAll: vi.fn(async () => ({ aaaa: instance })),
  }
  const apiClient: IVectrApiClient = {
    getStatus: vi.fn(async () => ({ mode: daemonMode, fully_ready: true })),
    triggerIndex: vi.fn(async () => ({ ok: true })),
    recall: vi.fn(async () => ({ ok: true })),
    resume: vi.fn(async () => ({ ok: true })),
  }
  const codebaseService: ICodebaseService = { listForWorkspace: vi.fn(async () => []) }
  const init = vi.fn(async () =>
    opts.initOk === false ? { ok: false, error: 'init failed' } : { ok: true },
  )
  const restart = vi.fn(async () =>
    opts.restartOk === false ? { ok: false, error: 'restart failed' } : { ok: true },
  )
  const cliRunner: IVectrCliRunner = { init, restart, start: vi.fn(async () => ({ ok: true })) }
  const service = new SessionVectrService({
    instanceResolver,
    apiClient,
    codebaseService,
    cliRunner,
    // Short probe budget: the "not verified" cases must fail fast, not hang.
    upgradeTimeoutMs: 300,
    ...(opts.modesPath !== undefined ? { modesPath: opts.modesPath } : {}),
    ...(opts.warn !== undefined ? { warn: opts.warn } : {}),
  })
  return { service, init, restart }
}

describe('mode store writes only on a verified mode change', () => {
  it('verified downgrade -> memory_only is remembered (this is what survives the next prune)', async () => {
    const ws = await mkdtemp(join(dir, 'ws-'))
    const { service } = makeService(ws, 'memory_only', { modesPath })

    const res = await service.downgradeWorkspace(ws)

    expect(res.ok).toBe(true)
    expect(lookupMode(modesPath, ws)).toBe('memory_only')
  })

  it('verified upgrade -> full is remembered', async () => {
    const ws = await mkdtemp(join(dir, 'ws-'))
    writeMode(modesPath, ws, 'memory_only')
    const { service } = makeService(ws, 'full', { modesPath })

    const res = await service.upgradeWorkspace(ws)

    expect(res.ok).toBe(true)
    expect(lookupMode(modesPath, ws)).toBe('full')
  })

  it('downgrade that the daemon did NOT confirm writes nothing', async () => {
    const ws = await mkdtemp(join(dir, 'ws-'))
    // restart "succeeded" but the daemon is still answering as full.
    const { service } = makeService(ws, 'full', { modesPath })

    const res = await service.downgradeWorkspace(ws)

    expect(res.ok).toBe(false)
    expect(readModes(modesPath)).toEqual({})
    expect(existsSync(modesPath)).toBe(false)
  })

  it('upgrade that left the daemon in memory_only does not overwrite the remembered mode', async () => {
    const ws = await mkdtemp(join(dir, 'ws-'))
    writeMode(modesPath, ws, 'memory_only')
    const { service } = makeService(ws, 'memory_only', { modesPath })

    const res = await service.upgradeWorkspace(ws)

    expect(res.ok).toBe(false)
    expect(lookupMode(modesPath, ws)).toBe('memory_only')
  })

  it('a failed restart writes nothing in either direction', async () => {
    const ws = await mkdtemp(join(dir, 'ws-'))
    const down = makeService(ws, 'memory_only', { modesPath, restartOk: false })
    expect((await down.service.downgradeWorkspace(ws)).ok).toBe(false)

    const up = makeService(ws, 'full', { modesPath, initOk: false })
    expect((await up.service.upgradeWorkspace(ws)).ok).toBe(false)

    expect(existsSync(modesPath)).toBe(false)
  })

  it('a service built without modesPath touches no store at all (no hidden global write)', async () => {
    const ws = await mkdtemp(join(dir, 'ws-'))
    const { service } = makeService(ws, 'memory_only', {})

    const res = await service.downgradeWorkspace(ws)

    expect(res.ok).toBe(true)
    expect(readModes(modesPath)).toEqual({})
    expect(existsSync(modesPath)).toBe(false)
  })

  it('the recorded key is the resolved workspace path the start paths look up', async () => {
    const ws = await mkdtemp(join(dir, 'ws-'))
    const { service } = makeService(ws, 'memory_only', { modesPath })

    await service.downgradeWorkspace(ws)

    const stored = readModes(modesPath)
    expect(Object.keys(stored)).toEqual([resolve(ws)])
    // A trailing-slash variant of the same directory finds the same record.
    expect(lookupMode(modesPath, `${resolve(ws)}/`)).toBe('memory_only')
  })
})

describe('mode-store write failures are reported, never swallowed', () => {
  it('a verified downgrade whose store write fails still succeeds, and the failure is warned with the path', async () => {
    const ws = await mkdtemp(join(dir, 'ws-'))
    // A directory cannot be replaced by a file: writeMode's atomic rename fails.
    const blocked = join(dir, 'blocked-store')
    mkdirSync(blocked)
    const warnings: string[] = []
    const { service } = makeService(ws, 'memory_only', {
      modesPath: blocked,
      warn: message => warnings.push(message),
    })

    const res = await service.downgradeWorkspace(ws)

    // The daemon really did come back memory_only: the operation itself succeeded.
    expect(res.ok).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('could not remember the verified memory_only mode')
    expect(warnings[0]).toContain(ws)
    expect(warnings[0]).toContain(blocked)
    expect(statSync(blocked).isDirectory()).toBe(true)
  })

  it('with no logger injected the same failure goes to console.warn, not into a void', async () => {
    const ws = await mkdtemp(join(dir, 'ws-'))
    const blocked = join(dir, 'blocked-store')
    mkdirSync(blocked)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { service } = makeService(ws, 'memory_only', { modesPath: blocked })
      expect((await service.downgradeWorkspace(ws)).ok).toBe(true)
      expect(consoleWarn).toHaveBeenCalledTimes(1)
      expect(String(consoleWarn.mock.calls[0]?.[0])).toContain(blocked)
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('control: a store write that worked produces no warning at all', async () => {
    const ws = await mkdtemp(join(dir, 'ws-'))
    const warnings: string[] = []
    const { service } = makeService(ws, 'memory_only', {
      modesPath,
      warn: message => warnings.push(message),
    })

    expect((await service.downgradeWorkspace(ws)).ok).toBe(true)
    expect(warnings).toEqual([])
    expect(lookupMode(modesPath, ws)).toBe('memory_only')
  })
})

describe('boot harvest diagnostics: disagreements and failed writes reach the log', () => {
  function fakeLog(): {
    info: string[]
    warn: string[]
    log: { info: (message: string) => void; warn: (message: string) => void }
  } {
    const info: string[] = []
    const warn: string[] = []
    return {
      info,
      warn,
      log: {
        info: (message: string) => {
          info.push(message)
        },
        warn: (message: string) => {
          warn.push(message)
        },
      },
    }
  }

  it('a registry/store disagreement is a warn naming both sides, the workspace and the store path', () => {
    const { info, warn, log } = fakeLog()
    reportModeHarvest(log, '/tmp/store/vectr-modes.json', {
      added: [],
      conflicts: [{ workspace: '/home/csy/Work/demo', stored: 'full', incoming: 'memory_only' }],
      writeFailed: false,
    })

    expect(warn).toHaveLength(1)
    expect(warn[0]).toContain('/home/csy/Work/demo')
    expect(warn[0]).toContain('registry says memory_only')
    expect(warn[0]).toContain('store says full')
    expect(warn[0]).toContain('keeping full')
    expect(warn[0]).toContain('/tmp/store/vectr-modes.json')
    expect(info).toEqual([])
  })

  it('a harvest that agreed with the store logs nothing at all (the warn is not unconditional)', () => {
    const { info, warn, log } = fakeLog()
    reportModeHarvest(log, '/tmp/store/vectr-modes.json', { added: [], conflicts: [], writeFailed: false })
    expect(warn).toEqual([])
    expect(info).toEqual([])
  })

  it('a failed write is a warn that says nothing was persisted — never an info about success', () => {
    const { info, warn, log } = fakeLog()
    reportModeHarvest(log, '/tmp/store/vectr-modes.json', {
      added: ['/home/csy/Work/a', '/home/csy/Work/b'],
      conflicts: [],
      writeFailed: true,
    })

    expect(warn).toHaveLength(1)
    expect(warn[0]).toContain('write FAILED')
    expect(warn[0]).toContain('/tmp/store/vectr-modes.json')
    expect(warn[0]).toContain('2 harvested')
    expect(info).toEqual([])
  })

  it('conflicts are still reported when the write itself also failed', () => {
    const { warn, log } = fakeLog()
    reportModeHarvest(log, '/tmp/store/vectr-modes.json', {
      added: ['/home/csy/Work/new'],
      conflicts: [{ workspace: '/home/csy/Work/old', stored: 'full', incoming: 'search_only' }],
      writeFailed: true,
    })
    expect(warn).toHaveLength(2)
    expect(warn[0]).toContain('store says full')
    expect(warn[1]).toContain('write FAILED')
  })

  it('a clean harvest is one info naming the store path (what a normal boot logs)', () => {
    const { info, warn, log } = fakeLog()
    reportModeHarvest(log, '/tmp/store/vectr-modes.json', {
      added: ['/home/csy/Work/a', '/home/csy/Work/b'],
      conflicts: [],
      writeFailed: false,
    })
    expect(warn).toEqual([])
    expect(info).toHaveLength(1)
    expect(info[0]).toContain('2 workspace mode(s)')
    expect(info[0]).toContain('/tmp/store/vectr-modes.json')
  })
})

describe('production wiring: buildStartAllDeps uses the configured store path', () => {
  it('recordMode writes to config.modesPath, and the resolved default is ~/.dsh/vectr-modes.json', async () => {
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as Parameters<typeof buildStartAllDeps>[0]
    const config = ConfigSchema({ modesPath } as never) as Required<Config>

    const deps = buildStartAllDeps(ctx, join(dir, 'instances.json'), config)
    deps.recordMode?.('/home/csy/Work/demo', 'memory_only')

    expect(lookupMode(modesPath, '/home/csy/Work/demo')).toBe('memory_only')
    // The default is the documented dotfile, so an unconfigured boot still remembers.
    expect(ConfigSchema({} as never).modesPath).toBe(DEFAULT_MODES_FILE)
  })
})

describe('store content after a verified transition is plain JSON a human can audit', () => {
  it('is a flat workspace -> mode map', async () => {
    const ws = await mkdtemp(join(dir, 'ws-'))
    const { service } = makeService(ws, 'memory_only', { modesPath })
    await service.downgradeWorkspace(ws)

    const parsed = JSON.parse(readFileSync(modesPath, 'utf-8')) as Record<string, string>
    expect(parsed[resolve(ws)]).toBe('memory_only')
    expect(Object.keys(parsed)).toHaveLength(1)
  })
})
