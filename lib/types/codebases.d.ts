/**
 * Multi-codebase management for the vectr-client plugin (feature B).
 *
 * This module is pure logic: every side effect (spawning vectr, running ssh,
 * storing secrets, resolving free ports) is injected by the caller so the whole
 * surface is unit-testable with fakes. The on-disk metadata file
 * (`~/.dsh/vectr-codebases.json`) records only non-secret fields and a
 * `credentialRef` pointing at the secret store; the secret value itself is
 * never written to that file.
 *
 * @module dsh-vectr-client/codebases
 */
import { type InstancesFile } from './registry';
/** TCP connect budget for the `isPortListening` liveness check of the FORWARDED
 * local port (ms) — used by `ensureTunnelUp` purely to decide
 * reuse-vs-reallocate of `localPort`. This is NOT the ssh control-master
 * liveness path: `ssh -O check` (the authoritative up/down signal) has its own
 * `-o ConnectTimeout=5` and is independent of this budget. */
export declare const DEFAULT_TUNNEL_PROBE_MS = 800;
/** Reserved local tunnel-bind port range (inclusive). Both `createCodebase` and
 * `ensureTunnelUp` allocate from this same window so the forwarded
 * Streamable-HTTP endpoints stay in one predictable band. Shared as a constant
 * so the two call sites cannot drift apart. */
export declare const TUNNEL_PORT_MIN = 8760;
export declare const TUNNEL_PORT_MAX = 8799;
/** Discriminant for where a codebase's vectr daemon runs. */
export type CodebaseType = 'local' | 'remote';
/** How a remote host authenticates (informational; the secret lives in the store). */
export type CodebaseAuth = 'key' | 'password';
/** Input description of a codebase to create. */
export interface CodebaseSpec {
    /** Where the daemon runs. */
    type: CodebaseType;
    /** Absolute workspace path served by the daemon. */
    path: string;
    /** Owning workspace (absolute). Local == `path`; remote == the remote workspace the daemon serves. Composite `serverName` is derived from this + `slug`. */
    workspace?: string;
    /** Remote host (`user@host` or `host`) for `type === 'remote'`. */
    host?: string;
    /** Remote auth method. */
    auth?: CodebaseAuth;
    /** Plaintext password for `auth === 'password'`; consumed, never persisted here. */
    password?: string;
    /** Stable short identifier, also used to derive `serverName`. */
    slug: string;
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
    /** Owning workspace (absolute); enables per-workspace binding isolation. Local == `path`; remote == the remote workspace. */
    workspace?: string;
    /** Derived MCP server name (`vectr_<sha256(workspace)[:12]>_<slug>`) — globally unique across workspaces. */
    serverName: string;
    /** Local Streamable HTTP port the host connects to (tunnel endpoint / daemon port). */
    localPort?: number;
    /** Remote daemon port for `type === 'remote'`. */
    remotePort?: number;
    /** PID of the ssh tunnel process for `type === 'remote'`. */
    tunnelPid?: number;
    /** Control-socket path of the ssh tunnel master (`-M -S`); reliable PID query + clean teardown. */
    tunnelCtl?: string;
    /** Reference into the credential store (never the value). */
    credentialRef?: string;
    /** Connection status. */
    status: 'up' | 'down' | 'error';
    /** Last error detail when `status === 'error'`. */
    error?: string;
}
/**
 * Secret store seam. Implemented either by a wrapper over `ctx.credentials`
 * (async host service) or a {@link FileCredentialStore} fallback. Only
 * `set`/`get`/`unset` of a `ref` are needed by this module; the secret value
 * never appears in the metadata file.
 */
export interface CredentialStore {
    /** Store a secret value under `ref`. */
    set(ref: string, value: string): Promise<void> | void;
    /** Read a secret value by `ref`, or `undefined` when absent. */
    get(ref: string): Promise<string | undefined> | string | undefined;
    /** Remove a secret value by `ref`. */
    unset(ref: string): Promise<void> | void;
}
/**
 * Spawned-process runner. Mirrors `child_process.spawn` semantics: returns a
 * handle whose `promise` resolves with `{ code, stdout, stderr, signal }`.
 * `signal` is `null` for a clean exit and the signal name (e.g. `'SIGTERM'`)
 * when the process was killed — a signaled "exit" is never a success, so
 * callers that gate on success must check BOTH `code === 0` and
 * `signal === null` (the promise resolves, it does not reject, on non-zero).
 */
export interface SpawnHandle {
    /** Resolves when the process exits. */
    promise: Promise<{
        code: number;
        stdout: string;
        stderr: string;
        signal: NodeJS.Signals | null;
    }>;
    /** Kill the process (e.g. to clean up a partially-started daemon). */
    kill(): void;
}
/** Function that spawns a local vectr command. */
export type SpawnRunner = (command: string, args: string[]) => SpawnHandle;
/** Auth context the ssh runner may need to satisfy (e.g. password hosts). */
export interface SshAuthContext {
    /** Plaintext password for password-auth hosts; the runner feeds it to ssh (e.g. via sshpass). */
    password?: string;
}
/** Function that spawns an ssh command (used for remote probe / install / start / tunnel). */
export type SshRunner = (args: string[], auth?: SshAuthContext) => SpawnHandle;
/** Dependencies injected into the management functions (kept minimal / faked in tests). */
export interface CodebaseDeps {
    /** Local vectr runner. */
    spawnRunner: SpawnRunner;
    /** Remote ssh runner. */
    sshRunner: SshRunner;
    /** Secret store. */
    credStore: CredentialStore;
    /** Optional warn sink for observable non-fatal events (e.g. (c) preferred
     * tunnel-port migration). Injected by the host so this module stays
     * logger-free; may be absent in tests and direct use. */
    warn?: (message: string) => void;
}
/** Validation regex for a slug (also used to derive `serverName`). */
export declare const SLUG_PATTERN: RegExp;
/** Default metadata file location. */
export declare const DEFAULT_CODEBASES_FILE: string;
/** Clear the in-process server-name registry (test helper). */
export declare function _resetServerNameRegistry(): void;
/** Sentinel `workspace` for old entries that cannot be inferred during migration. */
export declare const UNASSIGNED_WORKSPACE = "__unassigned__";
/**
 * Derive the MCP server name from an owning workspace + slug. The workspace is
 * hashed (sha256, first {@link WORKSPACE_KEY_LENGTH} hex chars — the same key
 * vectr writes into `~/.vectr/instances.json`) so two workspaces may reuse the
 * same slug while still getting globally-unique server names (binding isolation
 * at the MCP-registration layer). Reuses the registry's key length constant so
 * the two never drift.
 * @param workspace - absolute owning workspace path.
 * @param slug - the codebase slug.
 * @returns `vectr_<workspaceKey>_<slug>`.
 */
/**
 * C2: only remove a file we actually own under a controlled base directory.
 * A corrupted/absent `tunnelCtl` (or any meta-derived path) must never let us
 * `rmSync` an arbitrary file on disk. We resolve and require the target to be
 * strictly inside `base`; otherwise throw instead of deleting.
 * @param path - candidate path to remove.
 * @param base - the only directory under which removal is permitted.
 */
export declare function safeRemove(path: string, base: string): void;
export declare function deriveServerName(workspace: string, slug: string): string;
/**
 * Validate a slug and its derived server name, enforcing the format and the
 * in-process uniqueness invariant (composite key: workspace + slug).
 * @param workspace - absolute owning workspace path.
 * @param slug - candidate slug.
 * @throws when the slug is malformed or its composite server name is already taken.
 */
export declare function assertServerNameAvailable(workspace: string, slug: string): void;
/**
 * Read the codebase metadata file. A missing file yields `[]`; a malformed file
 * throws with a clear diagnostic (misconfiguration must fail loud).
 * @param metaPath - absolute path of the metadata JSON.
 * @returns the parsed entries.
 */
export declare function loadCodebases(metaPath: string): CodebaseEntry[];
/**
 * Atomically write the codebase metadata file (tmp + rename, 0600). The secret
 * value is never present in `list` — only `credentialRef`.
 * @param metaPath - absolute path to write.
 * @param list - entries to persist.
 */
export declare function saveCodebases(metaPath: string, list: CodebaseEntry[]): void;
/**
 * Find the first free TCP port in `[min, max]`. Implemented by attempting to
 * `listen` and immediately `close`; the OS assigns a port when we pass 0, but
 * here we bind the candidate to detect occupancy.
 * @param min - first candidate port (inclusive).
 * @param max - last candidate port (inclusive).
 * @param exclude - ports to skip (e.g. reserved by an in-flight create / heal).
 * @param warn - optional warn sink used to surface port migration (c). When the
 *   preferred `min` port is occupied and a LATER port in the window is
 *   selected, `warn(message)` is invoked with a self-diagnosing message so the
 *   migration is visible in the host log. The preferred-port-available case
 *   never warns (a silent hit would just be noise).
 * @returns the first free port, or `undefined` when none are free.
 */
export declare function findFreePort(min?: number, max?: number, exclude?: Set<number>, warn?: (message: string) => void): Promise<number | undefined>;
/**
 * Create a codebase: spawn (local) or ssh-provision + tunnel (remote), then
 * persist the entry. Any partial failure cleans up what was already built.
 * @param deps - injected runners / store.
 * @param metaPath - metadata file path to persist into.
 * @param spec - the codebase to create.
 * @returns the created entry.
 */
export declare function createCodebase(deps: CodebaseDeps, metaPath: string, spec: CodebaseSpec): Promise<CodebaseEntry>;
/**
 * Delete a codebase: stop the daemon (local or remote), kill the tunnel, and
 * remove the entry from metadata.
 * @param deps - injected runners.
 * @param metaPath - metadata file path.
 * @param entry - the entry to delete.
 */
export declare function deleteCodebase(deps: CodebaseDeps, metaPath: string, entry: CodebaseEntry): Promise<void>;
/**
 * (d) Fallback orphan cleanup used by {@link deleteCodebase} when no recorded
 * `tunnelCtl` / `tunnelPid` exists OR the recorded teardown failed silently.
 * Scans tmpdir for any `vectr-tunnel-<slug>-*.sock` and asks ssh to exit each
 * control master cleanly via `ssh -O exit -S <sock> <host>`. When ssh itself
 * is unavailable, the socket file is simply unlinked (the underlying master
 * will not answer to `-O exit` either way). Every error is swallowed — this is
 * a best-effort hygiene step that must not veto the delete.
 *
 * Exported as `cleanupOrphanedTunnelsForCodebases` so the effect disposer in
 * `index.ts` can sweep the same set of orphans when the host pid changes and
 * the recorded `tunnelPid` / `tunnelCtl` no longer points at a live master.
 * Entries that are not `type === 'remote'` or whose slug is empty are
 * silently skipped.
 */
export declare function cleanupOrphanedTunnelsForCodebases(deps: CodebaseDeps, entries: readonly CodebaseEntry[]): Promise<void>;
/** Error carrying an HTTP status so the route layer can map it directly.
 * Pure domain errors (missing slug, unregistered workspace, serverName
 * collision) surface as {@link CodebaseError} from {@link patchCodebase}. */
export declare class CodebaseError extends Error {
    /** HTTP status to respond with. */
    readonly status: number;
    /** @param status - HTTP status. @param message - diagnostic. */
    constructor(status: number, message: string);
}
/** Options for {@link patchCodebase}. */
export interface PatchCodebaseOptions {
    /** Parsed vectr daemon registry (from `readInstancesFile`). When `undefined`
     * or the target workspace does not resolve to a known daemon workspace, the
     * assignment is rejected — a reassign target must be a real vectr workspace. */
    instances?: InstancesFile;
}
/**
 * Reassign an existing codebase's owning `workspace` and recompute its
 * composite `serverName` (`deriveServerName(workspace, slug)`), rejecting a
 * serverName collision with another entry, then persist and re-hydrate the
 * in-process uniqueness registry. Pure logic: no spawning, no HTTP, no body
 * parsing — the route validates the request shape and reads the registry.
 *
 * The route's `assign` action calls this to move a (typically remote) codebase
 * to a different owning workspace and keep `serverName` globally unique across
 * workspaces. Local entries are not special-cased: the same recompute runs.
 *
 * @param metaPath - codebase metadata file.
 * @param slug - entry slug to reassign.
 * @param workspace - target absolute workspace path (route must validate this).
 * @param options - optional parsed daemon registry for target validation.
 * @returns the updated entry.
 * @throws {CodebaseError} 404 when the slug is unknown; 409 when the target
 *   workspace is unregistered, or the recomputed serverName collides.
 */
export declare function patchCodebase(metaPath: string, slug: string, workspace: string, options?: PatchCodebaseOptions): CodebaseEntry;
/**
 * Probe a codebase's local MCP endpoint for liveness.
 * @param entry - the entry to test (uses `localPort`).
 * @returns `{ ok, status? }` on success or `{ ok: false, error }` on failure.
 */
/**
 * Result of probing a remote codebase's SSH tunnel for liveness.
 */
export interface TunnelHealth {
    /** `true` only when the ssh control master answers `ssh -O check` (the
     * AUTHORITATIVE liveness signal). The forwarded local port's TCP state is
     * deliberately NOT a fallback here — see {@link probeTunnel}. */
    alive: boolean;
    /** Why the tunnel is judged dead (present only when `alive === false`). */
    reason?: string;
}
/**
 * Probe whether a remote codebase's SSH tunnel is currently live — without
 * mutating anything. Liveness is derived from the AUTHORITATIVE signal only:
 *
 *  `ssh -O check -S <tunnelCtl> <host>` — asks the ssh control master directly.
 *  A 0 exit means the master process is alive; any other result (including a
 *  missing control socket) means the tunnel is down.
 *
 * The forwarded local port's TCP state is deliberately NOT used as a liveness
 * signal here: a listening port only proves *some* process holds `localPort`,
 * not that the ssh master is up, so it would both lie about status and make the
 * `findFreePort` reallocation in {@link ensureTunnelUp} unreachable. The bind
 * availability of `localPort` is checked separately, inside `ensureTunnelUp`,
 * purely to decide reuse-vs-reallocate. Treating `status:'up'` as "the master is
 * alive" is exactly the 问题1B truth-correction.
 *
 * Local (`type === 'local'`) entries have no tunnel and return
 * `{ alive: false, reason: 'not-remote' }` so callers treat them as "nothing to
 * heal" rather than "dead tunnel".
 *
 * @param entry - the remote entry to probe.
 * @param deps - injected ssh runner.
 */
export declare function probeTunnel(entry: CodebaseEntry, deps: CodebaseDeps): Promise<TunnelHealth>;
/** Result of {@link ensureTunnelUp}. */
export interface EnsureTunnelResult {
    /** The (possibly updated) entry — `localPort`/`tunnelCtl`/`status` may change. */
    entry: CodebaseEntry;
    /** `true` when a dead tunnel was actually reopened. */
    healed: boolean;
    /** Diagnostic when the tunnel could not be brought up (and status was downgraded). */
    error?: string;
}
/**
 * Ensure a remote codebase's SSH tunnel is up, reopening it when dead. This is
 * the self-healing fix for the "tunnel died, `status:'up'` lied" production
 * defect (问题1B):
 *
 *  - If {@link probeTunnel} reports the tunnel alive, return the entry unchanged
 *    (`healed: false`) — no churn.
 *  - If dead, reopen `ssh -f -N -M -S <ctl> -L 127.0.0.1:<localPort>:127.0.0.1:
 *    <remotePort> <host>` — the SAME `localPort` is reused when still free
 *    (so the persisted MCP endpoint URL stays stable), otherwise
 *    {@link findFreePort} allocates a fresh one and the meta is updated so every
 *    consumer (routes, binds) sees the new port.
 *  - On any reopen failure the persisted `status` is downgraded to `'error'`
 *    with a self-diagnosing `error` message instead of being left claiming
 *    `'up'` (no more lying). The same message is returned as `error` so callers
 *    (e.g. `testCodebase`) can surface it directly.
 *
 * Password-auth codebases resolve their secret from `credentialRef` so the
 * reopen feeds it back to the ssh runner (via sshpass) exactly like the initial
 * create. Key-auth entries pass `undefined` auth.
 *
 * NOTE (forwarding semantics): `localPort` is the LOCAL bind on this machine;
 * `remotePort` is the conan daemon port the tunnel forwards to. A local daemon
 * listening on 8767 does NOT conflict with a local tunnel bind on 8760 — they
 * are different addresses (ponytail: comment only, the ssh `-L` tuple is
 * authoritative).
 *
 * @param deps - injected runners / store.
 * @param metaPath - metadata file to persist status/port changes into.
 * @param entry - the (persisted) remote entry to bring up.
 */
export declare function ensureTunnelUp(deps: CodebaseDeps, metaPath: string, entry: CodebaseEntry): Promise<EnsureTunnelResult>;
/** Result of {@link migrateCodebases}. */
export interface MigrateResult {
    /** `true` when at least one entry was rewritten (persisted). */
    changed: boolean;
    /** Number of entries rewritten this run. */
    migrated: number;
}
/**
 * Idempotently backfill the `workspace` field and recompute the composite
 * `serverName` for entries written before per-workspace isolation existed.
 * Runs once at plugin apply (best-effort). Existing entries that already carry a
 * `workspace` matching their composite `serverName` are left untouched, so a
 * second run is a no-op (no rewrite, no churn).
 *
 * Inference for entries missing `workspace`:
 *  - local: reverse-lookup the workspace via `resolveInstance(instances, path)`
 *    (the daemon whose `instances.json` workspace equals `path`).
 *  - remote: match `host` against `instances[].host`.
 *  - either fails → {@link UNASSIGNED_WORKSPACE}.
 *
 * The on-disk envelope stays a bare `CodebaseEntry[]` (no schema change).
 * @param metaPath - absolute path of the codebase metadata file.
 * @param instances - parsed vectr daemon registry (for workspace inference).
 * @returns whether anything changed and how many entries were migrated.
 */
export declare function migrateCodebases(metaPath: string, instances: InstancesFile, logger?: {
    warn(message: string): void;
}): MigrateResult;
/** Options for {@link testCodebase}. */
export interface TestCodebaseOpts {
    /** Injected runners/store — required when `heal` is set. */
    deps?: CodebaseDeps;
    /** Metadata file path — required when `heal` is set (to persist any reopen). */
    metaPath?: string;
    /** Self-heal the tunnel before probing (问题1B): a dead tunnel is reopened
     * rather than producing a bare ECONNREFUSED fetch error. Heal failure yields a
     * diagnostic `{ ok: false, error: 'tunnel down: ...' }`. */
    heal?: boolean;
}
/**
 * Probe a codebase's local MCP endpoint for liveness. When `opts.heal` is set
 * and the entry is a remote whose tunnel is down, the tunnel is brought back up
 * first (see {@link ensureTunnelUp}); a heal that fails short-circuits with the
 * diagnostic instead of hitting `fetch`.
 * @param entry - the entry to test (uses `localPort`).
 * @param opts - optional self-heal / injection.
 * @returns `{ ok, status? }` on success or `{ ok: false, error }` on failure.
 */
export declare function testCodebase(entry: CodebaseEntry, opts?: TestCodebaseOpts): Promise<{
    ok: boolean;
    status?: unknown;
    error?: string;
}>;
/**
 * File-backed secret store with atomic 0600 writes, used when no
 * `ctx.credentials` service is available. Secrets are stored as
 * `{ "<ref>": "<value>" }` — never in the codebase metadata file.
 */
export declare class FileCredentialStore implements CredentialStore {
    /** Absolute path of the secrets JSON file. */
    readonly path: string;
    /** @param path - absolute secrets file path (defaults to `~/.dsh/vectr-secrets.json`). */
    constructor(path?: string);
    private readAll;
    private writeAll;
    set(ref: string, value: string): void;
    get(ref: string): string | undefined;
    unset(ref: string): void;
}
/** Remove a metadata file entirely (used in tests / reset). */
export declare function _removeMeta(metaPath: string): void;
/**
 * Best-effort cleanup of stale tunnel control sockets left behind when a
 * previous plugin process crashed (the master ssh process is gone but its
 * `vectr-tunnel-*.sock` remains in tmpdir). A socket is considered stale when
 * the node process that created it (pid encoded in the filename) is no longer
 * alive; live tunnels of the current process are left untouched. Every error is
 * swallowed — this is a startup hygiene step, never fatal.
 *
 * (a) Host-restart case: when the host process restarts with a DIFFERENT pid
 * the old socket's encoded pid is no longer alive, so the pid heuristic still
 * removes the stale socket — but only if its slug prefix matches one of OUR
 * codebases. Without the slug-prefix filter the function also touches unrelated
 * plugins/users on the same host. The new `slugs` argument narrows the scope
 * to OUR codebases, fixing the false-positive problem the survey flagged.
 *
 * @param dir - directory to scan (defaults to tmpdir).
 * @param slugs - optional whitelist of codebase slugs whose prefix-matched
 *   sockets should be cleaned. When omitted, the legacy pid-only heuristic
 *   runs across every `vectr-tunnel-*.sock` (kept for back-compat with the
 *   pre-isolate startup hygiene path).
 * @returns the number of sockets removed.
 */
export declare function cleanupStaleTunnelSockets(dir?: string, slugs?: readonly string[]): number;
//# sourceMappingURL=codebases.d.ts.map