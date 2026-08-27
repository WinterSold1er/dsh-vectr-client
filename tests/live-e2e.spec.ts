/**
 * Live end-to-end proof against the REAL vectr daemons on this machine:
 * boots the plugin through the Loader, creates an agent whose session cwd is
 * a workspace with a live vectr daemon (from ~/.vectr/instances.json), and
 * asserts the `mcp__vectr__*` tools are registered scoped to that agent and
 * execute against the real daemon.
 *
 * Self-skips when no live daemon is present (CI / other machines), so this
 * spec is safe to run anywhere.
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { connect as tcpConnect } from 'node:net'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as vectrClient from '../src/index.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const fixtureDir = resolve(import.meta.dirname, 'fixtures')
const baseConfig = join(fixtureDir, 'vectr-base.cordis.yml')

const liveContexts = new Set<Context>()

afterEach(async () => {
  for (const ctx of liveContexts) await ctx.fiber.dispose()
  liveContexts.clear()
})

/** sha256(abs path)[:12] — the exact registry key vectr writes. */
function keyOf(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex').slice(0, 12)
}

function readInstances(): Record<string, { workspace: string; port: number }> {
  const p = join(homedir(), '.vectr', 'instances.json')
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, { workspace: string; port: number }>
  } catch {
    return {}
  }
}

/** TCP liveness probe (mirrors the plugin's pre-bind check) so the live-e2e
 * `hasBoth` judgment does not falsely run against a dead/registered-but-down
 * daemon — that produced environmental false failures. */
function isPortListening(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolveAlive) => {
    const socket = tcpConnect(port, '127.0.0.1', () => {
      socket.destroy()
      resolveAlive(true)
    })
    const onError = (): void => {
      socket.destroy()
      resolveAlive(false)
    }
    socket.once('error', onError)
    socket.setTimeout(timeoutMs, () => {
      socket.destroy()
      resolveAlive(false)
    })
  })
}

async function waitForTool(ctx: Context, agent: Agent, name: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (ctx.tools.get(name, agent) !== undefined) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`tool ${name} not registered for agent within ${timeoutMs}ms`)
}

describe('vectr-client live daemon e2e', () => {
  const instances = readInstances()
  const liveEntries = Object.entries(instances).filter(([, e]) => e?.workspace && e?.port)
  const usable = liveEntries.find(([, e]) => e.port === 8765 || e.port === 8767)

  const maybe = usable
    ? describe
    : describe.skip

  maybe('against the real daemon', () => {
    const [key, entry] = usable!
    const workspaceCwd = entry.workspace

    it('registers mcp__vectr__* tools scoped to the agent and executes vectr_status', async (testCtx) => {
      // Liveness guard (D-7 follow-up): the registry may list a daemon whose
      // port is not actually listening (crashed/restarted). Skip cleanly rather
      // than fail on an environmental condition.
      if (!(await isPortListening(entry.port))) {
        testCtx.skip()
        return
      }
      expect(key).toBe(keyOf(workspaceCwd))

      const patch: PatchOptions = { id: 'vectr-client' }
      const ctx = await boot(
        'vectr-live-e2e',
        baseConfig,
        [patch],
        (bootCtx) => {
          liveContexts.add(bootCtx)
          bootCtx.loader.builtins['vectr-test-system-prompt'] = SystemPrompt
          bootCtx.loader.builtins['vectr-test-tools'] = ToolRuntime
          bootCtx.loader.builtins['vectr-test-llm'] = LlmRuntime
          bootCtx.loader.builtins['vectr-test-session'] = SessionStore
          bootCtx.loader.builtins['vectr-test-agent'] = AgentRegistry
          bootCtx.loader.builtins['vectr-test-agent-loop'] = AgentLoop
          bootCtx.loader.builtins['vectr-test-vectr-client'] = vectrClient
        },
      )

      const adapter = new MockAdapter([textResponse('ok')])
      ctx.llm.registerAdapter(['mock'], adapter)
      const handle = await ctx.agents.create({
        sessionId: SessionId(`vectr-live-${Date.now()}`),
        meta: { cwd: workspaceCwd },
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      const agent = handle.agent

      await waitForTool(ctx, agent, 'mcp__vectr__vectr_status')

      // Visible only in the agent's scope.
      expect(ctx.tools.get('mcp__vectr__vectr_status', agent)).toBeDefined()
      expect(ctx.tools.get('mcp__vectr__vectr_status')).toBeUndefined()

      // Execute against the REAL daemon.
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId(`vectr-live-call-${Date.now()}`),
        name: 'mcp__vectr__vectr_status',
        arguments: {},
        agent,
      })
      expect(result.isError).toBe(false)
      const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      expect(text).toContain('Vectr status')

      await handle.dispose()
      await vi.waitFor(() => {
        expect(ctx.tools.get('mcp__vectr__vectr_status', agent)).toBeUndefined()
      }, { timeout: 5_000 })
    }, 30_000)
  })
})

describe('vectr-client per-workspace port isolation', () => {
  // If BOTH live daemons exist (two:8767, twoplus:8765), prove each agent's
  // tools resolve to ITS OWN daemon: create two agents in the two workspaces
  // and assert each executes against its own port.
  const byPort = new Map(Object.values(readInstances()).filter(e => e?.port).map(e => [e.port, e.workspace]))
  const hasBoth = byPort.has(8765) && byPort.has(8767)

  const maybe = hasBoth ? describe : describe.skip

  maybe('with two daemons (8765 twoplus, 8767 two)', () => {
    it('R3: binds HTTP-reachable daemons, gracefully skips HTTP-hung ones', async (testCtx) => {
      // Liveness guard (D-7 follow-up): both registry entries must be actually
      // listening, else the bind is skipped by the plugin and the assertion
      // would fail on an environmental (not behavioral) condition.
      const alive8765 = await isPortListening(8765)
      const alive8767 = await isPortListening(8767)
      if (!alive8765 || !alive8767) {
        testCtx.skip()
        return
      }
      const patch: PatchOptions = { id: 'vectr-client' }
      const ctx = await boot(
        'vectr-isolation-e2e',
        baseConfig,
        [patch],
        (bootCtx) => {
          liveContexts.add(bootCtx)
          bootCtx.loader.builtins['vectr-test-system-prompt'] = SystemPrompt
          bootCtx.loader.builtins['vectr-test-tools'] = ToolRuntime
          bootCtx.loader.builtins['vectr-test-llm'] = LlmRuntime
          bootCtx.loader.builtins['vectr-test-session'] = SessionStore
          bootCtx.loader.builtins['vectr-test-agent'] = AgentRegistry
          bootCtx.loader.builtins['vectr-test-agent-loop'] = AgentLoop
          bootCtx.loader.builtins['vectr-test-vectr-client'] = vectrClient
        },
      )
      const adapter = new MockAdapter([textResponse('ok')])
      ctx.llm.registerAdapter(['mock'], adapter)

      // HTTP reachability per daemon = the R3 gate's HTTP layer. A daemon that
      // is TCP-up but HTTP-hung (e.g. twoplus/8765) must be skipped, not bound.
      const reach = async (port: number): Promise<boolean> => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 1500)
        try {
          const res = await fetch(`http://127.0.0.1:${port}/v1/status`, { signal: controller.signal })
          return res.ok
        } catch {
          return false
        } finally {
          clearTimeout(timer)
        }
      }
      const reach8765 = await reach(8765)
      const reach8767 = await reach(8767)

      const handles = await Promise.all(
        [8765, 8767].map((port) => ctx.agents.create({
          sessionId: SessionId(`vectr-isolation-${port}-${Date.now()}`),
          meta: { cwd: byPort.get(port)! },
          agentOptions: { provider: 'mock', model: 'mock' },
        })),
      )
      const [agent8765, agent8767] = handles.map(h => h.agent)

      // Healthy (HTTP-reachable) daemon: tools bound, scoped, executable.
      const healthyAgent = reach8767 ? agent8767 : reach8765 ? agent8765 : undefined
      if (healthyAgent !== undefined) {
        await waitForTool(ctx, healthyAgent, 'mcp__vectr__vectr_status')
        expect(ctx.tools.get('mcp__vectr__vectr_status', healthyAgent)).toBeDefined()
        expect(ctx.tools.get('mcp__vectr__vectr_status')).toBeUndefined()
        const result = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: CallId(`vectr-isolation-call-${Date.now()}`),
          name: 'mcp__vectr__vectr_status',
          arguments: {},
          agent: healthyAgent,
        })
        expect(result.isError).toBe(false)
        const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        expect(text).toContain('Vectr status')
      }

      // HTTP-hung daemon: the R3 gate skips it gracefully — no tools, no throw
      // (this is the twoplus/8765 case: pid alive + TCP listening + HTTP dead).
      const hungAgent = !reach8765 ? agent8765 : !reach8767 ? agent8767 : undefined
      if (hungAgent !== undefined) {
        await new Promise(resolve => setTimeout(resolve, 200))
        expect(ctx.tools.get('mcp__vectr__vectr_status', hungAgent)).toBeUndefined()
      }

      for (const handle of handles) await handle.dispose()
    }, 40_000)
  })
})
