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
import { setTimeout as sleep } from 'node:timers/promises';
import { connect as tcpConnect } from 'node:net';
import { DEFAULT_HOST } from './registry';
/** Default TCP connect budget for the port-listening probe. */
export const DEFAULT_TCP_TIMEOUT_MS = 300;
/**
 * TCP liveness probe for a vectr daemon endpoint.
 * @param host - bind host.
 * @param port - TCP port of the daemon's endpoint.
 * @param timeoutMs - connect timeout before declaring the port dead.
 * @returns `true` when a TCP connection opens within the budget, else `false`.
 */
export function isPortListening(host, port, timeoutMs = DEFAULT_TCP_TIMEOUT_MS) {
    return new Promise((resolveAlive) => {
        const socket = tcpConnect(port, host, () => {
            socket.destroy();
            resolveAlive(true);
        });
        const onError = () => {
            socket.destroy();
            resolveAlive(false);
        };
        socket.once('error', onError);
        socket.setTimeout(timeoutMs, () => {
            socket.destroy();
            resolveAlive(false);
        });
    });
}
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
export async function fetchStatus(entry, timeoutMs) {
    const host = entry.host ?? DEFAULT_HOST;
    const controller = new AbortController();
    const timer = sleep(timeoutMs).then(() => controller.abort());
    try {
        const res = await fetch(`http://${host}:${entry.port}/v1/status`, { signal: controller.signal });
        if (!res.ok)
            return undefined;
        return await res.json();
    }
    catch {
        return undefined;
    }
    finally {
        void timer.catch(() => { });
    }
}
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
export async function diagnoseDaemon(entry, deps) {
    const host = entry.host ?? DEFAULT_HOST;
    // Process layer: pid signal is authoritative when present AND numeric (a
    // non-number pid, e.g. the string 'abc', would make process.kill throw
    // TypeError(ERR_INVALID_ARG_TYPE) which is neither ESRCH nor ENOENT and would
    // be wrongly treated as "alive"; treat such records as pid-less and fall
    // through to the TCP/HTTP layer instead).
    if (typeof entry.pid === 'number') {
        try {
            process.kill(entry.pid, 0);
            // alive at process layer → fall through to the HTTP layer.
        }
        catch (error) {
            const code = error?.code;
            if (code === 'ESRCH' || code === 'ENOENT')
                return { alive: false, reason: 'PROCESS_DEAD_ESRCH' };
            // EPERM or other codes: process exists; treat as alive → HTTP layer.
        }
    }
    else {
        // No pid: a listening socket is the weakest "something answers" signal.
        const tcpAlive = await isPortListening(host, entry.port, deps.tcpTimeoutMs);
        if (!tcpAlive)
            return { alive: false, reason: 'PORT_CLOSED' };
    }
    // HTTP layer: reuse the same /v1/status probe the console scan uses.
    try {
        const status = await deps.httpProbe(entry, deps.httpTimeoutMs);
        if (status === undefined)
            return { alive: false, reason: 'HTTP_PROBE_UNREACHABLE' };
        return { alive: true };
    }
    catch {
        return { alive: false, reason: 'HTTP_PROBE_TIMEOUT' };
    }
}
/**
 * Liveness gate boolean (requirement R3). Thin wrapper over
 * {@link diagnoseDaemon} for callers that only need the verdict.
 * @param entry - the daemon record to validate.
 * @param deps - injected probe + timeouts.
 * @returns `true` only when process layer AND HTTP layer both pass.
 */
export async function isDaemonAlive(entry, deps) {
    return (await diagnoseDaemon(entry, deps)).alive;
}
//# sourceMappingURL=probe.js.map