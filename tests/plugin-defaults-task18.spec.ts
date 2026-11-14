/**
 * task-18 — two plugin-side defaults, verified against real behavior.
 *
 * A) `promptRecallTimeoutMs` defaults to 6 000 ms, not 400 ms.
 *    Measured `/v1/recall` latency on a live indexed workspace:
 *    1 889 / 2 238 / 4 665 / 3 035 / 2 626 / 3 428 / 3 459 ms — every call
 *    HTTP 200 and carrying notes. A 400 ms budget sits below every one of
 *    them, so the per-turn recall timed out on every prompt; each timeout is
 *    a recall failure, three failures open the injection breaker
 *    (`BREAKER_FAILURE_LIMIT`, `BREAKER_OPEN_MS`) and the second strike sets
 *    `disabledUntil = Number.POSITIVE_INFINITY`, killing injection for the
 *    rest of the session. 6 000 ms clears the slowest sample with headroom
 *    and stays configurable.
 *
 * B) `startAllDaemons` carries over the mode already recorded for a workspace
 *    in the daemon registry instead of falling back to `vectr start`'s own
 *    (full) default when the caller did not force a mode.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import {
  apply,
  Config as ConfigSchema,
  DEFAULT_PROMPT_RECALL_TIMEOUT_MS,
  startAllDaemons,
  type StartAllDeps,
} from '../src/index.ts'
import type { AliveDiagnosis } from '../src/probe.ts'
import type { DiscoveredWorkspace } from '../src/workspaces.ts'
import type { InstanceEntry, StartResult, VectrStartOptions } from '../src/domain/index.ts'

vi.mock('@deepseek-ai/dsh-mcp-client/src/connection.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client/src/connection.ts')>()
  return {
    ...actual,
    startConnection: vi.fn(() => ({
      ready: Promise.resolve({}),
      dispose: vi.fn(async () => {}),
    })),
  }
})

const roots: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Resolve a raw config through the schema, exactly as the Loader does. */
function resolveConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const result = ConfigSchema(raw as never)
  if (typeof result !== 'object' || result === null) throw new Error('Config schema did not return an object')
  return result as Record<string, unknown>
}

/** `/v1/recall` latencies measured on the live daemon (all HTTP 200, notes present). */
const MEASURED_RECALL_MS = [1_889, 2_238, 4_665, 3_035, 2_626, 3_428, 3_459]

describe('A — promptRecallTimeoutMs default is 6000 ms', () => {
  it('ships 6000 ms, above the slowest measured recall, from the schema and the constant', () => {
    const resolved = resolveConfig({})
    expect(resolved.promptRecallTimeoutMs).toBe(DEFAULT_PROMPT_RECALL_TIMEOUT_MS)
    expect(DEFAULT_PROMPT_RECALL_TIMEOUT_MS).toBe(6_000)
    // The whole point of the change: the budget must cover every observed recall.
    expect(DEFAULT_PROMPT_RECALL_TIMEOUT_MS).toBeGreaterThan(Math.max(...MEASURED_RECALL_MS))
    // The previous budget was below every observed sample; it must not come back.
    expect(DEFAULT_PROMPT_RECALL_TIMEOUT_MS).not.toBe(400)
    expect(400).toBeLessThan(Math.min(...MEASURED_RECALL_MS))
    // The neighbouring budgets are untouched by this change.
    expect(resolved.bootRecallTimeoutMs).toBe(1_500)
    expect(resolved.toolRecallTimeoutMs).toBe(300)
  })

  it('stays configurable and keeps the positive-number guardrail', () => {
    expect(resolveConfig({ promptRecallTimeoutMs: 1_234 }).promptRecallTimeoutMs).toBe(1_234)
    expect(resolveConfig({ promptRecallTimeoutMs: 30_000 }).promptRecallTimeoutMs).toBe(30_000)
    expect(() => ConfigSchema({ promptRecallTimeoutMs: 0 } as never)).toThrow()
    expect(() => ConfigSchema({ promptRecallTimeoutMs: -1 } as never)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// A end to end: `apply()` must wire the resolved default into the injector, so
// a real 1.2 s recall still lands — and an explicit 400 ms still cuts it off.
// ---------------------------------------------------------------------------

const SLOW_RECALL_MS = 1_200
const DAEMON_PORT = 5_599
const PROMPT_NOTE = '[#7] prompt-anchored note'

interface RecallCall {
  url: string
  body: Record<string, unknown>
}

const sleep = (ms: number): Promise<void> => new Promise((resolveTimer) => { setTimeout(resolveTimer, ms) })

/** Sleep that rejects when the client aborts, i.e. behaves like a real timeout. */
function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolveTimer, rejectTimer) => {
    if (signal?.aborted === true) {
      rejectTimer(new Error('aborted before the daemon answered'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolveTimer()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      rejectTimer(new Error('aborted before the daemon answered'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Stand-in daemon: the prompt-anchored recall is slow (like the measured
 * 1.7–4.7 s), the boot recall answers at once with nothing to inject, so every
 * assertion below is about the per-turn recall alone.
 */
function stubDaemon(calls: RecallCall[]): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    calls.push({ url, body })
    if (url.endsWith('/v1/recall')) {
      if (body.hook_event === 'UserPromptSubmit') {
        await abortableSleep(SLOW_RECALL_MS, init?.signal)
        return jsonResponse({ ok: true, notes: PROMPT_NOTE, processing_ms: SLOW_RECALL_MS })
      }
      return jsonResponse({ ok: true, notes: '' })
    }
    return jsonResponse({})
  }))
}

function registryKey(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex').slice(0, 12)
}

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function human(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

interface Wired {
  /** The agent `apply()` bound to the daemon; the same object the host passes back. */
  agent: Agent
  /** Diagnostics the host emitted while wiring. */
  warnings: string[]
  /** The `agent/pre-step` handler `apply()` registered. */
  preStep: (payload: unknown, next: () => Promise<unknown>) => Promise<{ messages: unknown[] }>
}

/**
 * Boot the plugin over a fake host whose single agent has a live daemon in the
 * registry, and hand back the pre-step handler it registered.
 */
function applyWithBoundAgent(config: Record<string, unknown>): Wired {
  const dir = tempRoot('dsh-vectr-task18-')
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(dir, 'instances.json'), JSON.stringify({
    [registryKey(workspace)]: { workspace, port: DAEMON_PORT, mode: 'full' },
  }))

  const onCalls: { event: string; handler: (payload: never, next: never) => unknown }[] = []
  const warnings: string[] = []
  const agent = {
    id: 'agent-task18',
    session: { id: 'agent-task18', header: { cwd: workspace } },
    ctx: {
      logger: { warn: (m: string) => { warnings.push(m) }, info: () => {}, error: () => {}, debug: () => {} },
      on: () => {},
      inject: (_deps: string[], callback: (scope: unknown) => void) => {
        callback({
          systemPrompt: { section: () => {}, getSectionOrder: () => 100 },
          on: () => {},
        })
        return { dispose: async () => {} }
      },
    },
  }

  const ctx = {
    logger: { warn: (m: string) => { warnings.push(m) }, info: () => {}, error: () => {}, debug: () => {} },
    get: () => undefined,
    on: (event: string, handler: (payload: never, next: never) => unknown) => {
      onCalls.push({ event, handler })
      return () => {}
    },
    agents: { list: () => [agent as unknown as Agent] },
    effect: (factory: () => unknown) => {
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
    // Boot recall stays out of the way: the assertions are about the prompt recall.
    bootRecallTimeoutMs: 10,
    toolRecallTimeoutMs: 10,
    ...config,
  })

  const registered = onCalls.find(call => call.event === 'agent/pre-step')
  if (registered === undefined) throw new Error('apply() did not register the agent/pre-step seam')
  return { agent: agent as unknown as Agent, warnings, preStep: registered.handler as Wired['preStep'] }
}

describe('A end to end — the resolved default reaches the injector', () => {
  it('injects a 1.2 s recall under the default budget', async () => {
    const calls: RecallCall[] = []
    stubDaemon(calls)
    const { agent, preStep, warnings } = applyWithBoundAgent({})

    const started = Date.now()
    const decision = await preStep(
      { agent, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [human('what changed in the resolver')] }),
    )

    const promptRecall = calls.find(call => call.url.endsWith('/v1/recall') && call.body.hook_event === 'UserPromptSubmit')
    if (promptRecall === undefined) {
      throw new Error(`no prompt recall fired. requests: ${calls.map(c => c.url).join(', ') || '(none)'}; host warnings: ${warnings.join(' | ') || '(none)'}`)
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(SLOW_RECALL_MS - 50)
    const injected = decision.messages.map(message => JSON.stringify(message))
    expect(injected.some(text => text.includes(PROMPT_NOTE))).toBe(true)
  })

  it('still cuts the same recall off when a 400 ms budget is configured explicitly', async () => {
    const calls: RecallCall[] = []
    stubDaemon(calls)
    const { agent, preStep } = applyWithBoundAgent({ promptRecallTimeoutMs: 400 })

    const decision = await preStep(
      { agent, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [human('what changed in the resolver')] }),
    )

    const promptRecall = calls.find(call => call.url.endsWith('/v1/recall') && call.body.hook_event === 'UserPromptSubmit')
    expect(promptRecall).toBeDefined()
    // The knob is honored: the same slow daemon gets aborted and nothing is injected.
    const injected = decision.messages.map(message => JSON.stringify(message))
    expect(injected.some(text => text.includes(PROMPT_NOTE))).toBe(false)
    expect(decision.messages).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// B — startAllDaemons must carry the recorded mode, not re-default to full.
// ---------------------------------------------------------------------------

function entry(workspace: string, port: number, mode?: string): InstanceEntry {
  return { workspace, port, ...(mode === undefined ? {} : { mode }) }
}

/** `instances.json` shape: hash-keyed records. */
function registry(entries: InstanceEntry[]): Record<string, InstanceEntry> {
  const out: Record<string, InstanceEntry> = {}
  for (const e of entries) out[registryKey(e.workspace)] = e
  return out
}

interface Sweep {
  starts: VectrStartOptions[]
  deps: StartAllDeps
}

/** Registry/probe/spawn/discovery seams; every `start()` call is recorded. */
function sweep(
  instances: Record<string, InstanceEntry> | undefined,
  discovered: DiscoveredWorkspace[],
  overrides: { probe?: (e: InstanceEntry) => AliveDiagnosis; start?: (o: VectrStartOptions) => StartResult } = {},
): Sweep {
  const starts: VectrStartOptions[] = []
  return {
    starts,
    deps: {
      readInstances: () => instances,
      probe: async (e) => overrides.probe?.(e) ?? { alive: false, reason: 'PORT_CLOSED' },
      start: async (o) => {
        starts.push(o)
        return overrides.start?.(o) ?? { ok: true }
      },
      discover: () => discovered,
      warn: () => {},
    },
  }
}

describe('B — the recorded memory-only mode survives a sweep that starts from discovery', () => {
  /**
   * The discovery tail is reached when the registry record cannot be started
   * from directly (no usable port) while the mode the user chose is still
   * recorded under that path — the exact state a stopped memory-only daemon
   * leaves behind.
   */
  function staleRecord(workspace: string, mode: string): Record<string, InstanceEntry> {
    return registry([entry(workspace, 0, mode)])
  }

  it('starts a recorded memory_only workspace as memory-only when no mode is forced', async () => {
    const dir = tempRoot('dsh-vectr-memonly-')
    const workspace = join(dir, 'memory-only-ws')
    mkdirSync(workspace, { recursive: true })

    const { starts, deps } = sweep(staleRecord(workspace, 'memory_only'), [{ workspace }])
    await startAllDaemons(deps, {})

    expect(starts.map(s => [s.workspace, s.memoryOnly])).toEqual([[workspace, true]])
  })

  it('accepts the memory-only spelling just as well', async () => {
    const dir = tempRoot('dsh-vectr-memonly-')
    const workspace = join(dir, 'dash-spelling')
    mkdirSync(workspace, { recursive: true })

    const { starts, deps } = sweep(staleRecord(workspace, 'memory-only'), [{ workspace }])
    await startAllDaemons(deps, {})

    expect(starts.map(s => [s.workspace, s.memoryOnly])).toEqual([[workspace, true]])
  })

  it('keeps a recorded full workspace full', async () => {
    const dir = tempRoot('dsh-vectr-memonly-')
    const workspace = join(dir, 'full-ws')
    mkdirSync(workspace, { recursive: true })

    const { starts, deps } = sweep(staleRecord(workspace, 'full'), [{ workspace }])
    await startAllDaemons(deps, {})

    expect(starts.map(s => [s.workspace, s.memoryOnly])).toEqual([[workspace, false]])
  })

  it('leaves a workspace with no recorded mode to `vectr start` own default', async () => {
    const dir = tempRoot('dsh-vectr-memonly-')
    const workspace = join(dir, 'unknown-ws')
    mkdirSync(workspace, { recursive: true })

    const recordedButNoMode = registry([entry(workspace, 0)])
    const { starts, deps } = sweep(recordedButNoMode, [{ workspace }])
    await startAllDaemons(deps, {})
    expect(starts.map(s => [s.workspace, s.memoryOnly])).toEqual([[workspace, false]])

    const noRecordAtAll = sweep(undefined, [{ workspace }])
    await startAllDaemons(noRecordAtAll.deps, {})
    expect(noRecordAtAll.starts.map(s => [s.workspace, s.memoryOnly])).toEqual([[workspace, false]])
  })

  it('an explicit force beats the recorded mode in both directions', async () => {
    const dir = tempRoot('dsh-vectr-memonly-')
    const memoryWorkspace = join(dir, 'forced-off')
    const fullWorkspace = join(dir, 'forced-on')
    mkdirSync(memoryWorkspace, { recursive: true })
    mkdirSync(fullWorkspace, { recursive: true })

    const instances = registry([
      entry(memoryWorkspace, 0, 'memory_only'),
      entry(fullWorkspace, 0, 'full'),
    ])

    const forceOff = sweep(instances, [{ workspace: memoryWorkspace }, { workspace: fullWorkspace }])
    await startAllDaemons(forceOff.deps, { memoryOnly: false })
    expect(Object.fromEntries(forceOff.starts.map(s => [s.workspace, s.memoryOnly]))).toEqual({
      [memoryWorkspace]: false,
      [fullWorkspace]: false,
    })

    const forceOn = sweep(instances, [{ workspace: memoryWorkspace }, { workspace: fullWorkspace }])
    await startAllDaemons(forceOn.deps, { memoryOnly: true })
    expect(Object.fromEntries(forceOn.starts.map(s => [s.workspace, s.memoryOnly]))).toEqual({
      [memoryWorkspace]: true,
      [fullWorkspace]: true,
    })
  })

  it('does not disturb a live registry row: its own mode still decides', async () => {
    const dir = tempRoot('dsh-vectr-memonly-')
    const workspace = join(dir, 'live-row')
    mkdirSync(workspace, { recursive: true })

    const instances = registry([entry(workspace, 5_601, 'memory_only')])
    const { starts, deps } = sweep(instances, [{ workspace }], {
      probe: () => ({ alive: false, reason: 'PORT_CLOSED' }),
    })
    const result = await startAllDaemons(deps, {})

    // Registry row is started from the row itself, and discovery adds no second spawn.
    expect(starts.map(s => [s.workspace, s.memoryOnly])).toEqual([[workspace, true]])
    expect(starts).toHaveLength(1)
    expect(result.started).toBe(0)
    expect(result.failed).toBe(1) // the post-start probe says it is not alive
  })
})
