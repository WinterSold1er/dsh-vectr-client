/**
 * Per-workspace start route (T1): `POST /api/vectr/daemons/start`.
 *
 * Everything here drives the REAL route handler registered by
 * `registerManagementRoutes` on a fake webServer, with the registry / probe /
 * spawn seams injected (no child process, no socket, no real `$HOME`). The
 * response contract the client codes against is pinned per test.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  Config as ConfigSchema,
  registerManagementRoutes,
  type Config,
  type StartAllDeps,
} from '../src/index.ts'
import type { AliveDiagnosis } from '../src/probe.ts'
import type { DiscoveredWorkspace } from '../src/workspaces.ts'
import type { InstanceEntry, StartResult, VectrStartOptions } from '../src/domain/index.ts'
import type { InstancesFile } from '../src/registry.ts'

const CONFIG = ConfigSchema({} as never) as Required<Config>

interface Route {
  path: string
  handler: (req: unknown, res: unknown) => Promise<void>
}

/** Registry + spawn seams shared by every test, with call recording. */
interface Recorded {
  registry: InstancesFile
  starts: VectrStartOptions[]
}

function makeDeps(
  registry: InstancesFile,
  overrides: {
    probe?: (entry: InstanceEntry) => AliveDiagnosis | Promise<AliveDiagnosis>
    start?: (options: VectrStartOptions) => StartResult | Promise<StartResult>
  } = {},
): { deps: StartAllDeps; recorded: Recorded } {
  const recorded: Recorded = { registry, starts: [] }
  const deps: StartAllDeps = {
    readInstances: () => recorded.registry,
    probe: overrides.probe ?? (() => ({ alive: false, reason: 'PORT_CLOSED' })),
    start: async (options) => {
      recorded.starts.push(options)
      return overrides.start === undefined ? { ok: true } : overrides.start(options)
    },
  }
  return { deps, recorded }
}

/** Request whose async iteration yields the raw body bytes (drives `readJsonBody`). */
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

/** Capture every registered route and invoke one by path. */
function routesOf(
  instancesPath: string,
  deps: StartAllDeps,
  discover?: () => DiscoveredWorkspace[],
  codebasesPath?: string,
): Map<string, Route> {
  const routes = new Map<string, Route>()
  const webServer = {
    register: (route: Route) => {
      routes.set(route.path, route)
      return () => {}
    },
  }
  const ctx = {
    get: (key: string) => (key === 'webServer' ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as Context
  registerManagementRoutes(ctx, instancesPath, {
    ...CONFIG,
    instancesPath,
    ...(codebasesPath === undefined ? {} : { codebasesPath }),
  }, deps, discover)
  return routes
}

async function post(
  routes: Map<string, Route>,
  payload: unknown,
  method = 'POST',
): Promise<{ code: number; body: Record<string, unknown> }> {
  const route = routes.get('/api/vectr/daemons/start')
  if (route === undefined) throw new Error('POST /api/vectr/daemons/start was not registered')
  const captured = captureRes()
  await route.handler(jsonReq(JSON.stringify(payload), method), captured.res)
  return { code: captured.state.code, body: JSON.parse(captured.state.body) as Record<string, unknown> }
}

let tmp: string
let registryPath: string
let workspace: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vectr-start-route-'))
  registryPath = join(tmp, 'instances.json')
  workspace = join(tmp, 'workspace-alpha')
  await mkdir(workspace)
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('POST /api/vectr/daemons/start', () => {
  it('rejects a missing or relative workspace with 400 and never spawns', async () => {
    const { deps, recorded } = makeDeps({})
    const routes = routesOf(registryPath, deps)

    const missing = await post(routes, {})
    expect(missing.code).toBe(400)
    expect(missing.body['ok']).toBe(false)
    expect(missing.body['error']).toBe('workspace must be a non-empty absolute path')

    const relative = await post(routes, { workspace: 'workspace-alpha' })
    expect(relative.code).toBe(400)
    expect(recorded.starts).toHaveLength(0)
  })

  it('rejects a nonexistent directory with 400 and never spawns', async () => {
    const { deps, recorded } = makeDeps({})
    const routes = routesOf(registryPath, deps)

    const result = await post(routes, { workspace: join(tmp, 'does-not-exist') })

    expect(result.code).toBe(400)
    expect(result.body['ok']).toBe(false)
    expect(String(result.body['error'])).toMatch(/^no such workspace directory: /)
    expect(recorded.starts).toHaveLength(0)
  })

  it('answers a non-POST method with 405', async () => {
    const { deps } = makeDeps({})
    const routes = routesOf(registryPath, deps)

    const result = await post(routes, {}, 'GET')

    expect(result.code).toBe(405)
    expect(result.body['error']).toBe('method not allowed')
  })

  it('reports an already-running daemon as 409 with its live port and does not spawn again', async () => {
    await writeFile(registryPath, JSON.stringify({}))
    const { deps, recorded } = makeDeps({
      aa: { workspace, port: 5199, pid: process.pid, mode: 'full', host: '127.0.0.1' },
    }, { probe: () => ({ alive: true }) })
    const routes = routesOf(registryPath, deps)

    const result = await post(routes, { workspace })

    // Documented contract choice: already-running is a conflict (409), never a
    // silent second daemon and never a fake 200.
    expect(result.code).toBe(409)
    expect(result.body['ok']).toBe(false)
    expect(result.body['port']).toBe(5199)
    expect(recorded.starts).toHaveLength(0)
  })

  it('spawns through the shared start path and returns the refreshed registry port', async () => {
    await writeFile(registryPath, JSON.stringify({}))
    const { deps, recorded } = makeDeps({}, {
      start: () => {
        // A real `vectr start` records the daemon (possibly on a new free port).
        recorded.registry = {
          bb: { workspace, port: 5277, pid: 4242, mode: 'full', host: '127.0.0.1' },
        }
        return { ok: true }
      },
      probe: (entry) => entry.port === 5277
        ? { alive: true }
        : { alive: false, reason: 'PORT_CLOSED' },
    })
    const routes = routesOf(registryPath, deps)

    const result = await post(routes, { workspace })

    expect(result.code).toBe(200)
    expect(result.body).toEqual({ ok: true, port: 5277, pid: 4242 })
    expect(recorded.starts).toEqual([{ workspace }])
  })

  it('surfaces a spawn failure as 500 with the real error text', async () => {
    await writeFile(registryPath, JSON.stringify({}))
    const { deps } = makeDeps({}, { start: () => ({ ok: false, error: 'boom' }) })
    const routes = routesOf(registryPath, deps)

    const result = await post(routes, { workspace })

    expect(result.code).toBe(500)
    expect(result.body).toEqual({ ok: false, error: 'boom' })
  })

  it('fails with 500 when the spawned daemon never answers the post-start probe', async () => {
    await writeFile(registryPath, JSON.stringify({}))
    const { deps, recorded } = makeDeps({}, {
      start: () => {
        // The registry records an entry, but it never answers the probe.
        recorded.registry = {
          cc: { workspace, port: 5288, mode: 'full', host: '127.0.0.1' },
        }
        return { ok: true }
      },
      probe: () => ({ alive: false, reason: 'HTTP_PROBE_UNREACHABLE' }),
    })
    const routes = routesOf(registryPath, deps)

    const result = await post(routes, { workspace })

    expect(result.code).toBe(500)
    expect(String(result.body['error'])).toMatch(/post-start probe/)
  })
})

describe('GET /api/vectr/workspaces wiring', () => {
  it('forwards the injected discovery source so a never-started workspace is listed', async () => {
    await writeFile(registryPath, JSON.stringify({
      aa: { workspace: '/ws/live', port: 1, mode: 'full', host: '127.0.0.1' },
    }))
    const { deps } = makeDeps({}, { probe: () => ({ alive: false, reason: 'PORT_CLOSED' }) })
    const routes = routesOf(registryPath, deps, () => [
      { workspace: '/ws/never-started', title: 'never started' },
    ])

    const route = routes.get('/api/vectr/workspaces')
    if (route === undefined) throw new Error('GET /api/vectr/workspaces was not registered')
    const captured = captureRes()
    await route.handler({ method: 'GET' }, captured.res)

    expect(captured.state.code).toBe(200)
    const views = JSON.parse(captured.state.body) as Array<Record<string, unknown>>
    expect(views).toHaveLength(2)
    expect(views[0]).toMatchObject({ workspace: '/ws/live', live: false })
    expect(views[1]).toEqual({
      workspace: '/ws/never-started',
      title: 'never started',
      live: false,
      registered: false,
      reason: 'not started',
      error: 'daemon not started',
    })
  })

  it('derives registered from the configured codebasesPath, not from the default metadata file', async () => {
    // Regression guard: the console route called scanWorkspaces without
    // config.codebasesPath, so a custom metadata file left every badge
    // "unregistered" no matter what the user configured.
    const customPath = join(tmp, 'custom-codebases.json')
    await writeFile(customPath, JSON.stringify([
      {
        id: 'c',
        slug: 'c',
        type: 'local',
        path: '/ws/custom-registered',
        workspace: '/ws/custom-registered',
        serverName: 'vectr_c',
      },
    ]))
    await writeFile(registryPath, JSON.stringify({
      aa: { workspace: '/ws/custom-registered', port: 1, mode: 'full', host: '127.0.0.1' },
      bb: { workspace: '/ws/custom-absent', port: 2, mode: 'full', host: '127.0.0.1' },
    }))
    const { deps } = makeDeps({}, { probe: () => ({ alive: false, reason: 'PORT_CLOSED' }) })
    const routes = routesOf(registryPath, deps, () => [], customPath)

    const route = routes.get('/api/vectr/workspaces')
    if (route === undefined) throw new Error('GET /api/vectr/workspaces was not registered')
    const captured = captureRes()
    await route.handler({ method: 'GET' }, captured.res)

    expect(captured.state.code).toBe(200)
    const views = JSON.parse(captured.state.body) as Array<Record<string, unknown>>
    expect(views.find(view => view.workspace === '/ws/custom-registered')?.registered).toBe(true)
    expect(views.find(view => view.workspace === '/ws/custom-absent')?.registered).toBe(false)
  })
})
