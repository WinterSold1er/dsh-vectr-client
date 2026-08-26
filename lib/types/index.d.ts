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
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import z from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type ConnectionHandle, type ReconnectConfig } from '@deepseek-ai/dsh-mcp-client';
import { type CredentialStore, type SpawnRunner, type SshRunner } from './codebases';
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
/** Default path of the vectr daemon registry, inside the user's home. */
export declare const DEFAULT_INSTANCES_FILE: string;
/** Default per-tool-call timeout for vectr MCP calls (ms). */
export declare const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000;
/** Default local namespace for vectr tools (`mcp__vectr__*`). */
export declare const DEFAULT_SERVER_NAME = "vectr";
/** Hex-char length of the sha256 workspace key prefix vectr stores per instance. */
export declare const WORKSPACE_KEY_LENGTH = 12;
/** Default path of the multi-codebase metadata file (feature B). */
export declare const DEFAULT_CODEBASES_FILE: string;
/** Default path of the file-backed secret store (used when no host credentials service). */
export declare const DEFAULT_SECRETS_FILE: string;
/** One vectr daemon record from {@link InstancesFile}. */
export interface InstanceEntry {
    /** Absolute workspace directory this daemon serves. */
    workspace: string;
    /** TCP port of the daemon's Streamable HTTP MCP endpoint. */
    port: number;
    /** Daemon process id. */
    pid?: number;
    /** Unix epoch milliseconds when the daemon started. */
    started_at?: number;
    /** Registry mode (`full`, `lite`, …). */
    mode?: string;
    /** Bind host; defaults to `127.0.0.1`. */
    host?: string;
    /** Optional extra index roots. */
    extra_roots?: string[];
    /** Optional VS Code workspace file the daemon indexes. */
    code_workspace_file?: string | null;
}
/** The on-disk `instances.json` mapping: sha256(workspace)[:12] → daemon record. */
export type InstancesFile = Record<string, InstanceEntry>;
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
}
export declare const Config: z<Config>;
/**
 * Resolve the vectr daemon record for one workspace, following the same
 * registry conventions vectr writes: exact sha256(cwd)[:12] key first, then a
 * prefix match (cwd inside a listed workspace directory), then a
 * trailing-slash-tolerant string match on the stored workspace path.
 * @param instances - parsed `instances.json` records.
 * @param cwd - absolute workspace directory of the agent.
 * @returns the matching daemon record, or `undefined` when no entry applies.
 */
export declare function resolveInstance(instances: InstancesFile, cwd: string): InstanceEntry | undefined;
/**
 * Read and parse the vectr daemon registry file. A missing file means "no
 * vectr daemons"; a present-but-unparseable file is a misconfiguration and
 * fails loud.
 * @param ctx - plugin context carrying the logger.
 * @param instancesPath - absolute path of `instances.json`.
 * @returns the parsed records, or `undefined` when the file does not exist.
 */
export declare function readInstancesFile(ctx: Context, instancesPath: string): InstancesFile | undefined;
/**
 * TCP liveness probe for a vectr daemon endpoint.
 * @param host - bind host (defaults applied by caller).
 * @param port - TCP port of the daemon's `/mcp` endpoint.
 * @param timeoutMs - connect timeout before declaring the port dead.
 * @returns `true` when a TCP connection opens within the budget, else `false`.
 */
export declare function isPortListening(host: string, port: number, timeoutMs?: number): Promise<boolean>;
/**
 * Validate that a registry daemon record still corresponds to a live daemon.
 * A stale record (crashed process, reused port) must not bind tools to a dead
 * endpoint: a failed bind is invisible to the agent, so we skip explicitly.
 *
 * Resolution order (cheapest first):
 * 1. `entry.pid` present → `process.kill(pid, 0)` (ESRCH/ENOENT = dead,
 *    EPERM or success = alive). This is authoritative when the daemon writes
 *    its pid, which vectr does.
 * 2. No pid → short-timeout TCP probe of `host:port` (a listening socket is
 *    the weakest signal that something answers, good enough to avoid binding
 *    to a known-dead port; a real HTTP/MCP handshake still happens at connect).
 *
 * @param entry - the daemon record to validate.
 * @returns `true` when the record looks live, `false` when it should be skipped.
 */
export declare function isDaemonAlive(entry: InstanceEntry): Promise<boolean>;
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
export declare function install(ctx: Context, handles: Map<Agent, ConnectionHandle>, instancesPath: string, config: Required<Config>, agent: Agent, codebasesPath?: string): void;
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
 */
export declare function registerManagementRoutes(ctx: Context, instancesPath: string): void;
/**
 * Build the runtime dependencies for the codebase manager from the host
 * environment. `spawnRunner` wraps `node:child_process spawn`; `sshRunner`
 * wraps `spawn('ssh', args)`; `credStore` prefers the host `credentials`
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
    instancesPath: string;
};
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
export declare function registerCodebaseRoutes(ctx: Context, codebasesPath: string, secretsPath: string): void;
export {};
//# sourceMappingURL=index.d.ts.map