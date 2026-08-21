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
import z from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type ConnectionHandle, type ReconnectConfig } from '@deepseek-ai/dsh-mcp-client';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "vectr-client";
/** Services required by this plugin. */
export declare const inject: string[];
/** Default path of the vectr daemon registry, inside the user's home. */
export declare const DEFAULT_INSTANCES_FILE: string;
/** Default per-tool-call timeout for vectr MCP calls (ms). */
export declare const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000;
/** Default local namespace for vectr tools (`mcp__vectr__*`). */
export declare const DEFAULT_SERVER_NAME = "vectr";
/** Hex-char length of the sha256 workspace key prefix vectr stores per instance. */
export declare const WORKSPACE_KEY_LENGTH = 12;
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
 * Install the vectr MCP connection for one agent.
 * @param ctx - plugin context (the loader fiber) providing agents and logger.
 * @param handles - live connection handles keyed by agent.
 * @param instances - parsed daemon registry records.
 * @param config - resolved plugin configuration.
 * @param agent - the agent whose workspace resolves the daemon port.
 */
export declare function install(ctx: Context, handles: Map<Agent, ConnectionHandle>, instances: InstancesFile | undefined, config: Required<Config>, agent: Agent): void;
/**
 * The vectr-client plugin entry: seed already-live agents, watch
 * `agent/created` / `agent/disposed`, and close every connection on teardown.
 * @param ctx - plugin context whose fiber owns the listeners and handles.
 * @param config - resolved plugin configuration.
 */
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map