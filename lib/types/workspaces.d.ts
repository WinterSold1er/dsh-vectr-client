/**
 * Host data plane for the vectr workspace web console (feature A / C1).
 *
 * Two pure functions assemble the management view the browser half renders:
 *
 * - {@link scanWorkspaces}: reads the vectr daemon registry, liveness-probes
 *   every entry, then concurrently asks each live daemon for `/v1/status`. One
 *   dead or unresponsive daemon never blocks the rest of the table.
 * - {@link triggerIndex}: POSTs `/v1/index` to one daemon, with a clear
 *   pre-flight gate for modes/state that must not be re-indexed, and a
 *   transparent pass-through of a daemon's 503 "reindex in progress" text.
 *
 * Both are plain async functions over the already-exported registry helpers
 * (`readInstancesFile` / `resolveInstance` / `isDaemonAlive`) so they unit-test
 * against a temp registry file plus an in-process HTTP server, with no Cordis
 * or live daemon dependency.
 *
 * @module dsh-vectr-client/workspaces
 */
import type { Context } from '@deepseek-ai/cordis';
import { type InstanceEntry } from './registry';
import { type SkipReason, type VectrStatus } from './probe';
export type { VectrStatus };
/** Default per-status request budget before a daemon is treated as unresponsive. */
export declare const DEFAULT_STATUS_TIMEOUT_MS = 3000;
/** Default per-index-trigger request budget. */
export declare const DEFAULT_TRIGGER_TIMEOUT_MS = 30000;
/** One row in the workspace console table. */
export interface WorkspaceView {
    /** Absolute workspace directory the daemon serves. */
    workspace: string;
    /** Daemon TCP port. */
    port: number;
    /** Daemon pid, when the registry recorded one. */
    pid?: number;
    /** Registry mode (`full`, `lite`, `memory_only`, `search_only`, …). */
    mode?: string;
    /** Whether the registry record passed the liveness probe. */
    live: boolean;
    /** Precise liveness-failure reason (PROCESS_DEAD_ESRCH / PORT_CLOSED / HTTP_PROBE_TIMEOUT / HTTP_PROBE_UNREACHABLE); absent when `live`. */
    reason?: SkipReason;
    /** Human-readable reason the row is not `live`; absent when live. */
    error?: string;
    /** Parsed `/v1/status` payload; present only when `live` and the call succeeded. */
    status?: VectrStatus;
}
/** Outcome of a {@link triggerIndex} call. */
export interface TriggerResult {
    /** `true` when the daemon accepted the index request (HTTP 2xx). */
    ok: boolean;
    /** Human-readable failure reason; absent on success. */
    error?: string;
    /** HTTP status code the daemon returned, when the request reached it. */
    status?: number;
}
/**
 * Build the workspace console table: read the registry, liveness-probe each
 * entry, then concurrently fetch `/v1/status` from every live daemon.
 *
 * A missing registry file yields an empty list (no daemons configured). A
 * dead record still appears as a row with `live: false` and a reason, so the
 * operator sees stale entries instead of a silent gap. One unresponsive daemon
 * never blocks the others: the status fetch uses `Promise.allSettled` and
 * tolerates a missing/partial status payload.
 *
 * @param ctx - plugin context carrying the logger (registry read diagnostics).
 * @param instancesPath - absolute path of `instances.json`.
 * @param opts - optional per-call tuning (`statusTimeoutMs`).
 * @returns one {@link WorkspaceView} per registry entry, in registry order.
 */
export declare function scanWorkspaces(ctx: Context, instancesPath: string, opts?: {
    statusTimeoutMs?: number;
}): Promise<WorkspaceView[]>;
/**
 * Request a re-index from one daemon (`POST /v1/index` body `{"force":false}`).
 *
 * Pre-flight gates reject requests the daemon would refuse or that would be
 * unsafe:
 * - `memory_only` / `search_only` modes cannot be re-indexed (no persistent
 *   index store) — returns a clear error without hitting the network.
 * - A daemon reporting `fully_ready` false (initial index still settling) is
 *   gated to avoid piling a second pass onto an in-flight one; the caller may
 *   retry after it stabilizes.
 *
 * A daemon 503 ("reindex in progress") text is passed through verbatim so the
 * operator sees the daemon's own words. Any other non-2xx becomes a generic
 * error carrying the status code.
 *
 * @param entry - the daemon record to target.
 * @param opts - optional tuning (`timeoutMs`, and an injected `status` to avoid
 *   a second `/v1/status` round-trip when the caller already scanned).
 * @returns the {@link TriggerResult}.
 */
export declare function triggerIndex(entry: InstanceEntry, opts?: {
    timeoutMs?: number;
    status?: VectrStatus;
}): Promise<TriggerResult>;
//# sourceMappingURL=workspaces.d.ts.map