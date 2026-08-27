/**
 * Route-level config-externalization check (QA follow-up, F5).
 *
 * Asserts that the `/api/vectr/workspaces` management route honors
 * `daemonHttpTimeoutMs` from the resolved Config: a daemon whose `/v1/status`
 * answers *after* the configured budget must be judged not-alive by the route,
 * proving the timeout is truly externalized (not a hardcoded 3000ms default).
 *
 * Marked `it.fails` because, at time of writing, `registerManagementRoutes`
 * calls `scanWorkspaces(ctx, instancesPath)` without forwarding
 * `config.daemonHttpTimeoutMs`, so the console route silently uses the
 * hardcoded `DEFAULT_STATUS_TIMEOUT_MS` (3000) and ignores the configuration.
 * Once the route forwards the configured timeout (fix for F5), drop `it.fails`
 * and this becomes a normal passing assertion.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerManagementRoutes, type Config } from '../src/index.ts'

/** A daemon whose /v1/status answers after `statusDelayMs`. */
function startSlowDaemon(statusDelayMs: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/v1/status') {
        setTimeout(() => {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ fully_ready: true }))
        }, statusDelayMs)
        return
      }
      res.statusCode = 404
      res.end()
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port
}

let tmp: string
let registryPath: string
let daemon: Server
let captured: { code?: number; body?: string }

const resolvedConfig = {
  instancesPath: '',
  serverName: 'vectr',
  toolCallTimeoutMs: 60_000,
  reconnect: { enabled: false, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
  codebasesPath: '',
  secretsPath: '',
  daemonHttpTimeoutMs: 50,
  daemonTcpTimeoutMs: 300,
} as Required<Config>

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vectr-route-timeout-'))
  registryPath = join(tmp, 'instances.json')
  daemon = await startSlowDaemon(500) // answers AFTER the 50ms configured budget
  await writeFile(registryPath, JSON.stringify({
    k1: { workspace: '/ws', port: portOf(daemon), mode: 'full', host: '127.0.0.1' },
  }))
  captured = {}
})

afterEach(async () => {
  await new Promise<void>((r) => daemon.close(() => r()))
  await rm(tmp, { recursive: true, force: true })
})

describe('route honors daemonHttpTimeoutMs (config externalization, F5)', () => {
  it('a daemon slower than daemonHttpTimeoutMs is judged not-alive by /api/vectr/workspaces', async () => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<void>> = {}
    const fakeWebServer = {
      register: (r: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
        handlers[r.path] = r.handler
        return () => {}
      },
    }
    const ctx = {
      get: (s: string) => (s === 'webServer' ? fakeWebServer : undefined),
      effect: (fn: () => unknown) => fn(),
      logger: { warn() {}, info() {}, error() {} },
    } as unknown as Context

    registerManagementRoutes(ctx, registryPath, { ...resolvedConfig, instancesPath: registryPath })

    const handler = handlers['/api/vectr/workspaces']
    expect(handler).toBeTypeOf('function')

    const res = {
      writeHead(code: number) { captured.code = code },
      end(payload: string) { captured.body = payload },
    }
    await handler!({ method: 'GET' }, res)
    expect(captured.code).toBe(200)
    const views = JSON.parse(captured.body!)
    expect(views).toHaveLength(1)
    // Configured 50ms << daemon's 500ms answer -> must be judged dead.
    expect(views[0].live).toBe(false)
    expect(views[0].reason).toBe('HTTP_PROBE_UNREACHABLE')
  })
})
