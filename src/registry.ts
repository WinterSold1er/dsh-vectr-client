/**
 * Registry layer for the vectr-client plugin (leaf module).
 *
 * Owns the on-disk `instances.json` shape and the cwd→daemon-record resolution.
 * Intentionally free of Cordis, config parsing, and HTTP probing so it can be
 * unit-tested against a temp file with no live daemon and no plugin context.
 *
 * @module dsh-vectr-client/registry
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { InstanceEntry, InstancesFile } from './domain/types'

export type { InstanceEntry, InstancesFile }

/** Minimal logger surface {@link readInstancesFile} touches (no Cordis dep). */
interface LoggerLike {
  info(message: string): void
  warn(message: string): void
}

/** Logger-bearing context accepted by {@link readInstancesFile}. */
export interface LoggerCtx {
  logger: LoggerLike
}

/** Default bind host used only when an `InstanceEntry.host` is absent. */
export const DEFAULT_HOST = '127.0.0.1'

/** Hex-char length of the sha256 workspace key prefix vectr stores per instance. */
export const WORKSPACE_KEY_LENGTH = 12

/** Default path of the vectr daemon registry, inside the user's home. */
export const DEFAULT_INSTANCES_FILE = join(homedir(), '.vectr', 'instances.json')

/**
 * Resolve the vectr daemon record for one workspace, following the same
 * registry conventions vectr writes: exact sha256(cwd)[:12] key first, then a
 * prefix match (cwd inside a listed workspace directory), then a
 * trailing-slash-tolerant string match on the stored workspace path.
 * @param instances - parsed `instances.json` records.
 * @param cwd - absolute workspace directory of the agent.
 * @returns the matching daemon record, or `undefined` when no entry applies.
 */
export function resolveInstance(instances: InstancesFile, cwd: string): InstanceEntry | undefined {
  const key = createHash('sha256').update(cwd).digest('hex').slice(0, WORKSPACE_KEY_LENGTH)
  const exact = instances[key]
  if (exact !== undefined) return exact
  const normalizedCwd = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
  const candidates = Object.values(instances)

  // Exact string match on stored workspace path has priority over prefix matches
  const exactWorkspace = candidates.find(entry => {
    const stored = entry.workspace.endsWith('/') ? entry.workspace.slice(0, -1) : entry.workspace
    return stored === normalizedCwd
  })
  if (exactWorkspace !== undefined) return exactWorkspace

  // Longest-prefix match for nested subdirectories inside a registered project.
  // Exclude user homedir from prefix matching: a daemon for ~/ (typically memory-only)
  // must never hijack separate projects under ~/Code, ~/Work, etc.
  const home = homedir()
  const normalizedHome = home.endsWith('/') ? home.slice(0, -1) : home
  const sortedPrefixCandidates = candidates
    .map(entry => ({
      entry,
      stored: entry.workspace.endsWith('/') ? entry.workspace.slice(0, -1) : entry.workspace,
    }))
    .filter(({ stored }) => stored.length > 0 && stored !== normalizedHome)
    .sort((a, b) => b.stored.length - a.stored.length)

  const prefixMatch = sortedPrefixCandidates.find(({ stored }) =>
    normalizedCwd.startsWith(`${stored}/`),
  )
  if (prefixMatch !== undefined) return prefixMatch.entry

  return undefined
}

/**
 * EXACT-match instance lookup: the sha256(workspace)[:12] key first, then a
 * trailing-slash-tolerant EQUALITY match on the stored workspace path.
 *
 * Deliberately not {@link resolveInstance}: that one also accepts a cwd nested
 * inside a recorded workspace (prefix match), which is right for binding an
 * agent but catastrophic for port reconciliation — a codebase with no record of
 * its own would be silently rewritten to the enclosing `/home/csy` daemon's port
 * and then bind to the wrong workspace's index.
 *
 * @param instances - parsed `instances.json` records.
 * @param workspace - absolute workspace path to match exactly.
 * @returns the exactly matching daemon record, or `undefined`.
 */
export function resolveInstanceExact(
  instances: InstancesFile,
  workspace: string,
): InstanceEntry | undefined {
  const key = createHash('sha256').update(workspace).digest('hex').slice(0, WORKSPACE_KEY_LENGTH)
  const exact = instances[key]
  if (exact !== undefined) return exact
  const normalized = workspace.endsWith('/') ? workspace.slice(0, -1) : workspace
  return Object.values(instances).find(entry => {
    const stored = entry.workspace.endsWith('/') ? entry.workspace.slice(0, -1) : entry.workspace
    return stored === normalized
  })
}

/**
 * Read and parse the vectr daemon registry file. A missing file means "no
 * vectr daemons"; a present-but-unparseable file is a misconfiguration and
 * fails loud (the caller decides whether to skip or throw).
 * @param ctx - context carrying the logger (registry read diagnostics).
 * @param instancesPath - absolute path of `instances.json`.
 * @returns the parsed records, or `undefined` when the file does not exist.
 */
export function readInstancesFile(ctx: LoggerCtx, instancesPath: string): InstancesFile | undefined {
  let text: string
  try {
    text = readFileSync(instancesPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      ctx.logger.info(`vectr-client: no daemon registry at ${instancesPath}, skipping`)
      return undefined
    }
    throw new Error(`vectr-client: failed to read ${instancesPath}: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`vectr-client: failed to parse ${instancesPath}: ${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`vectr-client: ${instancesPath} must be a JSON object mapping workspace keys to daemon records`)
  }
  return parsed as InstancesFile
}
