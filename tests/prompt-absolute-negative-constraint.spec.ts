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
  })
})
