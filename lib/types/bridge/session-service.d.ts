/**
 * Application service for session-scoped Vectr status and operations.
 *
 * Implements {@link ISessionStatusService} (Layer 3: Host RPC Bridge).
 * Coordinates domain policies, instance discovery, codebase querying,
 * daemon HTTP calls, and CLI execution.
 *
 * @module dsh-vectr-client/bridge/session-service
 */
import { type ICodebaseService, type IInstanceResolver, type InitResult, type ISessionStatusService, type IVectrApiClient, type IVectrCliRunner, type RecallOptions, type ResumeResponse, type SessionVectrState, type StartResult, type TriggerResult, type UpgradeResult, type VectrInitOptions, type VectrStartOptions } from '../domain';
export interface SessionServiceOptions {
    instanceResolver: IInstanceResolver;
    apiClient: IVectrApiClient;
    codebaseService: ICodebaseService;
    cliRunner: IVectrCliRunner;
    statusTimeoutMs?: number;
    recallTimeoutMs?: number;
    upgradeTimeoutMs?: number;
    defaultHost?: string;
    /**
     * Plugin-side mode store (`~/.dsh/vectr-modes.json`). When provided, a verified
     * upgrade/downgrade records the mode the daemon was *confirmed* to be in, so a
     * later `vectr start` (after the registry record is pruned) can replay the same
     * mode flag instead of silently falling back to a full re-index.
     * Omitted (tests, embedded callers) means "never write": no hidden global state.
     */
    modesPath?: string;
    /**
     * Sink for non-fatal diagnostics from the mode store (production: `ctx.logger`).
     * A persistence failure is not an error of the daemon operation — the daemon
     * already IS in the requested mode — but it must never be silent: the workspace
     * comes back in a different mode after the next prune. Omitted, the warning goes
     * to `console.warn`, because "no logger wired" is not a reason to say nothing.
     */
    warn?: (message: string) => void;
}
export declare class SessionVectrService implements ISessionStatusService {
    private readonly instanceResolver;
    private readonly apiClient;
    private readonly codebaseService;
    private readonly cliRunner;
    private readonly statusTimeoutMs;
    private readonly recallTimeoutMs;
    private readonly upgradeTimeoutMs;
    private readonly defaultHost;
    private readonly modesPath;
    private readonly modeStoreWarn;
    private readonly inFlightUpgrades;
    constructor(options: SessionServiceOptions);
    /**
     * Persist a mode that was *verified* against the live daemon. Never called on a
     * failure path, so a failed upgrade/downgrade cannot corrupt what the plugin
     * remembers. Persistence is a startup hint, so a write failure is not an error of
     * the operation itself (the daemon already IS in the requested mode) and is not
     * returned to the caller — but it is never silent either: a store that could not
     * be written means the NEXT restart may bring this workspace up in a different
     * mode, which is exactly the incident this whole layer exists to prevent.
     */
    private persistVerifiedMode;
    private buildCodebases;
    getSessionStatus(workspace: string): Promise<SessionVectrState>;
    triggerIndex(workspace: string): Promise<TriggerResult>;
    initWorkspace(options: VectrInitOptions): Promise<InitResult>;
    startWorkspace(options: VectrStartOptions): Promise<StartResult>;
    upgradeWorkspace(workspace: string): Promise<UpgradeResult>;
    private doUpgradeWorkspace;
    downgradeWorkspace(workspace: string): Promise<UpgradeResult>;
    private doDowngradeWorkspace;
    recallNotes(target: {
        workspace?: string | undefined;
        port?: number | undefined;
    }, options: RecallOptions): Promise<{
        ok: boolean;
        notes?: string | undefined;
        error?: string | undefined;
        processing_ms?: number | undefined;
    }>;
    getResume(target: {
        workspace?: string | undefined;
        port?: number | undefined;
    }): Promise<{
        ok: boolean;
        data?: ResumeResponse | undefined;
        error?: string | undefined;
    }>;
}
//# sourceMappingURL=session-service.d.ts.map