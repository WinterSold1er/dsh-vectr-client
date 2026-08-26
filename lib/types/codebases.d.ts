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
    /** Derived MCP server name (`vectr_<slug>`) — globally unique. */
    serverName: string;
    /** Local Streamable HTTP port the host connects to (tunnel endpoint / daemon port). */
    localPort?: number;
    /** Remote daemon port for `type === 'remote'`. */
    remotePort?: number;
    /** PID of the ssh tunnel process for `type === 'remote'`. */
    tunnelPid?: number;
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
 * handle whose `promise` resolves with `{ code, stdout, stderr }`.
 */
export interface SpawnHandle {
    /** Resolves when the process exits. */
    promise: Promise<{
        code: number;
        stdout: string;
        stderr: string;
    }>;
    /** Kill the process (e.g. to clean up a partially-started daemon). */
    kill(): void;
}
/** Function that spawns a local vectr command. */
export type SpawnRunner = (command: string, args: string[]) => SpawnHandle;
/** Function that spawns an ssh command (used for remote probe / install / start / tunnel). */
export type SshRunner = (args: string[]) => SpawnHandle;
/** Dependencies injected into the management functions (kept minimal / faked in tests). */
export interface CodebaseDeps {
    /** Local vectr runner. */
    spawnRunner: SpawnRunner;
    /** Remote ssh runner. */
    sshRunner: SshRunner;
    /** Secret store. */
    credStore: CredentialStore;
    /** Path of the vectr daemon registry (passed through; not read here). */
    instancesPath: string;
}
/** Validation regex for a slug (also used to derive `serverName`). */
export declare const SLUG_PATTERN: RegExp;
/** Default metadata file location. */
export declare const DEFAULT_CODEBASES_FILE: string;
/** Clear the in-process server-name registry (test helper). */
export declare function _resetServerNameRegistry(): void;
/**
 * Derive the MCP server name from a slug.
 * @param slug - the codebase slug.
 * @returns `vectr_<slug>`.
 */
export declare function deriveServerName(slug: string): string;
/**
 * Validate a slug and its derived server name, enforcing the format and the
 * in-process uniqueness invariant.
 * @param slug - candidate slug.
 * @throws when the slug is malformed or its server name is already taken.
 */
export declare function assertSlugAvailable(slug: string): void;
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
 * @returns the first free port, or `undefined` when none are free.
 */
export declare function findFreePort(min?: number, max?: number): Promise<number | undefined>;
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
 * Probe a codebase's local MCP endpoint for liveness.
 * @param entry - the entry to test (uses `localPort`).
 * @returns `{ ok, status? }` on success or `{ ok: false, error }` on failure.
 */
export declare function testCodebase(entry: CodebaseEntry): Promise<{
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
//# sourceMappingURL=codebases.d.ts.map