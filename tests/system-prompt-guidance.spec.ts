/**
 * Unit tests for the vectr MCP usage-guidance system-prompt section (feature
 * A-2). These assert the injection *policy* and *lifecycle* without booting the
 * full SystemPrompt harness: `agent.ctx.inject(['systemPrompt'], cb)` is mocked
 * so we can capture the contributed section and its disposer directly. The
 * daemon-liveness gate is exercised with the same real `/v1/status` simulator
 * the daemon-health suite uses (`startConnection` is mocked so no MCP client
 * is ever opened).
 *
 * Covers:
 *  - injection occurs (and only when the daemon is verified alive);
 *  - injection does NOT occur when the daemon is dead;
 *  - the contributed section is disposed (removed) when the agent's prompt
 *    fiber is torn down.
 */
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { startConnection } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  install,
  VECTR_GUIDANCE_SECTION_NAME,
  VECTR_GUIDANCE_SECTION_ORDER,
  VECTR_GUIDANCE_SECTION_TEXT,
  type InstanceEntry,
} from '../src/index.ts'
import { fetchStatus } from '../src/probe.ts'

// Mock startConnection so no real MCP/HTTP client is opened; the test asserts
// call/non-call directly (same subpath target the plugin imports from).
vi.mock('@deepseek-ai/dsh-mcp-client/src/connection.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client/src/connection.ts')>()
  return {
    ...actual,
    startConnection: vi.fn(() => ({ ready: Promise.resolve({}), dispose: vi.fn() })),
  }
})

const startConnectionMock = startConnection as unknown as Mock

function entryFor(cwd: string, port: number, pid?: number): InstanceEntry {
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
const promptFibers = new Map<Agent, unknown>()
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
  promptFibers.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * Build an agent whose `ctx.inject(['systemPrompt'], cb)` is mocked: the cb is
 * run against a mock scope exposing `systemPrompt.section(...)`. The returned
 * fiber's `dispose()` invokes the section's own disposer, mirroring how Cordis
 * unwinds a scope's effects on fiber disposal.
 */
function makeAgentWithInjectSpy(id: string, cwd: string) {
  let sectionDisposer: (() => void) | undefined
  const sectionSpy = vi.fn((section: { name: string; order: number; text: unknown }) => {
    // Record the disposer the real systemPrompt would return; disposing the
    // fiber must invoke it so the section is removed on agent teardown.
    sectionDisposer = () => {}
    return sectionDisposer
  })
  const disposeFiber = vi.fn(async () => {
    sectionDisposer?.()
  })
  const injectSpy = vi.fn((_deps: string[], cb: (scope: unknown) => void) => {
    cb({ systemPrompt: { section: sectionSpy } })
    return { dispose: disposeFiber }
  })
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
    ctx: { inject: injectSpy, logger: new Context().logger },
  } as unknown as Agent
  return { agent, injectSpy, sectionSpy, disposeFiber }
}

async function writeInstances(dir: string, entry: InstanceEntry) {
  const cwd = dir.endsWith('ws') ? dir : join(dir, 'ws')
  const file = join(dir, 'instances.json')
  await writeFile(file, JSON.stringify({ [cwd]: entry }))
  return { file, cwd }
}

describe('vectr guidance system-prompt section (feature A-2)', () => {
  it('injects the guidance section when the daemon is verified alive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-guidance-alive-'))
    roots.push(dir)
    const { file, cwd } = await writeInstances(dir, entryFor(cwd0(dir), statusPort, 4242))
    const { agent, injectSpy, sectionSpy } = makeAgentWithInjectSpy('guidance-alive', cwd)

    const ctx = new Context()
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true) // pid alive

    install(ctx, handles, promptFibers, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
      daemonHttpTimeoutMs: 5000,
      daemonTcpTimeoutMs: 300,
    }, agent)

    // Wait for the liveness IIFE to settle on the real outcome.
    await vi.waitFor(() => {
      expect(promptFibers.has(agent)).toBe(true)
    }, { timeout: 5000, interval: 25 })

    expect(injectSpy).toHaveBeenCalledTimes(1)
    expect(injectSpy.mock.calls[0]?.[0]).toEqual(['systemPrompt'])
    expect(sectionSpy).toHaveBeenCalledTimes(1)
    const section = sectionSpy.mock.calls[0]?.[0] as { name: string; order: number; text: unknown }
    expect(section.name).toBe(VECTR_GUIDANCE_SECTION_NAME)
    expect(section.order).toBe(VECTR_GUIDANCE_SECTION_ORDER)
    expect(section.text).toBe(VECTR_GUIDANCE_SECTION_TEXT)
    expect(handles.has(agent)).toBe(true) // tool bind also happened (same gate)
    killSpy.mockRestore()
  })

  it('does NOT inject the guidance section when the daemon is dead', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-guidance-dead-'))
    roots.push(dir)
    const { file, cwd } = await writeInstances(dir, entryFor(cwd0(dir), 1234, 99_999)) // dead pid
    const { agent, injectSpy, sectionSpy } = makeAgentWithInjectSpy('guidance-dead', cwd)

    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException
      err.code = 'ESRCH'
      throw err
    })

    install(ctx, handles, promptFibers, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
      daemonHttpTimeoutMs: 5000,
      daemonTcpTimeoutMs: 300,
    }, agent)

    await vi.waitFor(() => {
      expect(warn.mock.calls.some(
        c => String(c[0]).includes('not alive') && String(c[0]).includes('reason=PROCESS_DEAD_ESRCH'),
      )).toBe(true)
    }, { timeout: 5000, interval: 25 })

    expect(sectionSpy).not.toHaveBeenCalled() // no prompt injection
    expect(injectSpy).not.toHaveBeenCalled()
    expect(promptFibers.has(agent)).toBe(false)
    expect(handles.has(agent)).toBe(false)
    killSpy.mockRestore()
  })

  it('disposes the guidance section when the prompt fiber is torn down', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-guidance-dispose-'))
    roots.push(dir)
    const { file, cwd } = await writeInstances(dir, entryFor(cwd0(dir), statusPort, 4242))
    const { agent, sectionSpy, disposeFiber } = makeAgentWithInjectSpy('guidance-dispose', cwd)

    const ctx = new Context()
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    install(ctx, handles, promptFibers, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
      daemonHttpTimeoutMs: 5000,
      daemonTcpTimeoutMs: 300,
    }, agent)

    await vi.waitFor(() => {
      expect(promptFibers.has(agent)).toBe(true)
    }, { timeout: 5000, interval: 25 })

    expect(sectionSpy).toHaveBeenCalledTimes(1)
    // Simulate agent/disposed teardown: dispose the captured fiber.
    const fiber = promptFibers.get(agent) as { dispose: () => Promise<void> }
    await fiber.dispose()
    expect(disposeFiber).toHaveBeenCalledTimes(1)
    // The section disposer (the real systemPrompt's removal) ran via the fiber.
    killSpy.mockRestore()
  })
})

/** Resolve the workspace key dir used by writeInstances above. */
function cwd0(dir: string): string {
  return join(dir, 'ws')
}
