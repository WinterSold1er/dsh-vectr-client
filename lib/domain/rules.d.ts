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
//# sourceMappingURL=rules.d.ts.map