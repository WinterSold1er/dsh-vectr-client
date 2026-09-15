/**
 * Per-workspace vectr MCP binding plugin: on every `agent/created` (and for
 * already-live agents at startup) it resolves the agent's workspace (session
 * cwd), looks up that workspace's vectr daemon port in
 * `~/.vectr/instances.json`, connects a Streamable HTTP MCP client to
 * `http://localhost:<port>/mcp` through the shared mcp-client supervisor, and
 * registers the vectr tools (`mcp__vectr__*`) scoped to that agent only.
 * `agent/disposed` closes the HTTP connection; the agent scope unwinds the
 * tool registrations on its own.
 *
 * Each workspace directory has its own vectr daemon (and port), so the binding
 * is entirely derived from the agent's workspace — no global MCP config.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is
 * effect-scoped: disposal closes every live connection.
 *
 * @module dsh-vectr-client
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  resolveReconnectPolicy,
  startConnection,
  type ConnectionHandle,
  type ReconnectConfig,
} from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
// P7: these symbols are only exposed via the package SUBPATH
// `@deepseek-ai/dsh-mcp-client/src/connection.ts`; the package ROOT only
// re-exports { Config, apply, inject, name }. Pinning the subpath import is
// intentional and must not be 'simplified' to the root, or the real binding is
// lost at build time (rc.2 constraint; revisit if upstream adds root exports).
import { scanWorkspaces, triggerIndex } from './workspaces'
import {
  cleanupOrphanedTunnelsForCodebases,
  cleanupStaleTunnelSockets,
  createCodebase,
  deleteCodebase,
  ensureTunnelUp,
  FileCredentialStore,
  loadCodebases,
  migrateCodebases,
  patchCodebase,
  CodebaseError,
  testCodebase,
  UNASSIGNED_WORKSPACE,
  type CodebaseEntry,
  type CodebaseSpec,
  type CredentialStore,
  type SpawnHandle,
  type SpawnRunner,
  type SshRunner,
} from './codebases'
import {
  DEFAULT_INSTANCES_FILE,
  DEFAULT_HOST,
  resolveInstance,
  readInstancesFile,
  WORKSPACE_KEY_LENGTH,
  type InstancesFile,
} from './registry'
import {
  DEFAULT_TCP_TIMEOUT_MS,
  diagnoseDaemon,
  fetchStatus,
  isPortListening,
} from './probe'
import { VectrCliRunner, VectrApiClient, InstanceResolver, CodebaseService } from './infra'
import { SessionVectrService, registerSessionRoutes } from './bridge'
import { hasCodebase, isSystemPrimarySlug } from './domain'

// Export 4-layer architecture modules (Domain Core, Infrastructure, Host RPC Bridge)
export * from './domain'
export * from './infra'
export * from './bridge'

// Re-export the registry/probe surface so existing importers (and tests) keep
// resolving these symbols from the plugin root without the index↔workspaces cycle.
export { isDaemonAlive, isPortListening } from './probe'
export { readInstancesFile, resolveInstance, DEFAULT_INSTANCES_FILE, WORKSPACE_KEY_LENGTH } from './registry'
export type { InstanceEntry, InstancesFile } from './registry'

// Re-export the tunnel self-heal surface (问题1B) so callers/tests resolve it
// from the plugin root, and so the built artifact provably contains it.
export { ensureTunnelUp, probeTunnel, DEFAULT_TUNNEL_PROBE_MS } from './codebases'
export type { TunnelHealth, EnsureTunnelResult, TestCodebaseOpts } from './codebases'

/** Return a shallow copy with the credential ref omitted (no secret leaks). */
function stripSecret(entry: CodebaseEntry): CodebaseEntry {
  const { credentialRef: _credentialRef, ...rest } = entry
  return rest
}

/**
 * Local structural view of the host `webServer` service this plugin registers
 * routes on. Declared as a Cordis `Context` augmentation so `ctx.webServer` is
 * typed without taking a build dependency on the webserver package; the running
 * host provides the real implementation. Only the `register` surface used here
 * is shaped.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServerLike
    /** Provided by `@deepseek-ai/dsh-system-prompt` at host runtime (same
     * optional-augmentation pattern as `webServer` above). Declared here so
     * `agent.ctx.systemPrompt.section(...)` type-checks without a build
     * dependency on the system-prompt package. */
    systemPrompt: SystemPrompt
  }
}

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'vectr-client'

/** Services required by this plugin. `webServer` is consumed optionally via
 * `ctx.get` (see {@link registerManagementRoutes}) so the plugin also loads in
 * harness compositions that do not boot the web server; the host provides it. */
export const inject = ['agents']

/** Default per-tool-call timeout for vectr MCP calls (ms). */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Default local namespace for vectr tools (`mcp__vectr__*`). */
export const DEFAULT_SERVER_NAME = 'vectr'

/** Default path of the multi-codebase metadata file (feature B). */
export const DEFAULT_CODEBASES_FILE = join(homedir(), '.dsh', 'vectr-codebases.json')

/** Default path of the file-backed secret store (used when no host credentials service). */
export const DEFAULT_SECRETS_FILE = join(homedir(), '.dsh', 'vectr-secrets.json')

/** Plugin configuration validated by {@link Config}. */
export interface Config {
  /** Path of the vectr daemon registry (default `~/.vectr/instances.json`). */
  instancesPath?: string
  /** Local namespace for the vectr tools (`mcp__<serverName>__*`). */
  serverName?: string
  /** Per-tool-call timeout in milliseconds (default 60000). */
  toolCallTimeoutMs?: number
  /** Automatic reconnect policy after a lost connection; default `{ enabled: false }`. */
  reconnect?: ReconnectConfig
  /** Path of the multi-codebase metadata file (feature B; default `~/.dsh/vectr-codebases.json`). */
  codebasesPath?: string
  /** Path of the file-backed secret store (feature B; default `~/.dsh/vectr-secrets.json`). */
  secretsPath?: string
  /** HTTP `/v1/status` liveness-probe budget in ms (default 5000); below the known hang window so a hung daemon is judged dead. */
  daemonHttpTimeoutMs?: number
  /** TCP port-listening probe budget in ms (default 300). */
  daemonTcpTimeoutMs?: number
  /** Optional custom path to vectr CLI executable (default derived from env or PATH). */
  cliPath?: string
  /** Vectr CLI execution timeout in ms (default 30000). */
  cliTimeoutMs?: number
  /** Working memory note recall / resume timeout in ms (default 10000). */
  recallTimeoutMs?: number
  /** Vectr workspace upgrade timeout in ms (default 15000). */
  upgradeTimeoutMs?: number
}

/** Default HTTP `/v1/status` liveness-probe budget (ms); below the known hang window. */
export const DEFAULT_DAEMON_HTTP_TIMEOUT_MS = 5_000
export const DEFAULT_HTTP_TIMEOUT_MS = DEFAULT_DAEMON_HTTP_TIMEOUT_MS

/** Default TCP port-listening probe budget (ms). */
export const DEFAULT_DAEMON_TCP_TIMEOUT_MS = DEFAULT_TCP_TIMEOUT_MS

/** Default Vectr CLI execution timeout in ms (default 30,000). */
export const DEFAULT_CLI_TIMEOUT_MS = 30_000

/** Default working memory note recall / resume timeout in ms (default 10,000). */
export const DEFAULT_RECALL_TIMEOUT_MS = 10_000

/** Default Vectr workspace upgrade timeout in ms (default 15,000). */
export const DEFAULT_UPGRADE_TIMEOUT_MS = 15_000

/** (b) Minimum interval between startup-time heal attempts for the same slug.
 * Prevents a persistently-unreachable host from being hammered on every host
 * restart while still leaving room for transient blips to recover. */
export const STARTUP_HEAL_COOLDOWN_MS = 30_000

/** Per-slug timestamp of the last startup-heal attempt. Process-local — a
 * restart resets the map (one fresh attempt per slug per host lifetime). */
const startupHealCooldown = new Map<string, number>()

/** (b) Startup-heal scope: which persisted entries get an automatic
 * `ensureTunnelUp` attempt at host startup. `up` keeps its legacy behavior;
 * `down` and `error` are the previously-deadlocked states that were only
 * surfaced to the user and never automatically recovered. `local` entries
 * have no tunnel to heal. */
export function startupHealEligible(
  entry: Pick<CodebaseEntry, 'type' | 'status'>,
): boolean {
  return (
    entry.type === 'remote' &&
    (entry.status === 'up' || entry.status === 'down' || entry.status === 'error')
  )
}

const Reconnect: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(false),
  initialDelayMs: z.number().min(1).default(500),
  maxDelayMs: z.number().min(1).default(30_000),
  maxAttempts: z.number().step(1).min(1).default(10),
})

export const Config: z<Config> = z.object({
  instancesPath: z.string().default(DEFAULT_INSTANCES_FILE),
  serverName: z.string().default(DEFAULT_SERVER_NAME),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  reconnect: Reconnect.default({ enabled: false }),
  codebasesPath: z.string().default(DEFAULT_CODEBASES_FILE),
  secretsPath: z.string().default(DEFAULT_SECRETS_FILE),
  daemonHttpTimeoutMs: z.number().min(1).default(DEFAULT_DAEMON_HTTP_TIMEOUT_MS),
  daemonTcpTimeoutMs: z.number().min(1).default(DEFAULT_DAEMON_TCP_TIMEOUT_MS),
  cliPath: z.string().default(''),
  cliTimeoutMs: z.number().min(1).default(DEFAULT_CLI_TIMEOUT_MS),
  recallTimeoutMs: z.number().min(1).default(DEFAULT_RECALL_TIMEOUT_MS),
  upgradeTimeoutMs: z.number().min(1).default(DEFAULT_UPGRADE_TIMEOUT_MS),
})

/**
 * System-prompt section contributed to each agent when its vectr daemon is
 * verified alive: nudges the agent to prioritize vectr MCP tools for code queries
 * and codebase navigation over grep and blind file reads. Static English text
 * (matches the official prompt style). Order 95 sits after the deployment
 * persona (0) and before the tool-guidance band (100–199); see
 * `@deepseek-ai/dsh-system-prompt`.
 */
export const VECTR_GUIDANCE_SECTION_NAME = 'vectr:mcp-guidance'
export const VECTR_GUIDANCE_SECTION_ORDER = 95
export const VECTR_GUIDANCE_SECTION_TEXT =
  'When answering code-query or codebase-navigation questions, prioritize the vectr MCP tools (mcp__vectr__*) over grep and blind file reads. Search, retrieve, and reason over the indexed workspace using vectr first; fall back to grep only if vectr query fails or returns no matches.'

/**
 * Scoped prompt section that shadows the global `tool:grep` section for agents
 * in a verified vectr workspace. Instead of directly telling the model to use
 * grep to search file contents, it instructs the model to prioritize vectr tools
 * and only use grep as a fallback if vectr fails.
 */
export const VECTR_GREP_SECTION_NAME = 'tool:grep'
export const VECTR_GREP_SECTION_ORDER = 1500
export const VECTR_GREP_SECTION_TEXT =
  'Prioritize querying code via vectr tools (mcp__vectr__*). If vectr query fails or yields no results, use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.'

/**
 * @see ./registry.ts for `resolveInstance` / `readInstancesFile`.
 * @see ./probe.ts for `isPortListening` / `isDaemonAlive` / `diagnoseDaemon`.
 * These were migrated out of this file; it re-exports them above and only
 * wires the plugin together.
 */
/**
 * Install the vectr MCP connection for one agent. Re-reads the registry on
 * every call so a daemon restart (new port / new pid) is picked up by the next
 * `agent/created` or seed without a Host reload.
 * @param ctx - plugin context (the loader fiber) providing agents and logger.
 * @param handles - live connection handles keyed by agent.
 * @param promptFibers - live system-prompt injection fibers keyed by agent.
 * @param instancesPath - absolute path of the vectr daemon registry.
 * @param config - resolved plugin configuration.
 * @param agent - the agent whose workspace resolves the daemon port.
 */
export function install(
  ctx: Context,
  handles: Map<Agent, ConnectionHandle>,
  promptFibers: Map<Agent, Fiber>,
  instancesPath: string,
  config: Required<Config>,
  agent: Agent,
  codebasesPath?: string,
  /** Agents disposed while their liveness probe is still in flight (see P1 in
   * `apply`). When set, the IIFE tears down the freshly-created connection /
   * prompt fiber instead of leaking it to host teardown. Defaults to an empty
   * set so callers that do not seed live agents (unit tests) need not pass it. */
  disposed: Set<Agent> = new Set<Agent>(),
): void {
  if (handles.has(agent) || promptFibers.has(agent)) return
  const cwd = agent.session.header.cwd
  if (cwd === undefined) {
    // A session without a workspace cwd cannot be bound to any vectr daemon.
    // Falling back to process.cwd() would silently bind the agent to the wrong
    // workspace's daemon (or none), so we skip explicitly instead.
    ctx.logger.warn(`vectr-client: no cwd on session ${agent.id}, skipping vectr binding`)
    return
  }
  // Re-read the registry on every call (D-7): a daemon restart that rewrote
  // the registry (new port / new pid) is picked up without a Host reload.
  let instances: InstancesFile | undefined
  try {
    instances = readInstancesFile(ctx, instancesPath)
  } catch (error) {
    // An unparseable registry must not veto agent/created publication: skip
    // this agent with a diagnostic instead of throwing into the listener.
    ctx.logger.warn(`vectr-client: cannot read daemon registry at ${instancesPath} (${String(error)}); skipping bind for session ${agent.id}`)
  }

  let codebases: CodebaseEntry[] | undefined
  if (codebasesPath !== undefined) {
    try {
      codebases = loadCodebases(codebasesPath)
    } catch (error) {
      ctx.logger.warn(`vectr-client: cannot read codebase metadata at ${codebasesPath} (${String(error)}); skipping codebase binds for session ${agent.id}`)
    }
  }

  const entry = instances !== undefined ? resolveInstance(instances, cwd) : undefined
  if (!hasCodebase({ workspace: cwd, entry, codebases })) {
    ctx.logger.info(`vectr-client: no vectr daemon for ${cwd}, skipping`)
    return
  }

  // Immediately inject system prompt guidance sections unconditionally without awaiting daemon probe.
  // As long as a codebase exists, the prompt guidance is active immediately.
  if (!promptFibers.has(agent)) {
    const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.section({
        name: VECTR_GUIDANCE_SECTION_NAME,
        order: VECTR_GUIDANCE_SECTION_ORDER,
        text: VECTR_GUIDANCE_SECTION_TEXT,
      })
      scope.systemPrompt.section({
        name: VECTR_GREP_SECTION_NAME,
        order: scope.systemPrompt.getSectionOrder?.('TOOL_GREP') ?? VECTR_GREP_SECTION_ORDER,
        text: VECTR_GREP_SECTION_TEXT,
      })
    })
    if (disposed.has(agent)) {
      void fiber.dispose().catch(() => {})
    } else {
      promptFibers.set(agent, fiber)
    }
  }

  // Background daemon network probe & connection pipeline runs independently:
  // When entry exists and not yet connected, asynchronously probe and startConnection.
  // Probe failure or timeout logs warn and leaves handles empty, without affecting prompt guidance.
  if (entry !== undefined && !handles.has(agent)) {
    void (async () => {
      try {
        const diagnosis = await diagnoseDaemon(entry, {
          httpProbe: (e, ms) => fetchStatus(e, ms),
          httpTimeoutMs: config.daemonHttpTimeoutMs ?? DEFAULT_DAEMON_HTTP_TIMEOUT_MS,
          tcpTimeoutMs: config.daemonTcpTimeoutMs ?? DEFAULT_DAEMON_TCP_TIMEOUT_MS,
        })
        if (!diagnosis.alive) {
          const pid = entry.pid === undefined ? 'n/a' : String(entry.pid)
          const reason = diagnosis.reason ?? 'HTTP_PROBE_UNREACHABLE'
          ctx.logger.warn(
            `vectr-client: vectr daemon not alive, skipping bind for session ${agent.id} (cwd=${cwd}, workspace=${entry.workspace}, port=${entry.port}, pid=${pid}, reason=${reason})`,
          )
          return
        }
        const host = entry.host ?? DEFAULT_HOST
        const port = entry.port
        const policy = resolveReconnectPolicy(config.reconnect, `vectr-client(${config.serverName}): reconnect`)
        // The SCOPED agent context routes every registration into that agent's
        // tool layer; disposal of the scope (which the loop runs BEFORE emitting
        // `agent/disposed`) unwinds the tools, so this listener only closes the
        // HTTP connection.
        const conn = startConnection(agent.ctx, {
          transport: 'streamable-http',
          serverName: config.serverName,
          url: `http://${host}:${port}/mcp`,
          headers: {},
          toolCallTimeoutMs: config.toolCallTimeoutMs,
          failOnStartupError: false,
        }, policy)
        void conn.ready.then((outcome) => {
          if (outcome.error !== undefined) {
            // D-1: route the failure to the agent-visible channel when one is bound
            // to the session, so the agent/user (not only the loader fiber) sees it.
            // The message always carries cwd/port/error so it is self-diagnosing.
            const message = `vectr-client: vectr connection failed for session ${agent.id} (cwd=${cwd}, port=${port}): ${String(outcome.error)}`
            if (agent.ctx?.logger !== undefined) agent.ctx.logger.warn(message)
            else ctx.logger.warn(message)
          }
        })
        // P1: register the connection. If the agent was disposed during the probe
        // window (between install() returning and this IIFE settling), the
        // agent/disposed handler already ran and found nothing in `handles`, so
        // tear the connection down immediately instead of leaking it to host
        // teardown.
        if (disposed.has(agent)) {
          void conn.dispose().catch(() => {})
        } else {
          handles.set(agent, conn)
        }
      } catch (err) {
        ctx.logger.warn(`vectr-client: daemon probe error for session ${agent.id}: ${String(err)}`)
      } finally {
        disposed.delete(agent)
      }
    })()
  }

  // Feature B: also bind every persisted codebase whose status is 'up'. These
  // are host-level MCP servers (each with a globally-unique serverName), so a
  // failed bind must not veto the agent and only logs a warning. Runs once per
  // agent (guarded by `handles.has(agent)` at the top of install).
  if (codebasesPath !== undefined) {
    void installCodebaseConnections(ctx, config, agent, codebasesPath, instances, cwd)
  }
}

/**
 * Connect the agent to every persisted codebase entry with `status === 'up'`.
 * Each entry exposes a Streamable HTTP MCP endpoint at
 * `http://127.0.0.1:<localPort>/mcp`; registration uses the entry's
 * `serverName` (globally unique). A bind failure only logs a warning and never
 * blocks the main workspace connection.
 * @param ctx - plugin context providing the logger.
 * @param config - resolved plugin configuration.
 * @param agent - the agent to bind the codebase tools to.
 * @param codebasesPath - absolute path of the codebase metadata file.
 */
export async function installCodebaseConnections(
  ctx: Context,
  config: Required<Config>,
  agent: Agent,
  codebasesPath: string,
  instances?: InstancesFile,
  cwd?: string,
): Promise<void> {
  let entries: CodebaseEntry[]
  try {
    entries = loadCodebases(codebasesPath)
  } catch (error) {
    ctx.logger.warn(`vectr-client: cannot read codebase metadata at ${codebasesPath} (${String(error)}); skipping codebase binds for session ${agent.id}`)
    return
  }
  // Per-workspace binding isolation (阶段1): only bind codebases owned by the
  // agent's resolved workspace. `ws` comes from the agent cwd; when `cwd` or the
  // registry is absent we fall back to binding all 'up' entries (the architect's
  // `ws === undefined || e.workspace === ws` clause) — a permissive default used
  // only when isolation data is unavailable.
  // B4: resolve the agent's own workspace from its cwd via the registry. When
  // that is unavailable (session has no cwd, or no registry), do NOT blindly
  // bind every 'up' entry — that would bind UNASSIGNED/orphaned entries to an
  // agent. Only bind entries whose OWN workspace is a known key in the registry;
  // with no registry at all this binds nothing (the safe default). The risk this
  // accepts: an entry whose daemon has since vanished from the registry is also
  // skipped (it cannot be isolated), which is preferable to over-binding.
  const agentWs = (cwd !== undefined && instances !== undefined)
    ? resolveInstance(instances, cwd)?.workspace
    : undefined
  const knownWorkspaces = new Set(Object.values(instances ?? {}).map((e) => e.workspace))
  const policy = resolveReconnectPolicy(config.reconnect, 'vectr-client(codebase): reconnect')
  for (const entry of entries) {
    if (entry.status !== 'up' || entry.localPort === undefined) continue
    if (agentWs !== undefined) {
      if (entry.workspace !== agentWs) continue
    } else if (entry.workspace === undefined || !knownWorkspaces.has(entry.workspace)) {
      continue
    }
    try {
      const conn = startConnection(agent.ctx, {
        transport: 'streamable-http',
        serverName: entry.serverName,
        url: `http://127.0.0.1:${entry.localPort}/mcp`,
        headers: {},
        toolCallTimeoutMs: config.toolCallTimeoutMs,
        failOnStartupError: false,
      }, policy)
      void conn.ready.then((outcome) => {
        if (outcome.error !== undefined) {
          const message = `vectr-client: codebase connection failed for session ${agent.id} (serverName=${entry.serverName}, port=${entry.localPort}): ${String(outcome.error)}`
          if (agent.ctx?.logger !== undefined) agent.ctx.logger.warn(message)
          else ctx.logger.warn(message)
        }
      })
    } catch (error) {
      ctx.logger.warn(`vectr-client: codebase bind threw for ${entry.serverName} (session ${agent.id}): ${String(error)}`)
    }
  }
}

/**
 * The vectr-client plugin entry: seed already-live agents, watch
 * `agent/created` / `agent/disposed`, and close every connection on teardown.
 * @param ctx - plugin context whose fiber owns the listeners and handles.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: Required<Config> = {
    instancesPath: config.instancesPath ?? DEFAULT_INSTANCES_FILE,
    serverName: config.serverName ?? DEFAULT_SERVER_NAME,
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    reconnect: config.reconnect ?? { enabled: false },
    codebasesPath: config.codebasesPath ?? DEFAULT_CODEBASES_FILE,
    secretsPath: config.secretsPath ?? DEFAULT_SECRETS_FILE,
    daemonHttpTimeoutMs: config.daemonHttpTimeoutMs ?? DEFAULT_DAEMON_HTTP_TIMEOUT_MS,
    daemonTcpTimeoutMs: config.daemonTcpTimeoutMs ?? DEFAULT_DAEMON_TCP_TIMEOUT_MS,
    cliPath: config.cliPath ?? '',
    cliTimeoutMs: config.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
    recallTimeoutMs: config.recallTimeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS,
    upgradeTimeoutMs: (() => {
      const envVal = process.env.VECTR_UPGRADE_TIMEOUT_MS ? parseInt(process.env.VECTR_UPGRADE_TIMEOUT_MS.trim(), 10) : undefined
      if (typeof envVal === 'number' && !isNaN(envVal) && envVal > 0) return envVal
      return config.upgradeTimeoutMs ?? DEFAULT_UPGRADE_TIMEOUT_MS
    })(),
  }
  // Relative-path fallback (P3-safe): only resolves against process.cwd()
  // when Config supplies a *relative* path. Both defaults
  // (DEFAULT_INSTANCES_FILE / DEFAULT_CODEBASES_FILE) are absolute
  // (homedir-based), so the common case never uses process.cwd() as a
  // workspace fallback (D-4 still skips sessions lacking a cwd).
  const instancesPath = isAbsolute(resolved.instancesPath)
    ? resolved.instancesPath
    : resolve(process.cwd(), resolved.instancesPath)
  const codebasesPath = isAbsolute(resolved.codebasesPath)
    ? resolved.codebasesPath
    : resolve(process.cwd(), resolved.codebasesPath)
  // P6: best-effort cleanup of stale tunnel control sockets from a crashed
  // prior process before we (re)establish live tunnels. (a) Narrow the scan
  // to OUR codebases' slug prefixes so a host restart with a different pid
  // does not touch unrelated plugins/users sharing tmpdir.
  try {
    const startupSlugs = loadCodebases(codebasesPath)
      .filter((e) => e.type === 'remote' && typeof e.slug === 'string')
      .map((e) => e.slug)
    cleanupStaleTunnelSockets(undefined, startupSlugs)
  } catch {
    // best-effort startup hygiene; never fatal.
  }
  // 阶段1: idempotently backfill `workspace` + recompute the composite
  // `serverName` on existing meta (no-op once migrated). A2: skip entirely when
  // no registry is present (writing would poison the sticky UNASSIGNED field).
  // Best-effort — a malformed registry must not block host startup.
  try {
    const instances = readInstancesFile(ctx, instancesPath)
    if (instances !== undefined) migrateCodebases(codebasesPath, instances, ctx.logger)
  } catch (err) {
    ctx.logger.warn(`vectr-client: startup codebase migration skipped: ${String(err)}`)
  }
  // 问题1B: bring every persisted 'up' remote tunnel back up at startup. A
  // tunnel can die while the host stays up (ssh master crash, network blip); the
  // meta keeps `status: 'up'` but the endpoint is unreachable. Re-probe and
  // reopen each here (fire-and-forget, bounded by ssh's quick return) so the
  // endpoint comes back without blocking host startup. Each entry heals
  // independently so one failure cannot block the others. `apply` is sync in the
  // host contract, so this runs concurrently rather than awaited.
  //
  // (b) Heal-scope fix: a tunnel persisted as `status: 'error'` (or `'down'`)
  // was a permanent deadlock — the user-facing route surfaced the diagnostic
  // but no automatic recovery was ever attempted. Widen the predicate to also
  // include 'down' and 'error' entries (legacy 'up' behavior preserved),
  // gated by a per-slug cooldown so a persistently-unreachable host is not
  // hammered on every host restart.
  try {
    const deps = buildCodebaseDeps(ctx, resolved.secretsPath)
    const now = Date.now()
    for (const entry of loadCodebases(codebasesPath)) {
      if (!startupHealEligible(entry)) continue
      // Cooldown: skip if we already attempted this slug too recently. The
      // timestamp is kept in-process; it does not survive a restart, which is
      // fine — a fresh process starts with a clean slate and one attempt.
      const lastAttempt = startupHealCooldown.get(entry.slug)
      if (lastAttempt !== undefined && now - lastAttempt < STARTUP_HEAL_COOLDOWN_MS) continue
      startupHealCooldown.set(entry.slug, now)
      void ensureTunnelUp(deps, codebasesPath, entry).catch((err) => {
        ctx.logger.warn(`vectr-client: could not re-establish tunnel for ${entry.slug}: ${String(err)}`)
      })
    }
  } catch (err) {
    ctx.logger.warn(`vectr-client: startup tunnel heal skipped: ${String(err)}`)
  }
  const handles = new Map<Agent, ConnectionHandle>()
  // Per-agent system-prompt injection fibers (feature A-2): the guidance
  // section is contributed only when the daemon is verified alive, and disposed
  // together with the agent. Keyed separately from `handles` because the fiber
  // opens a dependency scope rather than an MCP connection.
  const promptFibers = new Map<Agent, Fiber>()
  // P1: agents disposed during their liveness-probe window. The IIFE in install
  // registers the fiber/connection only after the await; if the agent is torn
  // down before then, the disposed handler finds nothing in the maps. This set
  // lets the IIFE detect that and dispose the freshly-created registration.
  const disposed = new Set<Agent>()

  // The registry is read inside install() on every call (D-7), so seed and
  // each agent/created both see the current on-disk state. The codebase
  // metadata path is passed so install also binds up codebases.
  for (const agent of ctx.agents.list()) install(ctx, handles, promptFibers, instancesPath, resolved, agent, codebasesPath, disposed)
  ctx.on('agent/created', ({ agent }) => { install(ctx, handles, promptFibers, instancesPath, resolved, agent, codebasesPath, disposed) })
  ctx.on('agent/disposed', ({ agent }) => {
    disposed.add(agent)
    void handles.get(agent)?.dispose()
    handles.delete(agent)
    const fiber = promptFibers.get(agent)
    if (fiber !== undefined) {
      void fiber.dispose().catch((error: unknown) => {
        // A failed prompt-fiber disposal must not veto the rest of agent
        // teardown; log and continue (same posture as the connection dispose).
        ctx.logger.warn(`vectr-client: prompt-section cleanup failed for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
      })
      promptFibers.delete(agent)
    }
  })
  ctx.effect(() => async () => {
    for (const conn of handles.values()) void conn.dispose()
    handles.clear()
    for (const fiber of promptFibers.values()) void fiber.dispose().catch(() => {})
    promptFibers.clear()
    // Kill any surviving ssh tunnels recorded in the codebase metadata so a
    // host teardown does not leave orphaned port-forward processes.
    //
    // First pass: per recorded entry, prefer the recorded control-socket
    // exit (works even when tunnelPid was never recorded), then best-effort
    // SIGTERM the recorded PID. If NEITHER could reach the master (no
    // tunnelCtl, ssh missing, pid recycled), queue the entry for the slug-
    // prefix fallback so the host teardown does not leak an orphan master
    // when the host pid has changed.
    let fallbackNeeded: CodebaseEntry[] = []
    try {
      for (const entry of loadCodebases(codebasesPath)) {
        if (entry.type !== 'remote') continue
        const hasRecorded = entry.tunnelPid !== undefined || entry.tunnelCtl !== undefined
        if (!hasRecorded) continue
        let recordedOk = false
        if (entry.tunnelCtl !== undefined && entry.host !== undefined) {
          // Capture narrowed values before the closure (property narrowing
          // does not flow into the Promise executor callback).
          const ctl = entry.tunnelCtl
          const host = entry.host
          try {
            // F2: the old fire-and-forget `spawn` marked teardown ok before
            // ssh had even started, and an async 'error' event (missing ssh
            // binary) was unhandled and could crash the host teardown. Await
            // the exit and only count a clean exit (code 0, no signal) as ok;
            // otherwise the slug-prefix fallback sweep below takes over.
            const result = await new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolveExit) => {
              const child = spawn('ssh', ['-O', 'exit', '-S', ctl, host])
              child.on('error', () => { resolveExit({ code: 1, signal: null }) })
              child.on('close', (code, signal) => { resolveExit({ code: code ?? 1, signal }) })
            })
            recordedOk = result.code === 0 && result.signal === null
          } catch {
            // best-effort: control-socket exit unavailable at teardown.
          }
        }
        if (entry.tunnelPid !== undefined) {
          // N3: best-effort kill only — it never marks the teardown ok. The
          // recorded pid may be stale/recycled while a surviving master still
          // holds its socket, so `recordedOk` stays driven by the control-
          // socket exit above and the slug sweep below still runs.
          try {
            process.kill(entry.tunnelPid, 'SIGTERM')
          } catch (err) {
            // ESRCH = tunnel already gone (normal case, ignore); EPERM = pid
            // belongs to another user (warn; also not ok).
            const code = (err as NodeJS.ErrnoException).code
            if (code !== 'ESRCH') {
              ctx.logger.warn(`vectr-client: teardown cannot SIGTERM recorded tunnelPid ${entry.tunnelPid}: ${String(err)}`)
            }
          }
        }
        // (a) Recorded teardown could not reach the master -> sweep tmpdir
        // for any /tmp/vectr-tunnel-<slug>-*.sock the entry left behind.
        if (!recordedOk) fallbackNeeded.push(entry)
      }
    } catch {
      // metadata unreadable; nothing to clean up.
    }
    // Second pass: slug-prefix fallback for the orphans the recorded path
    // could not reach. Uses the existing ssh runner via deps so the
    // password is injected (mirrors deleteCodebase's fallback path).
    if (fallbackNeeded.length > 0) {
      try {
        const teardownDeps = buildCodebaseDeps(ctx, resolved.secretsPath)
        await cleanupOrphanedTunnelsForCodebases(teardownDeps, fallbackNeeded)
      } catch {
        // best-effort; teardown must never throw out of the disposer.
      }
    }
  }, 'vectr-client.connections')

  // Feature A (C1): host-side JSON routes backing the workspace console.
  // Registered in the root plugin scope (not per-agent) so a single pair of
  // management endpoints serves every workspace; disposed with this fiber.
  registerManagementRoutes(ctx, instancesPath, resolved)
  registerCodebaseRoutes(ctx, codebasesPath, resolved.secretsPath, instancesPath, resolved)

  // 4-Layer architecture: wire Domain, Infra, and Bridge services for session management
  const instanceResolver = new InstanceResolver(instancesPath, ctx)
  const apiClient = new VectrApiClient()
  const codebaseService = new CodebaseService(codebasesPath)
  const cliRunner = new VectrCliRunner({
    cliPath: resolved.cliPath || undefined,
    timeoutMs: resolved.cliTimeoutMs,
  })
  const sessionService = new SessionVectrService({
    instanceResolver,
    apiClient,
    codebaseService,
    cliRunner,
    statusTimeoutMs: resolved.daemonHttpTimeoutMs,
    recallTimeoutMs: resolved.recallTimeoutMs,
    upgradeTimeoutMs: resolved.upgradeTimeoutMs,
  })
  registerSessionRoutes(ctx, sessionService)
}

/**
 * Write a JSON body with the given status code.
 * @param res - the node:http response.
 * @param statusCode - HTTP status to send.
 * @param body - value serialized as JSON.
 */
function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/**
 * Read a JSON request body with a size cap (defense against unbounded reads).
 * @param req - the incoming request.
 * @param limitBytes - maximum accepted bytes.
 * @returns the parsed body, or a thrown Error on over-length / bad JSON.
 */
async function readJsonBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text)
}

/**
 * Register the two workspace-console HTTP routes on the injected webServer:
 *
 * - `GET /api/vectr/workspaces` → {@link scanWorkspaces} result (JSON array of
 *   {@link WorkspaceView}).
 * - `POST /api/vectr/trigger-index` body `{ "port": number }` (or
 *   `{ "workspace": string }`) → resolve the single matching registry entry and
 *   call {@link triggerIndex}; returns the {@link TriggerResult}.
 *
 * Both handlers are Cordis effects (the disposer from `webServer.register`),
 * so they vanish with the plugin fiber. A registry read failure on either
 * route answers 500 with the diagnostic rather than crashing the request.
 *
 * @param ctx - plugin context carrying the webServer service.
 * @param instancesPath - absolute path of `instances.json`.
 * @param config - resolved plugin configuration (supplies `daemonHttpTimeoutMs`).
 */
export function registerManagementRoutes(ctx: Context, instancesPath: string, config: Required<Config>): void {
  // `webServer` is provided by the host; in headless/unit contexts it may be
  // absent. `ctx.get` returns undefined (rather than throwing) so the plugin
  // still loads and the MCP-binding path keeps working without the console
  // routes. The host registration is re-attempted on the next apply only if the
  // service appears, which in practice means a host restart (documented).
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    ctx.logger.warn('vectr-client: webServer service unavailable; skipping /api/vectr/* management routes')
    return
  }
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/vectr/workspaces',
    handler: async (_req, res) => {
      try {
        const views = await scanWorkspaces(ctx, instancesPath, { statusTimeoutMs: config.daemonHttpTimeoutMs })
        sendJson(res, 200, views)
      } catch (error) {
        sendJson(res, 500, { error: String(error) })
      }
    },
  }), 'vectr-client: GET /api/vectr/workspaces')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/vectr/trigger-index',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { error: String(error) })
        return
      }
      const target = body as { port?: number; workspace?: string }
      const instances = readInstancesFile(ctx, instancesPath)
      if (instances === undefined) {
        sendJson(res, 404, { ok: false, error: 'no vectr daemon registry found' })
        return
      }
      let entry = undefined
      if (typeof target.port === 'number') {
        entry = Object.values(instances).find(e => e.port === target.port)
      } else if (typeof target.workspace === 'string') {
        entry = Object.values(instances).find(e => e.workspace === target.workspace)
      }
      if (entry === undefined) {
        sendJson(res, 404, { ok: false, error: 'no daemon matches the requested port/workspace' })
        return
      }
      // Reuse the shared /v1/status probe (fetchStatus) with the configured
      // timeout so a hung daemon cannot block this route (M2). Same probe the
      // liveness gate uses; never hand-roll fetch here.
      const status = await fetchStatus(entry, config.daemonHttpTimeoutMs ?? DEFAULT_DAEMON_HTTP_TIMEOUT_MS)
      const result = await triggerIndex(entry, status !== undefined ? { status } : {})
      sendJson(res, result.ok ? 200 : 409, result)
    },
  }), 'vectr-client: POST /api/vectr/trigger-index')
}

/**
 * Build the runtime dependencies for the codebase manager from the host
 * environment. `spawnRunner` wraps `node:child_process spawn`; `sshRunner`
 * wraps `spawn('ssh', args)` and, for password-auth codebases, injects the
 * password via `sshpass` (`-o PreferredAuthentications=password`); `credStore` prefers the host `credentials`
 * service (when present) and otherwise falls back to a file-backed store.
 *
 * When the host `credentials` service exists, its async `set`/`unset` are
 * adapted to the sync-friendly {@link CredentialStore} shape by awaiting; `get`
 * resolves via `resolve(ref)`. Ref names follow `VECTR_SSH_<SLUG>`.
 *
 * @param ctx - plugin context (for `credentials` lookup + logger).
 * @param secretsPath - fallback secret file path.
 * @returns the assembled {@link CodebaseDeps}-compatible runners + store.
 */
export function buildCodebaseDeps(
  ctx: Context,
  secretsPath: string,
): {
    spawnRunner: SpawnRunner
    sshRunner: SshRunner
    credStore: CredentialStore
    warn: (message: string) => void
  } {
  const spawnRunner: SpawnRunner = (command, args) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    const promise = new Promise<{ code: number; stdout: string; stderr: string; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.on('error', (err) => { resolveExit({ code: 1, stdout, stderr: `${stderr}\n${String(err)}`, signal: null }) })
      // F2: capture the signal so success gating can distinguish a clean exit
      // from a kill (a signaled "exit" is not a success).
      child.on('close', (code, signal) => { resolveExit({ code: code ?? 1, stdout, stderr, signal }) })
    })
    return {
      promise,
      kill() {
        child.kill('SIGTERM')
      },
    } satisfies SpawnHandle
  }
  const sshRunner: SshRunner = (args, auth) => {
    if (auth?.password !== undefined) {
      // Password-auth hosts: feed the password to sshpass via a 0600 temp file
      // (`-f`) so the plaintext never lands in argv (visible in `ps` /proc) or
      // the process environment. The file is unlinked once the ssh process has
      // exited (success or failure); the file is written before spawn so sshpass
      // can read it at startup. Key-auth hosts (auth absent) run plain `ssh`.
      const passFile = join(tmpdir(), `vectr-sshpass-${process.pid}-${randomBytes(6).toString('hex')}`)
      writeFileSync(passFile, auth.password, { mode: 0o600 })
      try {
        const handle = spawnRunner('sshpass', ['-f', passFile,
          '-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', ...args])
        void handle.promise.finally(() => {
          try { rmSync(passFile) } catch {
            // best-effort cleanup; a stale 0600 temp file only holds a password.
          }
        })
        return handle
      } catch (err) {
        // spawnRunner threw synchronously (illegal cwd/option, ENOENT, …) before
        // any child existed, so the `finally` above never registered. The temp
        // file already holds the plaintext password, so remove it now instead of
        // leaking a 0600 secret into /tmp, then propagate the original error.
        try { rmSync(passFile) } catch {
          // best-effort; nothing more we can do here.
        }
        throw err
      }
    }
    return spawnRunner('ssh', args)
  }

  const hostCreds = ctx.get('credentials') as
    | { set: (ref: string, v: string) => Promise<void>; unset: (ref: string) => Promise<void>; resolve: (ref: string) => Promise<{ value: string } | undefined> }
    | undefined
  let credStore: CredentialStore
  if (hostCreds !== undefined) {
    credStore = {
      set: (ref, value) => hostCreds.set(ref, value),
      get: (ref) => hostCreds.resolve(ref).then((r) => r?.value),
      unset: (ref) => hostCreds.unset(ref),
    }
  } else {
    credStore = new FileCredentialStore(secretsPath)
  }

  return {
    spawnRunner,
    sshRunner,
    credStore,
    // (c) warn sink: findFreePort's preferred-port-migration warning surfaces
    // in the host log instead of being silently swallowed inside the module.
    warn: (message: string) => {
      ctx.logger.warn(message)
    },
  }
}

/**
 * Extract the codebase slug from a request pathname. Strips the codebase route
 * prefix and keeps only the first path segment, so `/api/vectr/codebases/demo`
 * and `/api/vectr/codebases/demo/test` both yield `demo` — the `/test` suffix is
 * an action, not part of the slug. This was the root cause of
 * `POST /api/vectr/codebases/:slug/test` returning 404: the slug was derived as
 * `demo/test` and never matched a persisted entry (改动3).
 * @param pathname - request pathname (e.g. `/api/vectr/codebases/demo/test`).
 * @returns the bare slug, or `''` when the pathname carries no slug segment.
 */
export function slugFromPathname(pathname: string): string {
  // C3 asked to drop `?? ''`, but this repo enables `noUncheckedIndexedAccess`,
  // so `String.split(...)[0]` is typed `string | undefined`; the coalesce is
  // load-bearing (an empty array access must resolve to `''`), not redundant.
  return decodeURIComponent(pathname.replace('/api/vectr/codebases/', '')).split('/')[0] ?? ''
}

/**
 * Register the feature-B codebase management HTTP routes:
 *
 * - `GET  /api/vectr/codebases` → list persisted entries (no secrets).
 * - `POST /api/vectr/codebases` body {@link CodebaseSpec} → create (password
 *   only forwarded to the store; never echoed in the response).
 * - `DELETE /api/vectr/codebases/:slug` → delete.
 * - `POST /api/vectr/codebases/:slug/test` → liveness probe.
 *
 * The routes are Cordis effects so they vanish with the plugin fiber. A host
 * without `webServer` skips them (logged once).
 *
 * @param ctx - plugin context carrying `webServer` + `credentials`.
 * @param codebasesPath - absolute path of the codebase metadata file.
 * @param secretsPath - fallback secret file path.
 * @param instancesPath - instances JSON file path.
 * @param config - optional configuration override (e.g. daemonHttpTimeoutMs).
 */
export function registerCodebaseRoutes(
  ctx: Context,
  codebasesPath: string,
  secretsPath: string,
  instancesPath: string = DEFAULT_INSTANCES_FILE,
  config?: { daemonHttpTimeoutMs?: number },
): void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    ctx.logger.warn('vectr-client: webServer service unavailable; skipping /api/vectr/codebases* routes')
    return
  }
  const deps = buildCodebaseDeps(ctx, secretsPath)
  const httpTimeoutMs = config?.daemonHttpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/vectr/codebases',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        try {
          const url = new URL(req.url ?? '', 'http://localhost')
          const wsFilter = url.searchParams.get('workspace') ?? undefined
          let list = loadCodebases(codebasesPath).map(stripSecret)
          // 阶段1: optional `?workspace=` scoping for the workspace console.
          if (wsFilter !== undefined) {
            list = list.filter(e => e.workspace === wsFilter)
          }

          // Prepend Primary codebase for non-memory_only workspaces that have mounted codebases
          let instances: InstancesFile | undefined
          try {
            instances = readInstancesFile(ctx, instancesPath)
          } catch {
            // ignore
          }
          if (wsFilter !== undefined) {
            const inst = instances ? resolveInstance(instances, wsFilter) : undefined
            const isMemoryOnly = inst ? (inst.mode === 'memory_only' || inst.mode === 'memory-only') : false
            if (!isMemoryOnly && list.length > 0 && !list.some(e => e.isPrimary || isSystemPrimarySlug(e.slug))) {
              const isListening = inst?.port ? await isPortListening(inst.host ?? '127.0.0.1', inst.port, 300) : false
              list = [
                {
                  id: `primary:${wsFilter}`,
                  slug: 'primary',
                  type: 'local',
                  path: wsFilter,
                  workspace: wsFilter,
                  serverName: `primary_${wsFilter}`,
                  status: isListening ? 'up' : 'down',
                  isPrimary: true,
                },
                ...list,
              ]
            }
          } else {
            const workspacesWithEntries = new Set<string>()
            for (const item of list) {
              if (item.workspace && item.workspace !== UNASSIGNED_WORKSPACE) {
                workspacesWithEntries.add(item.workspace)
              }
            }
            const primaries: typeof list = []
            for (const ws of workspacesWithEntries) {
              const inst = instances ? resolveInstance(instances, ws) : undefined
              const isMemoryOnly = inst ? (inst.mode === 'memory_only' || inst.mode === 'memory-only') : false
              const alreadyHasPrimary = list.some(
                e => e.workspace === ws && (e.isPrimary || isSystemPrimarySlug(e.slug)),
              )
              if (!isMemoryOnly && !alreadyHasPrimary) {
                const wsKey = createHash('sha256').update(ws).digest('hex').slice(0, WORKSPACE_KEY_LENGTH)
                // Multi-workspace global listing: avoid pushing identical slug 'primary'
                const slug = workspacesWithEntries.size > 1 ? `primary-${wsKey}` : 'primary'
                const isListening = inst?.port ? await isPortListening(inst.host ?? '127.0.0.1', inst.port, 300) : false
                primaries.push({
                  id: `primary:${ws}`,
                  slug,
                  type: 'local',
                  path: ws,
                  workspace: ws,
                  serverName: `primary_${wsKey}`,
                  status: isListening ? 'up' : 'down',
                  isPrimary: true,
                })
              }
            }
            if (primaries.length > 0) {
              list = [...primaries, ...list]
            }
          }

          sendJson(res, 200, list)
        } catch (error) {
          sendJson(res, 500, { error: String(error) })
        }
        return
      }
      if (req.method === 'POST') {
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { error: String(error) })
          return
        }
        const spec = body as CodebaseSpec
        if (spec && typeof spec === 'object') {
          const rawPath = spec.path || (spec as unknown as { remotePath?: string }).remotePath
          if (rawPath && typeof rawPath === 'string') {
            spec.path = rawPath.trim()
          }
          if (!spec.auth && spec.password) {
            spec.auth = 'password'
          }
        }
        try {
          const entry = await createCodebase(deps, codebasesPath, spec)
          sendJson(res, 201, stripSecret(entry))
        } catch (error) {
          sendJson(res, 400, { error: String(error) })
        }
        return
      }
      sendJson(res, 405, { error: 'method not allowed' })
    },
  }), 'vectr-client: /api/vectr/codebases')

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/api/vectr/codebases',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const slug = slugFromPathname(url.pathname)
      if (slug.length === 0) {
        sendJson(res, 400, { error: 'missing codebase slug' })
        return
      }
      const normSlug = slug.trim().toLowerCase()
      const list = () => loadCodebases(codebasesPath)
      const find = () => list().find(e => e.slug.trim().toLowerCase() === normSlug)

      if (req.method === 'DELETE') {
        if (isSystemPrimarySlug(normSlug)) {
          sendJson(res, 403, { ok: false, error: 'Cannot delete primary codebase of the workspace' })
          return
        }
        const entry = find()
        if (entry === undefined) {
          sendJson(res, 404, { ok: false, error: 'no such codebase' })
          return
        }
        const isPrimaryByPath = Boolean(
          entry.workspace && entry.path && resolve(entry.path) === resolve(entry.workspace),
        )
        const isPrimaryBySlug =
          typeof entry.slug === 'string' && isSystemPrimarySlug(entry.slug)
        if (entry.isPrimary || isPrimaryBySlug || isPrimaryByPath) {
          sendJson(res, 403, { ok: false, error: 'Cannot delete primary codebase of the workspace' })
          return
        }
        try {
          await deleteCodebase(deps, codebasesPath, entry)
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) })
        }
        return
      }
      if (req.method === 'POST' && url.pathname.endsWith('/test')) {
        if (isSystemPrimarySlug(normSlug)) {
          let instances: InstancesFile | undefined
          try {
            instances = readInstancesFile(ctx, instancesPath)
          } catch {
            // ignore
          }
          if (!instances) {
            sendJson(res, 503, { ok: false, error: 'Instance registry unavailable' })
            return
          }
          let targetWs = url.searchParams.get('workspace') ?? undefined
          if (!targetWs && isSystemPrimarySlug(normSlug) && normSlug !== 'primary') {
            const key = normSlug.replace(/^primary-/i, '')
            for (const [k, inst] of Object.entries(instances)) {
              if (
                k.startsWith(key) ||
                key.startsWith(k) ||
                (inst?.workspace && createHash('sha256').update(inst.workspace).digest('hex').startsWith(key))
              ) {
                targetWs = inst?.workspace
                break
              }
            }
          }
          if (!targetWs) {
            const codebases = loadCodebases(codebasesPath)
            const wsSet = new Set(codebases.map(c => c.workspace).filter(w => w && w !== UNASSIGNED_WORKSPACE))
            if (wsSet.size === 1) {
              targetWs = [...wsSet][0]
            } else {
              const allInstWorkspaces = Object.values(instances).map(i => i.workspace).filter(Boolean)
              if (allInstWorkspaces.length === 1) {
                targetWs = allInstWorkspaces[0]
              }
            }
          }
          if (!targetWs) {
            sendJson(res, 400, { ok: false, error: 'Ambiguous primary codebase: please specify ?workspace=' })
            return
          }
          const inst = resolveInstance(instances, targetWs)
          if (!inst || !inst.port) {
            sendJson(res, 503, { ok: false, error: `No Vectr daemon registered for workspace ${targetWs}` })
            return
          }
          const host = inst.host || '127.0.0.1'
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), httpTimeoutMs)
          try {
            const probeRes = await fetch(`http://${host}:${inst.port}/v1/status`, { signal: controller.signal })
            if (!probeRes.ok) {
              sendJson(res, 503, { ok: false, error: `Primary daemon returned status ${probeRes.status}` })
              return
            }
            const statusData = await probeRes.json()
            sendJson(res, 200, { ok: true, status: statusData })
          } catch (err) {
            sendJson(res, 503, { ok: false, error: `Primary daemon probe failed: ${String(err)}` })
          } finally {
            clearTimeout(timer)
          }
          return
        }
        const entry = find()
        if (entry === undefined) {
          sendJson(res, 404, { ok: false, error: 'no such codebase' })
          return
        }
        // 问题1B: self-heal the tunnel before probing. A dead tunnel is reopened
        // (or yields a diagnostic 'tunnel down: ...' instead of a bare fetch
        // error) rather than silently reporting the persisted-but-false 'up'.
        const result = await testCodebase(entry, { deps, metaPath: codebasesPath, heal: true })
        sendJson(res, result.ok ? 200 : 503, result)
        return
      }
      if (req.method === 'PATCH') {
        if (isSystemPrimarySlug(normSlug)) {
          sendJson(res, 403, { ok: false, error: 'Cannot reassign primary codebase of the workspace' })
          return
        }
        const entry = find()
        if (entry === undefined) {
          sendJson(res, 404, { ok: false, error: 'no such codebase' })
          return
        }
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { error: String(error) })
          return
        }
        // Body shape: `{ workspace: string }` — the absolute target workspace.
        const { workspace } = (body ?? {}) as { workspace?: unknown }
        // PATCH accepts either an absolute workspace path (the normal assign
        // target) or the UNASSIGNED_WORKSPACE sentinel, which moves a codebase
        // back into the unassigned bucket without requiring a daemon registry
        // (consistent with GET / grouping semantics). Any other value is 400.
        const wsValid = typeof workspace === 'string' && workspace.length > 0 &&
          (workspace === UNASSIGNED_WORKSPACE || isAbsolute(workspace))
        if (!wsValid) {
          sendJson(res, 400, { error: 'PATCH body must include an absolute "workspace" path (or the "__unassigned__" sentinel)' })
          return
        }
        // Validate the target against the live daemon registry (assign only
        // moves a codebase to a real vectr workspace). A missing/unreadable
        // registry is a 500 (misconfiguration), not a silent pass.
        let instances: InstancesFile | undefined
        try {
          instances = readInstancesFile(ctx, instancesPath)
        } catch (error) {
          sendJson(res, 500, { error: String(error) })
          return
        }
        try {
          const updated = patchCodebase(
            codebasesPath,
            entry.slug,
            workspace,
            instances === undefined ? {} : { instances },
          )
          sendJson(res, 200, { ok: true, ...stripSecret(updated) })
        } catch (error) {
          if (error instanceof CodebaseError) {
            sendJson(res, error.status, { ok: false, error: error.message })
          } else {
            sendJson(res, 500, { ok: false, error: String(error) })
          }
        }
        return
      }
      sendJson(res, 405, { error: 'method not allowed' })
    },
  }), 'vectr-client: /api/vectr/codebases/:slug')
}
