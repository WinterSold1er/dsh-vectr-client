/**
 * Domain rules and invariants for Vectr client.
 *
 * Implements pure validation logic, mode guards, and re-indexing capability checks
 * without side-effects or network calls (Layer 1: Domain Core).
 *
 * @module dsh-vectr-client/domain/rules
 */
import type { VectrMode, VectrStatus } from './types';
/**
 * Validation pattern for codebase slugs: alphanumeric, underscores, hyphens, 1-32 chars.
 */
export declare const SLUG_PATTERN: RegExp;
/**
 * Validate a codebase slug.
 * @param slug - input slug string.
 * @returns validation result with error message if invalid.
 */
export declare function validateSlug(slug: string): {
    valid: boolean;
    error?: string;
};
/**
 * Validate a target workspace directory.
 * @param workspace - workspace directory path.
 * @returns validation result with error message if invalid.
 */
export declare function validateWorkspace(workspace: string): {
    valid: boolean;
    error?: string;
};
/**
 * Test whether a mode string indicates memory_only mode.
 */
export declare function isMemoryOnly(mode?: string): boolean;
/**
 * Test whether a given sessionId represents an active, valid session.
 * Absent values, undefined, null, empty strings, whitespace-only strings,
 * string literals 'null'/'undefined', and non-finite numbers (NaN, Infinity)
 * represent an inactive, blank, or invalid session.
 *
 * (Layer 1: Domain Core - Single Source of Truth for Session Activation)
 */
export declare function hasActiveSession(sessionId?: unknown): boolean;
/**
 * Test whether a mode string indicates search_only mode.
 */
export declare function isSearchOnly(mode?: string): boolean;
/**
 * Determine whether a daemon instance can be re-indexed.
 *
 * Invariant: memory_only and search_only modes MUST NOT trigger indexing requests.
 * Offline daemons and busy daemons are also rejected before hitting the network.
 */
export declare function canReindex(live: boolean, mode?: string, status?: VectrStatus): {
    canReindex: boolean;
    reason?: string;
};
/**
 * Normalize raw mode string and liveness state into typed VectrMode.
 */
export declare function formatMode(mode?: string, live?: boolean): VectrMode;
/**
 * Normalized unified status representation.
 */
export interface UnifiedStatus {
    kind: 'ready' | 'initializing' | 'indexing' | 'memory_only' | 'search_only' | 'offline' | 'unknown';
    label: string;
    isBusy?: boolean;
    description?: string;
}
export interface ResolveUnifiedStatusInput {
    live?: boolean | undefined;
    mode?: string | undefined;
    status?: VectrStatus | null | undefined;
    reason?: string | undefined;
    error?: string | undefined;
}
/**
 * Resolve unified lifecycle and operational status across settings and modals.
 */
export declare function resolveUnifiedStatus(input?: ResolveUnifiedStatusInput): UnifiedStatus;
//# sourceMappingURL=rules.d.ts.map