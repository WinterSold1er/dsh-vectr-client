/**
 * Feature A (C1) data-plane tests for `src/workspaces.ts`.
 *
 * No real vectr daemon: a process-local `node:http` server stands in for one or
 * more daemons, and a temp registry file drives `scanWorkspaces` /
 * `triggerIndex`. Covers list assembly (online/offline + field fallback),
 * concurrent fault tolerance (one dead, one alive), the `triggerIndex` mode
 * gate, 503 pass-through, and the status-request timeout.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  scanWorkspaces,
  triggerIndex,
  type InstanceEntry,
  type InstancesFile,
  type VectrStatus,
} from '../src/workspaces.ts'

/** Minimal ctx stub carrying the logger `readInstancesFile` touches. */
const ctx = { logger: { info() {}, warn() {}, error() {} } } as unknown as import('@deepseek-ai/cordis').Context

/** A daemon simulator: configurable /v1/status and /v1/index behavior. */
interface DaemonSim {
  server: Server
  port: number
  /** Override the status payload (defaults to a fully-ready profile). */
  status: VectrStatus
  /** When set, /v1/status responds after this many ms (to test timeout). */
  statusDelayMs: number
  /** Response for POST /v1/index: 'ok' | 503 | 'reject'. */
  indexResponse: 'ok' | '503' | 'reject'
  /** Captured body of the last /v1/index POST. */
  lastIndexBody: unknown
  /** Count of /v1/index hits. */
  indexHits: number
}

function startDaemon(opts: Partial<DaemonSim> = {}): Promise<DaemonSim> {
  const sim: DaemonSim = {
    server: undefined as unknown as Server,
    port: 0,
    status: opts.status ?? {
      indexed_files: 12,
      total_chunks: 34,
      languages: ['ts', 'py'],
      last_indexed: '2026-08-26T10:00:00Z',
      notes_count: 3,
      fully_ready: true,
      reindex_in_progress: false,
      embed_model: 'bge-m3',
    },
    statusDelayMs: opts.statusDelayMs ?? 0,
    indexResponse: opts.indexResponse ?? 'ok',
    lastIndexBody: undefined,
    indexHits: 0,
  }
  return new Promise((resolve) => {
    sim.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/v1/status') {
        if (sim.statusDelayMs > 0) {
          setTimeout(() => res.end(JSON.stringify(sim.status)), sim.statusDelayMs)
          return
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(sim.status))
        return
      }
      if (url.pathname === '/v1/index' && req.method === 'POST') {
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', () => {
          sim.indexHits += 1
          try { sim.lastIndexBody = JSON.parse(body) } catch { sim.lastIndexBody = body }
          if (sim.indexResponse === '503') {
            res.statusCode = 503
            res.end('reindex already in progress')
          } else if (sim.indexResponse === 'reject') {
            res.statusCode = 400
            res.end('bad request')
          } else {
            res.statusCode = 200
            res.end('{}')
          }
        })
        return
      }
      res.statusCode = 404
      res.end()
    })
    sim.server.listen(0, '127.0.0.1', () => {
      sim.port = (sim.server.address() as AddressInfo).port
      resolve(sim)
    })
  })
}

let tmp: string
let registryPath: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vectr-ws-'))
  registryPath = join(tmp, 'instances.json')
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

/** Write a registry file from an entries map. */
async function writeRegistry(entries: Record<string, InstanceEntry>): Promise<void> {
  const file: InstancesFile = entries
  await writeFile(registryPath, JSON.stringify(file), 'utf8')
}

describe('scanWorkspaces', () => {
  it('returns empty list when the registry file is absent', async () => {
    const views = await scanWorkspaces(ctx, join(tmp, 'missing.json'))
    expect(views).toEqual([])
  })

  it('assembles online rows with status fields', async () => {
    const a = await startDaemon()
    await writeRegistry({ aa: { workspace: '/ws/a', port: a.port, pid: process.pid, mode: 'full', host: '127.0.0.1' } })
    const views = await scanWorkspaces(ctx, registryPath)
    expect(views).toHaveLength(1)
    expect(views[0]!.live).toBe(true)
    expect(views[0]!.workspace).toBe('/ws/a')
    expect(views[0]!.port).toBe(a.port)
    expect(views[0]!.pid).toBe(process.pid)
    expect(views[0]!.mode).toBe('full')
    expect(views[0]!.status?.indexed_files).toBe(12)
    expect(views[0]!.status?.total_chunks).toBe(34)
    expect(views[0]!.status?.fully_ready).toBe(true)
    await new Promise<void>((r) => a.server.close(() => r()))
  })

  it('marks a dead daemon offline with a reason, not dropping the row', async () => {
    // Port 1 is essentially never listening; isDaemonAlive TCP probe fails.
    await writeRegistry({ bb: { workspace: '/ws/b', port: 1, mode: 'full', host: '127.0.0.1' } })
    const views = await scanWorkspaces(ctx, registryPath)
    expect(views).toHaveLength(1)
    expect(views[0]!.live).toBe(false)
    expect(views[0]!.error).toMatch(/not alive/)
    // Reviewer follow-up: the precise skip reason must be emitted (not only a
    // generic error string) so the console row shows why the daemon is dead.
    expect(views[0]!.reason).toBe('PORT_CLOSED')
    expect(views[0]!.status).toBeUndefined()
  })

  it('treats a non-2xx /v1/status as not alive (R3 HTTP layer fails)', async () => {
    const a = await startDaemon({ status: undefined as unknown as VectrStatus })
    a.server.removeAllListeners('request')
    a.server.on('request', (_req, res) => { res.statusCode = 500; res.end() })
    await writeRegistry({ cc: { workspace: '/ws/c', port: a.port, mode: 'full', host: '127.0.0.1' } })
    const views = await scanWorkspaces(ctx, registryPath)
    // R3: the HTTP /v1/status probe returns non-2xx → daemon not alive.
    expect(views[0]!.live).toBe(false)
    expect(views[0]!.status).toBeUndefined()
    await new Promise<void>((r) => a.server.close(() => r()))
  })

  it('tolerates one dead and one alive daemon concurrently (allSettled)', async () => {
    const a = await startDaemon()
    await writeRegistry({
      live: { workspace: '/ws/a', port: a.port, mode: 'full', host: '127.0.0.1' },
      dead: { workspace: '/ws/dead', port: 2, mode: 'full', host: '127.0.0.1' },
    })
    const views = await scanWorkspaces(ctx, registryPath)
    expect(views).toHaveLength(2)
    const byWs = Object.fromEntries(views.map(v => [v.workspace, v]))
    expect(byWs['/ws/a']!.live).toBe(true)
    expect(byWs['/ws/dead']!.live).toBe(false)
    await new Promise<void>((r) => a.server.close(() => r()))
  })

  it('does not treat a slow /v1/status as alive (HTTP probe aborts → not alive)', async () => {
    const a = await startDaemon({ statusDelayMs: 500 })
    await writeRegistry({ tt: { workspace: '/ws/t', port: a.port, mode: 'full', host: '127.0.0.1' } })
    const views = await scanWorkspaces(ctx, registryPath, { statusTimeoutMs: 50 })
    // R3: no pid → TCP listens, but the HTTP /v1/status probe aborts at 50ms → not alive.
    expect(views[0]!.live).toBe(false)
    expect(views[0]!.status).toBeUndefined()
    await new Promise<void>((r) => a.server.close(() => r()))
  })
})

describe('triggerIndex', () => {
  it('POSTs /v1/index with {"force":false} and reports ok on 2xx', async () => {
    const a = await startDaemon({ indexResponse: 'ok' })
    const entry: InstanceEntry = { workspace: '/ws/a', port: a.port, mode: 'full', host: '127.0.0.1' }
    const result = await triggerIndex(entry)
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(a.indexHits).toBe(1)
    expect(a.lastIndexBody).toEqual({ force: false })
    await new Promise<void>((r) => a.server.close(() => r()))
  })

  it('gates memory_only mode without hitting the network', async () => {
    const a = await startDaemon({ indexResponse: 'ok' })
    const entry: InstanceEntry = { workspace: '/ws/m', port: a.port, mode: 'memory_only', host: '127.0.0.1' }
    const result = await triggerIndex(entry)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/memory_only/)
    expect(a.indexHits).toBe(0)
    await new Promise<void>((r) => a.server.close(() => r()))
  })

  it('gates search_only mode without hitting the network', async () => {
    const a = await startDaemon({ indexResponse: 'ok' })
    const entry: InstanceEntry = { workspace: '/ws/s', port: a.port, mode: 'search_only', host: '127.0.0.1' }
    const result = await triggerIndex(entry)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/search_only/)
    expect(a.indexHits).toBe(0)
    await new Promise<void>((r) => a.server.close(() => r()))
  })

  it('gates fully_ready=false when status is supplied', async () => {
    const a = await startDaemon()
    const entry: InstanceEntry = { workspace: '/ws/f', port: a.port, mode: 'full', host: '127.0.0.1' }
    const result = await triggerIndex(entry, {
      status: { fully_ready: false, reindex_in_progress: false },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not fully_ready/)
    expect(a.indexHits).toBe(0)
    await new Promise<void>((r) => a.server.close(() => r()))
  })

  it('passes through the daemon 503 wording verbatim', async () => {
    const a = await startDaemon({ indexResponse: '503' })
    const entry: InstanceEntry = { workspace: '/ws/5', port: a.port, mode: 'full', host: '127.0.0.1' }
    const result = await triggerIndex(entry)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(503)
    expect(result.error).toBe('reindex already in progress')
    await new Promise<void>((r) => a.server.close(() => r()))
  })

  it('reports a non-503 rejection with its status code', async () => {
    const a = await startDaemon({ indexResponse: 'reject' })
    const entry: InstanceEntry = { workspace: '/ws/r', port: a.port, mode: 'full', host: '127.0.0.1' }
    const result = await triggerIndex(entry)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
    expect(result.error).toMatch(/400/)
    await new Promise<void>((r) => a.server.close(() => r()))
  })
})
