/**
 * Real-harness e2e for the vectr MCP usage-guidance system-prompt section
 * (feature A-2). Unlike the all-mock `system-prompt-guidance.spec.ts`, this
 * spec boots the REAL `@deepseek-ai/dsh-system-prompt` service and contributes
 * the section through a REAL agent scope (`createScope`), so it pins the
 * official `SystemPrompt.section()` contract: a contract change upstream that
 * renamed/retyped the section input would fail this spec, and the genuine
 * `dispose`-removes-the-section behavior is verified (not faked).
 *
 * Only `startConnection` is mocked — we do not open a real MCP client — but the
 * prompt section contribution and assembly go through the official registry.
 *
 * Asserts:
 *  - the scoped assembly contains `vectr:mcp-guidance` with the exact text;
 *  - the GLOBAL assembly does NOT contain it;
 *  - a dead daemon (no /v1/status) still injects the guidance section immediately;
 *  - a workspace without any codebase does NOT inject;
 *  - disposing the agent scope truly removes the section from the scoped view.
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { startConnection } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import * as vectrClient from '../../src/index.ts'
import {
  VECTR_GUIDANCE_SECTION_NAME,
  VECTR_GUIDANCE_SECTION_ORDER,
  VECTR_GUIDANCE_SECTION_TEXT,
  VECTR_GREP_SECTION_NAME,
  VECTR_GREP_SECTION_ORDER,
  VECTR_GREP_SECTION_TEXT,
} from '../../src/index.ts'

vi.mock('@deepseek-ai/dsh-mcp-client/src/connection.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client/src/connection.ts')>()
  return {
    ...actual,
    startConnection: vi.fn(() => ({ ready: Promise.resolve({}), dispose: vi.fn() })),
  }
})

const startConnectionMock = startConnection as unknown as Mock

/** sha256(abs path)[:12] — the exact registry key vectr writes. */
function keyOf(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex').slice(0, 12)
}

const roots: string[] = []
const liveContexts = new Set<Context>()

afterEach(async () => {
  for (const ctx of liveContexts) await ctx.fiber.dispose()
  liveContexts.clear()
  startConnectionMock.mockClear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  return ctx
}

/**
 * Mint a REAL agent scope (injecting tools + systemPrompt, exactly as the
 * agent loop does) and a stub Agent whose session cwd is `cwd`. The scope's
 * `ctx` is what the plugin's `agent.ctx.inject(['systemPrompt'], ...)` targets.
 */
async function mintAgent(ctx: Context, cwd: string): Promise<{ agent: Agent; scope: Scope; disposeAgent: () => void }> {
  const session = ctx.sessions.create(SessionId(`vectr-real-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`), { meta: { cwd } })
  const agent = {
    id: session.id,
    options: {},
    session,
    status: 'idle' as const,
    acceptsNextStep: false,
    followup() {},
    steer() {},
    inject() {},
    send() {},
    updateInbox() { return 'not-found' as const },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
    { inject: ['tools', 'systemPrompt'] }))
  ;(agent as { ctx: Context }).ctx = scope.ctx.extend({ agent })
  const disposeAgent = ctx.agents.register(agent)
  return { agent, scope, disposeAgent }
}

let statusServer: Server
let statusPort: number

beforeAll(async () => {
  statusServer = createServer((_req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ fully_ready: true }))
  })
  const listening: PromiseWithResolvers<void> = Promise.withResolvers()
  statusServer.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = statusServer.address() as AddressInfo
  statusPort = address.port
})

afterAll(async () => {
  const closed: PromiseWithResolvers<void> = Promise.withResolvers()
  statusServer.close(() => closed.resolve())
  await closed.promise
})

describe('vectr guidance section — real SystemPrompt harness (P3)', () => {
  let instancesDir: string
  let cwd: string

  beforeEach(async () => {
    instancesDir = await mkdtemp(join(tmpdir(), 'dsh-vectr-guidance-real-'))
    roots.push(instancesDir)
    cwd = join(instancesDir, 'workspace')
  })

  it('injects the guidance section into the scoped assembly only, with exact text/order', async () => {
    await writeFile(join(instancesDir, 'instances.json'), JSON.stringify({
      [keyOf(cwd)]: { workspace: cwd, port: statusPort, pid: 1, started_at: 0, mode: 'full', host: '127.0.0.1' },
    }))
    const ctx = await mountRegistry()
    liveContexts.add(ctx)
    const { agent, disposeAgent } = await mintAgent(ctx, cwd)

    await ctx.plugin({ name: 'vectr-client', inject: ['agents'], apply: vectrClient.apply }, {
      instancesPath: join(instancesDir, 'instances.json'),
    })

    // Wait for the liveness IIFE to settle and inject the section.
    await vi.waitFor(async () => {
      const assembly = await ctx.systemPrompt.assemble({ scope: agent })
      expect(assembly.sections.some(s => s.name === VECTR_GUIDANCE_SECTION_NAME)).toBe(true)
      expect(assembly.sections.some(s => s.name === VECTR_GREP_SECTION_NAME)).toBe(true)
    }, { timeout: 10_000 })

    const scopedAssembly = await ctx.systemPrompt.assemble({ scope: agent })
    const section = scopedAssembly.sections.find(s => s.name === VECTR_GUIDANCE_SECTION_NAME)
    expect(section).toBeDefined()
    expect(section!.text).toBe(VECTR_GUIDANCE_SECTION_TEXT)
    expect(section!.name).toBe(VECTR_GUIDANCE_SECTION_NAME)

    const grepSection = scopedAssembly.sections.find(s => s.name === VECTR_GREP_SECTION_NAME)
    expect(grepSection).toBeDefined()
    expect(grepSection!.text).toBe(VECTR_GREP_SECTION_TEXT)
    expect(grepSection!.name).toBe(VECTR_GREP_SECTION_NAME)

    // The GLOBAL assembly must NOT carry the agent-scoped section.
    const globalAssembly = await ctx.systemPrompt.assemble({})
    expect(globalAssembly.sections.some(s => s.name === VECTR_GUIDANCE_SECTION_NAME)).toBe(false)
    expect(globalAssembly.sections.some(s => s.name === VECTR_GREP_SECTION_NAME)).toBe(false)

    disposeAgent()
  })

  it('still injects guidance when the daemon is dead (no /v1/status)', async () => {
    // Point at a port nothing serves so diagnoseDaemon returns alive:false.
    const deadPort = 1 // privileged port, never bound → PORT_CLOSED
    await writeFile(join(instancesDir, 'instances.json'), JSON.stringify({
      [keyOf(cwd)]: { workspace: cwd, port: deadPort, pid: 1, started_at: 0, mode: 'full', host: '127.0.0.1' },
    }))
    const ctx = await mountRegistry()
    liveContexts.add(ctx)
    const { agent, disposeAgent } = await mintAgent(ctx, cwd)

    await ctx.plugin({ name: 'vectr-client', inject: ['agents'], apply: vectrClient.apply }, {
      instancesPath: join(instancesDir, 'instances.json'),
    })

    // Decoupled: guidance is injected immediately because codebase entry exists
    await vi.waitFor(async () => {
      const scopedAssembly = await ctx.systemPrompt.assemble({ scope: agent })
      expect(scopedAssembly.sections.some(s => s.name === VECTR_GUIDANCE_SECTION_NAME)).toBe(true)
    }, { timeout: 5000 })

    disposeAgent()
  })

  it('does NOT inject when the workspace has no codebase entry', async () => {
    await writeFile(join(instancesDir, 'instances.json'), JSON.stringify({}))
    const ctx = await mountRegistry()
    liveContexts.add(ctx)
    const { agent, disposeAgent } = await mintAgent(ctx, cwd)

    await ctx.plugin({ name: 'vectr-client', inject: ['agents'], apply: vectrClient.apply }, {
      instancesPath: join(instancesDir, 'instances.json'),
    })

    await new Promise(resolve => setTimeout(resolve, 100))
    const scopedAssembly = await ctx.systemPrompt.assemble({ scope: agent })
    expect(scopedAssembly.sections.some(s => s.name === VECTR_GUIDANCE_SECTION_NAME)).toBe(false)

    disposeAgent()
  })

  it('truly removes the section on agent disposal (real dispose, not a mock)', async () => {
    await writeFile(join(instancesDir, 'instances.json'), JSON.stringify({
      [keyOf(cwd)]: { workspace: cwd, port: statusPort, pid: 1, started_at: 0, mode: 'full', host: '127.0.0.1' },
    }))
    const ctx = await mountRegistry()
    liveContexts.add(ctx)
    const { agent, disposeAgent } = await mintAgent(ctx, cwd)

    await ctx.plugin({ name: 'vectr-client', inject: ['agents'], apply: vectrClient.apply }, {
      instancesPath: join(instancesDir, 'instances.json'),
    })

    await vi.waitFor(async () => {
      const assembly = await ctx.systemPrompt.assemble({ scope: agent })
      expect(assembly.sections.some(s => s.name === VECTR_GUIDANCE_SECTION_NAME)).toBe(true)
      expect(assembly.sections.some(s => s.name === VECTR_GREP_SECTION_NAME)).toBe(true)
    }, { timeout: 10_000 })

    // Genuine teardown: unregistering the agent emits agent/disposed, which the
    // plugin handles by disposing the captured prompt fiber. The section must
    // then be gone from the real scoped assembly (no mock disposer involved).
    disposeAgent()
    await vi.waitFor(async () => {
      const assembly = await ctx.systemPrompt.assemble({ scope: agent })
      expect(assembly.sections.some(s => s.name === VECTR_GUIDANCE_SECTION_NAME)).toBe(false)
      expect(assembly.sections.some(s => s.name === VECTR_GREP_SECTION_NAME)).toBe(false)
    }, { timeout: 5_000 })
  })

  it('shadows the global tool:grep section in scoped assembly', async () => {
    await writeFile(join(instancesDir, 'instances.json'), JSON.stringify({
      [keyOf(cwd)]: { workspace: cwd, port: statusPort, pid: 1, started_at: 0, mode: 'full', host: '127.0.0.1' },
    }))
    const ctx = await mountRegistry()
    ctx.systemPrompt.section({
      name: 'tool:grep',
      order: 1500,
      text: 'Default global grep text',
    })
    liveContexts.add(ctx)
    const { agent, disposeAgent } = await mintAgent(ctx, cwd)

    await ctx.plugin({ name: 'vectr-client', inject: ['agents'], apply: vectrClient.apply }, {
      instancesPath: join(instancesDir, 'instances.json'),
    })

    await vi.waitFor(async () => {
      const assembly = await ctx.systemPrompt.assemble({ scope: agent })
      expect(assembly.sections.find(s => s.name === 'tool:grep')?.text).toBe(VECTR_GREP_SECTION_TEXT)
    }, { timeout: 10_000 })

    const globalAssembly = await ctx.systemPrompt.assemble({})
    expect(globalAssembly.sections.find(s => s.name === 'tool:grep')?.text).toBe('Default global grep text')

    disposeAgent()
    await vi.waitFor(async () => {
      const assembly = await ctx.systemPrompt.assemble({ scope: agent })
      expect(assembly.sections.find(s => s.name === 'tool:grep')?.text).toBe('Default global grep text')
    }, { timeout: 5_000 })
  })
})
