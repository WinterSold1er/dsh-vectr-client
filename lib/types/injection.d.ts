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
import { type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent';
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools';
import type { RecallOptions } from './domain/types';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /** Context injected by this plugin's host-side working-memory bridge. */
        vectr: {
            kind: 'vectr';
        } & ContextFormed;
    }
}
/** Source kind carried by every message this module injects. */
export declare const INJECTION_SOURCE_KIND = "vectr";
/** Failure count that opens the injection breaker. */
export declare const BREAKER_FAILURE_LIMIT = 3;
/** Open duration of the first breaker strike. */
export declare const BREAKER_OPEN_MS = 60000;
/** Seconds-free knobs resolved by the plugin config; all values are bounded. */
export interface InjectionConfig {
    bootRecallTimeoutMs: number;
    promptRecallTimeoutMs: number;
    toolRecallTimeoutMs: number;
    promptRecallLimit: number;
    perTurnTokenCap: number;
    perSessionTokenCap: number;
    maxInjectionChars: number;
    injectCompactionSnapshot: boolean;
}
export interface InjectionLogger {
    warn(message: string): void;
}
/** HTTP boundary used by tests to assert the exact request shape. */
export interface RecallClient {
    recall(host: string, port: number, options: RecallOptions, timeoutMs: number): Promise<{
        ok: boolean;
        notes?: string | undefined;
        error?: string | undefined;
    }>;
}
export type PostRequest = (host: string, port: number, path: string, body: Record<string, unknown>, timeoutMs: number) => Promise<void>;
export interface HostInjectorDeps {
    logger: InjectionLogger;
    config: InjectionConfig;
    client?: RecallClient | undefined;
    now?: (() => number) | undefined;
    post?: PostRequest | undefined;
    createMessage?: ((text: string, label: string) => UserMessage) | undefined;
}
export interface BindTarget {
    host: string;
    port: number;
    hasCode: boolean;
}
export interface PreStepPayload {
    agent: Agent;
    messages: UserMessage[];
    turn: number;
    step: number;
    signal: AbortSignal;
}
/** Probed key + recall options for one tool call, when the call is injectable. */
export interface ToolProbe {
    key: string;
    options: RecallOptions;
}
/**
 * Filter out note lines whose ids were already delivered this session.
 * Lines without an id are kept as-is (headers, continuation text). Mutates
 * `delivered` with the ids of the lines it keeps.
 * @param text - recall output.
 * @param delivered - session-wide set of note ids already shown to the model.
 * @returns the de-duplicated text; `''` when every note was a repeat.
 */
export declare function dedupeNotes(text: string, delivered: Set<number>): string;
/**
 * Last genuine human message in the claimed step batch. Injected context
 * messages carry a non-`user` source kind, so they never become a recall
 * query.
 * @param messages - messages claimed by the step.
 * @returns the prompt text, or `undefined` when the batch has no human prompt.
 */
export declare function lastHumanPrompt(messages: readonly UserMessage[]): string | undefined;
/**
 * Map one tool call onto upstream's `PreToolUse` payload shape. DSH's built-in
 * `edit`/`write` use `file_path` and `bash` uses `command`, exactly like the
 * upstream payload, so no field renaming is needed.
 * @param name - tool name.
 * @param args - parsed tool arguments.
 * @returns the probe, or `undefined` when the call is not injectable.
 */
export declare function toolProbe(name: string, args: unknown): ToolProbe | undefined;
/**
 * Owns all dynamic working-memory injection for one plugin instance.
 * Agents are keyed weakly; state dies with the agent.
 */
export declare class HostInjector {
    private readonly states;
    private readonly bySession;
    private readonly logger;
    private readonly config;
    private readonly client;
    private readonly now;
    private readonly post;
    private readonly createMessage;
    constructor(deps: HostInjectorDeps);
    /**
     * Attach injection state to an agent whose workspace resolved a live daemon.
     * Idempotent; a rebind after daemon restart refreshes the endpoint but keeps
     * the session's delivery ledger.
     * @param agent - the agent whose turns receive injections.
     * @param target - resolved daemon endpoint and whether an indexed codebase is bound.
     */
    bind(agent: Agent, target: BindTarget): void;
    /**
     * A `compact` session source means the conversation was compressed: the next
     * boot recall must carry `post-compaction` and re-deliver notes.
     * @param agent - the agent whose session source changed.
     * @param source - session start source.
     */
    markSource(agent: Agent, source: string): void;
    /**
     * Start the boot recall once for the session (or once after compaction).
     * The promise is stored so the first pre-step awaits it instead of issuing
     * a second request.
     * @param agent - the agent to prefetch for.
     */
    prefetchBoot(agent: Agent): void;
    /**
     * Inject the boot pack on the first step and prompt-relevant notes on the
     * first step of every later turn. The step is never blocked beyond the
     * configured bounds, and any thrown error leaves the decision untouched.
     * @param payload - step payload from the host.
     * @param next - downstream pre-step waterfall.
     * @returns the possibly extended step decision.
     */
    onPreStep(payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>;
    /**
     * Attach a tool-anchored gotcha pack to the next request. Only `accept`
     * decisions are extended; the tool result itself is passed through by
     * reference (never re-wrapped).
     * @param exec - the tool call that just ran.
     * @param next - downstream post-execute waterfall.
     * @returns the possibly extended post-execute decision.
     */
    onPostExecute(exec: ToolExecution, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>;
    /**
     * Consume compaction lifecycle events: snapshot + reset the trigger ledger
     * before compaction, and mark the next boot for re-delivery after it.
     * @param session - the session that appended the event.
     * @param event - the appended session event.
     */
    onSessionEvent(session: object, event: {
        type: string;
    }): void;
    /**
     * Drop all state for a disposed agent.
     * @param agent - the agent being torn down.
     */
    dispose(agent: Agent): void;
    private fetchNotes;
    private withTimeout;
    /**
     * De-duplicate on a staged copy, clamp, then charge the budget. Note ids are
     * committed to the session ledger only after the text is actually injected
     * and only for notes that survive clamping, so neither a budget-rejected nor
     * a truncated-out note is permanently suppressed.
     */
    private accept;
    /** Cumulative per-turn and per-session token gate (1 token = 4 chars). */
    private spend;
    private clamp;
    private message;
    private isDisabled;
    private noteFailure;
    private degrade;
    private degradeState;
    private warnOnce;
}
//# sourceMappingURL=injection.d.ts.map