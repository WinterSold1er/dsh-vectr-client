/**
 * Domain rules and invariants for Vectr client.
 *
 * Implements pure validation logic, mode guards, and re-indexing capability checks
 * without side-effects or network calls (Layer 1: Domain Core).
 *
 * @module dsh-vectr-client/domain/rules
 */

import { isAbsolute } from 'node:path'
import type { VectrMode, VectrStatus } from './types'

/**
 * Validation pattern for codebase slugs: alphanumeric, underscores, hyphens, 1-32 chars.
 */
export const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Validate a codebase slug.
 * @param slug - input slug string.
 * @returns validation result with error message if invalid.
 */
export function validateSlug(slug: string): { valid: boolean; error?: string } {
  if (!slug || typeof slug !== 'string') {
    return { valid: false, error: 'Slug must be a non-empty string' }
  }
  if (!SLUG_PATTERN.test(slug)) {
    return {
      valid: false,
      error: `Invalid slug "${slug}": must match ${String(SLUG_PATTERN)} (1-32 alphanumeric, underscores, or hyphens)`,
    }
  }
  return { valid: true }
}

/**
 * Validate a target workspace directory.
 * @param workspace - workspace directory path.
 * @returns validation result with error message if invalid.
 */
export function validateWorkspace(workspace: string): { valid: boolean; error?: string } {
  if (!workspace || typeof workspace !== 'string' || workspace.trim().length === 0) {
    return { valid: false, error: 'Workspace path must be a non-empty string' }
  }
  if (workspace.includes('\0')) {
    return { valid: false, error: 'Workspace path must not contain null bytes' }
  }
  if (workspace === '__unassigned__') {
    return { valid: false, error: 'Workspace cannot be the unassigned sentinel' }
  }
  const isAbs = isAbsolute(workspace) || /^[a-zA-Z]:[\\/]/.test(workspace)
  if (!isAbs) {
    return { valid: false, error: 'Workspace path must be an absolute path' }
  }
  return { valid: true }
}

/**
 * Test whether a mode string indicates memory_only mode.
 */
export function isMemoryOnly(mode?: string): boolean {
  return mode === 'memory_only'
}

/**
 * Test whether a mode string indicates search_only mode.
 */
export function isSearchOnly(mode?: string): boolean {
  return mode === 'search_only'
}

/**
 * Determine whether a daemon instance can be re-indexed.
 *
 * Invariant: memory_only and search_only modes MUST NOT trigger indexing requests.
 * Offline daemons and busy daemons are also rejected before hitting the network.
 */
export function canReindex(
  live: boolean,
  mode?: string,
  status?: VectrStatus,
): { canReindex: boolean; reason?: string } {
  if (!live) {
    return { canReindex: false, reason: 'Daemon offline' }
  }
  if (mode === 'memory_only') {
    return {
      canReindex: false,
      reason: "Daemon in 'memory_only' mode cannot be re-indexed (no persistent index store)",
    }
  }
  if (mode === 'search_only') {
    return {
      canReindex: false,
      reason: "Daemon in 'search_only' mode cannot be re-indexed (no persistent index store)",
    }
  }
  if (status?.reindex_in_progress === true) {
    return { canReindex: false, reason: 'Re-index already in progress' }
  }
  if (status?.fully_ready === false) {
    return { canReindex: false, reason: 'Daemon not fully_ready (initial index still settling)' }
  }
  return { canReindex: true }
}

/**
 * Normalize raw mode string and liveness state into typed VectrMode.
 */
export function formatMode(mode?: string, live?: boolean): VectrMode {
  if (live === false) return 'offline'
  if (!mode) return 'unknown'
  if (mode === 'full' || mode === 'memory_only' || mode === 'search_only' || mode === 'lite') {
    return mode
  }
  return 'unknown'
}
