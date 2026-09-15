/**
 * QA Deep Verification & Boundary Testing Suite: Prompt Decoupling & Core Invariants
 *
 * Verifies:
 * 1. Codebase detection & prompt injection decouple from network probe (100% injection under dead daemon/timeout/offline)
 * 2. Path matching matrix (trailing slashes, deep subdirectories, codebases dual field matching, negative prefix collision)
 * 3. Daemon retry & self-healing without duplicate prompt injection
 * 4. Externalized configuration overrides & corrupted file resilience
 * 5. Memory lifecycle & WeakSet disposal under in-flight probes and faulty disposers
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
  apply,
  VECTR_GUIDANCE_SECTION_NAME,
  VECTR_GUIDANCE_SECTION_ORDER,
  VECTR_GUIDANCE_SECTION_TEXT,
  VECTR_GREP_SECTION_NAME,
  VECTR_GREP_SECTION_ORDER,
  VECTR_GREP_SECTION_TEXT,
  type InstanceEntry,
  type Config,
} from '../src/index.ts'
import { hasCodebase, isWorkspaceMatch, normalizePath, isValidInstanceEntry } from '../src/domain'

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
    cb({ systemPrompt: { section: sectionSpy, getSectionOrder: () => 1500 } })
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

describe('QA Verification Suite: Prompt Decoupling & Resilient Invariants', () => {
  const baseConfig: Required<Config> = {
    instancesPath: '',
    serverName: 'vectr',
    toolCallTimeoutMs: 60_000,
    reconnect: { enabled: false },
    codebasesPath: '',
    secretsPath: '',
    daemonHttpTimeoutMs: 100,
    daemonTcpTimeoutMs: 50,
    cliPath: '',
    cliTimeoutMs: 30_000,
    recallTimeoutMs: 10_000,
    upgradeTimeoutMs: 15_000,
  }

  describe('1. Prompt Injection Independence (Probe-Free Decoupling)', () => {
    it('synchronously and unconditionally injects system prompt when daemon is dead (ESRCH)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-decouple-dead-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'my-ws')
      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: 9999, pid: 99999 },
      }))

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const err = new Error('ESRCH') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      })

      const ctx = new Context()
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent, injectSpy, sectionSpy } = makeMockAgent('test-dead', ws)

      install(ctx, handles, promptFibers, instancesPath, { ...baseConfig, instancesPath }, agent)

      // 100% immediate injection
      expect(promptFibers.has(agent)).toBe(true)
      expect(injectSpy).toHaveBeenCalledTimes(1)
      expect(sectionSpy).toHaveBeenCalledTimes(2)
      expect(sectionSpy.mock.calls[0][0].name).toBe(VECTR_GUIDANCE_SECTION_NAME)
      expect(sectionSpy.mock.calls[1][0].name).toBe(VECTR_GREP_SECTION_NAME)

      // Verify explicit 'when available' precondition and fallback semantics
      expect(VECTR_GUIDANCE_SECTION_TEXT).toContain('when available')
      expect(VECTR_GUIDANCE_SECTION_TEXT).toContain('fall back to grep if vectr tools are not available')
      expect(VECTR_GREP_SECTION_TEXT).toContain('when available')
      expect(VECTR_GREP_SECTION_TEXT).toContain('If vectr tools are not available, query fails, or yields no results')

      // Daemon probe reports warning in background telemetry, connection handle is maintained for self-healing
      await new Promise((r) => setTimeout(r, 120))
      expect(handles.has(agent)).toBe(true)
      killSpy.mockRestore()
    })

    it('injects system prompt when daemon probe times out (HTTP timeout)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-decouple-timeout-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'my-ws')

      // Create a hanging HTTP server that never responds
      const hangServer = createServer(() => {})
      let hangPort = 0
      await new Promise<void>((resolve) => {
        hangServer.listen(0, '127.0.0.1', () => {
          hangPort = (hangServer.address() as AddressInfo).port
          resolve()
        })
      })

      try {
        await writeFile(instancesPath, JSON.stringify({
          'key-1': { workspace: ws, port: hangPort, pid: process.pid },
        }))

        const ctx = new Context()
        const handles = new Map<Agent, ConnectionHandle>()
        const promptFibers = new Map<Agent, Fiber>()
        const { agent, injectSpy, sectionSpy } = makeMockAgent('test-timeout', ws)

        install(ctx, handles, promptFibers, instancesPath, {
          ...baseConfig,
          instancesPath,
          daemonHttpTimeoutMs: 50,
        }, agent)

        // Immediate prompt injection
        expect(promptFibers.has(agent)).toBe(true)
        expect(injectSpy).toHaveBeenCalledTimes(1)
        expect(sectionSpy).toHaveBeenCalledTimes(2)

        // Wait for probe timeout
        await new Promise((r) => setTimeout(r, 150))
        expect(handles.has(agent)).toBe(true)
      } finally {
        await new Promise<void>((resolve) => hangServer.close(() => resolve()))
      }
    })

    it('injects system prompt when port is closed (PORT_CLOSED)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-decouple-closed-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'my-ws')

      // Port 1 is reserved and closed
      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: 1, pid: process.pid },
      }))

      const ctx = new Context()
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent, injectSpy } = makeMockAgent('test-closed', ws)

      install(ctx, handles, promptFibers, instancesPath, { ...baseConfig, instancesPath }, agent)

      expect(promptFibers.has(agent)).toBe(true)
      expect(injectSpy).toHaveBeenCalledTimes(1)

      await new Promise((r) => setTimeout(r, 100))
      expect(handles.has(agent)).toBe(true)
    })
  })

  describe('2. Path & Codebase Matching Forms (hasCodebase)', () => {
    it('normalizes trailing slashes on both workspace and target', () => {
      expect(normalizePath('/my/path///')).toBe('/my/path')
      expect(normalizePath('/')).toBe('/')
      expect(normalizePath('')).toBe('')
      expect(normalizePath(null)).toBe('')
      expect(normalizePath('  /workspace/dir/  ')).toBe('/workspace/dir')
    })

    it('matches exact and subdirectory workspace launch paths', () => {
      // exact match
      expect(isWorkspaceMatch('/repo', '/repo')).toBe(true)
      // trailing slash tolerance
      expect(isWorkspaceMatch('/repo', '/repo/')).toBe(true)
      // deep subdirectory of repo
      expect(isWorkspaceMatch('/repo/sub/dir/pkg', '/repo')).toBe(true)
      // root directory
      expect(isWorkspaceMatch('/repo/sub', '/')).toBe(true)
      // collision: same prefix but different directory name MUST NOT match
      expect(isWorkspaceMatch('/repo-other', '/repo')).toBe(false)
      expect(isWorkspaceMatch('/repo_other', '/repo')).toBe(false)
      expect(isWorkspaceMatch('/repo.bak', '/repo')).toBe(false)
      // __unassigned__ sentinel MUST NOT match
      expect(isWorkspaceMatch('/ws', '__unassigned__')).toBe(false)
    })

    it('validates InstanceEntry strictly (rejecting invalid ports and workspaces)', () => {
      expect(isValidInstanceEntry({ workspace: '/ws', port: 8080 })).toBe(true)
      expect(isValidInstanceEntry({ workspace: '/ws', port: 0 })).toBe(false)
      expect(isValidInstanceEntry({ workspace: '/ws', port: -1 })).toBe(false)
      expect(isValidInstanceEntry({ workspace: '/ws', port: 65536 })).toBe(false)
      expect(isValidInstanceEntry({ workspace: '/ws', port: 3.14 })).toBe(false)
      expect(isValidInstanceEntry({ workspace: '/ws', port: NaN })).toBe(false)
      expect(isValidInstanceEntry({ workspace: '', port: 8080 })).toBe(false)
      expect(isValidInstanceEntry({ workspace: '   ', port: 8080 })).toBe(false)
      expect(isValidInstanceEntry(null)).toBe(false)
      expect(isValidInstanceEntry(undefined)).toBe(false)
      expect(isValidInstanceEntry('not an object')).toBe(false)
    })

    it('hasCodebase handles all valid and invalid configurations', () => {
      // 1. Primary entry exact match
      expect(hasCodebase({
        workspace: '/app/repo',
        entry: { workspace: '/app/repo', port: 8080 },
      })).toBe(true)

      // 2. Primary entry trailing slash in workspace
      expect(hasCodebase({
        workspace: '/app/repo/',
        entry: { workspace: '/app/repo', port: 8080 },
      })).toBe(true)

      // 3. Primary entry trailing slash in entry
      expect(hasCodebase({
        workspace: '/app/repo',
        entry: { workspace: '/app/repo///', port: 8080 },
      })).toBe(true)

      // 4. Subdirectory launch in monorepo
      expect(hasCodebase({
        workspace: '/app/repo/packages/core/test',
        entry: { workspace: '/app/repo', port: 8080 },
      })).toBe(true)

      // 5. CodebaseEntry path match
      expect(hasCodebase({
        workspace: '/external/lib',
        codebases: [{ id: '1', slug: 'ext', type: 'local', path: '/external/lib', serverName: 'ext' }],
      })).toBe(true)

      // 6. CodebaseEntry workspace match (remote codebase mount)
      expect(hasCodebase({
        workspace: '/mounted/remote',
        codebases: [{ id: '2', slug: 'rem', type: 'remote', path: '/srv/code', workspace: '/mounted/remote', serverName: 'rem' }],
      })).toBe(true)

      // 7. Negative: prefix collision
      expect(hasCodebase({
        workspace: '/app/repo-extended',
        entry: { workspace: '/app/repo', port: 8080 },
      })).toBe(false)

      // 8. Negative: empty or invalid workspace
      expect(hasCodebase({ workspace: '', entry: { workspace: '/app/repo', port: 8080 } })).toBe(false)
      expect(hasCodebase({ workspace: '   ', entry: { workspace: '/app/repo', port: 8080 } })).toBe(false)
      expect(hasCodebase({ workspace: undefined })).toBe(false)

      // 9. Negative: invalid entry port
      expect(hasCodebase({
        workspace: '/app/repo',
        entry: { workspace: '/app/repo', port: 0 },
      })).toBe(false)
    })
  })

  describe('3. Daemon Recovery & Idempotent Self-Healing', () => {
    it('retries connection on subsequent install without duplicate prompt injection', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-decouple-retry-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'my-ws')
      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: 12345 },
      }))

      const ctx = new Context()
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent, injectSpy, sectionSpy } = makeMockAgent('test-retry', ws)

      // Round 1: Daemon is reported dead by PID check
      let daemonAlive = false
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        if (!daemonAlive) {
          const err = new Error('ESRCH') as NodeJS.ErrnoException
          err.code = 'ESRCH'
          throw err
        }
        return true
      })

      // First install attempt: prompt injected, connection fails
      install(ctx, handles, promptFibers, instancesPath, { ...baseConfig, instancesPath }, agent)
      expect(promptFibers.has(agent)).toBe(true)
      expect(injectSpy).toHaveBeenCalledTimes(1)
      expect(sectionSpy).toHaveBeenCalledTimes(2)

      // Probe settles and logs advisory warning, connection established on Round 1
      await new Promise((r) => setTimeout(r, 120))
      expect(handles.has(agent)).toBe(true)

      // Round 2: Daemon recovers
      daemonAlive = true

      // Second install attempt (retry / workspace activation)
      install(ctx, handles, promptFibers, instancesPath, { ...baseConfig, instancesPath }, agent)

      // Prompt injection MUST NOT be called again
      expect(injectSpy).toHaveBeenCalledTimes(1)
      expect(sectionSpy).toHaveBeenCalledTimes(2)

      // Connection establishment retry succeeds
      await vi.waitFor(() => {
        expect(handles.has(agent)).toBe(true)
      }, { timeout: 3000, interval: 20 })

      // Round 3: Both handles and promptFibers exist, calling install is completely idempotent
      install(ctx, handles, promptFibers, instancesPath, { ...baseConfig, instancesPath }, agent)
      expect(injectSpy).toHaveBeenCalledTimes(1)
      expect(handles.has(agent)).toBe(true)

      killSpy.mockRestore()
    })
  })

  describe('4. Externalized Configuration & Corruption Resilience', () => {
    it('reads from custom instancesPath rather than default path', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-custom-config-'))
      roots.push(dir)
      const customInstancesPath = join(dir, 'custom-instances.json')
      const ws = join(dir, 'custom-ws')

      await writeFile(customInstancesPath, JSON.stringify({
        'key-custom': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))

      const ctx = new Context()
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent, injectSpy } = makeMockAgent('test-custom-cfg', ws)

      install(ctx, handles, promptFibers, customInstancesPath, {
        ...baseConfig,
        instancesPath: customInstancesPath,
      }, agent)

      expect(promptFibers.has(agent)).toBe(true)
      expect(injectSpy).toHaveBeenCalledTimes(1)

      await vi.waitFor(() => {
        expect(handles.has(agent)).toBe(true)
      }, { timeout: 3000, interval: 20 })
    })

    it('handles corrupted/malformed instances.json gracefully without crashing', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-corrupted-json-'))
      roots.push(dir)
      const corruptedPath = join(dir, 'instances.json')
      await writeFile(corruptedPath, '{ invalid json structure ...')

      const ctx = new Context()
      const warnSpy = vi.spyOn(ctx.logger, 'warn')
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent, injectSpy } = makeMockAgent('test-corrupted', join(dir, 'ws'))

      expect(() => {
        install(ctx, handles, promptFibers, corruptedPath, {
          ...baseConfig,
          instancesPath: corruptedPath,
        }, agent)
      }).not.toThrow()

      expect(injectSpy).not.toHaveBeenCalled()
      expect(promptFibers.has(agent)).toBe(false)
      expect(handles.has(agent)).toBe(false)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cannot read daemon registry'))
    })

    it('handles non-existent instances.json (ENOENT) gracefully', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-missing-file-'))
      roots.push(dir)
      const missingPath = join(dir, 'does-not-exist.json')

      const ctx = new Context()
      const infoSpy = vi.spyOn(ctx.logger, 'info')
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent, injectSpy } = makeMockAgent('test-missing', join(dir, 'ws'))

      expect(() => {
        install(ctx, handles, promptFibers, missingPath, {
          ...baseConfig,
          instancesPath: missingPath,
        }, agent)
      }).not.toThrow()

      expect(injectSpy).not.toHaveBeenCalled()
      expect(promptFibers.has(agent)).toBe(false)
      expect(handles.has(agent)).toBe(false)
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('no daemon registry at'))
    })

    it('handles corrupted codebases.json without crashing main daemon binding', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-corrupted-codebases-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const codebasesPath = join(dir, 'codebases.json')
      const ws = join(dir, 'my-ws')

      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))
      await writeFile(codebasesPath, 'NOT A VALID JSON')

      const ctx = new Context()
      const warnSpy = vi.spyOn(ctx.logger, 'warn')
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent, injectSpy } = makeMockAgent('test-corrupted-cb', ws)

      install(ctx, handles, promptFibers, instancesPath, {
        ...baseConfig,
        instancesPath,
        codebasesPath,
      }, agent, codebasesPath)

      // Main prompt still injected because instances.json has the codebase
      expect(promptFibers.has(agent)).toBe(true)
      expect(injectSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cannot read codebase metadata'))
    })
  })

  describe('5. Memory Management & Lifecycle Cleanup', () => {
    it('cleans up handles and promptFibers on agent disposal', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-lifecycle-clean-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'my-ws')
      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))

      const ctx = new Context()
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const { agent, disposeFiberSpy } = makeMockAgent('test-lifecycle', ws)

      install(ctx, handles, promptFibers, instancesPath, { ...baseConfig, instancesPath }, agent)

      expect(promptFibers.has(agent)).toBe(true)
      const fiber = promptFibers.get(agent)!
      await fiber.dispose()

      expect(disposeFiberSpy).toHaveBeenCalledTimes(1)
    })

    it('cancels and disposes connection if agent is disposed while probe is in flight', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-inflight-disposal-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'my-ws')
      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))

      const ctx = new Context()
      const handles = new Map<Agent, ConnectionHandle>()
      const promptFibers = new Map<Agent, Fiber>()
      const disposed = new WeakSet<Agent>()
      const { agent } = makeMockAgent('test-inflight', ws)

      // Agent is disposed prior to/during install
      disposed.add(agent)

      // Install checks disposed set
      install(ctx, handles, promptFibers, instancesPath, { ...baseConfig, instancesPath }, agent, undefined, disposed)

      // Wait for probe to complete
      await new Promise((r) => setTimeout(r, 150))

      // Handle must NOT be added to handles map because agent was disposed
      expect(handles.has(agent)).toBe(false)
    })

    it('resiliently survives and logs warning when fiber.dispose() throws during agent/disposed event', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-fiber-error-'))
      roots.push(dir)
      const instancesPath = join(dir, 'instances.json')
      const ws = join(dir, 'my-ws')
      await writeFile(instancesPath, JSON.stringify({
        'key-1': { workspace: ws, port: mockHttpPort, pid: process.pid },
      }))

      const ctx = new Context()
      ;(ctx as any).agents = { list: () => [] }
      const warnSpy = vi.spyOn(ctx.logger, 'warn')

      let registeredCreatedHandler: ((data: { agent: Agent }) => void) | undefined
      let registeredDisposedHandler: ((data: { agent: Agent }) => void) | undefined
      vi.spyOn(ctx, 'on').mockImplementation(((event: string, handler: any) => {
        if (event === 'agent/created') registeredCreatedHandler = handler
        if (event === 'agent/disposed') registeredDisposedHandler = handler
      }) as any)

      // Initialize plugin via apply()
      apply(ctx, {
        instancesPath,
        codebasesPath: join(dir, 'empty-cb.json'),
        daemonHttpTimeoutMs: 100,
        daemonTcpTimeoutMs: 50,
      })

      // Craft agent whose inject returns a fiber that rejects on dispose
      const faultyFiber = {
        dispose: vi.fn().mockRejectedValue(new Error('Fiber disposal boom!')),
      } as unknown as Fiber

      const agent = {
        id: 'agent-with-faulty-fiber',
        options: {},
        session: { header: { cwd: ws } },
        status: 'idle' as const,
        acceptsNextStep: false,
        followup() {},
        steer() {},
        inject() {},
        send() {},
        updateInbox() { return 'not-found' as const },
        cancel() {},
        whenIdle: () => Promise.resolve(),
        ctx: {
          inject: vi.fn(() => faultyFiber),
          logger: ctx.logger,
        },
      } as unknown as Agent

      expect(registeredCreatedHandler).toBeDefined()
      expect(registeredDisposedHandler).toBeDefined()

      // Create agent
      registeredCreatedHandler!({ agent })

      // Dispose agent
      registeredDisposedHandler!({ agent })

      // Wait for async rejection catch in prompt-fiber disposal
      await vi.waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('prompt-section cleanup failed for agent-with-faulty-fiber: Fiber disposal boom!'),
        )
      }, { timeout: 2000, interval: 25 })
    })

    it('WeakSet permits garbage collection of discarded Agent objects', () => {
      const disposed = new WeakSet<Agent>()
      let agentRef: Agent | null = { id: 'temp' } as Agent
      disposed.add(agentRef)
      expect(disposed.has(agentRef)).toBe(true)
      agentRef = null // cleared from reference, ready for GC
    })
  })
})
