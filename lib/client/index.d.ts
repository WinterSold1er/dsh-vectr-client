/**
 * Browser half of the vectr workspace console (feature A / C1).
 *
 * A thin React view mounted as the top-level **Settings → Vectr** section via the
 * `settings.section` slot (hosted by the VectrSettings shell, which also renders the
 * codebase manager under a tab bar). All data lives on the host: this half only
 * fetches the same-origin relative endpoints the host registered
 * (`/api/vectr/workspaces`, `/api/vectr/trigger-index`) and renders the table
 * plus a per-row "re-index" action and a global "refresh".
 *
 * The host serves this bundle from `lib/client.js` (the `dsh.client` dual-face
 * declaration), so bare imports of `react` and the slot service resolve through
 * the host's module table at runtime. Only `react` is imported as a value; the
 * Cordis client context is typed structurally so the host build needs no extra
 * type packages.
 *
 * @module dsh-vectr-client/client
 */
import { type ReactNode } from 'react';
/** Minimal structural view of the Cordis client context this half needs. */
interface ClientContext {
    slots: {
        inject(key: string, callback: () => unknown): () => void;
        register(options: {
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
/** The full console panel. */
export declare function WorkspaceConsole(): ReactNode;
/** Services required by the client half (informational; host resolves them). */
export declare const inject: string[];
/** Mount the Vectr shell as a top-level **Settings → Vectr** section. The shell
 * owns the Workspaces/Codebases tab bar and renders {@link WorkspaceConsole} and
 * the codebase manager; neither panel self-registers anymore. `slots.inject`
 * runs its callback as a Cordis effect, so the callback returns the disposer
 * `slots.register` yields (not a plain descriptor) or the loader rejects it. */
export declare function apply(ctx: ClientContext): void;
export {};
//# sourceMappingURL=index.d.ts.map