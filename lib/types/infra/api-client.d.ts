/**
 * Infrastructure HTTP API client for Vectr daemon.
 *
 * Implements {@link IVectrApiClient} (Layer 2: Infrastructure).
 * Handles HTTP requests to `/v1/status`, `/v1/index`, `/v1/recall`, `/v1/resume`
 * with AbortController timeouts and structured error handling.
 *
 * @module dsh-vectr-client/infra/api-client
 */
import type { IVectrApiClient, RecallOptions, ResumeResponse, TriggerResult, VectrStatus } from '../domain';
export interface ApiClientOptions {
    /** Injected fetch implementation for unit testing. */
    fetchFn?: typeof fetch | undefined;
}
export declare class VectrApiClient implements IVectrApiClient {
    private readonly customFetch;
    constructor(options?: ApiClientOptions);
    private get doFetch();
    getStatus(host: string, port: number, timeoutMs: number): Promise<VectrStatus | undefined>;
    triggerIndex(host: string, port: number, timeoutMs: number): Promise<TriggerResult>;
    recall(host: string, port: number, options: RecallOptions, timeoutMs: number): Promise<{
        ok: boolean;
        notes?: string;
        error?: string;
        processing_ms?: number;
    }>;
    resume(host: string, port: number, timeoutMs: number): Promise<{
        ok: boolean;
        data?: ResumeResponse;
        error?: string;
    }>;
}
//# sourceMappingURL=api-client.d.ts.map