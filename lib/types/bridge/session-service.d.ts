/**
 * Application service for session-scoped Vectr status and operations.
 *
 * Implements {@link ISessionStatusService} (Layer 3: Host RPC Bridge).
 * Coordinates domain policies, instance discovery, codebase querying,
 * daemon HTTP calls, and CLI execution.
 *
 * @module dsh-vectr-client/bridge/session-service
 */
import { type ICodebaseService, type IInstanceResolver, type InitResult, type ISessionStatusService, type IVectrApiClient, type IVectrCliRunner, type RecallOptions, type ResumeResponse, type SessionVectrState, type TriggerResult, type UpgradeResult, type VectrInitOptions } from '../domain';
export interface SessionServiceOptions {
    instanceResolver: IInstanceResolver;
    apiClient: IVectrApiClient;
    codebaseService: ICodebaseService;
    cliRunner: IVectrCliRunner;
    statusTimeoutMs?: number;
    recallTimeoutMs?: number;
    upgradeTimeoutMs?: number;
    defaultHost?: string;
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
    private readonly inFlightUpgrades;
    constructor(options: SessionServiceOptions);
    private buildCodebases;
    getSessionStatus(workspace: string): Promise<SessionVectrState>;
    triggerIndex(workspace: string): Promise<TriggerResult>;
    initWorkspace(options: VectrInitOptions): Promise<InitResult>;
    upgradeWorkspace(workspace: string): Promise<UpgradeResult>;
    private doUpgradeWorkspace;
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