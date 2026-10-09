import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  getVectrGuidanceText,
  getVectrGrepText,
  VECTR_GUIDANCE_SECTION_NAME,
  VECTR_GUIDANCE_SECTION_ORDER,
  VECTR_GUIDANCE_SECTION_TEXT,
  VECTR_GREP_SECTION_NAME,
  VECTR_GREP_SECTION_ORDER,
  VECTR_GREP_SECTION_TEXT,
  DEFAULT_SERVER_NAME,
  install,
  type ConnectionHandle,
  type Fiber,
} from '../src/index.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Absolute Negative Constraint & Mandatory Fallback Chain Prompting', () => {
  describe('1. Guidance Prompt Invariants', () => {
    it('enforces absolute negative constraint forbidding initial grep/glob/shell search', () => {
      const text = getVectrGuidanceText('vectr')
      expect(text).toContain('ABSOLUTE NEGATIVE CONSTRAINT')
      expect(text).toContain('DO NOT invoke grep, glob, or bash search commands')
      expect(text).toContain('strictly prohibited')
    })

    it('enforces preemptive exception closing forbidding skipping because files are known or executing a plan', () => {
      const text = getVectrGuidanceText('vectr')
      expect(text).toContain('PREEMPTIVE RESTRICTION')
      expect(text).toContain('already known')
      expect(text).toContain('executing a')
    })

    it('enforces subagent and team propagation rules', () => {
      const text = getVectrGuidanceText('vectr')
      expect(text).toContain('SUBAGENT & TEAM PROPAGATION')
      expect(text).toContain('subagent, teammate, or child agent')
    })

    it('defines mandatory first attempt with specific tool routing', () => {
      const serverName = 'my_vectr'
      const text = getVectrGuidanceText(serverName)
      expect(text).toContain('MANDATORY FIRST ATTEMPT')
      expect(text).toContain(`mcp__${serverName}*`)
      expect(text).toContain(`mcp__${serverName}__vectr_search(query="..."`)
      expect(text).toContain(`mcp__${serverName}__vectr_locate(name="..."`)
      expect(text).toContain(`mcp__${serverName}__vectr_trace(name="..."`)
    })

    it('enforces mandatory fallback chain only after vectr failure or zero results', () => {
      const text = getVectrGuidanceText('vectr')
      expect(text).toContain('MANDATORY FALLBACK CHAIN')
      expect(text).toContain('ONLY fall back to grep if vectr tools are not available, query fails, or yields no results')
      expect(text).toContain('MUST explicitly state the reason in your reasoning')
    })

    it('preserves default export VECTR_GUIDANCE_SECTION_TEXT matching default serverName', () => {
      expect(VECTR_GUIDANCE_SECTION_TEXT).toBe(getVectrGuidanceText(DEFAULT_SERVER_NAME))
      expect(VECTR_GUIDANCE_SECTION_TEXT).toContain(`mcp__${DEFAULT_SERVER_NAME}*`)
    })
  })

  describe('2. Grep Shadow Section Invariants', () => {
    it('shadows grep with critical restriction and negative constraint', () => {
      const text = getVectrGrepText('vectr')
      expect(text).toContain('CRITICAL RESTRICTION ON GREP')
      expect(text).toContain('DO NOT invoke grep as your initial tool')
      expect(text).toContain('MANDATORY FALLBACK RULE')
      expect(text).toContain('If vectr tools are not available, query fails, or yields no results')
    })

    it('dynamically adapts grep shadow text to custom serverName', () => {
      const customServer = 'enterprise_vectr'
      const text = getVectrGrepText(customServer)
      expect(text).toContain(`mcp__${customServer}*`)
      expect(text).toContain('Prioritize querying code via vectr tools')
    })

    it('preserves default export VECTR_GREP_SECTION_TEXT matching default serverName', () => {
      expect(VECTR_GREP_SECTION_TEXT).toBe(getVectrGrepText(DEFAULT_SERVER_NAME))
      expect(VECTR_GREP_SECTION_TEXT).toContain(`mcp__${DEFAULT_SERVER_NAME}*`)
    })
  })

  describe('3. Agent Scope Injection Integration', () => {
    it('injects both the negative constraint guidance and grep shadow into agent scope', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'test-prompt-constraint-'))
      try {
        const instancesPath = join(dir, 'instances.json')
        const ws = join(dir, 'test-ws')
        await writeFile(instancesPath, JSON.stringify({
          'entry-1': { workspace: ws, port: 9999, pid: process.pid },
        }))

        const ctx = new Context()
        const handles = new Map<Agent, ConnectionHandle>()
        const promptFibers = new Map<Agent, Fiber>()

        const sections: Array<{ name: string; order: number; text: string }> = []
        const mockAgent = {
          id: 'test-agent-constraint',
          session: { header: { cwd: ws } },
          ctx: {
            logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
            inject: (_deps: string[], cb: (scope: any) => void) => {
              cb({
                systemPrompt: {
                  section: (s: any) => sections.push(s),
                  getSectionOrder: () => 1500,
                },
              })
              return { dispose: async () => {} }
            },
          },
        } as unknown as Agent

        install(
          ctx,
          handles,
          promptFibers,
          instancesPath,
          {
            instancesPath,
            serverName: 'custom_srv',
            autoStart: false,
            daemonTcpTimeoutMs: 500,
            cliPath: '',
            cliTimeoutMs: 500,
            recallTimeoutMs: 500,
            upgradeTimeoutMs: 500,
            reconnect: { maxRetries: 0, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 1.5 },
          },
          mockAgent,
        )

        expect(sections.length).toBe(2)
        const guidance = sections.find((s) => s.name === VECTR_GUIDANCE_SECTION_NAME)
        const grep = sections.find((s) => s.name === VECTR_GREP_SECTION_NAME)

        expect(guidance).toBeDefined()
        expect(guidance!.order).toBe(VECTR_GUIDANCE_SECTION_ORDER)
        expect(guidance!.text).toBe(getVectrGuidanceText('custom_srv'))
        expect(guidance!.text).toContain('ABSOLUTE NEGATIVE CONSTRAINT')

        expect(grep).toBeDefined()
        expect(grep!.order).toBe(1500)
        expect(grep!.text).toBe(getVectrGrepText('custom_srv'))
        expect(grep!.text).toContain('CRITICAL RESTRICTION ON GREP')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('does NOT inject code retrieval guidance or grep shadow when workspace is memory_only with no mounted codebases', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'test-prompt-memory-only-'))
      try {
        const instancesPath = join(dir, 'instances.json')
        const ws = join(dir, 'test-mem-ws')
        await writeFile(instancesPath, JSON.stringify({
          'entry-mem': { workspace: ws, port: 9999, pid: process.pid, mode: 'memory_only' },
        }))

        const ctx = new Context()
        const handles = new Map<Agent, ConnectionHandle>()
        const promptFibers = new Map<Agent, Fiber>()

        const sections: Array<{ name: string; order: number; text: string }> = []
        const mockAgent = {
          id: 'test-agent-mem',
          session: { header: { cwd: ws } },
          ctx: {
            logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
            inject: (_deps: string[], cb: (scope: any) => void) => {
              cb({
                systemPrompt: {
                  section: (s: any) => sections.push(s),
                  getSectionOrder: () => 1500,
                },
              })
              return { dispose: async () => {} }
            },
          },
        } as unknown as Agent

        install(
          ctx,
          handles,
          promptFibers,
          instancesPath,
          {
            instancesPath,
            serverName: 'vectr',
            autoStart: false,
            daemonTcpTimeoutMs: 500,
            cliPath: '',
            cliTimeoutMs: 500,
            recallTimeoutMs: 500,
            upgradeTimeoutMs: 500,
            reconnect: { enabled: false },
          },
          mockAgent,
        )

        // For memory-only workspace with no codebase, no code retrieval guidance should be injected!
        expect(sections.length).toBe(0)
        expect(sections.find((s) => s.name === VECTR_GUIDANCE_SECTION_NAME)).toBeUndefined()
        expect(sections.find((s) => s.name === VECTR_GREP_SECTION_NAME)).toBeUndefined()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('DOES inject code retrieval guidance and grep shadow when memory_only workspace has an external mounted codebase', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'test-prompt-mem-with-codebase-'))
      try {
        const instancesPath = join(dir, 'instances.json')
        const codebasesPath = join(dir, 'vectr-codebases.json')
        const ws = join(dir, 'test-mem-ws')
        await writeFile(instancesPath, JSON.stringify({
          'entry-mem': { workspace: ws, port: 9999, pid: process.pid, mode: 'memory_only' },
        }))
        await writeFile(codebasesPath, JSON.stringify([
          {
            slug: 'external-repo',
            type: 'local',
            workspace: ws,
            path: '/path/to/external-repo',
            serverName: 'external_vectr',
            localPort: 8888,
          },
        ]))

        const ctx = new Context()
        const handles = new Map<Agent, ConnectionHandle>()
        const promptFibers = new Map<Agent, Fiber>()

        const sections: Array<{ name: string; order: number; text: string }> = []
        const mockAgent = {
          id: 'test-agent-mem-cb',
          session: { header: { cwd: ws } },
          ctx: {
            logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
            inject: (_deps: string[], cb: (scope: any) => void) => {
              cb({
                systemPrompt: {
                  section: (s: any) => sections.push(s),
                  getSectionOrder: () => 1500,
                },
              })
              return { dispose: async () => {} }
            },
          },
        } as unknown as Agent

        install(
          ctx,
          handles,
          promptFibers,
          instancesPath,
          {
            instancesPath,
            serverName: 'vectr',
            autoStart: false,
            daemonTcpTimeoutMs: 500,
            cliPath: '',
            cliTimeoutMs: 500,
            recallTimeoutMs: 500,
            upgradeTimeoutMs: 500,
            reconnect: { enabled: false },
          },
          mockAgent,
          codebasesPath,
        )

        expect(sections.length).toBe(2)
        expect(sections.find((s) => s.name === VECTR_GUIDANCE_SECTION_NAME)).toBeDefined()
        expect(sections.find((s) => s.name === VECTR_GREP_SECTION_NAME)).toBeDefined()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })
})
