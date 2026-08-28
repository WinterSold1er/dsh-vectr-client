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
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  resolveReconnectPolicy,
  startConnection,
  type ConnectionHandle,
  type ReconnectConfig,
} from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import { scanWorkspaces, triggerIndex } from './workspaces'
import {
  createCodebase,
  deleteCodebase,
  FileCredentialStore,
  loadCodebases,
  testCodebase,
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
  type InstancesFile,
} from './registry'
import {
  DEFAULT_TCP_TIMEOUT_MS,
  diagnoseDaemon,
  fetchStatus,
} from './probe'

// Re-export the registry/probe surface so existing importers (and tests) keep
// resolving these symbols from the plugin root without the index↔workspaces cycle.
export { isDaemonAlive, isPortListening } from './probe'
export { readInstancesFile, resolveInstance, DEFAULT_INSTANCES_FILE } from './registry'
export type { InstanceEntry, InstancesFile } from './registry'

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
}

/** Default HTTP `/v1/status` liveness-probe budget (ms); below the known hang window. */
export const DEFAULT_DAEMON_HTTP_TIMEOUT_MS = 5_000

/** Default TCP port-listening probe budget (ms). */
export const DEFAULT_DAEMON_TCP_TIMEOUT_MS = DEFAULT_TCP_TIMEOUT_MS

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
})

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
 * @param instancesPath - absolute path of the vectr daemon registry.
 * @param config - resolved plugin configuration.
 * @param agent - the agent whose workspace resolves the daemon port.
 */
export function install(
  ctx: Context,
  handles: Map<Agent, ConnectionHandle>,
  instancesPath: string,
  config: Required<Config>,
  agent: Agent,
  codebasesPath?: string,
): void {
  if (handles.has(agent)) return
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
    return
  }
  if (instances === undefined) return
  const entry = resolveInstance(instances, cwd)
  if (entry === undefined) {
    ctx.logger.info(`vectr-client: no vectr daemon for ${cwd}, skipping`)
    return
  }
  // Liveness gate (D-2 / R3): a stale record must not bind tools to a dead
  // daemon. alive = (pid alive OR TCP listening) AND HTTP /v1/status reachable,
  // so a "pid alive + port listening but HTTP hung" daemon is correctly skipped
  // (R3/R4). HTTP probe + budgets are injected from config (NFR2). Runs in a
  // non-blocking IIFE so the probe never delays `agent/created` publication;
  // failures are reported as warn + skip only and never thrown (NFR4).
  void (async () => {
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
      // NOTE: `startConnection` ignores `config.reconnect` — the resolved
      // `policy` passed as the third argument is the sole reconnect control
      // (see packages/mcp/mcp-client/src/connection.ts: scheduleReconnect reads
      // `policy`, never `config.reconnect`). Passing `config.reconnect` here
      // would be dead, so only `policy` is supplied.
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
    handles.set(agent, conn)
  })()

  // Feature B: also bind every persisted codebase whose status is 'up'. These
  // are host-level MCP servers (each with a globally-unique serverName), so a
  // failed bind must not veto the agent and only logs a warning. Runs once per
  // agent (guarded by `handles.has(agent)` at the top of install).
  if (codebasesPath !== undefined) {
    void installCodebaseConnections(ctx, config, agent, codebasesPath)
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
async function installCodebaseConnections(
  ctx: Context,
  config: Required<Config>,
  agent: Agent,
  codebasesPath: string,
): Promise<void> {
  let entries: CodebaseEntry[]
  try {
    entries = loadCodebases(codebasesPath)
  } catch (error) {
    ctx.logger.warn(`vectr-client: cannot read codebase metadata at ${codebasesPath} (${String(error)}); skipping codebase binds for session ${agent.id}`)
    return
  }
  const policy = resolveReconnectPolicy(config.reconnect, 'vectr-client(codebase): reconnect')
  for (const entry of entries) {
    if (entry.status !== 'up' || entry.localPort === undefined) continue
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
  const handles = new Map<Agent, ConnectionHandle>()

  // The registry is read inside install() on every call (D-7), so seed and
  // each agent/created both see the current on-disk state. The codebase
  // metadata path is passed so install also binds up codebases.
  for (const agent of ctx.agents.list()) install(ctx, handles, instancesPath, resolved, agent, codebasesPath)
  ctx.on('agent/created', ({ agent }) => { install(ctx, handles, instancesPath, resolved, agent, codebasesPath) })
  ctx.on('agent/disposed', ({ agent }) => {
    void handles.get(agent)?.dispose()
    handles.delete(agent)
  })
  ctx.effect(() => () => {
    for (const conn of handles.values()) void conn.dispose()
    handles.clear()
    // Kill any surviving ssh tunnels recorded in the codebase metadata so a
    // host teardown does not leave orphaned port-forward processes.
    try {
      for (const entry of loadCodebases(codebasesPath)) {
        if (entry.type === 'remote' && entry.tunnelPid !== undefined) {
          try {
            process.kill(entry.tunnelPid, 'SIGTERM')
          } catch {
            // tunnel already gone.
          }
        }
      }
    } catch {
      // metadata unreadable; nothing to clean up.
    }
  }, 'vectr-client.connections')

  // Feature A (C1): host-side JSON routes backing the workspace console.
  // Registered in the root plugin scope (not per-agent) so a single pair of
  // management endpoints serves every workspace; disposed with this fiber.
  registerManagementRoutes(ctx, instancesPath, resolved)
  registerCodebaseRoutes(ctx, codebasesPath, resolved.secretsPath)
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
    instancesPath: string
  } {
  const spawnRunner: SpawnRunner = (command, args) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    const promise = new Promise<{ code: number; stdout: string; stderr: string }>((resolveExit) => {
      child.on('error', (err) => { resolveExit({ code: 1, stdout, stderr: `${stderr}\n${String(err)}` }) })
      child.on('close', (code) => { resolveExit({ code: code ?? 1, stdout, stderr }) })
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
      // Password-auth hosts: feed the password through sshpass and force
      // password-only auth. Requires `sshpass` on the host PATH (documented in
      // README). Key-auth hosts (auth absent) run plain `ssh`.
      return spawnRunner('sshpass', ['-p', auth.password, 'ssh',
        '-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', ...args])
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
    instancesPath: DEFAULT_INSTANCES_FILE,
  }
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
 */
export function registerCodebaseRoutes(ctx: Context, codebasesPath: string, secretsPath: string): void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    ctx.logger.warn('vectr-client: webServer service unavailable; skipping /api/vectr/codebases* routes')
    return
  }
  const deps = buildCodebaseDeps(ctx, secretsPath)

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/vectr/codebases',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        try {
          const list = loadCodebases(codebasesPath).map(stripSecret)
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
    path: '/api/vectr/codebases/',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const slug = decodeURIComponent(url.pathname.replace('/api/vectr/codebases/', ''))
      if (slug.length === 0) {
        sendJson(res, 400, { error: 'missing codebase slug' })
        return
      }
      const list = () => loadCodebases(codebasesPath)
      const find = () => list().find(e => e.slug === slug)

      if (req.method === 'DELETE') {
        const entry = find()
        if (entry === undefined) {
          sendJson(res, 404, { ok: false, error: 'no such codebase' })
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
        const entry = find()
        if (entry === undefined) {
          sendJson(res, 404, { ok: false, error: 'no such codebase' })
          return
        }
        const result = await testCodebase(entry)
        sendJson(res, result.ok ? 200 : 503, result)
        return
      }
      sendJson(res, 405, { error: 'method not allowed' })
    },
  }), 'vectr-client: /api/vectr/codebases/:slug')
}
