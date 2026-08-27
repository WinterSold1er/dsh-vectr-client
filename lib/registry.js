/**
 * Registry layer for the vectr-client plugin (leaf module).
 *
 * Owns the on-disk `instances.json` shape and the cwd→daemon-record resolution.
 * Intentionally free of Cordis, config parsing, and HTTP probing so it can be
 * unit-tested against a temp file with no live daemon and no plugin context.
 *
 * @module dsh-vectr-client/registry
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** Default bind host used only when an `InstanceEntry.host` is absent. */
export const DEFAULT_HOST = '127.0.0.1';
/** Hex-char length of the sha256 workspace key prefix vectr stores per instance. */
export const WORKSPACE_KEY_LENGTH = 12;
/** Default path of the vectr daemon registry, inside the user's home. */
export const DEFAULT_INSTANCES_FILE = join(homedir(), '.vectr', 'instances.json');
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
 * fails loud (the caller decides whether to skip or throw).
 * @param ctx - context carrying the logger (registry read diagnostics).
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
//# sourceMappingURL=registry.js.map