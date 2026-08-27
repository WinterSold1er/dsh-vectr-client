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
import { setTimeout as sleep } from 'node:timers/promises';
import { readInstancesFile } from './registry';
import { DEFAULT_TCP_TIMEOUT_MS, diagnoseDaemon, fetchStatus } from './probe';
/** Default per-status request budget before a daemon is treated as unresponsive. */
export const DEFAULT_STATUS_TIMEOUT_MS = 3000;
/** Default per-index-trigger request budget. */
export const DEFAULT_TRIGGER_TIMEOUT_MS = 30_000;
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
export async function scanWorkspaces(ctx, instancesPath, opts = {}) {
    const timeoutMs = opts.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
    let instances;
    try {
        instances = readInstancesFile(ctx, instancesPath);
    }
    catch (error) {
        // An unparseable registry must surface, not masquerade as "no daemons".
        throw error;
    }
    if (instances === undefined)
        return [];
    const entries = Object.values(instances);
    // Use the precise diagnosis (not the boolean gate) so the console shows the
    // exact death reason (R4/M1) instead of a generic "not alive" string.
    const liveness = await Promise.all(entries.map(async (entry) => diagnoseDaemon(entry, {
        httpProbe: (e, ms) => fetchStatus(e, ms),
        httpTimeoutMs: timeoutMs,
        tcpTimeoutMs: DEFAULT_TCP_TIMEOUT_MS,
    })));
    const rows = await Promise.allSettled(entries.map(async (entry, i) => {
        const diag = liveness[i];
        if (!diag.alive) {
            return {
                workspace: entry.workspace,
                port: entry.port,
                ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
                ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
                live: false,
                ...(diag.reason !== undefined ? { reason: diag.reason } : {}),
                error: diag.reason !== undefined ? `daemon not alive: ${diag.reason}` : 'daemon not alive',
            };
        }
        const status = await fetchStatus(entry, timeoutMs);
        return {
            workspace: entry.workspace,
            port: entry.port,
            ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
            ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
            live: true,
            ...(status !== undefined ? { status } : {}),
        };
    }));
    return rows.map((settled, i) => {
        if (settled.status === 'fulfilled')
            return settled.value;
        // A throw inside the row mapper is a programming error in the probe chain;
        // represent it as a non-live row with the reason rather than dropping it.
        const entry = entries[i];
        return {
            workspace: entry.workspace,
            port: entry.port,
            ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
            ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
            live: false,
            error: `status probe failed: ${String(settled.reason)}`,
        };
    });
}
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
export async function triggerIndex(entry, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TRIGGER_TIMEOUT_MS;
    const mode = entry.mode;
    if (mode === 'memory_only' || mode === 'search_only') {
        return { ok: false, error: `cannot re-index daemon in '${mode}' mode (no persistent index store)` };
    }
    const status = opts.status;
    if (status !== undefined && status.fully_ready === false) {
        return { ok: false, error: 'daemon not fully_ready (initial index still settling); retry after it stabilizes' };
    }
    const host = entry.host ?? '127.0.0.1';
    const controller = new AbortController();
    const timer = sleep(timeoutMs).then(() => controller.abort());
    try {
        const res = await fetch(`http://${host}:${entry.port}/v1/index`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ force: false }),
            signal: controller.signal,
        });
        if (res.ok)
            return { ok: true, status: res.status };
        const text = await res.text().catch(() => '');
        if (res.status === 503) {
            // Pass through the daemon's own "reindex in progress" wording.
            return { ok: false, error: text.trim() || 'reindex already in progress (503)', status: 503 };
        }
        return { ok: false, error: `index request rejected: ${res.status}${text ? ` ${text}` : ''}`, status: res.status };
    }
    catch (error) {
        return { ok: false, error: `index request failed: ${String(error)}` };
    }
    finally {
        void timer.catch(() => { });
    }
}
//# sourceMappingURL=workspaces.js.map