/**
 * Registry layer for the vectr-client plugin (leaf module).
 *
 * Owns the on-disk `instances.json` shape and the cwd→daemon-record resolution.
 * Intentionally free of Cordis, config parsing, and HTTP probing so it can be
 * unit-tested against a temp file with no live daemon and no plugin context.
 *
 * @module dsh-vectr-client/registry
 */
/** Minimal logger surface {@link readInstancesFile} touches (no Cordis dep). */
interface LoggerLike {
    info(message: string): void;
    warn(message: string): void;
}
/** Logger-bearing context accepted by {@link readInstancesFile}. */
export interface LoggerCtx {
    logger: LoggerLike;
}
/** Default bind host used only when an `InstanceEntry.host` is absent. */
export declare const DEFAULT_HOST = "127.0.0.1";
/** Hex-char length of the sha256 workspace key prefix vectr stores per instance. */
export declare const WORKSPACE_KEY_LENGTH = 12;
/** Default path of the vectr daemon registry, inside the user's home. */
export declare const DEFAULT_INSTANCES_FILE: string;
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
    /** Bind host; defaults to {@link DEFAULT_HOST}. */
    host?: string;
    /** Optional extra index roots. */
    extra_roots?: string[];
    /** Optional VS Code workspace file the daemon indexes. */
    code_workspace_file?: string | null;
}
/** The on-disk `instances.json` mapping: sha256(workspace)[:12] → daemon record. */
export type InstancesFile = Record<string, InstanceEntry>;
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
 * fails loud (the caller decides whether to skip or throw).
 * @param ctx - context carrying the logger (registry read diagnostics).
 * @param instancesPath - absolute path of `instances.json`.
 * @returns the parsed records, or `undefined` when the file does not exist.
 */
export declare function readInstancesFile(ctx: LoggerCtx, instancesPath: string): InstancesFile | undefined;
export {};
//# sourceMappingURL=registry.d.ts.map