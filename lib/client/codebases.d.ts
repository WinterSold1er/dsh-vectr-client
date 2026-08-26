/**
 * Browser half of the multi-codebase manager (feature B).
 *
 * Mounted into the same Settings → Plugins tab as the workspace console. It
 * fetches the host's `/api/vectr/codebases` endpoints and renders a create
 * form plus a table with per-row test / delete actions. Secrets (passwords)
 * are submitted on create but never read back or shown.
 *
 * @module dsh-vectr-client/client/codebases
 */
/** Minimal structural view of the Cordis client context this half needs. */
interface ClientContext {
    slots: {
        inject(name: string, factory: () => {
            name: string;
            id?: string;
            order?: number;
            label?: () => string;
            locale?: string;
            inject?: () => unknown;
            children?: Record<string, unknown>;
        }, component: unknown): () => void;
    };
    effect(disposer: () => void, name?: string): void;
}
/** Services required by the client half (informational; host resolves them). */
export declare const inject: string[];
/** Mount the codebase manager into the Settings → Plugins tab (alongside the workspace console). */
export declare function apply(ctx: ClientContext): void;
export {};
//# sourceMappingURL=codebases.d.ts.map