/**
 * QA Adversarial Audit & Deep Verification Test Suite
 *
 * Designed by QA Inspector: Focuses on boundary conditions, failure paths,
 * config externalization, and anti-mock falsification.
 */

import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { startConnection, type ConnectionHandle } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  install,
  installCodebaseConnections,
  apply,
  getVectrGuidanceText,
  getVectrGrepText,
  VECTR_GUIDANCE_SECTION_NAME,
  VECTR_GUIDANCE_SECTION_ORDER,
  VECTR_GUIDANCE_SECTION_TEXT,
  VECTR_GREP_SECTION_NAME,
  VECTR_GREP_SECTION_ORDER,
  VECTR_GREP_SECTION_TEXT,
  DEFAULT_SERVER_NAME,
  type Config,
} from '../src/index.ts'
import { isValidInstanceEntry, validateWorkspace } from '../src/domain'

vi.mock('@deepseek-ai/dsh-mcp-client/src/connection.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client/src/connection.ts')>()
  return {
    ...actual,
    startConnection: vi.fn(() => ({
      ready: Promise.resolve({}),
      dispose: vi.fn().mockResolvedValue(undefined),
    })),
  }
})

const startConnectionMock = startConnection as unknown as Mock

function makeMockAgent(id: string, cwd?: string) {
  const disposers: (() => void)[] = []
  const sectionSpy = vi.fn((section: { name: string; order: number; text: unknown }) => {
    const d = vi.fn()
    disposers.push(d)
    return d
  })
  const disposeFiberSpy = vi.fn(async () => {
    for (const d of disposers) d()
  })
  const injectSpy = vi.fn((deps: string[], cb: (scope: any) => void) => {
    cb({
      systemPrompt: {
        section: sectionSpy,
        getSectionOrder: (name: string) => (name === 'TOOL_GREP' ? 1500 : 100),
      },
    })
    return { dispose: disposeFiberSpy } as Fiber
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
  return { agent, injectSpy, sectionSpy, disposeFiberSpy }
}

const roots: string[] = []
let mockHttpServer: Server
let mockHttpPort: number

beforeAll(async () => {
  mockHttpServer = createServer((_req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ fully_ready: true }))
  })
  await new Promise<void>((resolve) => {
    mockHttpServer.listen(0, '127.0.0.1', () => {
      mockHttpPort = (mockHttpServer.address() as AddressInfo).port
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => mockHttpServer.close(() => resolve()))
})

afterEach(async () => {
  vi.restoreAllMocks()
  startConnectionMock.mockClear()
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

describe('QA Adversarial Audit: Core Requirements & Invariants', () => {
  const baseConfig: Required<Config> = {
    instancesPath: '',
    serverName: 'vectr',
    toolCallTimeoutMs: 60_000,
    reconnect: {
      enabled: true,
      initialDelayMs: 500,
      maxDelayMs: 30_000,
      maxAttempts: 10,
    },
    codebasesPath: '',
    secretsPath: '',
    daemonHttpTimeoutMs: 100,
    daemonTcpTimeoutMs: 50,
    cliPath: '',
    cliTimeoutMs: 30_000,
    recallTimeoutMs: 10_000,
    upgradeTimeoutMs: 15_000,
  }

  describe('1. Probe Slow Response / Timeout & Connection De-vetoing', () => {
    it('establishes connection immediately and passes reconnect policy even if daemon probe is permanently hung', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-hang-probe-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'hang-ws')

      // Server that hangs indefinitely (slow response simulation)
      const hungServer = createServer(() => {
        // Intentionally never reply or close connection
      })
      let hungPort = 0
      await new Promise<void>((resolve) => {
        hungServer.listen(0, '127.0.0.1', () => {
          hungPort = (hungServer.address() as AddressInfo).port
          resolve()
        })
      })

      try {
        await writeFile(instancesPath, JSON.stringify({
          'key-hung': { workspace: ws, port: hungPort, pid: process.pid },
        }))

        const ctx = new Context()
        const warnSpy = vi.spyOn(ctx.logger, 'warn')
        const handles = new Map<Agent, ConnectionHandle>()
        const promptFibers = new Map<Agent, Fiber>()
        const { agent } = makeMockAgent('agent-hang', ws)

        // Run install with short daemonHttpTimeoutMs
        install(ctx, handles, promptFibers, instancesPath, {
          ...baseConfig,
          instancesPath,
          daemonHttpTimeoutMs: 60,
          daemonTcpTimeoutMs: 40,
        }, agent)

        // Main connection must be created synchronously without waiting for probe!
        expect(startConnectionMock).toHaveBeenCalledTimes(1)
        const callArgs = startConnectionMock.mock.calls[0]
        expect(callArgs[1].url).toBe(`http://127.0.0.1:${hungPort}/mcp`)
        expect(callArgs[1].failOnStartupError).toBe(false)
        expect(callArgs[2]).toBeDefined() // reconnect policy passed!
        expect(handles.has(agent)).toBe(true)

        // Wait for background advisory probe to time out
        await vi.waitFor(() => {
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('vectr daemon not alive, advisory telemetry warning'),
          )
        }, { timeout: 2000, interval: 30 })

        // The connection handle MUST NOT be deleted or vetoed by the hung probe
        expect(handles.has(agent)).toBe(true)
      } finally {
        await new Promise<void>((resolve) => hungServer.close(() => resolve()))
      }
    })

    it('advisory telemetry strictly warns without disposing or nullifying connection handle', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-adv-telemetry-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'closed-port-ws')

      // Port 1 is closed
      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: 1, pid: process.pid },
      }))

      const ctx = new Context()
      const warnSpy = vi.spyOn(ctx.logger, 'warn')
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent } = makeMockAgent('agent-closed', ws)

      const disposeSpy = vi.fn().mockResolvedValue(undefined)
      startConnectionMock.mockReturnValueOnce({
        ready: Promise.resolve({}),
        dispose: disposeSpy,
      })

      install(ctx, handles, promptFibers, instancesPath, {
        ...baseConfig,
        instancesPath,
        daemonHttpTimeoutMs: 50,
        daemonTcpTimeoutMs: 30,
      }, agent)

      expect(handles.has(agent)).toBe(true)

      // Wait for telemetry probe
      await vi.waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('advisory telemetry warning'),
        )
      }, { timeout: 2000, interval: 30 })

      // Connection handle remains alive and dispose was NEVER called by the telemetry failure
      expect(handles.has(agent)).toBe(true)
      expect(disposeSpy).not.toHaveBeenCalled()
    })
  })

  describe('2. Dynamic serverName Adaptation & Wildcard Decoupling', () => {
    it('renders wildcard prompt matching custom serverName (mcp__${serverName}*)', () => {
      const customName = 'my_vectr_instance'
      const guidance = getVectrGuidanceText(customName)
      const grep = getVectrGrepText(customName)

      expect(guidance).toContain(`mcp__${customName}*`)
      expect(guidance).toContain('prioritize the vectr MCP tools')
      expect(guidance).toContain('fall back to grep if vectr tools are not available')

      expect(grep).toContain(`mcp__${customName}*`)
      expect(grep).toContain('Prioritize querying code via vectr tools')
      expect(grep).toContain('If vectr tools are not available, query fails, or yields no results')

      // Verifies that wildcard covers both primary tool and codebase sub-tools
      const primaryTool = `mcp__${customName}__code_search`
      const codebaseSubTool = `mcp__${customName}_codebase1__code_search`
      const prefixRegex = new RegExp(`^mcp__${customName}`)
      expect(prefixRegex.test(primaryTool)).toBe(true)
      expect(prefixRegex.test(codebaseSubTool)).toBe(true)
    })

    it('injects dynamic serverName prompt sections into agent scope when configured', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-dyn-server-name-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'ws')

      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))

      const ctx = new Context()
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent, sectionSpy } = makeMockAgent('agent-custom-server', ws)

      install(ctx, handles, promptFibers, instancesPath, {
        ...baseConfig,
        instancesPath,
        serverName: 'vectr_stage',
      }, agent)

      expect(sectionSpy).toHaveBeenCalledTimes(2)
      const guidanceCall = sectionSpy.mock.calls.find((c) => c[0].name === VECTR_GUIDANCE_SECTION_NAME)
      const grepCall = sectionSpy.mock.calls.find((c) => c[0].name === VECTR_GREP_SECTION_NAME)

      expect(guidanceCall[0].text).toBe(getVectrGuidanceText('vectr_stage'))
      expect(grepCall[0].text).toBe(getVectrGrepText('vectr_stage'))
      expect(guidanceCall[0].text).toContain('mcp__vectr_stage*')
      expect(grepCall[0].text).toContain('mcp__vectr_stage*')
    })

    it('falls back to DEFAULT_SERVER_NAME when serverName is empty or undefined', () => {
      expect(getVectrGuidanceText(undefined)).toBe(VECTR_GUIDANCE_SECTION_TEXT)
      expect(getVectrGrepText(undefined)).toBe(VECTR_GREP_SECTION_TEXT)
      expect(VECTR_GUIDANCE_SECTION_TEXT).toContain(`mcp__${DEFAULT_SERVER_NAME}*`)
      expect(VECTR_GREP_SECTION_TEXT).toContain(`mcp__${DEFAULT_SERVER_NAME}*`)
    })
  })

  describe('3. Disposed Agent Guard & Zero Orphan Connection Invariants', () => {
    it('install() immediately exits on entry when agent is disposed, creating 0 connections and 0 fibers', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-disposed-guard-all-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'ws')

      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))

      const ctx = new Context()
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const disposed = new WeakSet<Agent>()
      const { agent, injectSpy } = makeMockAgent('agent-pre-disposed', ws)

      // Agent marked disposed before install() call
      disposed.add(agent)

      install(
        ctx,
        handles,
        promptFibers,
        instancesPath,
        { ...baseConfig, instancesPath },
        agent,
        undefined,
        disposed,
      )

      expect(injectSpy).not.toHaveBeenCalled()
      expect(startConnectionMock).not.toHaveBeenCalled()
      expect(promptFibers.size).toBe(0)
      expect(handles.size).toBe(0)
    })

    it('installCodebaseConnections() immediately exits on entry and loop when agent is disposed', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-disposed-codebase-'))
      roots.push(dir)
      const codebasesPath = join(dir, 'codebases.json')
      const ws = join(dir, 'ws')

      await writeFile(codebasesPath, JSON.stringify([
        { id: 'cb1', slug: 'cb-1', type: 'local', path: ws, serverName: 'cb_1', status: 'up', localPort: mockHttpPort },
        { id: 'cb2', slug: 'cb-2', type: 'local', path: ws, serverName: 'cb_2', status: 'up', localPort: mockHttpPort },
      ]))

      const ctx = new Context()
      const disposed = new WeakSet<Agent>()
      const codebaseHandles = new Map<Agent, ConnectionHandle[]>()
      const { agent } = makeMockAgent('agent-cb-disposed', ws)

      disposed.add(agent)

      await installCodebaseConnections(
        ctx,
        baseConfig,
        agent,
        codebasesPath,
        undefined,
        ws,
        disposed,
        codebaseHandles,
      )

      expect(startConnectionMock).not.toHaveBeenCalled()
      expect(codebaseHandles.has(agent)).toBe(false)
    })

    it('tears down newly started connection if agent was disposed while starting connection', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-conn-disposed-window-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'ws')

      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))

      const ctx = new Context()
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const disposed = new WeakSet<Agent>()
      const { agent } = makeMockAgent('agent-window', ws)

      const disposeMock = vi.fn().mockResolvedValue(undefined)
      startConnectionMock.mockImplementationOnce(() => {
        // Disposed right in the connection initialization window
        disposed.add(agent)
        return {
          ready: Promise.resolve({}),
          dispose: disposeMock,
        }
      })

      install(
        ctx,
        handles,
        promptFibers,
        instancesPath,
        { ...baseConfig, instancesPath },
        agent,
        undefined,
        disposed,
      )

      // The connection was immediately disposed and NOT retained in handles
      expect(disposeMock).toHaveBeenCalledTimes(1)
      expect(handles.has(agent)).toBe(false)
    })
  })

  describe('4. codebaseHandles Lifecycle & Teardown 100% Cleanup', () => {
    it('properly tracks and disposes all codebase connections on agent/disposed event', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-cb-handles-event-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const codebasesPath = join(dir, 'codebases.json')
      const ws = join(dir, 'ws')

      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))
      await writeFile(codebasesPath, JSON.stringify([
        { id: 'cb1', slug: 'cb-1', type: 'local', path: ws, serverName: 'cb_1', status: 'up', localPort: mockHttpPort, workspace: ws },
        { id: 'cb2', slug: 'cb-2', type: 'local', path: ws, serverName: 'cb_2', status: 'up', localPort: mockHttpPort, workspace: ws },
      ]))

      const ctx = new Context()
      ;(ctx as any).agents = { list: () => [] }

      let createdHandler: any
      let disposedHandler: any
      vi.spyOn(ctx, 'on').mockImplementation(((evt: string, fn: any) => {
        if (evt === 'agent/created') createdHandler = fn
        if (evt === 'agent/disposed') disposedHandler = fn
      }) as any)

      apply(ctx, {
        instancesPath,
        codebasesPath,
      })

      const mainDispose = vi.fn().mockResolvedValue(undefined)
      const cbDispose1 = vi.fn().mockResolvedValue(undefined)
      const cbDispose2 = vi.fn().mockResolvedValue(undefined)
      let count = 0
      startConnectionMock.mockImplementation(() => {
        count++
        if (count === 1) return { ready: Promise.resolve({}), dispose: mainDispose }
        if (count === 2) return { ready: Promise.resolve({}), dispose: cbDispose1 }
        return { ready: Promise.resolve({}), dispose: cbDispose2 }
      })

      const { agent } = makeMockAgent('agent-full-lifecycle', ws)

      // Fire agent/created
      createdHandler({ agent })

      // Wait for 1 main + 2 codebase connections
      await vi.waitFor(() => {
        expect(startConnectionMock).toHaveBeenCalledTimes(3)
      }, { timeout: 3000, interval: 20 })

      // Fire agent/disposed
      disposedHandler({ agent })

      // All 3 handles must be disposed
      expect(mainDispose).toHaveBeenCalledTimes(1)
      expect(cbDispose1).toHaveBeenCalledTimes(1)
      expect(cbDispose2).toHaveBeenCalledTimes(1)
    })

    it('cleans up all codebase handles across all agents on host plugin teardown', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-cb-teardown-all-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const codebasesPath = join(dir, 'codebases.json')
      const ws1 = join(dir, 'ws1')
      const ws2 = join(dir, 'ws2')

      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws1, port: mockHttpPort, pid: process.pid },
        'key-2': { workspace: ws2, port: mockHttpPort, pid: process.pid },
      }))
      await writeFile(codebasesPath, JSON.stringify([
        { id: 'cb1', slug: 'cb-1', type: 'local', path: ws1, serverName: 'cb_1', status: 'up', localPort: mockHttpPort, workspace: ws1 },
        { id: 'cb2', slug: 'cb-2', type: 'local', path: ws2, serverName: 'cb_2', status: 'up', localPort: mockHttpPort, workspace: ws2 },
      ]))

      const ctx = new Context()
      ;(ctx as any).agents = { list: () => [] }

      let createdHandler: any
      let teardownDisposer: (() => Promise<void>) | undefined
      vi.spyOn(ctx, 'on').mockImplementation(((evt: string, fn: any) => {
        if (evt === 'agent/created') createdHandler = fn
      }) as any)
      vi.spyOn(ctx, 'effect').mockImplementation(((fn: any) => {
        teardownDisposer = fn()
      }) as any)

      apply(ctx, { instancesPath, codebasesPath })

      const disposers: Mock[] = []
      startConnectionMock.mockImplementation(() => {
        const d = vi.fn().mockResolvedValue(undefined)
        disposers.push(d)
        return { ready: Promise.resolve({}), dispose: d }
      })

      const { agent: a1 } = makeMockAgent('a1', ws1)
      const { agent: a2 } = makeMockAgent('a2', ws2)

      createdHandler({ agent: a1 })
      createdHandler({ agent: a2 })

      // Each agent gets 1 main + 1 codebase connection = 4 connections total
      await vi.waitFor(() => {
        expect(startConnectionMock).toHaveBeenCalledTimes(4)
      }, { timeout: 3000, interval: 20 })

      expect(disposers.length).toBe(4)

      // Host teardown
      expect(teardownDisposer).toBeDefined()
      await teardownDisposer!()

      // All 4 handles must be disposed
      for (const d of disposers) {
        expect(d).toHaveBeenCalledTimes(1)
      }
    })

    it('tolerates errors thrown during conn.dispose() without crashing teardown or agent/disposed', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-cb-dispose-throw-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const codebasesPath = join(dir, 'codebases.json')
      const ws = join(dir, 'ws')

      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))
      await writeFile(codebasesPath, JSON.stringify([
        { id: 'cb1', slug: 'cb-1', type: 'local', path: ws, serverName: 'cb_1', status: 'up', localPort: mockHttpPort, workspace: ws },
      ]))

      const ctx = new Context()
      ;(ctx as any).agents = { list: () => [] }

      let createdHandler: any
      let disposedHandler: any
      vi.spyOn(ctx, 'on').mockImplementation(((evt: string, fn: any) => {
        if (evt === 'agent/created') createdHandler = fn
        if (evt === 'agent/disposed') disposedHandler = fn
      }) as any)

      apply(ctx, { instancesPath, codebasesPath })

      startConnectionMock.mockImplementation(() => {
        return {
          ready: Promise.resolve({}),
          dispose: vi.fn().mockRejectedValue(new Error('Fatal dispose failure!')),
        }
      })

      const { agent } = makeMockAgent('a-err', ws)
      createdHandler({ agent })

      await vi.waitFor(() => {
        expect(startConnectionMock).toHaveBeenCalledTimes(2)
      }, { timeout: 3000, interval: 20 })

      // Must not throw or crash unhandled
      expect(() => {
        disposedHandler({ agent })
      }).not.toThrow()
    })
  })

  describe('5. Synchronous startConnection try-catch Isolation', () => {
    it('isolates synchronous startConnection errors, preserves prompt fiber and keeps host intact', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-startconn-iso-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'ws')

      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))

      startConnectionMock.mockImplementationOnce(() => {
        throw new TypeError('Protocol engine failed to instantiate!')
      })

      const ctx = new Context()
      const warnSpy = vi.spyOn(ctx.logger, 'warn')
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent, injectSpy } = makeMockAgent('agent-sync-fail', ws)

      // install() MUST NOT throw!
      expect(() => {
        install(ctx, handles, promptFibers, instancesPath, {
          ...baseConfig,
          instancesPath,
        }, agent)
      }).not.toThrow()

      // Prompt injection was still successful and safe!
      expect(injectSpy).toHaveBeenCalledTimes(1)
      expect(promptFibers.has(agent)).toBe(true)

      // Handle not registered due to startup error
      expect(handles.has(agent)).toBe(false)

      // Warning recorded
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to initialize main connection for session agent-sync-fail'),
      )
    })

    it('captures async conn.ready errors and logs warning without throwing', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-async-ready-err-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'ws')

      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))

      startConnectionMock.mockReturnValueOnce({
        ready: Promise.resolve({ error: new Error('Handshake rejected by daemon') }),
        dispose: vi.fn(),
      })

      const ctx = new Context()
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent } = makeMockAgent('agent-async-fail', ws)
      const agentWarnSpy = vi.spyOn((agent.ctx as any).logger, 'warn')

      install(ctx, handles, promptFibers, instancesPath, {
        ...baseConfig,
        instancesPath,
      }, agent)

      await vi.waitFor(() => {
        expect(agentWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('vectr connection failed for session agent-async-fail'),
        )
      }, { timeout: 2000, interval: 20 })

      expect(agentWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Handshake rejected by daemon'),
      )
    })
  })

  describe('6. Boundary Conditions, Config Validation & Stress Debounce', () => {
    it('strictly validates InstanceEntry invalid ports and malformed objects', () => {
      // Numbers out of bounds
      expect(isValidInstanceEntry({ workspace: '/valid', port: 0 })).toBe(false)
      expect(isValidInstanceEntry({ workspace: '/valid', port: -10 })).toBe(false)
      expect(isValidInstanceEntry({ workspace: '/valid', port: 65536 })).toBe(false)
      expect(isValidInstanceEntry({ workspace: '/valid', port: 70000 })).toBe(false)
      expect(isValidInstanceEntry({ workspace: '/valid', port: 8080.5 })).toBe(false)
      expect(isValidInstanceEntry({ workspace: '/valid', port: NaN })).toBe(false)
      expect(isValidInstanceEntry({ workspace: '/valid', port: Infinity })).toBe(false)

      // Invalid workspace paths
      expect(isValidInstanceEntry({ workspace: '', port: 8080 })).toBe(false)
      expect(isValidInstanceEntry({ workspace: '   ', port: 8080 })).toBe(false)
      expect(isValidInstanceEntry({ workspace: null as any, port: 8080 })).toBe(false)

      // Valid boundary ports
      expect(isValidInstanceEntry({ workspace: '/valid', port: 1 })).toBe(true)
      expect(isValidInstanceEntry({ workspace: '/valid', port: 65535 })).toBe(true)
    })

    it('rejects workspace paths with null bytes and invalid relative paths in validateWorkspace', () => {
      expect(validateWorkspace('')).toEqual({ valid: false, error: 'Workspace path must be a non-empty string' })
      expect(validateWorkspace('   ')).toEqual({ valid: false, error: 'Workspace path must be a non-empty string' })
      expect(validateWorkspace('/valid/path\0inject')).toEqual({ valid: false, error: 'Workspace path must not contain null bytes' })
      expect(validateWorkspace('__unassigned__')).toEqual({ valid: false, error: 'Workspace cannot be the unassigned sentinel' })
      expect(validateWorkspace('relative/path')).toEqual({ valid: false, error: 'Workspace path must be an absolute path' })
      expect(validateWorkspace('/home/csy/repo').valid).toBe(true)
    })

    it('stress debounce: rapid concurrent install() calls invoke startConnection exactly once', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-stress-debounce-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'ws')

      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))

      const ctx = new Context()
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent, injectSpy } = makeMockAgent('agent-stress', ws)

      // Concurrently invoke install 25 times
      const promises = []
      for (let i = 0; i < 25; i++) {
        promises.push(
          Promise.resolve().then(() => {
            install(ctx, handles, promptFibers, instancesPath, {
              ...baseConfig,
              instancesPath,
            }, agent)
          }),
        )
      }
      await Promise.all(promises)

      // Must be called exactly once
      expect(startConnectionMock).toHaveBeenCalledTimes(1)
      expect(injectSpy).toHaveBeenCalledTimes(1)
      expect(handles.has(agent)).toBe(true)
      expect(promptFibers.has(agent)).toBe(true)
    })
  })

  describe('7. Deep Configuration Externalization & Boundary Falsification', () => {
    it('propagates disabled reconnect config (enabled: false) without hardcoded override', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-cfg-disabled-reconn-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'ws')

      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))

      const ctx = new Context()
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent } = makeMockAgent('agent-no-reconn', ws)

      install(ctx, handles, promptFibers, instancesPath, {
        ...baseConfig,
        instancesPath,
        reconnect: { enabled: false, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
      }, agent)

      expect(startConnectionMock).toHaveBeenCalledTimes(1)
      const passedPolicy = startConnectionMock.mock.calls[0][2]
      expect(passedPolicy).toBeDefined()
      expect(passedPolicy.enabled).toBe(false)
    })

    it('propagates customized reconnect timing (initialDelayMs, maxDelayMs, maxAttempts)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-cfg-custom-reconn-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'ws')

      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))

      const ctx = new Context()
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent } = makeMockAgent('agent-custom-reconn', ws)

      install(ctx, handles, promptFibers, instancesPath, {
        ...baseConfig,
        instancesPath,
        reconnect: {
          enabled: true,
          initialDelayMs: 350,
          maxDelayMs: 12_000,
          maxAttempts: 7,
        },
      }, agent)

      expect(startConnectionMock).toHaveBeenCalledTimes(1)
      const passedPolicy = startConnectionMock.mock.calls[0][2]
      expect(passedPolicy).toEqual({
        enabled: true,
        initialDelayMs: 350,
        maxDelayMs: 12_000,
        maxAttempts: 7,
      })
    })

    it('catches invalid reconnect delay range (initialDelay > maxDelay) safely inside try-catch', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-cfg-invalid-reconn-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'ws')

      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))

      const ctx = new Context()
      const warnSpy = vi.spyOn(ctx.logger, 'warn')
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent } = makeMockAgent('agent-bad-range', ws)

      // initialDelayMs (5000) > maxDelayMs (1000) violates invariant
      expect(() => {
        install(ctx, handles, promptFibers, instancesPath, {
          ...baseConfig,
          instancesPath,
          reconnect: {
            enabled: true,
            initialDelayMs: 5000,
            maxDelayMs: 1000,
            maxAttempts: 5,
          },
        }, agent)
      }).not.toThrow()

      // Prompt is still injected!
      expect(promptFibers.has(agent)).toBe(true)
      // Main connection caught in try-catch and warned
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to initialize main connection for session agent-bad-range'),
      )
    })

    it('gracefully handles missing session cwd without throwing or polluting global state', () => {
      const ctx = new Context()
      const warnSpy = vi.spyOn(ctx.logger, 'warn')
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent, injectSpy } = makeMockAgent('agent-no-cwd', undefined)

      install(ctx, handles, promptFibers, '/dummy/path', baseConfig, agent)

      expect(injectSpy).not.toHaveBeenCalled()
      expect(promptFibers.size).toBe(0)
      expect(handles.size).toBe(0)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no cwd on session agent-no-cwd, skipping vectr binding'),
      )
    })

    it('high-concurrency agent burst test: 50 agents created and disposed concurrently with 0 leaks', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-concurrency-burst-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const codebasesPath = join(dir, 'codebases.json')
      const ws = join(dir, 'ws')

      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))
      await writeFile(codebasesPath, JSON.stringify([
        { id: 'cb1', slug: 'cb-1', type: 'local', path: ws, serverName: 'cb_1', status: 'up', localPort: mockHttpPort, workspace: ws },
      ]))

      const ctx = new Context()
      ;(ctx as any).agents = { list: () => [] }

      let createdHandler: any
      let disposedHandler: any
      let teardownDisposer: any
      vi.spyOn(ctx, 'on').mockImplementation(((evt: string, fn: any) => {
        if (evt === 'agent/created') createdHandler = fn
        if (evt === 'agent/disposed') disposedHandler = fn
      }) as any)
      vi.spyOn(ctx, 'effect').mockImplementation(((fn: any) => {
        teardownDisposer = fn()
      }) as any)

      apply(ctx, { instancesPath, codebasesPath })

      const AGENT_COUNT = 50
      const activeAgents: Agent[] = []
      const mainDisposers: Mock[] = []
      const cbDisposers: Mock[] = []

      startConnectionMock.mockImplementation((_c, spec) => {
        const isCb = (spec as any).serverName !== 'vectr'
        const d = vi.fn().mockResolvedValue(undefined)
        if (isCb) cbDisposers.push(d)
        else mainDisposers.push(d)
        return { ready: Promise.resolve({}), dispose: d }
      })

      for (let i = 0; i < AGENT_COUNT; i++) {
        const { agent } = makeMockAgent(`burst-agent-${i}`, ws)
        activeAgents.push(agent)
        createdHandler({ agent })
      }

      // Wait for all 50 agents * 2 connections = 100 connections
      await vi.waitFor(() => {
        expect(startConnectionMock).toHaveBeenCalledTimes(AGENT_COUNT * 2)
      }, { timeout: 5000, interval: 30 })

      expect(mainDisposers.length).toBe(AGENT_COUNT)
      expect(cbDisposers.length).toBe(AGENT_COUNT)

      // Concurrently dispose first 25 agents
      for (let i = 0; i < 25; i++) {
        disposedHandler({ agent: activeAgents[i] })
      }

      // 25 main + 25 cb disposed
      expect(mainDisposers.slice(0, 25).every((d) => d.mock.calls.length === 1)).toBe(true)
      expect(cbDisposers.slice(0, 25).every((d) => d.mock.calls.length === 1)).toBe(true)

      // Remaining 25 still undisposed
      expect(mainDisposers.slice(25).every((d) => d.mock.calls.length === 0)).toBe(true)
      expect(cbDisposers.slice(25).every((d) => d.mock.calls.length === 0)).toBe(true)

      // Now teardown the plugin
      await teardownDisposer()

      // Remaining 25 must now be disposed by teardown
      expect(mainDisposers.slice(25).every((d) => d.mock.calls.length === 1)).toBe(true)
      expect(cbDisposers.slice(25).every((d) => d.mock.calls.length === 1)).toBe(true)
    })
  })

})
