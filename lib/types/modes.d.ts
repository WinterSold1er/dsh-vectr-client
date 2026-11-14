/**
 * Plugin-side persistence of the vectr daemon STARTUP MODE per workspace.
 *
 * Why this exists: `~/.vectr/instances.json` records `mode` only as RUNTIME
 * state — the daemon writes it while it lives, and `prune_dead()` deletes the
 * whole record as soon as the process is gone. A host restart (the harness unit
 * uses `KillMode=control-group`, so every daemon in the cgroup is SIGTERMed)
 * therefore erases the mode, and the plugin's own startup heal / start-all sweep
 * re-runs `vectr start` with no mode flag, which silently brings a memory-only
 * workspace back as a FULL re-index (the 146k-file rebuild incident).
 *
 * This file is the plugin's own memory of the choice: a flat map
 * `{ <normalized workspace path>: "memory_only" | "search_only" | "full" }`,
 * harvested from the registry BEFORE anything can prune it and written again on
 * every explicit mode change. `vectr start` behaviour is unchanged for a
 * workspace with no record here: no flag is emitted, which is exactly the old
 * behaviour (vectr's own default, `full`).
 *
 * @module dsh-vectr-client/modes
 */
import type { InstancesFile } from './domain/types';
/** The modes this plugin is allowed to remember (whitelist; anything else is dropped). */
export type PersistedMode = 'memory_only' | 'search_only' | 'full';
/** Default mode-store location, next to the other plugin-owned `~/.dsh` files. */
export declare const DEFAULT_MODES_FILE: string;
/** Whitelist check on an already-normalized mode string. */
export declare function isPersistedMode(value: unknown): value is PersistedMode;
/**
 * Normalize a raw mode string (both registry spellings, any case) into a mode
 * this plugin can persist. `lite` / `unknown` / garbage yield `undefined`: the
 * store only records modes whose start flags this plugin actually knows.
 */
export declare function toPersistedMode(value: unknown): PersistedMode | undefined;
/**
 * Read the mode store. A missing file, an unreadable file, invalid JSON, or a
 * JSON value that is not a plain object all mean "nothing remembered" and yield
 * `{}` — this must never throw, because a broken hint file may not break plugin
 * startup. Unknown mode values and unusable keys are dropped.
 */
export declare function readModes(modesPath: string): Record<string, PersistedMode>;
/** Look up the remembered mode for one workspace, or `undefined` when unknown. */
export declare function lookupMode(modesPath: string, workspace: string | null | undefined): PersistedMode | undefined;
/**
 * Remember one workspace's mode. The key is normalized exactly like every other
 * mode key in this plugin (registry sweep keys, `daemonDirectoryOf` lookups), so
 * a write here is readable by whichever start path asks next.
 * @returns whether the record reached disk.
 */
export declare function writeMode(modesPath: string, workspace: string, mode: PersistedMode): boolean;
/**
 * Copy every mode the daemon registry currently reports into the plugin store.
 * MUST run before anything that can prune `instances.json` (`vectr start` /
 * `vectr status` both prune globally), i.e. before startup heal and the
 * start-all sweep — after a prune the mode is simply gone from the registry.
 *
 * Idempotent and non-destructive: an existing key is never overwritten, so a
 * remembered `memory_only` can not be downgraded back to `full` by harvesting a
 * stale or half-pruned registry. What the old signature hid is that the other
 * direction is stale too — a store still saying `full` while the live registry
 * says `memory_only` — and "0, silently" made it undiagnosable. Disagreements
 * are now REPORTED, never resolved by surprise overwrite.
 * @returns what the harvest did: newly written keys, every disagreement with an
 * existing record, and whether the write to disk failed. A failed write is not
 * the same event as "nothing to harvest", and callers must be able to tell.
 */
export interface ModeHarvestConflict {
    /** Normalized workspace key the store and the registry disagree about. */
    workspace: string;
    /** Mode already remembered in the store. Kept: harvest never overwrites. */
    stored: PersistedMode;
    /** Mode the live registry currently claims. Kept, but surfaced to the caller. */
    incoming: PersistedMode;
}
export interface ModeHarvestResult {
    /** Normalized keys this harvest newly wrote into the store. */
    added: string[];
    /** Keys the store already had with a DIFFERENT mode (store wins, see above). */
    conflicts: ModeHarvestConflict[];
    /** True when there was new content to persist and the write to disk failed. */
    writeFailed: boolean;
}
export declare function harvestFromInstances(modesPath: string, instances: InstancesFile | undefined): ModeHarvestResult;
/**
 * The `vectr start` flags a mode requires. `full` and "no record" both produce
 * NO flag: `vectr start`'s own default is `full`, and emitting an explicit flag
 * there would change the behaviour of every workspace this plugin has never
 * downgraded.
 */
export declare function modeStartFlags(mode: PersistedMode | undefined): string[];
/**
 * Decide the mode a start should use, from the three sources this plugin knows,
 * in precedence order:
 *  1. an explicit request-body boolean (`memoryOnly: true` -> `memory_only`,
 *     `memoryOnly: false` -> `full`: an explicit panel choice is the user's intent);
 *  2. the mode recorded on the live registry entry;
 *  3. the mode remembered in the plugin store;
 *  4. nothing remembered anywhere -> `full`, i.e. no flag, i.e. today's behaviour.
 */
export declare function resolveStartMode(sources: {
    forcedMemoryOnly?: boolean | undefined;
    registryMode?: string | undefined;
    storedMode?: PersistedMode | undefined;
}): PersistedMode;
//# sourceMappingURL=modes.d.ts.map