/**
 * Host-side working-memory injection for DSH agents.
 *
 * Mirrors the upstream vectr agent contract on this host's seams:
 * - boot recall (session start, and again after compaction) as one injected
 *   user message on the first eligible pre-step;
 * - prompt-anchored recall (`UserPromptSubmit` equivalent) once per turn;
 * - tool-anchored gotcha recall after `edit`/`write`/`bash`, delivered through
 *   `tools/post-execute` `additionalContexts` (the only host seam that can
 *   attach context near a tool call — `tools/pre-execute` can only deny);
 * - compaction lifecycle: snapshot + trigger reset, then a boot re-delivery.
 *
 * Every network call is bounded and degrades to "inject nothing". Failures
 * never reach the host: three consecutive failures open a 60 s breaker, a
 * second strike disables injection for the session.
 *
 * @module dsh-vectr-client/injection
 */

import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { RecallOptions } from './domain/types'
import { VectrApiClient } from './infra/api-client'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Context injected by this plugin's host-side working-memory bridge. */
    vectr: { kind: 'vectr' } & ContextFormed
  }
}

/** Source kind carried by every message this module injects. */
export const INJECTION_SOURCE_KIND = 'vectr'
/** Note-id marker rendered by recall output, e.g. `[#12]`. */
const NOTE_ID_PATTERN = /\[#(\d+)\]/g
/** Failure count that opens the injection breaker. */
export const BREAKER_FAILURE_LIMIT = 3
/** Open duration of the first breaker strike. */
export const BREAKER_OPEN_MS = 60_000
/** Budget for compaction snapshot/reset calls (fire-and-forget). */
const COMPACTION_TIMEOUT_MS = 800
/** Bound on the per-session tool-probe dedupe ledger. */
const PROBED_KEY_LIMIT = 512

const BOOT_HEADER =
  'Vectr working memory (auto-injected at session start) — do not call vectr_recall to re-fetch these; call it only for something not shown here.'
const PROMPT_HEADER = 'Vectr working memory relevant to this prompt:'
const TOOL_HEADER = 'Vectr working memory for the tool call that just ran:'

/** Seconds-free knobs resolved by the plugin config; all values are bounded. */
export interface InjectionConfig {
  bootRecallTimeoutMs: number
  promptRecallTimeoutMs: number
  toolRecallTimeoutMs: number
  promptRecallLimit: number
  perTurnTokenCap: number
  perSessionTokenCap: number
  maxInjectionChars: number
  injectCompactionSnapshot: boolean
}

export interface InjectionLogger {
  warn(message: string): void
}

/** HTTP boundary used by tests to assert the exact request shape. */
export interface RecallClient {
  recall(
    host: string,
    port: number,
    options: RecallOptions,
    timeoutMs: number,
  ): Promise<{ ok: boolean; notes?: string | undefined; error?: string | undefined }>
}

export type PostRequest = (
  host: string,
  port: number,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
) => Promise<void>

export interface HostInjectorDeps {
  logger: InjectionLogger
  config: InjectionConfig
  client?: RecallClient | undefined
  now?: (() => number) | undefined
  post?: PostRequest | undefined
  createMessage?: ((text: string, label: string) => UserMessage) | undefined
}

export interface BindTarget {
  host: string
  port: number
  hasCode: boolean
}

interface SessionState {
  host: string
  port: number
  hasCode: boolean
  readonly sessionId: string
  readonly session: object
  boot: Promise<string> | undefined
  bootDelivered: boolean
  reBootPending: boolean
  lastTurn: number
  turnForBudget: number
  turnSpentTokens: number
  readonly delivered: Set<number>
  readonly probed: Set<string>
  spentTokens: number
  failures: number
  breakerTrips: number
  disabledUntil: number
  readonly warned: Set<string>
}

export interface PreStepPayload {
  agent: Agent
  messages: UserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}

/** Probed key + recall options for one tool call, when the call is injectable. */
export interface ToolProbe {
  key: string
  options: RecallOptions
}

/**
 * Filter out note lines whose ids were already delivered this session.
 * Lines without an id are kept as-is (headers, continuation text). Mutates
 * `delivered` with the ids of the lines it keeps.
 * @param text - recall output.
 * @param delivered - session-wide set of note ids already shown to the model.
 * @returns the de-duplicated text; `''` when every note was a repeat.
 */
export function dedupeNotes(text: string, delivered: Set<number>): string {
  const kept: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const ids = [...line.matchAll(NOTE_ID_PATTERN)]
      .map(match => Number(match[1]))
      .filter(id => Number.isInteger(id))
    if (ids.some(id => delivered.has(id))) continue
    for (const id of ids) delivered.add(id)
    kept.push(line)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Last genuine human message in the claimed step batch. Injected context
 * messages carry a non-`user` source kind, so they never become a recall
 * query.
 * @param messages - messages claimed by the step.
 * @returns the prompt text, or `undefined` when the batch has no human prompt.
 */
export function lastHumanPrompt(messages: readonly UserMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'user' || message.source.kind !== 'user') continue
    const text = message.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim()
    if (text !== '') return text
  }
  return undefined
}

/**
 * Map one tool call onto upstream's `PreToolUse` payload shape. DSH's built-in
 * `edit`/`write` use `file_path` and `bash` uses `command`, exactly like the
 * upstream payload, so no field renaming is needed.
 * @param name - tool name.
 * @param args - parsed tool arguments.
 * @returns the probe, or `undefined` when the call is not injectable.
 */
export function toolProbe(name: string, args: unknown): ToolProbe | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  if (name === 'edit' || name === 'write') {
    const filePath = record.file_path
    if (typeof filePath !== 'string' || filePath === '') return undefined
    return {
      key: `file:${filePath}`,
      options: { file_path: filePath, kind: 'gotcha', hook_event: 'PreToolUse' },
    }
  }
  if (name === 'bash') {
    const command = record.command
    if (typeof command !== 'string' || command.trim() === '') return undefined
    // Dedupe by command family (client-side approximation of the daemon's
    // server-side normalization); the full command still drives the match.
    const family = command.trim().split(/\s+/)[0] ?? command.trim()
    return { key: `command:${family}`, options: { command, hook_event: 'PreToolUse' } }
  }
  return undefined
}

function defaultPostRequest(
  host: string,
  port: number,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(`http://${host}:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then((response) => {
      if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}`)
    })
    .finally(() => {
      clearTimeout(timer)
    })
}

/**
 * Owns all dynamic working-memory injection for one plugin instance.
 * Agents are keyed weakly; state dies with the agent.
 */
export class HostInjector {
  private readonly states = new WeakMap<Agent, SessionState>()
  private readonly bySession = new WeakMap<object, SessionState>()
  private readonly logger: InjectionLogger
  private readonly config: InjectionConfig
  private readonly client: RecallClient
  private readonly now: () => number
  private readonly post: PostRequest
  private readonly createMessage: (text: string, label: string) => UserMessage

  constructor(deps: HostInjectorDeps) {
    this.logger = deps.logger
    this.config = deps.config
    this.client = deps.client ?? new VectrApiClient()
    this.now = deps.now ?? (() => Date.now())
    this.post = deps.post ?? defaultPostRequest
    this.createMessage = deps.createMessage ?? ((text, label) => createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: INJECTION_SOURCE_KIND,
        form: 'notice',
        summary: `vectr working memory (${label})`,
      },
    }))
  }

  /**
   * Attach injection state to an agent whose workspace resolved a live daemon.
   * Idempotent; a rebind after daemon restart refreshes the endpoint but keeps
   * the session's delivery ledger.
   * @param agent - the agent whose turns receive injections.
   * @param target - resolved daemon endpoint and whether an indexed codebase is bound.
   */
  bind(agent: Agent, target: BindTarget): void {
    const existing = this.states.get(agent)
    if (existing !== undefined) {
      existing.host = target.host
      existing.port = target.port
      existing.hasCode = target.hasCode
      return
    }
    const state: SessionState = {
      host: target.host,
      port: target.port,
      hasCode: target.hasCode,
      sessionId: agent.id,
      session: agent.session,
      boot: undefined,
      bootDelivered: false,
      reBootPending: false,
      lastTurn: 0,
      turnForBudget: 0,
      turnSpentTokens: 0,
      delivered: new Set(),
      probed: new Set(),
      spentTokens: 0,
      failures: 0,
      breakerTrips: 0,
      disabledUntil: 0,
      warned: new Set(),
    }
    this.states.set(agent, state)
    this.bySession.set(agent.session, state)
  }

  /**
   * A `compact` session source means the conversation was compressed: the next
   * boot recall must carry `post-compaction` and re-deliver notes.
   * @param agent - the agent whose session source changed.
   * @param source - session start source.
   */
  markSource(agent: Agent, source: string): void {
    if (source !== 'compact') return
    const state = this.states.get(agent)
    if (state === undefined) return
    state.reBootPending = true
    state.boot = undefined
    state.delivered.clear()
  }

  /**
   * Start the boot recall once for the session (or once after compaction).
   * The promise is stored so the first pre-step awaits it instead of issuing
   * a second request.
   * @param agent - the agent to prefetch for.
   */
  prefetchBoot(agent: Agent): void {
    const state = this.states.get(agent)
    if (state === undefined || state.boot !== undefined || this.isDisabled(state)) return
    const events = state.reBootPending ? ['session-start', 'post-compaction'] : ['session-start']
    state.reBootPending = false
    state.boot = this.fetchNotes(state, {
      boot: true,
      hook_event: 'SessionStart',
      session_id: state.sessionId,
      events,
    }, this.config.bootRecallTimeoutMs)
  }

  /**
   * Inject the boot pack on the first step and prompt-relevant notes on the
   * first step of every later turn. The step is never blocked beyond the
   * configured bounds, and any thrown error leaves the decision untouched.
   * @param payload - step payload from the host.
   * @param next - downstream pre-step waterfall.
   * @returns the possibly extended step decision.
   */
  async onPreStep(payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted) return decision
    const state = this.states.get(payload.agent)
    if (state === undefined || this.isDisabled(state)) return decision
    if (payload.turn !== state.turnForBudget) {
      state.turnForBudget = payload.turn
      state.turnSpentTokens = 0
    }
    try {
      const parts: string[] = []
      if (!state.bootDelivered || state.reBootPending) {
        this.prefetchBoot(payload.agent)
        const text = state.boot === undefined
          ? ''
          : await this.withTimeout(state.boot, this.config.bootRecallTimeoutMs, state, 'boot recall')
        state.boot = undefined
        state.bootDelivered = true
        const fresh = this.accept(state, text, BOOT_HEADER)
        if (fresh !== undefined) parts.push(fresh)
      }
      if (payload.step === 1 && payload.turn !== state.lastTurn) {
        state.lastTurn = payload.turn
        const prompt = lastHumanPrompt(decision.messages)
        if (prompt !== undefined) {
          const text = await this.withTimeout(
            this.fetchNotes(state, {
              query: prompt,
              limit: this.config.promptRecallLimit,
              detail: 'index',
              hook_event: 'UserPromptSubmit',
              events: ['prompt-submit'],
              session_id: state.sessionId,
            }, this.config.promptRecallTimeoutMs),
            this.config.promptRecallTimeoutMs + 100,
            state,
            'prompt recall',
          )
          const fresh = this.accept(state, text, PROMPT_HEADER)
          if (fresh !== undefined) parts.push(fresh)
        }
      }
      if (parts.length === 0) return decision
      return {
        ...decision,
        messages: [...decision.messages, this.message(parts.join('\n\n'), 'session')],
      }
    } catch (error) {
      this.degrade(payload.agent, error)
      return decision
    }
  }

  /**
   * Attach a tool-anchored gotcha pack to the next request. Only `accept`
   * decisions are extended; the tool result itself is passed through by
   * reference (never re-wrapped).
   * @param exec - the tool call that just ran.
   * @param next - downstream post-execute waterfall.
   * @returns the possibly extended post-execute decision.
   */
  async onPostExecute(
    exec: ToolExecution,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> {
    const decision = await next()
    if (decision.kind !== 'accept') return decision
    const state = exec.agent === undefined ? undefined : this.states.get(exec.agent)
    try {
      if (state === undefined || !state.hasCode || this.isDisabled(state)) return decision
      const probe = toolProbe(exec.name, exec.arguments)
      if (probe === undefined || state.probed.has(probe.key)) return decision
      state.probed.add(probe.key)
      if (state.probed.size > PROBED_KEY_LIMIT) state.probed.clear()
      const text = await this.fetchNotes(state, probe.options, this.config.toolRecallTimeoutMs)
      const fresh = this.accept(state, text, TOOL_HEADER)
      if (fresh === undefined) return decision
      return {
        ...decision,
        additionalContexts: [...(decision.additionalContexts ?? []), this.message(fresh, 'tool')],
      }
    } catch (error) {
      if (exec.agent !== undefined) this.degrade(exec.agent, error)
      return decision
    }
  }

  /**
   * Consume compaction lifecycle events: snapshot + reset the trigger ledger
   * before compaction, and mark the next boot for re-delivery after it.
   * @param session - the session that appended the event.
   * @param event - the appended session event.
   */
  onSessionEvent(session: object, event: { type: string }): void {
    const state = this.bySession.get(session)
    if (state === undefined || this.isDisabled(state)) return
    if (event.type === 'compaction/start') {
      if (this.config.injectCompactionSnapshot) {
        const label = `pre-compact-auto-${new Date(this.now()).toISOString()}`
        void this.post(state.host, state.port, '/v1/snapshot', { label, session_id: state.sessionId }, COMPACTION_TIMEOUT_MS)
          .catch((error: unknown) => { this.degradeState(state, error) })
      }
      // The trigger ledger reset must always run: it is what lets the
      // post-compaction boot recall fire again.
      void this.post(state.host, state.port, '/v1/trigger/reset', { session_id: state.sessionId }, COMPACTION_TIMEOUT_MS)
        .catch((error: unknown) => { this.degradeState(state, error) })
      return
    }
    if (event.type === 'compaction/end') {
      state.reBootPending = true
      state.boot = undefined
      state.delivered.clear()
    }
  }

  /**
   * Drop all state for a disposed agent.
   * @param agent - the agent being torn down.
   */
  dispose(agent: Agent): void {
    const state = this.states.get(agent)
    if (state !== undefined) this.bySession.delete(state.session)
    this.states.delete(agent)
  }

  private async fetchNotes(state: SessionState, options: RecallOptions, timeoutMs: number): Promise<string> {
    try {
      const result = await this.client.recall(state.host, state.port, options, timeoutMs)
      if (!result.ok || result.notes === undefined) {
        this.noteFailure(state, result.error ?? 'recall returned no notes')
        return ''
      }
      state.failures = 0
      return result.notes
    } catch (error) {
      this.noteFailure(state, String(error))
      return ''
    }
  }

  private async withTimeout(
    promise: Promise<string>,
    timeoutMs: number,
    state: SessionState,
    label: string,
  ): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<string>((resolve) => {
        timer = setTimeout(() => {
          this.warnOnce(state, `timeout:${label}`, `vectr-client: ${label} timed out after ${timeoutMs}ms; injecting nothing`)
          resolve('')
        }, timeoutMs)
      })
      return await Promise.race([promise, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * De-duplicate on a staged copy, clamp, then charge the budget. Note ids are
   * committed to the session ledger only after the text is actually injected
   * and only for notes that survive clamping, so neither a budget-rejected nor
   * a truncated-out note is permanently suppressed.
   */
  private accept(state: SessionState, text: string, header: string): string | undefined {
    const staged = new Set(state.delivered)
    const fresh = dedupeNotes(text, staged)
    if (fresh === '') return undefined
    const wrapped = this.clamp(`${header}\n\n${fresh}`)
    if (!this.spend(state, wrapped)) return undefined
    for (const match of wrapped.matchAll(NOTE_ID_PATTERN)) {
      const id = Number(match[1])
      if (Number.isInteger(id)) state.delivered.add(id)
    }
    return wrapped
  }

  /** Cumulative per-turn and per-session token gate (1 token = 4 chars). */
  private spend(state: SessionState, text: string): boolean {
    const cost = Math.ceil(text.length / 4)
    if (state.turnSpentTokens + cost > this.config.perTurnTokenCap) return false
    if (state.spentTokens + cost > this.config.perSessionTokenCap) return false
    state.turnSpentTokens += cost
    state.spentTokens += cost
    return true
  }

  private clamp(text: string): string {
    const cap = this.config.maxInjectionChars
    return text.length <= cap ? text : `${text.slice(0, cap)}\n… (truncated)`
  }

  private message(text: string, label: string): UserMessage {
    return this.createMessage(text, label)
  }

  private isDisabled(state: SessionState): boolean {
    return this.now() < state.disabledUntil
  }

  private noteFailure(state: SessionState, reason: string): void {
    state.failures += 1
    if (state.failures < BREAKER_FAILURE_LIMIT) return
    state.failures = 0
    state.breakerTrips += 1
    state.disabledUntil = state.breakerTrips >= 2 ? Number.POSITIVE_INFINITY : this.now() + BREAKER_OPEN_MS
    this.warnOnce(state, 'breaker', `vectr-client: memory injection paused after ${BREAKER_FAILURE_LIMIT} failures (${reason})`)
  }

  private degrade(agent: Agent, error: unknown): void {
    const state = this.states.get(agent)
    if (state === undefined) return
    this.degradeState(state, error)
  }

  private degradeState(state: SessionState, error: unknown): void {
    this.warnOnce(state, 'degrade', `vectr-client: memory injection degraded: ${error instanceof Error ? error.message : String(error)}`)
  }

  private warnOnce(state: SessionState, key: string, message: string): void {
    if (state.warned.has(key)) return
    state.warned.add(key)
    this.logger.warn(message)
  }
}
