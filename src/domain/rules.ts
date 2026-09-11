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
  return mode === 'memory_only' || mode === 'memory-only'
}

/**
 * Test whether a given sessionId represents an active, valid session.
 * Absent values, undefined, null, empty strings, whitespace-only strings,
 * string literals 'null'/'undefined', and non-finite numbers (NaN, Infinity)
 * represent an inactive, blank, or invalid session.
 *
 * (Layer 1: Domain Core - Single Source of Truth for Session Activation)
 */
export function hasActiveSession(sessionId?: unknown): boolean {
  if (sessionId === null || sessionId === undefined) {
    return false
  }
  if (typeof sessionId === 'string') {
    const trimmed = sessionId.trim()
    const lower = trimmed.toLowerCase()
    if (trimmed.length === 0 || lower === 'null' || lower === 'undefined') {
      return false
    }
    return true
  }
  if (typeof sessionId === 'number') {
    return Number.isFinite(sessionId)
  }
  return false
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
  if (mode === 'memory_only' || mode === 'memory-only') {
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
  if (mode === 'memory-only' || mode === 'memory_only') {
    return 'memory_only'
  }
  if (mode === 'full' || mode === 'search_only' || mode === 'lite') {
    return mode
  }
  return 'unknown'
}

/**
 * Normalized unified status representation.
 */
export interface UnifiedStatus {
  kind: 'ready' | 'initializing' | 'indexing' | 'memory_only' | 'search_only' | 'offline' | 'unknown'
  label: string
  isBusy?: boolean
  description?: string
}

export interface ResolveUnifiedStatusInput {
  live?: boolean | undefined
  mode?: string | undefined
  status?: VectrStatus | null | undefined
  reason?: string | undefined
  error?: string | undefined
}

/**
 * Resolve unified lifecycle and operational status across settings and modals.
 */
export function resolveUnifiedStatus(input?: ResolveUnifiedStatusInput): UnifiedStatus {
  if (input?.error) {
    return {
      kind: 'offline',
      label: 'Error',
      isBusy: false,
      description: input.error,
    }
  }

  if (!input || input.live !== true) {
    return {
      kind: 'offline',
      label: input?.live === undefined ? 'Unknown' : 'Offline',
      isBusy: false,
      description: input?.reason ?? (input?.live === undefined ? 'Daemon status unknown' : 'Daemon offline or unreachable'),
    }
  }

  if (!input.status) {
    return {
      kind: 'initializing',
      label: 'Initializing',
      isBusy: true,
      description: input.reason ?? 'Starting daemon or waiting for status',
    }
  }

  const normalizedMode = formatMode(input.mode, input.live)
  if (normalizedMode === 'memory_only') {
    return {
      kind: 'memory_only',
      label: 'Memory Only',
      isBusy: false,
      description: 'Running in working memory mode without persistent index',
    }
  }

  if (input.status?.reindex_in_progress === true) {
    return {
      kind: 'indexing',
      label: 'Indexing',
      isBusy: true,
      description: 'Re-indexing codebase files and embedding vectors',
    }
  }

  if (input.status?.fully_ready === false) {
    return {
      kind: 'initializing',
      label: 'Initializing',
      isBusy: true,
      description: 'Daemon starting or warming up initial index',
    }
  }

  if (normalizedMode === 'search_only') {
    return {
      kind: 'search_only',
      label: 'Search Only',
      isBusy: false,
      description: 'Semantic search active without working memory',
    }
  }

  if (normalizedMode === 'full' || normalizedMode === 'lite') {
    return {
      kind: 'ready',
      label: 'Ready',
      isBusy: false,
      description: 'Daemon fully ready and synchronized',
    }
  }

  return {
    kind: 'unknown',
    label: 'Unknown',
    isBusy: false,
    description: 'Unknown daemon status',
  }
}
