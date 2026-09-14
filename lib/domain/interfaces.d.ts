/**
 * Abstract interfaces (ports) for Vectr client.
 *
 * Defines boundaries between domain logic and infrastructure implementations
 * (Layer 1: Domain Core). Enables complete testability via mock implementations.
 *
 * @module dsh-vectr-client/domain/interfaces
 */
import type { CodebaseEntry, InitResult, InstanceEntry, RecallOptions, ResumeResponse, SessionVectrState, TriggerResult, UpgradeResult, VectrInitOptions, VectrStatus } from './types';
/**
 * Runner interface for Vectr CLI commands (e.g. vectr init, vectr restart).
 */
export interface IVectrCliRunner {
    /**
     * Run `vectr init` on a workspace directory.
     * @param options - initialization options (workspace, hooks, memoryOnly, style).
     */
    init(options: VectrInitOptions): Promise<InitResult>;
    /**
     * Run `vectr restart` on a workspace directory.
     * @param workspace - workspace path.
     * @param options - restart options (e.g. full: true).
     */
    restart(workspace: string, options?: {
        full?: boolean;
    }): Promise<InitResult>;
}
/**
 * Client interface for communicating with a running Vectr HTTP daemon.
 */
export interface IVectrApiClient {
    /**
     * Probe daemon `/v1/status`.
     */
    getStatus(host: string, port: number, timeoutMs: number): Promise<VectrStatus | undefined>;
    /**
     * Trigger a re-index via daemon `POST /v1/index`.
     */
    triggerIndex(host: string, port: number, timeoutMs: number): Promise<TriggerResult>;
    /**
     * Recall working memory notes via daemon `POST /v1/recall`.
     */
    recall(host: string, port: number, options: RecallOptions, timeoutMs: number): Promise<{
        ok: boolean;
        notes?: string | undefined;
        error?: string | undefined;
        processing_ms?: number | undefined;
    }>;
    /**
     * Get resume state summary via daemon `GET /v1/resume`.
     */
    resume(host: string, port: number, timeoutMs: number): Promise<{
        ok: boolean;
        data?: ResumeResponse | undefined;
        error?: string | undefined;
    }>;
}
/**
 * Resolver for discovering Vectr daemon instances.
 */
export interface IInstanceResolver {
    /**
     * Find the instance associated with a workspace directory.
     */
    resolveForWorkspace(workspace: string): Promise<InstanceEntry | undefined>;
    /**
     * Return all known instances indexed by key.
     */
    getAll(): Promise<Record<string, InstanceEntry>>;
}
/**
 * Service for querying and managing codebase metadata.
 */
export interface ICodebaseService {
    /**
     * List all codebases mounted in a specific workspace.
     */
    listForWorkspace(workspace: string): Promise<CodebaseEntry[]>;
}
/**
 * Application service for aggregating session state and executing session-scoped actions.
 */
export interface ISessionStatusService {
    /**
     * Aggregate full Vectr status and codebases for an active session's workspace.
     */
    getSessionStatus(workspace: string): Promise<SessionVectrState>;
    /**
     * Trigger a re-index for the daemon registered to this workspace.
     */
    triggerIndex(workspace: string): Promise<TriggerResult>;
    /**
     * Run vectr init for a workspace.
     */
    initWorkspace(options: VectrInitOptions): Promise<InitResult>;
    /**
     * Upgrade a memory-only workspace to full mode (indexing + memory).
     */
    upgradeWorkspace(workspace: string): Promise<UpgradeResult>;
    /**
     * Recall working memory notes for a workspace or port.
     */
    recallNotes(target: {
        workspace?: string | undefined;
        port?: number | undefined;
    }, options: RecallOptions): Promise<{
        ok: boolean;
        notes?: string | undefined;
        error?: string | undefined;
        processing_ms?: number | undefined;
    }>;
    /**
     * Retrieve resume status for a workspace or port.
     */
    getResume(target: {
        workspace?: string | undefined;
        port?: number | undefined;
    }): Promise<{
        ok: boolean;
        data?: ResumeResponse | undefined;
        error?: string | undefined;
    }>;
}
//# sourceMappingURL=interfaces.d.ts.map