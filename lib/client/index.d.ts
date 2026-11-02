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
 *  - one **workspace card** per registered workspace: identity, state pills
 *    (liveness / canonical mode / readiness), the key index facts and the
 *    re-index control,
 *  - a card toggle that expands a **codebase sub-table** (5 cols: name / type /
 *    target / status / actions) listing the codebases whose `workspace` equals
 *    that card's workspace,
 *  - a create form inside every expanded card, pre-bound to that card's
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
import { type VectrLanguageEntry } from '../domain';
export { SessionHeaderAction, SessionsBoundHeaderAction } from './SessionHeaderAction';
export { SessionDrawerModal } from './SessionDrawerModal';
export { CodebaseModal } from './CodebaseModal';
export { MemoryViewer } from './MemoryViewer';
export { VectrNavIcon } from './VectrNavIcon';
export { ConversationInputRightAction, SessionsBoundInputRightAction, SessionBoundInputRightAction, } from './ConversationInputRightAction';
export { VectrDialogRoot } from './VectrDialogRoot';
export { dialogCoordinator, DialogCoordinator } from './dialogCoordinator';
/** One `status.languages` entry — the shared domain union ({@link VectrLanguageEntry}),
 * so the host mirror and this one cannot drift apart again. */
type LanguageEntry = VectrLanguageEntry;
/** Mirrors the host {@link WorkspaceView} shape (see src/workspaces.ts). */
interface WorkspaceView {
    workspace: string;
    /** Daemon port. Absent on a row that is known but not started (contract: no port). */
    port?: number;
    pid?: number;
    mode?: string;
    live: boolean;
    error?: string;
    /** Precise liveness-failure reason enum from the host; absent when live. */
    reason?: string;
    /** Human title from the DSH workspace registry (not-started rows carry it). */
    title?: string;
    status?: {
        indexed_files?: number;
        total_chunks?: number;
        /** Newer daemons send objects (`{language, files, chunks, symbols}`); older ones plain strings. */
        languages?: LanguageEntry[];
        last_indexed?: string | null;
        notes_count?: number;
        fully_ready?: boolean;
        reindex_in_progress?: boolean;
        embed_model?: string;
        [key: string]: unknown;
    };
}
/** Mirrors the host {@link CodebaseEntry} view (src/codebases.ts), secrets stripped. */
interface CodebaseView {
    id: string;
    slug: string;
    type: 'local' | 'remote';
    path: string;
    host?: string;
    serverName: string;
    localPort?: number;
    remotePort?: number;
    tunnelPid?: number;
    status: 'up' | 'down' | 'error';
    error?: string;
    /** Owning workspace (absolute); absent ⇒ not shown under any workspace card. */
    workspace?: string;
    /** Whether this is the primary codebase of the workspace. */
    isPrimary?: boolean;
}
/** Minimal structural view of the Cordis client context this half needs. */
interface ClientContext {
    slots: {
        inject(key: string, callback: () => unknown): () => void;
        register(options: {
            name: string;
            id?: string;
            order?: number;
            label?: () => string;
            icon?: unknown;
            locale?: string;
            inject?: () => unknown;
            children?: Record<string, unknown>;
        }, component: unknown): () => void;
    };
    effect(disposer: () => unknown, name?: string): void;
}
/** Summary-strip counts, derived from the already-fetched workspace list. Every
 * row lands in exactly one bucket, so live + memoryOnly + offline === total. */
export declare function summarizeWorkspaces(views: WorkspaceView[] | null): {
    total: number;
    live: number;
    memoryOnly: number;
    offline: number;
};
/** Fetch both management endpoints together. A failure keeps the real message
 * (`String(err)`, e.g. "Error: workspaces endpoint returned 500") so the panel
 * renders the actual error instead of silently showing nothing. */
export declare function loadConsoleData(): Promise<{
    wsViews: WorkspaceView[] | null;
    cbViews: CodebaseView[] | null;
    wsError: string | null;
    cbError: string | null;
}>;
/** Result of starting one workspace's daemon (frozen host contract):
 * success carries the port/pid the host reported, failure the real message. */
export type StartWorkspaceResult = {
    ok: true;
    port: number;
    pid?: number;
} | {
    ok: false;
    error: string;
};
/** POST `/api/vectr/daemons/start` for ONE workspace.
 *
 * Same error handling as the start-all launcher in `DaemonLauncher`: a non-2xx
 * body's `error` wins, otherwise the HTTP status is the message; a body that
 * claims `ok` but carries no port is a contract violation, not a success. */
export declare function startWorkspaceDaemon(workspace: string): Promise<StartWorkspaceResult>;
/** Props of the hook-free start control (same split as `DaemonLauncherView`:
 * the hook-free half is what the headless specs can render). */
export interface StartDaemonButtonViewProps {
    busy: boolean;
    error: string | null;
    onStart: () => void;
}
/** Presentational half: the Start button plus the inline error text. */
export declare function StartDaemonButtonView(props: StartDaemonButtonViewProps): ReactNode;
/** Starts one workspace's daemon; `onStarted` is the console re-fetch, so the
 * row flips from "not started" to live. Owns its own busy/error state. */
export declare function StartDaemonButton(props: {
    workspace: string;
    onStarted: () => void;
}): ReactNode;
/** One workspace as a card: identity + state pills + re-index on the header row,
 * the key index facts below it, and the codebase detail when expanded. */
export declare function WorkspaceCard(props: {
    view: WorkspaceView;
    entries: CodebaseView[];
    expanded: boolean;
    onToggle: () => void;
    onReindex: (port: number) => void;
    busyPort: boolean;
    onTest: (slug: string, workspace?: string) => void;
    onStart?: ((slug: string, workspace?: string) => void) | undefined;
    onDelete: (slug: string) => void;
    busySlug: string | null;
    onCreated: () => void;
}): ReactNode;
/** The full merged console panel (workspaces + their codebases). */
export declare function WorkspaceConsole(): ReactNode;
/** The console's whole visual tree, driven purely by props: no hooks, no fetch.
 * Splitting it out of {@link WorkspaceConsole} is what makes the page renderable
 * headlessly (`renderToStaticMarkup` never runs effects, so a component that
 * fetches its own data could only ever be asserted in its empty state). */
export declare function WorkspaceConsoleView(props: {
    wsViews: WorkspaceView[] | null;
    cbViews: CodebaseView[] | null;
    wsError: string | null;
    cbError: string | null;
    loading: boolean;
    flash: string | null;
    busyPort: number | null;
    busySlug: string | null;
    expanded: ReadonlySet<string>;
    onRefresh: () => void;
    onToggle: (key: string) => void;
    onReindex: (port: number) => void;
    onTest: (slug: string, workspace?: string) => void;
    onStart: (slug: string, workspace?: string) => void;
    onDelete: (slug: string) => void;
}): ReactNode;
/** Services required by the client half (informational; host resolves them). */
export declare const inject: string[];
/** Mount the Vectr shell as a top-level **Settings → Vectr** section. The shell
 * owns the single merged panel (workspaces + their codebases). `slots.inject`
 * runs its callback as a Cordis effect, so the callback returns the disposer
 * `slots.register` yields (not a plain descriptor) or the loader rejects it. */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map