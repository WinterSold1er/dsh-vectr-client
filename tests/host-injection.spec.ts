/**
 * Host working-memory injection tests: boot recall, per-turn prompt recall,
 * tool-anchored gotchas, compaction lifecycle, gating, dedupe, and degradation.
 *
 * The HTTP boundary is injected (`RecallClient` / `post`) so assertions are on
 * the exact upstream request shape rather than on a mock of this module.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  apply,
  getVectrMemoryText,
  install,
  VECTR_GUIDANCE_SECTION_NAME,
  VECTR_GREP_SECTION_NAME,
  VECTR_MEMORY_SECTION_NAME,
  VECTR_MEMORY_SECTION_ORDER,
  type Config,
  type InstanceEntry,
} from '../src/index.ts'
import {
  HostInjector,
  dedupeNotes,
  lastHumanPrompt,
  toolProbe,
  type InjectionConfig,
  type InjectionLogger,
  type PreStepPayload,
  type RecallClient,
} from '../src/injection.ts'
import type { RecallOptions } from '../src/domain/types.ts'
import { VectrApiClient } from '../src/infra/api-client.ts'

vi.mock('@deepseek-ai/dsh-mcp-client/src/connection.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client/src/connection.ts')>()
  return {
    ...actual,
    startConnection: vi.fn(() => ({ ready: Promise.resolve({}), dispose: vi.fn() })),
  }
})

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function config(overrides: Partial<InjectionConfig> = {}): InjectionConfig {
  return {
    bootRecallTimeoutMs: 50,
    promptRecallTimeoutMs: 50,
    toolRecallTimeoutMs: 50,
    promptRecallLimit: 3,
    perTurnTokenCap: 500,
    perSessionTokenCap: 8000,
    maxInjectionChars: 4000,
    injectCompactionSnapshot: true,
    ...overrides,
  }
}

function makeAgent(id = 'agent-1'): Agent {
  const session = { id }
  return { id, session } as unknown as Agent
}

function human(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function step(
  agent: Agent,
  messages: UserMessage[],
  turn = 1,
  stepNumber = 1,
): PreStepPayload {
  return { agent, messages, turn, step: stepNumber, signal: new AbortController().signal }
}

function loggerSpy(): { logger: InjectionLogger; warnings: string[] } {
  const warnings: string[] = []
  return { logger: { warn: (message: string) => { warnings.push(message) } }, warnings }
}

interface RecallCall {
  host: string
  port: number
  options: RecallOptions
  timeoutMs: number
}

function recordingClient(
  notes: string | ((options: RecallOptions) => string),
): { client: RecallClient; calls: RecallCall[] } {
  const calls: RecallCall[] = []
  const client: RecallClient = {
    async recall(host, port, options, timeoutMs) {
      calls.push({ host, port, options, timeoutMs })
      return { ok: true, notes: typeof notes === 'function' ? notes(options) : notes }
    },
  }
  return { client, calls }
}

function enter(messages: UserMessage[] = []): PostToolDecision | { kind: 'enter'; messages: UserMessage[] } {
  return { kind: 'enter', messages }
}

function injectedText(message: UserMessage | undefined): string {
  if (message === undefined) return ''
  return message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

describe('G1 working-memory doctrine section', () => {
  it('is static, names the supersession/trigger contract, and carries no tool table', () => {
    const text = getVectrMemoryText()
    expect(text).toContain('vectr_remember')
    expect(text).toContain('supersedes')
    expect(text).toContain('contradicts')
    expect(text).toContain('triggers')
    expect(text).toContain('agent=')
    expect(text).not.toContain('vectr_forget')
    expect(text).not.toContain('ToolSearch')
    expect(text).not.toContain('vectr_search')
    expect(text).not.toContain('| Tool |')
    expect(text.split('\n').length).toBeLessThanOrEqual(25)
    expect(VECTR_MEMORY_SECTION_ORDER).toBe(96)
    expect(VECTR_MEMORY_SECTION_NAME).toBe('vectr:working-memory')
  })

  it('registers only the memory section when a daemon is bound but no codebase is indexed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-injection-'))
    roots.push(dir)
    const cwd = join(dir, 'ws')
    const instancesFile = join(dir, 'instances.json')
    const entry: InstanceEntry = {
      workspace: cwd,
      port: 1234,
      pid: 99_999,
      started_at: 0,
      mode: 'memory_only',
      host: '127.0.0.1',
    }
    await writeFile(instancesFile, JSON.stringify({ [cwd]: entry }))

    const sections: { name: string; order: number; text: unknown }[] = []
    const sectionSpy = vi.fn((section: { name: string; order: number; text: unknown }) => {
      sections.push(section)
      return () => {}
    })
    const agent = {
      id: 'memory-only',
      session: { header: { cwd } },
      ctx: {
        inject: vi.fn((_deps: string[], callback: (scope: unknown) => void) => {
          callback({ systemPrompt: { section: sectionSpy } })
          return { dispose: vi.fn(async () => {}) }
        }),
        logger: new Context().logger,
      },
    } as unknown as Agent

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('no such process') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })

    install(new Context(), new Map(), new Map(), instancesFile, {
      instancesPath: instancesFile,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
      daemonHttpTimeoutMs: 5000,
      daemonTcpTimeoutMs: 300,
    } as unknown as Config, agent)

    expect(sections.map(section => section.name)).toEqual([VECTR_MEMORY_SECTION_NAME])
    expect(sections[0]?.text).toBe(getVectrMemoryText())
    expect(sections.some(section => section.name === VECTR_GUIDANCE_SECTION_NAME)).toBe(false)
    expect(sections.some(section => section.name === VECTR_GREP_SECTION_NAME)).toBe(false)
    killSpy.mockRestore()
  })
})

describe('G2 boot recall', () => {
  it('prefetches boot with the hook payload and injects it as a vectr user message', async () => {
    const agent = makeAgent()
    const { client, calls } = recordingClient(options => (options.boot === true ? 'directive [#3] · always run pnpm test' : ''))
    const { logger } = loggerSpy()
    const injector = new HostInjector({ logger, config: config(), client })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: false })
    injector.prefetchBoot(agent)

    const decision = await injector.onPreStep(step(agent, [human('hello')]), async () => enter())

    expect(calls[0]).toMatchObject({
      host: '127.0.0.1',
      port: 4242,
      options: {
        boot: true,
        hook_event: 'SessionStart',
        session_id: 'agent-1',
        events: ['session-start'],
      },
    })
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const injected = decision.messages.at(-1)
    expect(injected?.role).toBe('user')
    expect(injected?.source.kind).toBe('vectr')
    expect(injectedText(injected)).toContain('directive [#3] · always run pnpm test')
    expect(injectedText(injected)).toContain('auto-injected at session start')
  })

  it('injects nothing when boot recall returns empty text', async () => {
    const agent = makeAgent()
    const { client } = recordingClient('')
    const { logger } = loggerSpy()
    const injector = new HostInjector({ logger, config: config(), client })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: false })
    injector.prefetchBoot(agent)

    const decision = await injector.onPreStep(step(agent, []), async () => enter())

    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') expect(decision.messages).toHaveLength(0)
  })

  it('never blocks the step when the boot recall exceeds its budget, and warns once', async () => {
    const agent = makeAgent()
    const hanging: RecallClient = { recall: () => new Promise(() => {}) }
    const { logger, warnings } = loggerSpy()
    const injector = new HostInjector({ logger, config: config({ bootRecallTimeoutMs: 30 }), client: hanging })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: false })
    injector.prefetchBoot(agent)

    const started = Date.now()
    const decision = await injector.onPreStep(step(agent, []), async () => enter())
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(500)
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') expect(decision.messages).toHaveLength(0)
    expect(warnings.filter(message => message.includes('boot recall timed out'))).toHaveLength(1)
  })
})

describe('G3 prompt-submit recall', () => {
  it('queries once per turn with the human prompt and dedupes repeated note ids', async () => {
    const agent = makeAgent()
    const { client, calls } = recordingClient(options => (options.hook_event === 'UserPromptSubmit' ? '[#12] gotcha: use pnpm' : ''))
    const { logger } = loggerSpy()
    const injector = new HostInjector({ logger, config: config(), client })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: false })
    injector.prefetchBoot(agent)

    const first = await injector.onPreStep(step(agent, [human('how do I build?')], 1, 1), async () => enter([human('how do I build?')]))
    const promptCalls = calls.filter(call => call.options.hook_event === 'UserPromptSubmit')
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0]?.options).toMatchObject({
      query: 'how do I build?',
      limit: 3,
      detail: 'index',
      events: ['prompt-submit'],
      session_id: 'agent-1',
    })
    expect(first.kind).toBe('enter')
    if (first.kind === 'enter') expect(injectedText(first.messages.at(-1))).toContain('[#12] gotcha: use pnpm')

    // Same turn, later step: no second prompt recall.
    await injector.onPreStep(step(agent, [], 1, 2), async () => enter())
    expect(calls.filter(call => call.options.hook_event === 'UserPromptSubmit')).toHaveLength(1)

    // Next turn re-queries, but the already-delivered note is dropped.
    const second = await injector.onPreStep(step(agent, [human('next question')], 2, 1), async () => enter([human('next question')]))
    expect(calls.filter(call => call.options.hook_event === 'UserPromptSubmit')).toHaveLength(2)
    if (second.kind === 'enter') expect(second.messages.filter(m => m.source.kind === 'vectr')).toHaveLength(0)
  })

  it('ignores its own injected messages as prompts', async () => {
    const agent = makeAgent()
    const { client, calls } = recordingClient('')
    const { logger } = loggerSpy()
    const injector = new HostInjector({ logger, config: config(), client })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: false })

    const ownMessage = createUserMessage({
      content: [{ type: 'text', text: 'Vectr working memory relevant to this prompt' }],
      source: { kind: 'vectr', form: 'notice', summary: 'vectr memory' },
    })
    await injector.onPreStep(step(agent, [ownMessage]), async () => enter([ownMessage]))

    expect(calls.filter(call => call.options.hook_event === 'UserPromptSubmit')).toHaveLength(0)
  })

  it('stops injecting once the per-session token cap is spent', async () => {
    const agent = makeAgent()
    const { client } = recordingClient(options => (options.boot === true ? 'boot [#1] directive body' : ''))
    const { logger } = loggerSpy()
    const injector = new HostInjector({
      logger,
      config: config({ perSessionTokenCap: 0 }),
      client,
    })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: false })
    injector.prefetchBoot(agent)

    const decision = await injector.onPreStep(step(agent, []), async () => enter())
    if (decision.kind === 'enter') expect(decision.messages).toHaveLength(0)
  })
})

describe('G4 tool-anchored gotchas', () => {
  function toolExec(agent: Agent, name: string, args: unknown): ToolExecution {
    return { name, arguments: args, agent } as unknown as ToolExecution
  }

  it('appends additionalContexts and preserves the tool result by reference', async () => {
    const agent = makeAgent()
    const { client } = recordingClient('[#9] gotcha: this file is generated')
    const { logger } = loggerSpy()
    const injector = new HostInjector({ logger, config: config(), client })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: true })

    const original: PostToolDecision = { kind: 'accept', content: [{ type: 'text', text: 'edited' }] }
    const decision = await injector.onPostExecute(
      toolExec(agent, 'edit', { file_path: 'src/generated.ts' }),
      async () => original,
    )

    expect(decision.kind).toBe('accept')
    if (decision.kind !== 'accept') return
    expect(decision.content).toBe(original.content)
    expect(decision.additionalContexts).toHaveLength(1)
    expect(decision.additionalContexts?.[0]?.source.kind).toBe('vectr')
    expect(injectedText(decision.additionalContexts?.[0])).toContain('[#9] gotcha')
  })

  it('leaves the tool result untouched when the recall fails', async () => {
    const agent = makeAgent()
    const failing: RecallClient = { recall: async () => ({ ok: false, error: 'HTTP 500' }) }
    const { logger } = loggerSpy()
    const injector = new HostInjector({ logger, config: config(), client: failing })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: true })

    const original: PostToolDecision = { kind: 'accept', content: [] }
    const decision = await injector.onPostExecute(
      toolExec(agent, 'bash', { command: 'pnpm test' }),
      async () => original,
    )

    expect(decision).toBe(original)
  })

  it('probes each file path at most once per session and is gated off without code', async () => {
    const agent = makeAgent()
    const { client, calls } = recordingClient('[#4] gotcha')
    const { logger } = loggerSpy()
    const injector = new HostInjector({ logger, config: config(), client })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: true })

    await injector.onPostExecute(toolExec(agent, 'write', { file_path: 'src/a.ts' }), async () => ({ kind: 'accept', content: [] }))
    await injector.onPostExecute(toolExec(agent, 'write', { file_path: 'src/a.ts' }), async () => ({ kind: 'accept', content: [] }))
    expect(calls).toHaveLength(1)

    const memoryOnly = makeAgent('agent-memory')
    injector.bind(memoryOnly, { host: '127.0.0.1', port: 4242, hasCode: false })
    await injector.onPostExecute(toolExec(memoryOnly, 'bash', { command: 'ls' }), async () => ({ kind: 'accept', content: [] }))
    expect(calls).toHaveLength(1)
  })
})

describe('G5/G6 compaction lifecycle', () => {
  it('snapshots and resets on compaction/start, then re-boots with post-compaction', async () => {
    const agent = makeAgent()
    const { client, calls } = recordingClient('')
    const { logger } = loggerSpy()
    const posted: { path: string; body: Record<string, unknown> }[] = []
    const injector = new HostInjector({
      logger,
      config: config(),
      client,
      post: async (_host, _port, path, body) => { posted.push({ path, body }) },
    })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: false })

    injector.onSessionEvent(agent.session, { type: 'compaction/start' })
    expect(posted.map(entry => entry.path)).toEqual(['/v1/snapshot', '/v1/trigger/reset'])
    expect(String(posted[0]?.body.label)).toMatch(/^pre-compact-auto-/)
    expect(posted[1]?.body.session_id).toBe('agent-1')

    injector.onSessionEvent(agent.session, { type: 'compaction/end' })
    injector.prefetchBoot(agent)
    expect(calls[0]?.options).toMatchObject({
      boot: true,
      events: ['session-start', 'post-compaction'],
    })
  })
})

describe('degradation', () => {
  it('never throws into the host and warns once when message construction fails', async () => {
    const agent = makeAgent()
    const { client } = recordingClient('boot [#1] text')
    const { logger, warnings } = loggerSpy()
    const injector = new HostInjector({
      logger,
      config: config(),
      client,
      createMessage: () => { throw new Error('message factory exploded') },
    })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: false })
    injector.prefetchBoot(agent)

    const decision = await injector.onPreStep(step(agent, []), async () => enter())
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') expect(decision.messages).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('message factory exploded')

    // A second degraded step must still return a valid decision and not spam logs.
    const again = await injector.onPreStep(step(agent, [], 2, 1), async () => enter())
    expect(again.kind).toBe('enter')
    expect(warnings).toHaveLength(1)
  })
})

describe('pure helpers', () => {
  it('dedupes by note id, keeps id-less lines, and collapses blank runs', () => {
    const delivered = new Set<number>()
    const text = 'header\n\n[#1] first note\n[#1] first note\n[#2] second note'
    const first = dedupeNotes(text, delivered)
    expect(first).toBe('header\n\n[#1] first note\n[#2] second note')
    expect([...delivered]).toEqual([1, 2])

    const second = dedupeNotes('[#2] second note\n[#3] third note', delivered)
    expect(second).toBe('[#3] third note')
  })

  it('finds the last human prompt only', () => {
    const own = createUserMessage({
      content: [{ type: 'text', text: 'injected' }],
      source: { kind: 'vectr', form: 'notice', summary: 'vectr' },
    })
    expect(lastHumanPrompt([human('earlier'), own, human('current')])).toBe('current')
    expect(lastHumanPrompt([own])).toBeUndefined()
  })

  it('maps edit/write/bash onto the upstream PreToolUse payload', () => {
    expect(toolProbe('edit', { file_path: 'src/a.ts' })).toEqual({
      key: 'file:src/a.ts',
      options: { file_path: 'src/a.ts', kind: 'gotcha', hook_event: 'PreToolUse' },
    })
    expect(toolProbe('bash', { command: 'pnpm test --watch' })).toEqual({
      key: 'command:pnpm',
      options: { command: 'pnpm test --watch', hook_event: 'PreToolUse' },
    })
    expect(toolProbe('read', { file_path: 'src/a.ts' })).toBeUndefined()
    expect(toolProbe('edit', {})).toBeUndefined()
  })
})

describe('D2/D3 budget ledger', () => {
  it('does not consume note ids when a package is rejected by the budget', async () => {
    const agent = makeAgent()
    const { client } = recordingClient(options =>
      options.boot === true
        ? `${'x'.repeat(250)} [#1] over-budget boot note`
        : '[#1] short prompt note',
    )
    const { logger } = loggerSpy()
    const injector = new HostInjector({ logger, config: config({ perTurnTokenCap: 40 }), client })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: false })
    injector.prefetchBoot(agent)

    const first = await injector.onPreStep(step(agent, []), async () => enter())
    if (first.kind === 'enter') expect(first.messages).toHaveLength(0)

    // Next turn: the boot-rejected id must still be eligible for injection.
    const second = await injector.onPreStep(step(agent, [human('later')], 2, 1), async () => enter([human('later')]))
    if (second.kind === 'enter') {
      expect(injectedText(second.messages.at(-1))).toContain('[#1] short prompt note')
    }
  })

  it('accumulates cost across boot and prompt packs in the same turn', async () => {
    const agent = makeAgent()
    const { client } = recordingClient(options =>
      options.boot === true ? '[#1] boot note' : '[#2] prompt note',
    )
    const { logger } = loggerSpy()
    const injector = new HostInjector({ logger, config: config({ perTurnTokenCap: 50 }), client })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: false })
    injector.prefetchBoot(agent)

    const decision = await injector.onPreStep(
      step(agent, [human('hello')], 1, 1),
      async () => enter([human('hello')]),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const vectrMessages = decision.messages.filter(message => message.source.kind === 'vectr')
    expect(vectrMessages).toHaveLength(1)
    const text = injectedText(vectrMessages[0])
    expect(text).toContain('[#1] boot note')
    expect(text).not.toContain('[#2] prompt note')
  })
})

describe('D5 breaker, disposal, character cap, and recall passthrough', () => {
  it('opens a 60s breaker after three failures and closes the session on the second strike', async () => {
    const agent = makeAgent()
    const calls: RecallCall[] = []
    const failing: RecallClient = {
      async recall(host, port, options, timeoutMs) {
        calls.push({ host, port, options, timeoutMs })
        return { ok: false, error: 'daemon down' }
      },
    }
    let now = 1_000
    const { logger, warnings } = loggerSpy()
    const injector = new HostInjector({
      logger,
      config: config({ bootRecallTimeoutMs: 20, promptRecallTimeoutMs: 20 }),
      client: failing,
      now: () => now,
    })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: false })
    injector.prefetchBoot(agent)

    // Turn 1: boot + prompt = 2 consecutive failures.
    await injector.onPreStep(step(agent, [human('one')], 1, 1), async () => enter([human('one')]))
    // Turn 2: third failure opens the first breaker strike.
    await injector.onPreStep(step(agent, [human('two')], 2, 1), async () => enter([human('two')]))
    expect(calls).toHaveLength(3)
    expect(warnings.some(message => message.includes('paused after 3 failures'))).toBe(true)

    // Turn 3: breaker open, no request.
    await injector.onPreStep(step(agent, [human('three')], 3, 1), async () => enter([human('three')]))
    expect(calls).toHaveLength(3)

    // 60s later: one probe is allowed again, then two more failures strike out.
    now += 60_001
    await injector.onPreStep(step(agent, [human('four')], 4, 1), async () => enter([human('four')]))
    await injector.onPreStep(step(agent, [human('five')], 5, 1), async () => enter([human('five')]))
    await injector.onPreStep(step(agent, [human('six')], 6, 1), async () => enter([human('six')]))
    expect(calls).toHaveLength(6)

    // Session-wide disable: no request even after the window.
    now += 10 * 60_000
    await injector.onPreStep(step(agent, [human('seven')], 7, 1), async () => enter([human('seven')]))
    expect(calls).toHaveLength(6)
  })

  it('does not inject or query after the agent is disposed', async () => {
    const agent = makeAgent()
    const { client, calls } = recordingClient('boot [#1] note')
    const { logger } = loggerSpy()
    const injector = new HostInjector({ logger, config: config(), client })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: false })
    injector.prefetchBoot(agent)
    injector.dispose(agent)
    calls.length = 0

    const decision = await injector.onPreStep(step(agent, [human('hello')]), async () => enter([human('hello')]))
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') expect(decision.messages).toHaveLength(1)
    expect(calls).toHaveLength(0)
  })

  it('clamps injected text to maxInjectionChars with an explicit truncation marker', async () => {
    const agent = makeAgent()
    const { client } = recordingClient(`prefix ${'y'.repeat(500)}`)
    const { logger } = loggerSpy()
    const injector = new HostInjector({ logger, config: config({ maxInjectionChars: 40 }), client })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: false })
    injector.prefetchBoot(agent)

    const decision = await injector.onPreStep(step(agent, []), async () => enter())
    if (decision.kind !== 'enter') return
    const text = injectedText(decision.messages.at(-1))
    expect(text.endsWith('\n… (truncated)')).toBe(true)
    expect(text.length).toBeLessThan(80)
    expect(text).not.toContain('y'.repeat(60))
  })

  it('does not mark a truncated-out note delivered, so a later turn can still inject it', async () => {
    const agent = makeAgent()
    // BOOT_HEADER + 155-char first note fills the 300-char cap exactly, so the
    // second note starts at index 300 and is cut off by the clamp.
    const bootPack = `[#10] first boot note ${'a'.repeat(133)}\n[#11] second boot note`
    const { client } = recordingClient(options =>
      options.hook_event !== 'UserPromptSubmit'
        ? bootPack
        : options.query === 'next turn' ? '[#11] later note' : '')
    const { logger } = loggerSpy()
    const injector = new HostInjector({ logger, config: config({ maxInjectionChars: 300 }), client })
    injector.bind(agent, { host: '127.0.0.1', port: 4242, hasCode: false })
    injector.prefetchBoot(agent)

    const first = await injector.onPreStep(step(agent, [human('hello')]), async () => enter([human('hello')]))
    if (first.kind !== 'enter') throw new Error('expected enter decision')
    const bootText = injectedText(first.messages.at(-1))
    expect(bootText).toContain('[#10] first boot note')
    expect(bootText).not.toContain('#11')

    // Under the old order #11 was charged to the ledger during boot, so this
    // prompt recall would be deduped away and the note lost for the session.
    const second = await injector.onPreStep(step(agent, [human('next turn')], 2, 1), async () => enter([human('next turn')]))
    if (second.kind !== 'enter') throw new Error('expected enter decision')
    expect(injectedText(second.messages.at(-1))).toContain('[#11] later note')
  })

  it('forwards every recall parameter verbatim to /v1/recall', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify({ notes: 'ok', processing_ms: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    const api = new VectrApiClient({ fetchFn })

    const result = await api.recall('127.0.0.1', 4321, {
      boot: true,
      events: ['session-start', 'post-compaction'],
      hook_event: 'SessionStart',
      session_id: 'session-1',
      min_similarity: 0.4,
      max_age_days: 3,
      note_id: 7,
      surface: 'mcp',
      file_path: 'src/a.ts',
      command: 'pnpm test',
      limit: 5,
      detail: 'index',
      query: 'hello',
      kind: 'gotcha',
    }, 500)

    expect(result.ok).toBe(true)
    expect(seen[0]?.url).toBe('http://127.0.0.1:4321/v1/recall')
    const body = JSON.parse(String(seen[0]?.init.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      boot: true,
      events: ['session-start', 'post-compaction'],
      hook_event: 'SessionStart',
      session_id: 'session-1',
      min_similarity: 0.4,
      max_age_days: 3,
      note_id: 7,
      surface: 'mcp',
      file_path: 'src/a.ts',
      command: 'pnpm test',
      limit: 5,
      detail: 'index',
      query: 'hello',
      kind: 'gotcha',
    })
  })
})

describe('D4 host wiring', () => {
  it('registers the pre-step, lifecycle, and tools/post-execute seams in apply()', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-wiring-'))
    roots.push(dir)
    const onCalls: { event: string; handler: unknown; options: unknown }[] = []
    const scopeOnCalls: { event: string; handler: unknown }[] = []
    const injectCalls: { deps: string[]; callback: (scope: unknown) => void }[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      agents: { list: () => [] },
      get: () => undefined,
      on(event: string, handler: unknown, options?: unknown) {
        onCalls.push({ event, handler, options })
        return () => {}
      },
      inject(deps: string[], callback: (scope: unknown) => void) {
        injectCalls.push({ deps, callback })
        return { dispose: () => {} }
      },
      effect(factory: () => unknown) {
        factory()
        return () => {}
      },
    } as unknown as Context

    apply(ctx, {
      autoStartDaemons: false,
      instancesPath: join(dir, 'instances.json'),
      modesPath: join(dir, 'vectr-modes.json'),
      codebasesPath: join(dir, 'codebases.json'),
      secretsPath: join(dir, 'secrets.json'),
    })

    const preStep = onCalls.find(call => call.event === 'agent/pre-step')
    expect(preStep).toBeDefined()
    expect(preStep?.options).toEqual({ prepend: true })
    expect(typeof preStep?.handler).toBe('function')
    for (const event of ['agent/created', 'agent/disposed', 'session/event']) {
      expect(onCalls.some(call => call.event === event)).toBe(true)
    }

    const toolsInjection = injectCalls.find(call => call.deps.includes('tools'))
    expect(toolsInjection).toBeDefined()
    toolsInjection?.callback({
      on(event: string, handler: unknown) {
        scopeOnCalls.push({ event, handler })
        return () => {}
      },
    })
    const postExecute = scopeOnCalls.find(call => call.event === 'tools/post-execute')
    expect(postExecute).toBeDefined()
    expect(typeof postExecute?.handler).toBe('function')
  })
})
