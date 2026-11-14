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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeWorkspacePath } from './probe'
import { normalizeMode } from './domain/rules'
import type { InstancesFile } from './domain/types'

/** The modes this plugin is allowed to remember (whitelist; anything else is dropped). */
export type PersistedMode = 'memory_only' | 'search_only' | 'full'

const PERSISTED_MODE_VALUES: readonly PersistedMode[] = ['memory_only', 'search_only', 'full']

/** Default mode-store location, next to the other plugin-owned `~/.dsh` files. */
export const DEFAULT_MODES_FILE = join(homedir(), '.dsh', 'vectr-modes.json')

/** Whitelist check on an already-normalized mode string. */
export function isPersistedMode(value: unknown): value is PersistedMode {
  return typeof value === 'string' && (PERSISTED_MODE_VALUES as readonly string[]).includes(value)
}

/**
 * Normalize a raw mode string (both registry spellings, any case) into a mode
 * this plugin can persist. `lite` / `unknown` / garbage yield `undefined`: the
 * store only records modes whose start flags this plugin actually knows.
 */
export function toPersistedMode(value: unknown): PersistedMode | undefined {
  const normalized = typeof value === 'string' ? normalizeMode(value) : undefined
  return isPersistedMode(normalized) ? normalized : undefined
}

/**
 * Read the mode store. A missing file, an unreadable file, invalid JSON, or a
 * JSON value that is not a plain object all mean "nothing remembered" and yield
 * `{}` — this must never throw, because a broken hint file may not break plugin
 * startup. Unknown mode values and unusable keys are dropped.
 */
export function readModes(modesPath: string): Record<string, PersistedMode> {
  let parsed: unknown
  try {
    if (!existsSync(modesPath)) return {}
    parsed = JSON.parse(readFileSync(modesPath, 'utf-8'))
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  const modes: Record<string, PersistedMode> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const path = normalizeWorkspacePath(key)
    const mode = toPersistedMode(value)
    if (path === '' || mode === undefined) continue
    modes[path] = mode
  }
  return modes
}

/** Look up the remembered mode for one workspace, or `undefined` when unknown. */
export function lookupMode(modesPath: string, workspace: string | null | undefined): PersistedMode | undefined {
  const key = normalizeWorkspacePath(workspace)
  if (key === '') return undefined
  return readModes(modesPath)[key]
}

/**
 * Atomically replace the whole store (same tmp + rename + 0600 discipline as
 * {@link saveCodebases}). Persistence is advisory: a mode record is a startup
 * hint, never a correctness invariant, so an unwritable store must not fail the
 * daemon operation that triggered the write. `false` reports that honestly to
 * callers that can log it.
 */
function persistModes(modesPath: string, modes: Record<string, PersistedMode>): boolean {
  try {
    const dir = dirname(modesPath)
    mkdirSync(dir, { recursive: true })
    const tmp = `${modesPath}.${process.pid}.tmp`
    const payload = JSON.stringify(modes, null, 2)
    writeFileSync(tmp, payload, { mode: 0o600 })
    renameSync(tmp, modesPath)
    // Best-effort: ensure the final mode is 0600 even if umask interfered.
    try {
      writeFileSync(modesPath, payload, { mode: 0o600 })
    } catch {
      // rename already committed the content; ignore re-write failure.
    }
    return true
  } catch {
    return false
  }
}

/**
 * Remember one workspace's mode. The key is normalized exactly like every other
 * mode key in this plugin (registry sweep keys, `daemonDirectoryOf` lookups), so
 * a write here is readable by whichever start path asks next.
 * @returns whether the record reached disk.
 */
export function writeMode(modesPath: string, workspace: string, mode: PersistedMode): boolean {
  // A blank workspace normalizes to `/`, which would store a mode for the filesystem
  // root and hand a mode flag to any start that mis-parses a path. Refuse it.
  if (typeof workspace !== 'string' || workspace.trim() === '') return false
  const key = normalizeWorkspacePath(workspace)
  const value = toPersistedMode(mode)
  if (key === '' || value === undefined) return false
  const modes = readModes(modesPath)
  modes[key] = value
  return persistModes(modesPath, modes)
}

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
  workspace: string
  /** Mode already remembered in the store. Kept: harvest never overwrites. */
  stored: PersistedMode
  /** Mode the live registry currently claims. Kept, but surfaced to the caller. */
  incoming: PersistedMode
}

export interface ModeHarvestResult {
  /** Normalized keys this harvest newly wrote into the store. */
  added: string[]
  /** Keys the store already had with a DIFFERENT mode (store wins, see above). */
  conflicts: ModeHarvestConflict[]
  /** True when there was new content to persist and the write to disk failed. */
  writeFailed: boolean
}

export function harvestFromInstances(
  modesPath: string,
  instances: InstancesFile | undefined,
): ModeHarvestResult {
  const added: string[] = []
  const conflicts: ModeHarvestConflict[] = []
  if (instances === null || typeof instances !== 'object') {
    return { added, conflicts, writeFailed: false }
  }

  const modes = readModes(modesPath)
  for (const entry of Object.values(instances)) {
    if (entry === null || typeof entry !== 'object') continue
    const rawWorkspace = (entry as { workspace?: unknown }).workspace
    const key = typeof rawWorkspace === 'string' ? normalizeWorkspacePath(rawWorkspace) : ''
    const mode = toPersistedMode((entry as { mode?: unknown }).mode)
    if (key === '' || mode === undefined) continue
    const stored = modes[key]
    if (stored !== undefined) {
      // The store wins — overwriting it from a registry that a prune can erase at
      // any moment is how the full re-index came back. But the disagreement is
      // handed to the caller: a store stuck on `full` against a `memory_only`
      // registry is a record an operator has to be able to SEE (and then fix by
      // hand or by an explicit mode change), not one to guess at from silence.
      if (stored !== mode) conflicts.push({ workspace: key, stored, incoming: mode })
      continue
    }
    modes[key] = mode
    added.push(key)
  }
  if (added.length === 0) {
    // Nothing new was found: leave the file untouched (a no-op harvest rewrites nothing).
    return { added, conflicts, writeFailed: false }
  }
  // A failed write is its own outcome; it must never read as "nothing harvested".
  return { added, conflicts, writeFailed: !persistModes(modesPath, modes) }
}

/**
 * The `vectr start` flags a mode requires. `full` and "no record" both produce
 * NO flag: `vectr start`'s own default is `full`, and emitting an explicit flag
 * there would change the behaviour of every workspace this plugin has never
 * downgraded.
 */
export function modeStartFlags(mode: PersistedMode | undefined): string[] {
  if (mode === 'memory_only') return ['--memory-only']
  if (mode === 'search_only') return ['--search-only']
  return []
}

/**
 * Decide the mode a start should use, from the three sources this plugin knows,
 * in precedence order:
 *  1. an explicit request-body boolean (`memoryOnly: true` -> `memory_only`,
 *     `memoryOnly: false` -> `full`: an explicit panel choice is the user's intent);
 *  2. the mode recorded on the live registry entry;
 *  3. the mode remembered in the plugin store;
 *  4. nothing remembered anywhere -> `full`, i.e. no flag, i.e. today's behaviour.
 */
export function resolveStartMode(sources: {
  forcedMemoryOnly?: boolean | undefined
  registryMode?: string | undefined
  storedMode?: PersistedMode | undefined
}): PersistedMode {
  if (sources.forcedMemoryOnly === true) return 'memory_only'
  if (sources.forcedMemoryOnly === false) return 'full'
  const fromRegistry = toPersistedMode(sources.registryMode)
  if (fromRegistry !== undefined) return fromRegistry
  return sources.storedMode ?? 'full'
}
