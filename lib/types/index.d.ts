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
import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import z from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { type ConnectionHandle, type ReconnectConfig } from '@deepseek-ai/dsh-mcp-client/src/connection.ts';
import { type CodebaseEntry, type CredentialStore, type SpawnRunner, type SshRunner } from './codebases';
import { type InstancesFile } from './registry';
export { isDaemonAlive, isPortListening } from './probe';
export { readInstancesFile, resolveInstance, DEFAULT_INSTANCES_FILE } from './registry';
export type { InstanceEntry, InstancesFile } from './registry';
export { ensureTunnelUp, probeTunnel, DEFAULT_TUNNEL_PROBE_MS } from './codebases';
export type { TunnelHealth, EnsureTunnelResult, TestCodebaseOpts } from './codebases';
/**
 * Local structural view of the host `webServer` service this plugin registers
 * routes on. Declared as a Cordis `Context` augmentation so `ctx.webServer` is
 * typed without taking a build dependency on the webserver package; the running
 * host provides the real implementation. Only the `register` surface used here
 * is shaped.
 */
declare module '@deepseek-ai/cordis' {
    interface Context {
        webServer: WebServerLike;
        /** Provided by `@deepseek-ai/dsh-system-prompt` at host runtime (same
         * optional-augmentation pattern as `webServer` above). Declared here so
         * `agent.ctx.systemPrompt.section(...)` type-checks without a build
         * dependency on the system-prompt package. */
        systemPrompt: SystemPrompt;
    }
}
interface WebServerLike {
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
}
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "vectr-client";
/** Services required by this plugin. `webServer` is consumed optionally via
 * `ctx.get` (see {@link registerManagementRoutes}) so the plugin also loads in
 * harness compositions that do not boot the web server; the host provides it. */
export declare const inject: string[];
/** Default per-tool-call timeout for vectr MCP calls (ms). */
export declare const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000;
/** Default local namespace for vectr tools (`mcp__vectr__*`). */
export declare const DEFAULT_SERVER_NAME = "vectr";
/** Default path of the multi-codebase metadata file (feature B). */
export declare const DEFAULT_CODEBASES_FILE: string;
/** Default path of the file-backed secret store (used when no host credentials service). */
export declare const DEFAULT_SECRETS_FILE: string;
/** Plugin configuration validated by {@link Config}. */
export interface Config {
    /** Path of the vectr daemon registry (default `~/.vectr/instances.json`). */
    instancesPath?: string;
    /** Local namespace for the vectr tools (`mcp__<serverName>__*`). */
    serverName?: string;
    /** Per-tool-call timeout in milliseconds (default 60000). */
    toolCallTimeoutMs?: number;
    /** Automatic reconnect policy after a lost connection; default `{ enabled: false }`. */
    reconnect?: ReconnectConfig;
    /** Path of the multi-codebase metadata file (feature B; default `~/.dsh/vectr-codebases.json`). */
    codebasesPath?: string;
    /** Path of the file-backed secret store (feature B; default `~/.dsh/vectr-secrets.json`). */
    secretsPath?: string;
    /** HTTP `/v1/status` liveness-probe budget in ms (default 5000); below the known hang window so a hung daemon is judged dead. */
    daemonHttpTimeoutMs?: number;
    /** TCP port-listening probe budget in ms (default 300). */
    daemonTcpTimeoutMs?: number;
}
/** Default HTTP `/v1/status` liveness-probe budget (ms); below the known hang window. */
export declare const DEFAULT_DAEMON_HTTP_TIMEOUT_MS = 5000;
/** Default TCP port-listening probe budget (ms). */
export declare const DEFAULT_DAEMON_TCP_TIMEOUT_MS = 300;
/** (b) Minimum interval between startup-time heal attempts for the same slug.
 * Prevents a persistently-unreachable host from being hammered on every host
 * restart while still leaving room for transient blips to recover. */
export declare const STARTUP_HEAL_COOLDOWN_MS = 30000;
/** (b) Startup-heal scope: which persisted entries get an automatic
 * `ensureTunnelUp` attempt at host startup. `up` keeps its legacy behavior;
 * `down` and `error` are the previously-deadlocked states that were only
 * surfaced to the user and never automatically recovered. `local` entries
 * have no tunnel to heal. */
export declare function startupHealEligible(entry: Pick<CodebaseEntry, 'type' | 'status'>): boolean;
export declare const Config: z<Config>;
/**
 * System-prompt section contributed to each agent when its vectr daemon is
 * verified alive: nudges the agent to use the vectr MCP tools for code queries
 * instead of blind file reads. Static English text (matches the official
 * prompt style). Order 95 sits after the deployment persona (0) and before the
 * tool-guidance band (100–199); see `@deepseek-ai/dsh-system-prompt`.
 */
export declare const VECTR_GUIDANCE_SECTION_NAME = "vectr:mcp-guidance";
export declare const VECTR_GUIDANCE_SECTION_ORDER = 95;
export declare const VECTR_GUIDANCE_SECTION_TEXT = "When answering code-query or codebase-navigation questions, prefer the vectr MCP tools (mcp__vectr__*) over blind file reads. Use them to search, retrieve, and reason over the indexed workspace.";
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
export declare function install(ctx: Context, handles: Map<Agent, ConnectionHandle>, promptFibers: Map<Agent, Fiber>, instancesPath: string, config: Required<Config>, agent: Agent, codebasesPath?: string, 
/** Agents disposed while their liveness probe is still in flight (see P1 in
 * `apply`). When set, the IIFE tears down the freshly-created connection /
 * prompt fiber instead of leaking it to host teardown. Defaults to an empty
 * set so callers that do not seed live agents (unit tests) need not pass it. */
disposed?: Set<Agent>): void;
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
export declare function installCodebaseConnections(ctx: Context, config: Required<Config>, agent: Agent, codebasesPath: string, instances?: InstancesFile, cwd?: string): Promise<void>;
/**
 * The vectr-client plugin entry: seed already-live agents, watch
 * `agent/created` / `agent/disposed`, and close every connection on teardown.
 * @param ctx - plugin context whose fiber owns the listeners and handles.
 * @param config - resolved plugin configuration.
 */
export declare function apply(ctx: Context, config?: Config): void;
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
export declare function registerManagementRoutes(ctx: Context, instancesPath: string, config: Required<Config>): void;
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
export declare function buildCodebaseDeps(ctx: Context, secretsPath: string): {
    spawnRunner: SpawnRunner;
    sshRunner: SshRunner;
    credStore: CredentialStore;
    warn: (message: string) => void;
};
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
export declare function slugFromPathname(pathname: string): string;
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
export declare function registerCodebaseRoutes(ctx: Context, codebasesPath: string, secretsPath: string, instancesPath?: string): void;
//# sourceMappingURL=index.d.ts.map