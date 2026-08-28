/**
 * H2 + H5 — connection-failure agent-visibility (D-1) and dead-reconnect-field
 * (D-6) assertions on `install()`.
 *
 * `install()` probes the daemon (real `/v1/status` fetch against an in-process
 * server), and on liveness calls `startConnection`. We mock
 * `@deepseek-ai/dsh-mcp-client/src/connection.ts` `startConnection` so no real
 * MCP/HTTP connection is made, but its `ready` promise resolves with an error so
 * we can assert:
 *
 *   H2: the failure is routed to the AGENT-visible logger (`agent.ctx.logger`),
 *       not only the loader-fiber logger — so the agent/user sees the problem.
 *   H5: `startConnection` is called with the resolved `policy` as the third arg
 *       and the options object (second arg) carries NO dead `reconnect` field
 *       (D-6): only `policy` drives reconnection.
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { startConnection, resolveReconnectPolicy } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { install, type InstanceEntry } from '../src/index.ts'

// Mock startConnection so no real MCP/HTTP connection is ever attempted; the
// test asserts call/non-call and the failure routing. Mirrors daemon-health.spec.
vi.mock('@deepseek-ai/dsh-mcp-client/src/connection.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client/src/connection.ts')>()
  return {
    ...actual,
    startConnection: vi.fn(() => ({ ready: Promise.resolve({ error: 'boom' }), dispose: vi.fn() })),
  }
})

const startConnectionMock = startConnection as unknown as Mock

function keyOf(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex').slice(0, 12)
}

function makeAgent(id: string, cwd: string): Agent {
  const sessionCtx = new Context()
  const agent = {
    id,
    options: {},
    session: { header: { cwd } },
    status: 'idle' as const,
    acceptsNextStep: false,
    followup() {},
    steer() {},
    inject() {},
    send() {},
    updateInbox() { return 'not-found' as const },
    cancel() {},
    whenIdle: () => Promise.resolve(),
    ctx: sessionCtx,
  } as unknown as Agent
  return agent
}

function entryFor(cwd: string, port: number, pid: number): InstanceEntry {
  return { workspace: cwd, port, pid, started_at: 0, mode: 'full', host: '127.0.0.1' }
}

function startStatusServer(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ fully_ready: true }))
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const roots: string[] = []
const handles = new Map<Agent, unknown>()
let statusServer: Server
let statusPort: number

beforeAll(async () => {
  statusServer = await startStatusServer()
  statusPort = (statusServer.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => statusServer.close(() => r()))
})

afterEach(async () => {
  vi.restoreAllMocks()
  startConnectionMock.mockClear()
  handles.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tick(ms = 30): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function requiredConfig(file: string, codebasesPath: string) {
  return {
    instancesPath: file,
    serverName: 'vectr',
    toolCallTimeoutMs: 60_000,
    reconnect: { enabled: false } as const,
    codebasesPath,
    secretsPath: '',
    daemonHttpTimeoutMs: 5000,
    daemonTcpTimeoutMs: 300,
  }
}

describe('install connection-failure routing (H2) + reconnect policy (H5)', () => {
  it('routes a failed connection to the agent-visible logger (D-1)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-h2-'))
    roots.push(dir)
    const cwd = join(dir, 'ws')
    const file = join(dir, 'instances.json')
    await writeFile(file, JSON.stringify({ [keyOf(cwd)]: entryFor(cwd, statusPort, 4242) }))

    const ctx = new Context()
    const agent = makeAgent('h2-agent', cwd)
    const warn = vi.spyOn(agent.ctx.logger, 'warn')
    // Force the liveness gate's pid layer to pass (same technique as
    // daemon-health.spec) so install() reaches startConnection; H2/H5 only care
    // about the failure routing / reconnect wiring, not the liveness gate.
    vi.spyOn(process, 'kill').mockImplementation(() => true)

    install(ctx, handles as Map<Agent, never>, file, requiredConfig(file, join(dir, 'none.json')), agent)
    await vi.waitFor(() => expect(startConnectionMock).toHaveBeenCalled(), { timeout: 5000 })
    // The error outcome is delivered via conn.ready.then; wait for it.
    await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 5000 })

    const message = warn.mock.calls.map(c => String(c[0])).join('\n')
    expect(message).toContain('connection failed')
    expect(message).toContain(cwd) // self-diagnosing: carries workspace
    expect(message).toContain('boom') // carries the underlying error
    expect(message).toContain(String(statusPort)) // carries the port
  })

  it('passes the resolved policy as startConnection 3rd arg and no dead reconnect field (H5)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-h5-'))
    roots.push(dir)
    const cwd = join(dir, 'ws')
    const file = join(dir, 'instances.json')
    await writeFile(file, JSON.stringify({ [keyOf(cwd)]: entryFor(cwd, statusPort, 4242) }))

    const ctx = new Context()
    const agent = makeAgent('h5-agent', cwd)
    const config = requiredConfig(file, join(dir, 'none.json'))
    vi.spyOn(process, 'kill').mockImplementation(() => true)

    install(ctx, handles as Map<Agent, never>, file, config, agent)
    await vi.waitFor(() => expect(startConnectionMock).toHaveBeenCalled(), { timeout: 5000 })

    const call = startConnectionMock.mock.calls[0]
    expect(call).toBeDefined()
    // 2nd arg (options) must NOT carry the dead `reconnect` field (D-6).
    expect(call?.[1]).toBeTypeOf('object')
    expect('reconnect' in (call?.[1] as Record<string, unknown>)).toBe(false)
    // 3rd arg must be the resolved reconnect policy, not config.reconnect.
    expect(call?.[2]).toBeTypeOf('object')
    expect(call?.[2]).toEqual(resolveReconnectPolicy(config.reconnect, 'vectr-client(vectr): reconnect'))
  })
})
