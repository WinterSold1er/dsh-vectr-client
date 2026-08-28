/**
 * Browser half of the vectr workspace console (feature A / C1) — **阶段2**: the
 * multi-codebase manager is merged INTO this panel (no separate Codebases tab).
 *
 * A thin React view mounted as the top-level **Settings → Vectr** section via the
 * `settings.section` slot (hosted by the VectrSettings shell). All data lives on
 * the host: this half only fetches the same-origin relative endpoints the host
 * registered (`/api/vectr/workspaces`, `/api/vectr/codebases`,
 * `/api/vectr/trigger-index`) and renders:
 *
 *  - the workspace table (13 cols, unchanged from feature A),
 *  - a per-row chevron that expands a **codebase sub-table** (5 cols: name /
 *    type / target / status / actions) listing the codebases whose
 *    `workspace` equals this row's workspace,
 *  - an **Unassigned** pseudo-section for codebases with
 *    `workspace === '__unassigned__'` (plus an inline assign action),
 *  - a create form inside every expanded section, pre-bound to that section's
 *    workspace (the 阶段2 "form reports workspace" requirement).
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
/** The full merged console panel (workspaces + their codebases). */
export declare function WorkspaceConsole(): ReactNode;
/** Services required by the client half (informational; host resolves them). */
export declare const inject: string[];
/** Mount the Vectr shell as a top-level **Settings → Vectr** section. The shell
 * owns the single merged panel (workspaces + their codebases). `slots.inject`
 * runs its callback as a Cordis effect, so the callback returns the disposer
 * `slots.register` yields (not a plain descriptor) or the loader rejects it. */
export declare function apply(ctx: ClientContext): void;
export {};
//# sourceMappingURL=index.d.ts.map