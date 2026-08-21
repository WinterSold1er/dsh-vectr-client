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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { resolveReconnectPolicy, startConnection, } from '@deepseek-ai/dsh-mcp-client';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'vectr-client';
/** Services required by this plugin. */
export const inject = ['agents'];
/** Default path of the vectr daemon registry, inside the user's home. */
export const DEFAULT_INSTANCES_FILE = join(homedir(), '.vectr', 'instances.json');
/** Default per-tool-call timeout for vectr MCP calls (ms). */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;
/** Default local namespace for vectr tools (`mcp__vectr__*`). */
export const DEFAULT_SERVER_NAME = 'vectr';
/** Hex-char length of the sha256 workspace key prefix vectr stores per instance. */
export const WORKSPACE_KEY_LENGTH = 12;
const Reconnect = z.object({
    enabled: z.boolean().default(false),
    initialDelayMs: z.number().min(1).default(500),
    maxDelayMs: z.number().min(1).default(30_000),
    maxAttempts: z.number().step(1).min(1).default(10),
});
export const Config = z.object({
    instancesPath: z.string().default(DEFAULT_INSTANCES_FILE),
    serverName: z.string().default(DEFAULT_SERVER_NAME),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    reconnect: Reconnect.default({ enabled: false }),
});
/**
 * Resolve the vectr daemon record for one workspace, following the same
 * registry conventions vectr writes: exact sha256(cwd)[:12] key first, then a
 * prefix match (cwd inside a listed workspace directory), then a
 * trailing-slash-tolerant string match on the stored workspace path.
 * @param instances - parsed `instances.json` records.
 * @param cwd - absolute workspace directory of the agent.
 * @returns the matching daemon record, or `undefined` when no entry applies.
 */
export function resolveInstance(instances, cwd) {
    const key = createHash('sha256').update(cwd).digest('hex').slice(0, WORKSPACE_KEY_LENGTH);
    const exact = instances[key];
    if (exact !== undefined)
        return exact;
    const normalizedCwd = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
    const candidates = Object.values(instances);
    const prefix = candidates.find(entry => {
        const stored = entry.workspace.endsWith('/') ? entry.workspace.slice(0, -1) : entry.workspace;
        return stored.length > 0 && (normalizedCwd === stored || normalizedCwd.startsWith(`${stored}/`));
    });
    if (prefix !== undefined)
        return prefix;
    const exactWorkspace = candidates.find(entry => {
        const stored = entry.workspace.endsWith('/') ? entry.workspace.slice(0, -1) : entry.workspace;
        return stored === normalizedCwd;
    });
    return exactWorkspace;
}
/**
 * Read and parse the vectr daemon registry file. A missing file means "no
 * vectr daemons"; a present-but-unparseable file is a misconfiguration and
 * fails loud.
 * @param ctx - plugin context carrying the logger.
 * @param instancesPath - absolute path of `instances.json`.
 * @returns the parsed records, or `undefined` when the file does not exist.
 */
export function readInstancesFile(ctx, instancesPath) {
    let text;
    try {
        text = readFileSync(instancesPath, 'utf8');
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            ctx.logger.info(`vectr-client: no daemon registry at ${instancesPath}, skipping`);
            return undefined;
        }
        throw new Error(`vectr-client: failed to read ${instancesPath}: ${String(error)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        throw new Error(`vectr-client: failed to parse ${instancesPath}: ${String(error)}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`vectr-client: ${instancesPath} must be a JSON object mapping workspace keys to daemon records`);
    }
    return parsed;
}
/**
 * Install the vectr MCP connection for one agent.
 * @param ctx - plugin context (the loader fiber) providing agents and logger.
 * @param handles - live connection handles keyed by agent.
 * @param instances - parsed daemon registry records.
 * @param config - resolved plugin configuration.
 * @param agent - the agent whose workspace resolves the daemon port.
 */
export function install(ctx, handles, instances, config, agent) {
    if (instances === undefined)
        return;
    if (handles.has(agent))
        return;
    const cwd = agent.session.header.cwd ?? process.cwd();
    const entry = resolveInstance(instances, cwd);
    if (entry === undefined) {
        ctx.logger.info(`vectr-client: no vectr daemon for ${cwd}, skipping`);
        return;
    }
    const host = entry.host ?? '127.0.0.1';
    const port = entry.port;
    const policy = resolveReconnectPolicy(config.reconnect, `vectr-client(${config.serverName}): reconnect`);
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
        reconnect: config.reconnect,
    }, policy);
    void conn.ready.then((outcome) => {
        if (outcome.error !== undefined) {
            ctx.logger.warn(`vectr-client: connect to :${port} failed: ${String(outcome.error)}`);
        }
    });
    handles.set(agent, conn);
}
/**
 * The vectr-client plugin entry: seed already-live agents, watch
 * `agent/created` / `agent/disposed`, and close every connection on teardown.
 * @param ctx - plugin context whose fiber owns the listeners and handles.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config = {}) {
    const resolved = {
        instancesPath: config.instancesPath ?? DEFAULT_INSTANCES_FILE,
        serverName: config.serverName ?? DEFAULT_SERVER_NAME,
        toolCallTimeoutMs: config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
        reconnect: config.reconnect ?? { enabled: false },
    };
    const instancesPath = isAbsolute(resolved.instancesPath)
        ? resolved.instancesPath
        : resolve(process.cwd(), resolved.instancesPath);
    const instances = readInstancesFile(ctx, instancesPath);
    const handles = new Map();
    for (const agent of ctx.agents.list())
        install(ctx, handles, instances, resolved, agent);
    ctx.on('agent/created', ({ agent }) => { install(ctx, handles, instances, resolved, agent); });
    ctx.on('agent/disposed', ({ agent }) => {
        void handles.get(agent)?.dispose();
        handles.delete(agent);
    });
    ctx.effect(() => () => {
        for (const conn of handles.values())
            void conn.dispose();
        handles.clear();
    }, 'vectr-client.connections');
}
//# sourceMappingURL=index.js.map