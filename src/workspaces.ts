/**
 * Host data plane for the vectr workspace web console (feature A / C1).
 *
 * Two pure functions assemble the management view the browser half renders:
 *
 * - {@link scanWorkspaces}: reads the vectr daemon registry, liveness-probes
 *   every entry, then concurrently asks each live daemon for `/v1/status`. One
 *   dead or unresponsive daemon never blocks the rest of the table. The table is
 *   then unioned with {@link discoverWorkspaceRoots}, so a workspace DSH knows
 *   about but that has no daemon is still listed (`reason: 'not started'`).
 * - {@link triggerIndex}: POSTs `/v1/index` to one daemon, with a clear
 *   pre-flight gate for modes/state that must not be re-indexed, and a
 *   transparent pass-through of a daemon's 503 "reindex in progress" text.
 *
 * Both are plain async functions over the already-exported registry helpers
 * (`readInstancesFile` / `resolveInstance` / `isDaemonAlive`) so they unit-test
 * against a temp registry file plus an in-process HTTP server, with no Cordis
 * or live daemon dependency. Discovery takes its file path as an argument for
 * the same reason: tests drive a temp fixture, never the real `$HOME`.
 *
 * @module dsh-vectr-client/workspaces
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { readInstancesFile, type InstanceEntry, type InstancesFile } from './registry'
import { normalizeMode, normalizePath } from './domain/rules'
import { DEFAULT_TCP_TIMEOUT_MS, diagnoseDaemon, fetchStatus, type SkipReason, type VectrStatus } from './probe'
import { DEFAULT_CODEBASES_FILE, loadCodebases } from './codebases'

// Re-exported so existing importers (and tests) keep resolving VectrStatus
// from this module without a Cordis/config dependency on the probe layer.
export type { VectrStatus }

/** Default per-status request budget before a daemon is treated as unresponsive. */
export const DEFAULT_STATUS_TIMEOUT_MS = 3000

/** DSH's own workspace registry (`$DSH_HOME/storages/workspace.json`, `~/.dsh` fallback). */
export const DEFAULT_DSH_WORKSPACE_FILE = join(
  process.env['DSH_HOME'] ?? join(homedir(), '.dsh'),
  'storages',
  'workspace.json',
)

/** One workspace root DSH knows about, with the title it shows for it. */
export interface DiscoveredWorkspace {
  /** Absolute workspace directory. */
  workspace: string
  /** Display title from DSH's workspace registry; absent when it has none. */
  title?: string
}

/**
 * Dedupe key for a workspace path: absolute, trailing separators dropped.
 *
 * The two discovery sources spell the same directory differently (`/a/b`,
 * `/a/b/`, `/a/./b`); without one canonical spelling the union would list a
 * workspace twice.
 */
export function normalizeWorkspacePath(workspace: string): string {
  return normalizePath(resolve(workspace))
}

/**
 * Read every workspace root DSH records, best-effort.
 *
 * The source is the DSH unit store `{ tables: { workspaces: { <id>: { path,
 * title } } } }`. Discovery is decoration for the console, never a blocker: a
 * missing, unreadable or unparseable file degrades to an empty list and reports
 * through `onError` (production: the logger) instead of throwing. A workspace
 * whose `path` is absent, empty or relative is skipped — it cannot be served by
 * a daemon.
 *
 * @param filePath - absolute path of DSH's `workspace.json`.
 * @param onError - diagnostic sink for the degradation paths.
 * @returns discovered roots in file order, deduped by {@link normalizeWorkspacePath}.
 */
export function discoverWorkspaceRoots(
  filePath: string,
  onError?: (error: unknown) => void,
): DiscoveredWorkspace[] {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    onError?.(error)
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    onError?.(error)
    return []
  }
  const table = (parsed as { tables?: { workspaces?: unknown } } | null)?.tables?.workspaces
  if (typeof table !== 'object' || table === null || Array.isArray(table)) return []

  const roots: DiscoveredWorkspace[] = []
  const seen = new Set<string>()
  for (const record of Object.values(table as Record<string, unknown>)) {
    const path = (record as { path?: unknown } | null)?.path
    if (typeof path !== 'string' || path === '' || !isAbsolute(path)) continue
    const key = normalizeWorkspacePath(path)
    if (seen.has(key)) continue
    seen.add(key)
    const title = (record as { title?: unknown }).title
    roots.push({
      workspace: path,
      ...(typeof title === 'string' && title.trim() !== '' ? { title: title.trim() } : {}),
    })
  }
  return roots
}

/** Default per-index-trigger request budget. */
export const DEFAULT_TRIGGER_TIMEOUT_MS = 30_000

/**
 * One row in the workspace console table.
 *
 * Three kinds share the shape: a live daemon, a registry record that failed its
 * liveness probe, and a workspace DSH knows about that has no daemon at all
 * (`live: false`, `reason: 'not started'`, no `port`).
 */
export interface WorkspaceView {
  /** Absolute workspace directory. */
  workspace: string
  /** Daemon TCP port; absent on a known-but-not-started row. */
  port?: number
  /** Daemon pid, when the registry recorded one. */
  pid?: number
  /** Registry mode (`full`, `lite`, `memory_only`, `search_only`, …). */
  mode?: string
  /** Whether the registry record passed the liveness probe. */
  live: boolean
  /** Whether `vectr-codebases.json` already has a record for this workspace. */
  registered: boolean
  /** Display title from DSH's workspace registry, when known. */
  title?: string
  /** Why the row is not live: a probe failure reason, or `'not started'` for a discovered workspace with no daemon record. */
  reason?: SkipReason | 'not started'
  /** Human-readable reason the row is not `live`; absent when live. */
  error?: string
  /** Parsed `/v1/status` payload; present only when `live` and the call succeeded. */
  status?: VectrStatus
}

/** Outcome of a {@link triggerIndex} call. */
export interface TriggerResult {
  /** `true` when the daemon accepted the index request (HTTP 2xx). */
  ok: boolean
  /** Human-readable failure reason; absent on success. */
  error?: string
  /** HTTP status code the daemon returned, when the request reached it. */
  status?: number
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
 * @param opts - optional per-call tuning (`statusTimeoutMs`) and the workspace
 *   discovery source (`discover`, production: {@link discoverWorkspaceRoots}).
 * @returns registry rows in registry order, then not-started rows for every
 * discovered workspace the registry does not already describe.
 */
export async function scanWorkspaces(
  ctx: Context,
  instancesPath: string,
  opts: {
    statusTimeoutMs?: number
    discover?: () => DiscoveredWorkspace[]
    /** Codebase metadata file; defaults to the real `~/.dsh/vectr-codebases.json`. */
    codebasesPath?: string
  } = {},
): Promise<WorkspaceView[]> {
  const timeoutMs = opts.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS
  // Explicitly registered codebases, keyed by the same canonical path used for
  // dedupe below: a workspace that only exists because DSH knows it has no
  // record here, which is what the console needs to distinguish.
  const codebasesPath = opts.codebasesPath ?? DEFAULT_CODEBASES_FILE
  const registeredPaths = new Set<string>()
  try {
    for (const entry of loadCodebases(codebasesPath)) {
      for (const p of [entry.path, entry.workspace]) {
        if (typeof p === 'string' && p !== '') registeredPaths.add(normalizeWorkspacePath(p))
      }
    }
  } catch (error) {
    // A broken metadata file must not blank the workspace table: the badge
    // degrades to "unregistered" and the real cause goes to the log.
    ctx.logger.warn(`vectr-client: cannot read codebase metadata at ${codebasesPath} (${String(error)}); workspace rows report registered: false`)
  }
  const isRegistered = (workspace: string): boolean => registeredPaths.has(normalizeWorkspacePath(workspace))
  let instances: InstancesFile | undefined
  try {
    instances = readInstancesFile(ctx, instancesPath)
  } catch (error) {
    // An unparseable registry must surface, not masquerade as "no daemons".
    throw error
  }

  const entries = instances === undefined ? [] : Object.values(instances)
  // Use the precise diagnosis (not the boolean gate) so the console shows the
  // exact death reason (R4/M1) instead of a generic "not alive" string.
  const liveness = await Promise.all(entries.map(async (entry) =>
    diagnoseDaemon(entry, {
      httpProbe: (e, ms) => fetchStatus(e, ms),
      httpTimeoutMs: timeoutMs,
      tcpTimeoutMs: DEFAULT_TCP_TIMEOUT_MS,
    }),
  ))

  const rows = await Promise.allSettled(entries.map(async (entry, i) => {
    const diag = liveness[i]!
    // The registry stores whatever spelling the CLI wrote ("memory-only"), so
    // canonicalize once here: every consumer of this payload compares against
    // the canonical 'memory_only'.
    const mode = normalizeMode(entry.mode)
    if (!diag.alive) {
      return {
        workspace: entry.workspace,
        port: entry.port,
        ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
        ...(mode !== undefined ? { mode } : {}),
        live: false,
        registered: isRegistered(entry.workspace),
        ...(diag.reason !== undefined ? { reason: diag.reason } : {}),
        error: diag.reason !== undefined ? `daemon not alive: ${diag.reason}` : 'daemon not alive',
      } satisfies WorkspaceView
    }
    const status = await fetchStatus(entry, timeoutMs)
    return {
      workspace: entry.workspace,
      port: entry.port,
      ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
      ...(mode !== undefined ? { mode } : {}),
      live: true,
      registered: isRegistered(entry.workspace),
      ...(status !== undefined ? { status } : {}),
    } satisfies WorkspaceView
  }))

  const views = rows.map((settled, i) => {
    if (settled.status === 'fulfilled') return settled.value
    // A throw inside the row mapper is a programming error in the probe chain;
    // represent it as a non-live row with the reason rather than dropping it.
    const entry = entries[i]!
    const mode = normalizeMode(entry.mode)
    return {
      workspace: entry.workspace,
      port: entry.port,
      ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
      ...(mode !== undefined ? { mode } : {}),
      live: false,
      registered: isRegistered(entry.workspace),
      error: `status probe failed: ${String(settled.reason)}`,
    } satisfies WorkspaceView
  })

  // Union in the workspaces DSH knows about that have no daemon record: without
  // this the console only ever shows what a daemon wrote to the registry, so a
  // workspace that was added but never started stays invisible. Registry
  // records win a path collision — they carry the real daemon state.
  const discovered = opts.discover?.() ?? []
  if (discovered.length === 0) return views

  const titleByPath = new Map<string, string>()
  for (const root of discovered) {
    if (root.title !== undefined) titleByPath.set(normalizeWorkspacePath(root.workspace), root.title)
  }
  const titled: WorkspaceView[] = views.map((view) => {
    const title = titleByPath.get(normalizeWorkspacePath(view.workspace))
    return title === undefined ? view : { ...view, title }
  })

  const seen = new Set(entries.map(entry => normalizeWorkspacePath(entry.workspace)))
  for (const root of discovered) {
    const key = normalizeWorkspacePath(root.workspace)
    if (seen.has(key)) continue
    seen.add(key)
    titled.push({
      workspace: root.workspace,
      ...(root.title !== undefined ? { title: root.title } : {}),
      live: false,
      registered: isRegistered(root.workspace),
      reason: 'not started',
      error: 'daemon not started',
    } satisfies WorkspaceView)
  }
  return titled
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
export async function triggerIndex(
  entry: InstanceEntry,
  opts: { timeoutMs?: number; status?: VectrStatus } = {},
): Promise<TriggerResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TRIGGER_TIMEOUT_MS
  // Same canonical spelling as the API payload above: a registry entry written
  // as "memory-only" must not slip past this gate and reach the network.
  const mode = normalizeMode(entry.mode)
  if (mode === 'memory_only' || mode === 'search_only') {
    return { ok: false, error: `cannot re-index daemon in '${mode}' mode (no persistent index store)` }
  }

  const status = opts.status
  if (status !== undefined && status.fully_ready === false) {
    return { ok: false, error: 'daemon not fully_ready (initial index still settling); retry after it stabilizes' }
  }

  const host = entry.host ?? '127.0.0.1'
  const controller = new AbortController()
  const timer = sleep(timeoutMs).then(() => controller.abort())
  try {
    const res = await fetch(`http://${host}:${entry.port}/v1/index`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: false }),
      signal: controller.signal,
    })
    if (res.ok) return { ok: true, status: res.status }
    const text = await res.text().catch(() => '')
    if (res.status === 503) {
      // Pass through the daemon's own "reindex in progress" wording.
      //
      // Concurrency note (H7): this client has NO plugin-side guard against
      // concurrent re-indexes — it deliberately relies on the daemon to reject a
      // second `POST /v1/index` while one is already running with a 503
      // `reindex_in_progress`. The frontend disables the button during an in-
      // flight call, but that is only UX; the real backstop is this 503 pass-
      // through. If the daemon ever stops returning 503 for a busy index, the
      // client would happily double-trigger — the guard lives in the daemon.
      return { ok: false, error: text.trim() || 'reindex already in progress (503)', status: 503 }
    }
    return { ok: false, error: `index request rejected: ${res.status}${text ? ` ${text}` : ''}`, status: res.status }
  } catch (error) {
    return { ok: false, error: `index request failed: ${String(error)}` }
  } finally {
    void timer.catch(() => {})
  }
}
