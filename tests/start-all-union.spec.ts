/**
 * T4-union — `startAllDaemons` must sweep the UNION of the daemon registry
 * (`readInstances`) and host discovery (`discover`), deduped by directory, and
 * must never let a discovery problem sink the whole sweep.
 *
 * Contract under test:
 *   startAllDaemons(deps: { readInstances, probe, start, discover }, body)
 *   discover(): DiscoveredWorkspace[]           (at least `workspace`)
 *   results[]: { workspace, port: number|null, status, error? }
 *
 * No fs mocking: every workspace path here is a real directory under
 * `mkdtempSync(os.tmpdir())`. The seams are hand-written fakes whose behaviour
 * is real: a probe answers only on a port a live daemon actually holds, and a
 * `start()` records its options and leaves behind a registry record with the
 * port its daemon bound.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { startAllDaemons, type StartAllResponse } from '../src/index.ts'
import type { DiscoveredWorkspace } from '../src/workspaces.ts'
import type { AliveDiagnosis } from '../src/probe.ts'
import type { InstanceEntry, StartResult, VectrStartOptions } from '../src/domain/index.ts'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** Real directory under the temp root; discovery would report it verbatim. */
let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'vectr-start-all-union-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function realWorkspace(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Registry record with the fields the sweep reads. */
function entry(port: number, workspace: string): InstanceEntry {
  return { workspace, port }
}

/** `instances.json` shape: key order carries no meaning, values do. */
function registryOf(entries: InstanceEntry[]): Record<string, InstanceEntry> {
  const out: Record<string, InstanceEntry> = {}
  entries.forEach((e, i) => { out[`sha256-${i}`] = e })
  return out
}

/** The seam set the sweep is called with: registry, probe, spawn, discovery. */
interface UnionStartAllDeps {
  readInstances: () => Record<string, InstanceEntry> | undefined
  probe: (entry: InstanceEntry) => Promise<AliveDiagnosis>
  start: (options: VectrStartOptions) => Promise<StartResult>
  discover: () => DiscoveredWorkspace[]
}

interface Fake {
  deps: UnionStartAllDeps
  /** Options every `start()` call received, in call order. */
  starts: VectrStartOptions[]
  /** Records every `probe()` call received, in call order. */
  probes: InstanceEntry[]
  /** Live call counters; read them after the sweep, not at destructure time. */
  calls: { discover: number }
}

function fakeDeps(
  discover: () => DiscoveredWorkspace[],
  opts: {
    registry?: Record<string, InstanceEntry>
    /** Ports that already answer a probe before the sweep begins. */
    livePorts?: number[]
    probe?: (entry: InstanceEntry) => AliveDiagnosis
    /** `spawn(workspace, port)` records the daemon this spawn leaves running. */
    start?: (options: VectrStartOptions, spawn: (workspace: string, port: number) => void) => StartResult | Promise<StartResult>
  } = {},
): Fake {
  const registry = { ...(opts.registry ?? {}) }
  const livePorts = new Set(opts.livePorts ?? [])
  const liveWorkspaces = new Set<string>()
  const starts: VectrStartOptions[] = []
  const probes: InstanceEntry[] = []
  let nextPort = 6500
  const calls = { discover: 0 }

  const spawnDaemon = (workspace: string, port: number): void => {
    livePorts.add(port)
    liveWorkspaces.add(workspace)
    registry[workspace] = { workspace, port, pid: 4200 + livePorts.size }
  }

  const deps: UnionStartAllDeps = {
    readInstances: () => registry,
    probe: async (e) => {
      probes.push(e)
      if (opts.probe !== undefined) return opts.probe(e)
      // A daemon answers on the port it bound: a pre-seeded live port, or the
      // port the spawn this fake accepted left in the registry.
      const live = (e.port !== undefined && livePorts.has(e.port)) || liveWorkspaces.has(e.workspace)
      return live ? { alive: true } : { alive: false, reason: 'PORT_CLOSED' }
    },
    start: async (o) => {
      starts.push(o)
      if (opts.start !== undefined) return opts.start(o, spawnDaemon)
      const port = nextPort
      nextPort += 1
      spawnDaemon(o.workspace, port)
      return { ok: true, port }
    },
    discover: () => {
      calls.discover += 1
      return discover()
    },
  }

  return { deps, starts, probes, calls }
}

function byWorkspace(result: StartAllResponse): Map<string, StartAllResponse['results'][number]> {
  return new Map(result.results.map(r => [resolve(r.workspace), r]))
}

describe('startAllDaemons union of registry and discovery', () => {
  it('unions a discovered unregistered directory with the registry: one spawn, for the unregistered one only', async () => {
    const registered = realWorkspace('registered')
    const unregistered = realWorkspace('unregistered')
    const { deps, starts } = fakeDeps(() => [{ workspace: unregistered }], {
      registry: registryOf([entry(6011, registered)]),
      livePorts: [6011],
    })

    const result = await startAllDaemons(deps, {})

    // The alive registry row is described, not re-spawned; the discovered
    // directory is the only thing that costs a spawn.
    expect(starts.map(s => s.workspace)).toEqual([unregistered])
    expect(result.results.length).toBe(2)
    expect(byWorkspace(result).get(registered)?.status).toBe('already-running')
    expect(byWorkspace(result).get(registered)?.port).toBe(6011)
    expect(byWorkspace(result).get(unregistered)?.status).toBe('started')
    expect(result.started).toBe(1)
    expect(result.alreadyRunning).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.ok).toBe(true)
  })

  it('does not list or spawn a discovered directory the registry already covers under another spelling', async () => {
    const dir = realWorkspace('same-dir')
    const { deps, starts, calls } = fakeDeps(
      () => [{ workspace: `${dir}/` }, { workspace: join(root, '.', 'same-dir') }],
      { registry: registryOf([entry(6012, dir)]), livePorts: [6012] },
    )

    const result = await startAllDaemons(deps, {})

    // Without this the row count passes vacuously when discovery is ignored.
    expect(calls.discover).toBeGreaterThan(0)
    // A second row for the same directory would race the first over the port.
    expect(starts).toHaveLength(0)
    expect(result.results.length).toBe(1)
    expect(new Set(result.results.map(r => resolve(r.workspace))).size).toBe(1)
    expect(result.results[0]?.workspace).toBe(dir)
    expect(result.results[0]?.status).toBe('already-running')
    expect(result.alreadyRunning).toBe(1)
    expect(result.started).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.ok).toBe(true)
  })

  it('reports a discovered absolute path with no directory on disk as failed, with the missing-directory reason, and never spawns it', async () => {
    const missing = join(root, 'never-created')
    expect(existsSync(missing)).toBe(false)

    const { deps, starts } = fakeDeps(() => [{ workspace: missing }])
    const result = await startAllDaemons(deps, {})

    expect(starts).toHaveLength(0)
    expect(result.results.length).toBe(1)
    expect(result.results[0]?.workspace).toBe(missing)
    expect(result.results[0]?.status).toBe('failed')
    expect(result.results[0]?.port).toBeNull()
    expect(result.results[0]?.error).toContain('no such workspace directory')
    expect(result.failed).toBe(1)
    expect(result.started).toBe(0)
    expect(result.ok).toBe(false)
  })

  it('degrades a throwing discover() to an empty set instead of rejecting the sweep or losing registry rows', async () => {
    const dir = realWorkspace('registry-only')
    const reason = 'storages/workspace.json unreadable: EACCES'
    const { deps, starts, calls } = fakeDeps(() => {
      throw new Error(reason)
    }, { registry: registryOf([entry(6013, dir)]) })

    const result = await startAllDaemons(deps, {})

    expect(calls.discover).toBeGreaterThan(0)
    expect(result.results.length).toBe(1)
    expect(result.results[0]?.workspace).toBe(dir)
    expect(result.results[0]?.status).toBe('started')
    expect(starts.map(s => s.workspace)).toEqual([dir])
    expect(result.started).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.ok).toBe(true)
  })

  it('keeps at most one spawn in flight across registry rows and discovered directories together', async () => {
    const regA = realWorkspace('seq-reg-a')
    const regB = realWorkspace('seq-reg-b')
    const discA = realWorkspace('seq-disc-a')
    const discB = realWorkspace('seq-disc-b')

    let depth = 0
    let maxDepth = 0
    const { deps, starts } = fakeDeps(() => [{ workspace: discA }, { workspace: discB }], {
      registry: registryOf([entry(6014, regA), entry(6015, regB)]),
      start: async (o, spawn) => {
        depth += 1
        maxDepth = Math.max(maxDepth, depth)
        await sleep(15)
        spawn(o.workspace, 6016 + starts.length)
        depth -= 1
        return { ok: true }
      },
    })

    const result = await startAllDaemons(deps, {})

    // Concurrent `vectr start` runs race on free-port discovery and on
    // instances.json, so no two may overlap.
    expect(maxDepth).toBe(1)
    expect(starts).toHaveLength(4)
    expect(result.results.length).toBe(4)
    expect(new Set(result.results.map(r => resolve(r.workspace))).size).toBe(4)
    expect(result.started).toBe(4)
    expect(result.failed).toBe(0)
    expect(result.ok).toBe(true)
  })

  it('reports a spawn that never answers the post-start probe as failed with the real probe reason, not as started', async () => {
    const dir = realWorkspace('spawn-silent')
    const port = 6017
    const reason = 'HTTP_PROBE_TIMEOUT: GET /health after 5000ms'
    const { deps, starts } = fakeDeps(() => [], {
      registry: registryOf([entry(port, dir)]),
      probe: () => ({ alive: false, reason }),
      // `vectr start` returned ok and then the daemon never bound: no live port
      // and no registry record are left behind.
      start: () => ({ ok: true }),
    })

    const result = await startAllDaemons(deps, {})

    expect(starts).toHaveLength(1)
    expect(result.results.length).toBe(1)
    expect(result.results[0]?.status).toBe('failed')
    expect(result.results[0]?.port).toBe(port)
    expect(result.results[0]?.error).toContain(reason)
    expect(result.started).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.ok).toBe(false)
  })
})
