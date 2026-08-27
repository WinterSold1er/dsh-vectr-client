/**
 * Probe layer for the vectr-client plugin (pure, no Cordis / no config).
 *
 * Combines the process-layer liveness signal (pid / TCP) with an HTTP
 * `/v1/status` probe so a "pid alive + port listening but HTTP hung" daemon is
 * correctly judged dead (requirement R3). Every external dependency is injected
 * (`httpProbe`), so the gate is fully unit-testable with no real network
 * (NFR3). Imports only the leaf {@link registry} module.
 *
 * @module dsh-vectr-client/probe
 */
import { type InstanceEntry } from './registry';
/** Shape of `/v1/status` as vectr documents it (optional fields tolerated). */
export interface VectrStatus {
    indexed_files?: number;
    total_chunks?: number;
    languages?: string[];
    last_indexed?: string | null;
    notes_count?: number;
    fully_ready?: boolean;
    reindex_in_progress?: boolean;
    embed_model?: string;
    [key: string]: unknown;
}
/** Default TCP connect budget for the port-listening probe. */
export declare const DEFAULT_TCP_TIMEOUT_MS = 300;
/**
 * An injected HTTP probe standing in for `fetchStatus`. Returns the parsed
 * `/v1/status` payload when the daemon answers 2xx within budget, `undefined`
 * on a non-2xx / timeout / transport failure. Implementations may throw to
 * model a hard timeout; {@link diagnoseDaemon} treats a throw as "probe hung".
 */
export type HttpProbe = (entry: InstanceEntry, timeoutMs: number) => Promise<VectrStatus | undefined>;
/** Reason a daemon record was judged not alive (for skip diagnostics, R4). */
export type SkipReason = 'PROCESS_DEAD_ESRCH' | 'PORT_CLOSED' | 'HTTP_PROBE_TIMEOUT' | 'HTTP_PROBE_UNREACHABLE';
/** Result of the combined liveness diagnosis. */
export interface AliveDiagnosis {
    /** `true` only when the process layer AND the HTTP layer both pass. */
    alive: boolean;
    /** Why the record is dead; absent when `alive`. */
    reason?: SkipReason;
}
/** Dependencies for {@link diagnoseDaemon} / {@link isDaemonAlive}. */
export interface ProbeDeps {
    /** Injected HTTP `/v1/status` probe (default: {@link fetchStatus}). */
    httpProbe: HttpProbe;
    /** Budget for the HTTP probe (ms). */
    httpTimeoutMs: number;
    /** Budget for the TCP port-listening probe (ms). */
    tcpTimeoutMs: number;
}
/**
 * TCP liveness probe for a vectr daemon endpoint.
 * @param host - bind host.
 * @param port - TCP port of the daemon's endpoint.
 * @param timeoutMs - connect timeout before declaring the port dead.
 * @returns `true` when a TCP connection opens within the budget, else `false`.
 */
export declare function isPortListening(host: string, port: number, timeoutMs?: number): Promise<boolean>;
/**
 * Fetch `/v1/status` from one daemon, returning `undefined` on any transport
 * failure or non-2xx so the caller can decide how to render the row. This is
 * the single HTTP probe reused by both the liveness gate (R3) and the console
 * scan; do not re-implement the HTTP detection elsewhere.
 * fetchStatus swallows *all* transport/parse errors and returns `undefined`, so in
 * production it never throws — meaning a live daemon whose answer merely times
 * out surfaces as `HTTP_PROBE_UNREACHABLE` (undefined), not `HTTP_PROBE_TIMEOUT`.
 * The `HTTP_PROBE_TIMEOUT` reason (throw path) is only reached when an *injected*
 * `httpProbe` throws (test seam), never by `fetchStatus` itself. This is a
 * deliberate semantic boundary: production never emits HTTP_PROBE_TIMEOUT, but
 * correctness is unaffected because both reasons yield `alive: false`.
 * @param entry - the daemon registry record.
 * @param timeoutMs - abort budget for the request.
 * @returns the parsed status object, or `undefined` on failure.
 */
export declare function fetchStatus(entry: InstanceEntry, timeoutMs: number): Promise<VectrStatus | undefined>;
/**
 * Combined liveness diagnosis (requirement R3):
 *
 *   processLayer = (pid present AND kill(pid,0) succeeds)
 *               OR (TCP port listening)
 *   httpLayer    = httpProbe(entry, httpTimeoutMs) !== undefined
 *   alive        = processLayer AND httpLayer
 *
 * A "pid alive + port listening but HTTP hung" daemon fails `httpLayer` and is
 * judged dead. The injected `httpProbe` is wrapped so any throw is treated as a
 * hang (the gate never propagates an exception, NFR4/R4).
 *
 * @param entry - the daemon record to validate.
 * @param deps - injected probe + timeouts.
 * @returns the diagnosis (alive flag + optional reason).
 */
export declare function diagnoseDaemon(entry: InstanceEntry, deps: ProbeDeps): Promise<AliveDiagnosis>;
/**
 * Liveness gate boolean (requirement R3). Thin wrapper over
 * {@link diagnoseDaemon} for callers that only need the verdict.
 * @param entry - the daemon record to validate.
 * @param deps - injected probe + timeouts.
 * @returns `true` only when process layer AND HTTP layer both pass.
 */
export declare function isDaemonAlive(entry: InstanceEntry, deps: ProbeDeps): Promise<boolean>;
//# sourceMappingURL=probe.d.ts.map