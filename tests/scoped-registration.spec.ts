/**
 * Scoped-registration test: boot a real ToolRuntime, mint a real agent scope,
 * stand up an in-process Streamable HTTP MCP server as the "vectr daemon",
 * point `instances.json` at it, load the vectr-client plugin, and assert the
 * vectr tools appear in the agent's scope only — then unwind on disposal.
 * Uses the REAL mcp-client supervisor (via the plugin's own imports), so this
 * is an integration test without a Loader boot.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as vectrClient from '../src/index.ts'

const testToolSignal = new AbortController().signal

const roots: string[] = []
const liveContexts = new Set<Context>()

afterEach(async () => {
  for (const ctx of liveContexts) await ctx.fiber.dispose()
  liveContexts.clear()
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

/** sha256(abs path)[:12], the exact registry key vectr writes. */
function keyOf(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex').slice(0, 12)
}

/**
 * Stateless Streamable HTTP endpoint: a fresh McpServer + server transport per
 * request (the SDK's documented stateless pattern). Stands in for a vectr
 * daemon's `/mcp` endpoint.
 */
async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const server = new McpServer(
    { name: 'vectr-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.registerTool('vectr_search', {
    description: 'Semantic code search.',
    inputSchema: { query: z.string().describe('Query') },
  }, async args => ({
    content: [{ type: 'text', text: `search:${String(args.query)}` }],
  }))
  server.registerTool('vectr_status', {
    description: 'Vectr status.',
    inputSchema: {},
  }, async () => ({
    content: [{ type: 'text', text: 'Vectr status\n  Mode: full' }],
  }))
  const transport = new StreamableHTTPServerTransport({})
  res.on('close', () => { void transport.close(); void server.close() })
  await server.connect(transport as Transport)
  await transport.handleRequest(req, res)
}

describe('vectr-client scoped registration', () => {
  let httpServer: Server
  let port: number
  let instancesDir: string
  let cwd: string

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      handleMcpRequest(req, res).catch((error: unknown) => {
        res.writeHead(500).end(String(error))
      })
    })
    const listening: PromiseWithResolvers<void> = Promise.withResolvers()
    httpServer.listen(0, '127.0.0.1', listening.resolve)
    await listening.promise
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error(`expected a TCP AddressInfo, got ${String(address)}`)
    port = address.port
  })

  afterAll(async () => {
    const closed: PromiseWithResolvers<void> = Promise.withResolvers()
    httpServer.close(() => { closed.resolve() })
    await closed.promise
  })

  beforeEach(async () => {
    instancesDir = await mkdtemp(join(tmpdir(), 'dsh-vectr-client-scoped-'))
    roots.push(instancesDir)
    cwd = join(instancesDir, 'workspace')
    await writeFile(join(instancesDir, 'instances.json'), JSON.stringify({
      [keyOf(cwd)]: { workspace: cwd, port, pid: 1, started_at: 0, mode: 'full', host: '127.0.0.1' },
    }))
  })

  /** Mint a real agent scope (injecting tools+systemPrompt, as the loop does) plus a stub Agent whose session cwd is `cwd`. */
  async function mintAgent(ctx: Context): Promise<{ agent: Agent; disposeAgent: () => void; disposeScope: () => Promise<void> }> {
    const session = ctx.sessions.create(SessionId('vectr-scoped-agent'), { meta: { cwd } })
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
    let scope!: import('@deepseek-ai/dsh-scope').Scope
    // The scoped context resolves services through the MINTING plugin's
    // dependency chain — the minter must inject what scope holders will reach
    // (in production the agent loop's inject list plays this role).
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
      { inject: ['tools', 'systemPrompt'] }))
    ;(agent as { ctx: Context }).ctx = scope.ctx.extend({ agent })
    const disposeAgent = ctx.agents.register(agent)
    return { agent, disposeAgent, disposeScope: () => scope.dispose() }
  }

  it('registers the vectr tools in the owning agent scope only, executes them, and unwinds on disposal', async () => {
    const ctx = await mountRegistry()
    liveContexts.add(ctx)
    const { agent, disposeAgent, disposeScope } = await mintAgent(ctx)

    await ctx.plugin({ name: 'vectr-client', inject: ['agents'], apply: vectrClient.apply }, {
      instancesPath: join(instancesDir, 'instances.json'),
    })

    // The plugin seeds live agents at load; discovery settles asynchronously.
    await vi.waitFor(() => {
      expect(ctx.tools.get('mcp__vectr__vectr_search', agent)).toBeDefined()
    }, { timeout: 10_000 })

    // Scoped view only: the global view never sees vectr tools.
    expect(ctx.tools.get('mcp__vectr__vectr_status', agent)).toBeDefined()
    expect(ctx.tools.get('mcp__vectr__vectr_search')).toBeUndefined()

    // The agent's assembled prompt lists them; the global assembly does not.
    const agentAssembly = await ctx.systemPrompt.assemble({ scope: agent })
    expect(agentAssembly.tools.map(t => t.name)).toContain('mcp__vectr__vectr_search')
    const globalAssembly = await ctx.systemPrompt.assemble({})
    expect(globalAssembly.tools.map(t => t.name)).not.toContain('mcp__vectr__vectr_search')

    // Execute through the scoped dispatcher.
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('vectr-call-1'),
      name: 'mcp__vectr__vectr_search',
      arguments: { query: 'lock acquisition' },
      agent,
    })
    expect(result.isError).toBe(false)
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(text).toContain('search:lock acquisition')

    // Disposal unwinds the tools (scope first, then the registry edge).
    await disposeScope()
    disposeAgent()
    await vi.waitFor(() => {
      expect(ctx.tools.get('mcp__vectr__vectr_search', agent)).toBeUndefined()
    }, { timeout: 5_000 })
    expect(ctx.tools.get('mcp__vectr__vectr_status', agent)).toBeUndefined()
  })

  it('skips agents whose workspace has no vectr daemon (no throw, no tools)', async () => {
    const ctx = await mountRegistry()
    liveContexts.add(ctx)
    const other = join(instancesDir, 'elsewhere')
    await writeFile(join(instancesDir, 'instances.json'), JSON.stringify({
      [keyOf(cwd)]: { workspace: cwd, port, pid: 1, started_at: 0 },
    }))
    const session = ctx.sessions.create(SessionId('vectr-no-daemon-agent'), { meta: { cwd: other } })
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
    let scope!: import('@deepseek-ai/dsh-scope').Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
      { inject: ['tools', 'systemPrompt'] }))
    ;(agent as { ctx: Context }).ctx = scope.ctx.extend({ agent })
    const disposeAgent = ctx.agents.register(agent)

    await ctx.plugin({ name: 'vectr-client', inject: ['agents'], apply: vectrClient.apply }, {
      instancesPath: join(instancesDir, 'instances.json'),
    })
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
    expect(ctx.tools.get('mcp__vectr__vectr_search', agent)).toBeUndefined()

    await scope.dispose()
    disposeAgent()
  })
})
