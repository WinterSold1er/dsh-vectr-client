/**
 * T4 — one-click start-all: `POST /api/vectr/daemons/start-all` and the
 * `DaemonLauncher` client component.
 *
 * Everything here runs against the REAL route handler (registered by
 * `registerManagementRoutes` on a fake webServer) and the REAL
 * `startAllDaemons` sweep, with the registry/probe/spawn seams injected. No
 * socket, no child process, no `NODE_ENV` branch anywhere.
 */
import { describe, expect, it } from 'vitest'
import * as React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  Config as ConfigSchema,
  registerManagementRoutes,
  startAllDaemons,
  type Config,
  type StartAllDeps,
  type StartAllResponse,
} from '../src/index.ts'
import { DaemonLauncher, DaemonLauncherView } from '../src/client/DaemonLauncher.tsx'
import type { AliveDiagnosis } from '../src/probe.ts'
import type { InstanceEntry, StartResult, VectrStartOptions } from '../src/domain/index.ts'
import { renderToHtml } from './react-render.ts'

/** Fully-materialized config (the schema fills every default), deps are injected anyway. */
const CONFIG = ConfigSchema({} as never) as Required<Config>

const sleep = (ms: number): Promise<void> => new Promise(resolveTimer => setTimeout(resolveTimer, ms))

/** Registry record with the fields this route reads. */
function entry(port: number, workspace: string, mode?: string): InstanceEntry {
  return { workspace, port, ...(mode === undefined ? {} : { mode }) }
}

/** `instances.json` shape: hash-keyed records (the key itself is not read here). */
function instances(entries: InstanceEntry[]): Record<string, InstanceEntry> {
  const out: Record<string, InstanceEntry> = {}
  entries.forEach((e, i) => { out[`sha256-${i}`] = e })
  return out
}

interface Recorded {
  deps: StartAllDeps
  /** Options every `start()` call received, in call order. */
  starts: VectrStartOptions[]
  /** Workspaces every `probe()` call received, in call order. */
  probes: string[]
}

/** Fake registry/probe/spawn seams; only what a test overrides is behaviourally different. */
function fakeDeps(
  readInstances: () => Record<string, InstanceEntry> | undefined,
  overrides: {
    probe?: (e: InstanceEntry) => AliveDiagnosis | Promise<AliveDiagnosis>
    start?: (o: VectrStartOptions) => StartResult | Promise<StartResult>
  } = {},
): Recorded {
  const starts: VectrStartOptions[] = []
  const probes: string[] = []
  return {
    starts,
    probes,
    deps: {
      readInstances,
      probe: async (e) => {
        probes.push(e.workspace)
        return overrides.probe === undefined ? { alive: false, reason: 'PORT_CLOSED' } : await overrides.probe(e)
      },
      start: async (o) => {
        starts.push(o)
        return overrides.start === undefined ? { ok: true } : await overrides.start(o)
      },
    },
  }
}

interface Route {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => Promise<void>
}

/** Register the real management routes on a fake webServer and return the start-all handler. */
function captureRoute(deps: StartAllDeps): Route['handler'] {
  const routes: Route[] = []
  const webServer = {
    register: (def: Route) => {
      routes.push(def)
      return () => {}
    },
  }
  const ctx = {
    get: (key: string) => (key === 'webServer' ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as Context
  registerManagementRoutes(ctx, CONFIG.instancesPath, CONFIG, deps)
  const route = routes.find(r => r.path === '/api/vectr/daemons/start-all')
  if (route === undefined) throw new Error('POST /api/vectr/daemons/start-all was not registered')
  return route.handler
}

/** Request whose async iteration yields the raw body bytes (drives the real readJsonBody). */
function jsonReq(payload: string, method = 'POST'): unknown {
  return {
    method,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload)
    },
  }
}

/** Response capturing what `sendJson` wrote. */
function captureRes(): { state: { code: number; body: string }; res: unknown } {
  const state = { code: 0, body: '' }
  return {
    state,
    res: {
      writeHead: (code: number) => { state.code = code },
      end: (body: string) => { state.body = body },
    },
  }
}

describe('POST /api/vectr/daemons/start-all', () => {
  it('mixed registry: probes live, spawns dead, reports a throwing spawn with its real error', async () => {
    const registry = instances([
      entry(5101, '/ws/live', 'full'),
      entry(5102, '/ws/dead-a'),
      entry(5103, '/ws/dead-b'),
      entry(5104, '/ws/boom'),
    ])
    const alive = new Set(['/ws/live'])
    const { deps, starts, probes } = fakeDeps(() => registry, {
      probe: e => ({ alive: alive.has(e.workspace), reason: 'PORT_CLOSED' }),
      start: (o) => {
        if (o.workspace === '/ws/boom') throw new Error('boom: vectr start exploded')
        alive.add(o.workspace)
        return { ok: true }
      },
    })
    const { state, res } = captureRes()
    await captureRoute(deps)(jsonReq('{}'), res)

    expect(state.code).toBe(200)
    const body = JSON.parse(state.body) as StartAllResponse
    expect(body.ok).toBe(false)
    expect(body.started).toBe(2)
    expect(body.alreadyRunning).toBe(1)
    expect(body.failed).toBe(1)
    expect(body.results).toHaveLength(4)

    // Registry order is hash-keyed, so the sweep imposes port order.
    expect(starts.map(s => s.workspace)).toEqual(['/ws/dead-a', '/ws/dead-b', '/ws/boom'])

    // The live daemon is NOT spawned a second time — pre-start probe was enough.
    expect(starts.some(s => s.workspace === '/ws/live')).toBe(false)
    expect(probes.filter(w => w === '/ws/live')).toHaveLength(1)

    const byWorkspace = new Map(body.results.map(r => [r.workspace, r]))
    expect(byWorkspace.get('/ws/live')).toEqual({ workspace: '/ws/live', port: 5101, status: 'already-running' })
    expect(byWorkspace.get('/ws/dead-a')).toEqual({ workspace: '/ws/dead-a', port: 5102, status: 'started' })
    expect(byWorkspace.get('/ws/dead-b')).toEqual({ workspace: '/ws/dead-b', port: 5103, status: 'started' })
    expect(byWorkspace.get('/ws/boom')?.status).toBe('failed')
    expect(byWorkspace.get('/ws/boom')?.port).toBeNull()
    expect(byWorkspace.get('/ws/boom')?.error).toContain('boom: vectr start exploded')
  })

  it('empty (or missing) registry reports zero of everything', async () => {
    const { state, res } = captureRes()
    const { deps, starts, probes } = fakeDeps(() => undefined)
    await captureRoute(deps)(jsonReq('{}'), res)

    expect(state.code).toBe(200)
    expect(JSON.parse(state.body)).toEqual({ ok: true, started: 0, alreadyRunning: 0, failed: 0, results: [] })
    expect(starts).toHaveLength(0)
    expect(probes).toHaveLength(0)

    // Same for a present-but-empty registry object.
    expect(await startAllDaemons(fakeDeps(() => ({})).deps, {}))
      .toEqual({ ok: true, started: 0, alreadyRunning: 0, failed: 0, results: [] })
  })

  it('malformed JSON body answers 400 without touching the registry', async () => {
    const { deps, starts, probes } = fakeDeps(() => instances([entry(5110, '/ws/x')]))
    const { state, res } = captureRes()
    await captureRoute(deps)(jsonReq('{not json'), res)

    expect(state.code).toBe(400)
    const body = JSON.parse(state.body) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error.startsWith('Invalid JSON body:')).toBe(true)
    expect(starts).toHaveLength(0)
    expect(probes).toHaveLength(0)
  })

  it('non-POST is rejected with 405', async () => {
    const { state, res } = captureRes()
    await captureRoute(fakeDeps(() => undefined).deps)(jsonReq('', 'GET'), res)
    expect(state.code).toBe(405)
    expect(JSON.parse(state.body)).toEqual({ error: 'method not allowed' })
  })

  it('spawns strictly one at a time (never two in flight)', async () => {
    const registry = instances([entry(5201, '/ws/a'), entry(5202, '/ws/b'), entry(5203, '/ws/c')])
    const alive = new Set<string>()
    let depth = 0
    let maxDepth = 0
    const order: string[] = []
    const { deps } = fakeDeps(() => registry, {
      probe: e => ({ alive: alive.has(e.workspace), reason: 'PORT_CLOSED' }),
      start: async (o) => {
        depth += 1
        maxDepth = Math.max(maxDepth, depth)
        order.push(o.workspace)
        await sleep(15)
        alive.add(o.workspace)
        depth -= 1
        return { ok: true }
      },
    })

    const result = await startAllDaemons(deps, {})
    expect(maxDepth).toBe(1)
    expect(order).toEqual(['/ws/a', '/ws/b', '/ws/c'])
    expect(result.started).toBe(3)
    expect(result.failed).toBe(0)
    expect(result.ok).toBe(true)
  })

  it('forwards memoryOnly to the runner: body wins, otherwise the entry mode decides', async () => {
    const registry = instances([
      entry(5301, '/ws/full', 'full'),
      entry(5302, '/ws/mem', 'memory_only'),
      entry(5303, '/ws/dash-mem', 'memory-only'),
      entry(5304, '/ws/no-mode'),
    ])

    const forced = fakeDeps(() => registry)
    await startAllDaemons(forced.deps, { memoryOnly: true })
    expect(forced.starts.map(s => [s.workspace, s.memoryOnly])).toEqual([
      ['/ws/full', true],
      ['/ws/mem', true],
      ['/ws/dash-mem', true],
      ['/ws/no-mode', true],
    ])

    const natural = fakeDeps(() => registry)
    await startAllDaemons(natural.deps, {})
    expect(natural.starts.map(s => [s.workspace, s.memoryOnly])).toEqual([
      ['/ws/full', false],
      ['/ws/mem', true],
      ['/ws/dash-mem', true],
      // No recorded mode: no mode is invented, `vectr start`'s own default applies.
      ['/ws/no-mode', false],
    ])
  })

  it('a runner that reports ok:false is counted failed and keeps its real error', async () => {
    const { deps } = fakeDeps(() => instances([entry(5401, '/ws/x')]), {
      start: () => ({ ok: false, error: 'vectr start: port 5401 in use' }),
    })
    const result = await startAllDaemons(deps, {})
    expect(result.ok).toBe(false)
    expect(result.started).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.results[0]).toEqual({
      workspace: '/ws/x',
      port: null,
      status: 'failed',
      error: 'vectr start: port 5401 in use',
    })
  })

  it('a spawn that never answers the post-start probe is failed, not "started"', async () => {
    const { deps } = fakeDeps(() => instances([entry(5501, '/ws/slow')]), {
      start: () => ({ ok: true }),
      probe: () => ({ alive: false, reason: 'HTTP_PROBE_TIMEOUT' }),
    })
    const result = await startAllDaemons(deps, {})
    expect(result.ok).toBe(false)
    expect(result.failed).toBe(1)
    expect(result.results[0]?.status).toBe('failed')
    expect(result.results[0]?.port).toBe(5501)
    expect(result.results[0]?.error).toContain('HTTP_PROBE_TIMEOUT')
  })

  it('a throwing probe fails only that workspace and the sweep carries on', async () => {
    const registry = instances([entry(5601, '/ws/probe-boom'), entry(5602, '/ws/fine')])
    const alive = new Set<string>()
    const { deps, starts } = fakeDeps(() => registry, {
      probe: (e) => {
        if (e.workspace === '/ws/probe-boom') throw new Error('probe: connection refused (hard timeout)')
        return { alive: alive.has(e.workspace), reason: 'PORT_CLOSED' }
      },
      start: (o) => {
        alive.add(o.workspace)
        return { ok: true }
      },
    })
    const result = await startAllDaemons(deps, {})
    expect(result.ok).toBe(false)
    expect(result.started).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.results[0]?.workspace).toBe('/ws/probe-boom')
    expect(result.results[0]?.error).toContain('probe: connection refused (hard timeout)')
    expect(result.results[1]).toEqual({ workspace: '/ws/fine', port: 5602, status: 'started' })
    expect(starts.map(s => s.workspace)).toEqual(['/ws/fine'])
  })

  it('a registry record that is not a valid daemon is reported failed, not dropped', async () => {
    const broken = { 'sha256-broken': { port: 'not-a-number', workspace: '/ws/broken' } } as unknown as Record<string, InstanceEntry>
    const result = await startAllDaemons(fakeDeps(() => broken).deps, {})
    expect(result.ok).toBe(false)
    expect(result.failed).toBe(1)
    expect(result.results[0]).toEqual({
      workspace: '/ws/broken',
      port: null,
      status: 'failed',
      error: 'invalid registry entry: missing a non-empty workspace and a valid port',
    })
  })
})

describe('DaemonLauncher client component', () => {
  it('first render is the real button, with no effect and no fetch needed', () => {
    const html = renderToHtml(React.createElement(DaemonLauncher, {}))
    expect(html).toContain('type="button"')
    expect(html).toContain('一键启动全部 Daemon')
    expect(html).not.toContain('已启动')
  })

  it('renders the real response summary and every failure error text', () => {
    const response: StartAllResponse = {
      ok: false,
      started: 2,
      alreadyRunning: 1,
      failed: 2,
      results: [
        { workspace: '/ws/ok-a', port: 5401, status: 'started' },
        { workspace: '/ws/live', port: 5402, status: 'already-running' },
        { workspace: '/ws/boom', port: null, status: 'failed', error: 'Error: boom: vectr start exploded' },
        { workspace: '/ws/slow', port: 5501, status: 'failed', error: 'daemon did not answer the post-start probe (HTTP_PROBE_TIMEOUT)' },
      ],
    }
    const html = renderToHtml(React.createElement(DaemonLauncherView, {
      busy: false, data: response, error: null, onRun: () => {},
    }))
    expect(html).toContain('已启动 2 · 已在运行 1 · 失败 2')
    expect(html).toContain('/ws/boom: Error: boom: vectr start exploded')
    expect(html).toContain('/ws/slow: daemon did not answer the post-start probe (HTTP_PROBE_TIMEOUT)')
    // Non-failures are not rendered as error rows.
    expect(html).not.toContain('/ws/ok-a:')
    expect(html).not.toContain('/ws/live:')
  })

  it('renders the in-flight hint and the real transport error text', () => {
    const busyHtml = renderToHtml(React.createElement(DaemonLauncherView, {
      busy: true, data: null, error: null, onRun: () => {},
    }))
    expect(busyHtml).toContain('正在启动…')
    expect(busyHtml).toContain('disabled')

    const errorHtml = renderToHtml(React.createElement(DaemonLauncherView, {
      busy: false, data: null, error: 'start-all endpoint returned 500', onRun: () => {},
    }))
    expect(errorHtml).toContain('start-all endpoint returned 500')
    expect(errorHtml).not.toContain('已启动')
  })
})
