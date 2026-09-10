/**
 * REAL-composition test (per docs/testing.md + packages/AGENTS.md): boot a
 * minimal `cordis.yml` through the real Cordis Loader (`@deepseek-ai/dsh-app-boot`
 * `boot()`), mapping the bare rows to source builtins, with an in-process
 * Streamable HTTP server standing in for the vectr daemon, a temp HOME whose
 * `instances.json` maps the agent's session cwd to that port, a real agent
 * created through the registry, and the vectr tool discovered, executed, then
 * unwound on agent disposal.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId as CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as vectrClient from '../src/index.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const fixtureDir = resolve(import.meta.dirname, 'fixtures')
const baseConfig = join(fixtureDir, 'vectr-base.cordis.yml')

const liveContexts = new Set<Context>()
const roots: string[] = []

afterEach(async () => {
  for (const ctx of liveContexts) await ctx.fiber.dispose()
  liveContexts.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** sha256(abs path)[:12], the exact registry key vectr writes. */
function keyOf(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex').slice(0, 12)
}

/**
 * Stateless Streamable HTTP endpoint standing in for a vectr daemon's `/mcp`.
 */
async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const server = new McpServer(
    { name: 'vectr-fixture', version: '1.9.0' },
    { capabilities: { tools: {} } },
  )
  server.registerTool('vectr_search', {
    description: 'Semantic code search.',
    inputSchema: { query: z.string().describe('Query') },
  }, async args => ({
    content: [{ type: 'text', text: `search:${String(args.query)}` }],
  }))
  const transport = new StreamableHTTPServerTransport({})
  res.on('close', () => { void transport.close(); void server.close() })
  await server.connect(transport as Transport)
  await transport.handleRequest(req, res)
}

async function waitForTool(ctx: Context, agent: import('@deepseek-ai/dsh-agent').Agent, name: string): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.tools.get(name, agent)).toBeDefined()
  }, { timeout: 10_000 })
}

describe('vectr-client real composition', () => {
  let httpServer: Server
  let port: number
  let instancesDir: string
  let workspaceCwd: string

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      // R3: the liveness gate probes /v1/status; a real vectr daemon answers 2xx.
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/v1/status') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ fully_ready: true }))
        return
      }
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
    instancesDir = await mkdtemp(join(tmpdir(), 'dsh-vectr-client-composition-'))
    roots.push(instancesDir)
    workspaceCwd = join(instancesDir, 'workspace')
  })

  it('boots through the Loader, registers scoped vectr tools, executes them, and unwinds on disposal', async () => {
    const instancesPath = join(instancesDir, 'instances.json')
    await writeFile(instancesPath, JSON.stringify({
      [keyOf(workspaceCwd)]: { workspace: workspaceCwd, port, pid: 1, started_at: 0, mode: 'full', host: '127.0.0.1' },
    }))

    const patch: PatchOptions = {
      id: 'vectr-client',
      config: { instancesPath },
    }
    const ctx = await boot(
      'vectr-composition-test',
      baseConfig,
      [patch],
      (bootCtx) => {
        liveContexts.add(bootCtx)
        bootCtx.loader.builtins['vectr-test-system-prompt'] = SystemPrompt
        bootCtx.loader.builtins['vectr-test-tools'] = ToolRuntime
        bootCtx.loader.builtins['vectr-test-llm'] = LlmRuntime
        bootCtx.loader.builtins['vectr-test-session'] = SessionStore
        bootCtx.loader.builtins['vectr-test-agent'] = AgentRegistry
        bootCtx.loader.builtins['vectr-test-session-projections'] = {
          name: 'vectr-test-session-projections',
          apply(c: Context) {
            c.provide('sessionProjections', {
              register: () => {},
              stateOf: () => undefined,
            })
          },
        }
        bootCtx.loader.builtins['vectr-test-agent-loop'] = AgentLoop
        bootCtx.loader.builtins['vectr-test-vectr-client'] = vectrClient
      },
    )

    // The agent-loop row in the yml creates no agents, so mount a mock adapter
    // and create one agent through the real registry with the workspace cwd.
    const adapter = new MockAdapter([textResponse('ok')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('vectr-composition-agent'),
      meta: { cwd: workspaceCwd },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = handle.agent

    await waitForTool(ctx, agent, 'mcp__vectr__vectr_search')

    // The tool is visible only in the agent's scope.
    expect(ctx.tools.get('mcp__vectr__vectr_search', agent)).toBeDefined()
    expect(ctx.tools.get('mcp__vectr__vectr_search')).toBeUndefined()

    // Execute it through the scoped dispatcher.
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('vectr-composition-call-1'),
      name: 'mcp__vectr__vectr_search',
      arguments: { query: 'lock acquisition' },
      agent,
    })
    expect(result.isError).toBe(false)
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(text).toContain('search:lock acquisition')

    // Disposing the agent unwinds the scoped tools.
    await handle.dispose()
    await vi.waitFor(() => {
      expect(ctx.tools.get('mcp__vectr__vectr_search', agent)).toBeUndefined()
    }, { timeout: 5_000 })
    expect(ctx.agents.get(SessionId('vectr-composition-agent'))).toBeUndefined()
  }, 20_000)
})
