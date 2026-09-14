/**
 * Domain types for Vectr integration.
 *
 * Defines core entities, parameters, and results agnostic of host framework
 * or transport details (Layer 1: Domain Core).
 *
 * @module dsh-vectr-client/domain/types
 */
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
/** One vectr daemon record from InstancesFile. */
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
    /** Bind host. */
    host?: string;
    /** Optional extra index roots. */
    extra_roots?: string[];
    /** Optional VS Code workspace file the daemon indexes. */
    code_workspace_file?: string | null;
}
/** The on-disk `instances.json` mapping: sha256(workspace)[:12] -> daemon record. */
export type InstancesFile = Record<string, InstanceEntry>;
/** Where the codebase daemon runs. */
export type CodebaseType = 'local' | 'remote';
/** Last-known lifecycle status of a managed codebase. */
export type CodebaseStatus = 'up' | 'down' | 'error';
/** How a remote host authenticates (informational; the secret lives in the store). */
export type CodebaseAuth = 'key' | 'password';
/** Input description of a codebase to create. */
export interface CodebaseSpec {
    /** Where the daemon runs. */
    type: CodebaseType;
    /** Absolute workspace path served by the daemon. */
    path: string;
    /** Owning workspace (absolute). Local == `path`; remote == caller local cwd. */
    workspace?: string;
    /** Remote host (`user@host` or `host`) for `type === 'remote'`. */
    host?: string;
    /** Remote auth method. */
    auth?: CodebaseAuth;
    /** Plaintext password for `auth === 'password'`; consumed, never persisted here. */
    password?: string;
    /** Stable short identifier, also used to derive `serverName`. */
    slug: string;
    /** Optional custom remote port forwarded to local port. */
    remotePort?: number;
}
/** Runtime / persisted record of one managed codebase. */
export interface CodebaseEntry {
    /** `slug` (stable identifier). */
    id: string;
    /** `slug` duplicate field kept for callers expecting `id` + `slug`. */
    slug: string;
    /** Where the daemon runs. */
    type: CodebaseType;
    /** Absolute workspace path served by the daemon. */
    path: string;
    /** Remote host for `type === 'remote'`. */
    host?: string;
    /** Owning workspace (absolute); enables per-workspace binding isolation. */
    workspace?: string;
    /** Derived MCP server name (`vectr_<sha256(workspace)[:12]>_<slug>`). */
    serverName: string;
    /** Local Streamable HTTP port the host connects to. */
    localPort?: number;
    /** Remote daemon port for `type === 'remote'`. */
    remotePort?: number;
    /** PID of the ssh tunnel process for `type === 'remote'`. */
    tunnelPid?: number;
    /** Control-socket path of the ssh tunnel master (`-M -S`). */
    tunnelCtl?: string;
    /** SSH master control socket path for `type === 'remote'`. */
    ctlPath?: string;
    /** Informational auth method used to provision this codebase. */
    auth?: CodebaseAuth;
    /** Injected credential reference name (e.g. `VECTR_SSH_FOO`), never the secret itself. */
    credentialRef?: string;
    /** Connection status. */
    status: CodebaseStatus;
    /** Last error detail when `status === 'error'`. */
    error?: string;
    /** Whether this codebase is the primary codebase of the workspace. */
    isPrimary?: boolean | undefined;
}
/**
 * Operating mode of a Vectr daemon instance.
 * - full: Complete indexing, semantic search, and working memory.
 * - memory_only: Working memory & hooks only; no index/code directory required, no re-index.
 * - search_only: Semantic search & code graph only; no working memory.
 * - lite: Lightweight indexing mode.
 * - offline: Instance dead or unreachable.
 * - unknown: Mode not reported.
 */
export type VectrMode = 'full' | 'memory_only' | 'search_only' | 'lite' | 'offline' | 'unknown';
/**
 * Summary view of a codebase mounted in a workspace.
 */
export interface CodebaseSummary {
    slug: string;
    type: 'local' | 'remote';
    target: string;
    status: 'up' | 'down' | 'error';
    error?: string | undefined;
    workspace?: string | undefined;
    isPrimary?: boolean | undefined;
    deletable?: boolean | undefined;
}
/**
 * Aggregated Vectr state for a specific session's workspace.
 */
export interface SessionVectrState {
    workspace: string;
    live: boolean;
    mode: VectrMode;
    port?: number | undefined;
    pid?: number | undefined;
    host?: string | undefined;
    status?: VectrStatus | undefined;
    codebases: CodebaseSummary[];
    canReindex: boolean;
    reindexDisabledReason?: string | undefined;
    reason?: string | undefined;
    error?: string | undefined;
}
/**
 * Parameters for executing `vectr init`.
 */
export interface VectrInitOptions {
    /** Absolute workspace directory to initialize. */
    workspace: string;
    /** Whether to inject Claude Code hooks into settings (.claude/settings.json). */
    hooks?: boolean | undefined;
    /** Whether to configure memory-only style (--style memory-only). */
    memoryOnly?: boolean | undefined;
    /** Custom instruction style override (additive, directed, memory-first, memory-only). */
    style?: string | undefined;
}
/**
 * Parameters for querying working memory notes via daemon /v1/recall.
 */
export interface RecallOptions {
    query?: string | undefined;
    tags?: string[] | undefined;
    priority?: string | undefined;
    kind?: string | undefined;
    limit?: number | undefined;
    detail?: ('index' | 'full') | undefined;
    sort_by?: ('relevance' | 'recency' | 'priority' | 'chronological') | undefined;
}
/**
 * Structure of daemon /v1/resume response.
 */
export interface ResumeResponse {
    last_task?: {
        id?: number | undefined;
        title?: string | undefined;
        content?: string | undefined;
        priority?: string | undefined;
        [key: string]: unknown;
    } | null | undefined;
    snapshot?: {
        label?: string | undefined;
        timestamp?: string | undefined;
        [key: string]: unknown;
    } | null | undefined;
    gotchas?: Array<{
        id?: number | undefined;
        title?: string | undefined;
        content?: string | undefined;
        file_path?: string | undefined;
        [key: string]: unknown;
    }> | undefined;
    gotchas_truncated?: boolean | undefined;
    formatted: string;
    processing_ms: number;
}
/**
 * Result of a CLI init execution.
 */
export interface InitResult {
    ok: boolean;
    stdout?: string | undefined;
    stderr?: string | undefined;
    error?: string | undefined;
}
/**
 * Outcome of upgrading a workspace from memory-only to full mode.
 */
export interface UpgradeResult {
    ok: boolean;
    mode?: VectrMode | undefined;
    port?: number | undefined;
    error?: string | undefined;
    stdout?: string | undefined;
    stderr?: string | undefined;
}
/**
 * Result of triggering a daemon re-index.
 */
export interface TriggerResult {
    ok: boolean;
    error?: string | undefined;
    status?: number | undefined;
}
//# sourceMappingURL=types.d.ts.map