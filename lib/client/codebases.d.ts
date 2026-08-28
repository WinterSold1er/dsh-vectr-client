/**
 * Browser half of the multi-codebase manager (feature B).
 *
 * Rendered inside the top-level **Settings → Vectr** section (alongside the
 * workspace console) under a tab bar; this component only fetches and renders
 * its own data. It fetches the host's `/api/vectr/codebases` endpoints and renders a create
 * form plus a table with per-row test / delete actions. Secrets (passwords)
 * are submitted on create but never read back or shown.
 *
 * @module dsh-vectr-client/client/codebases
 */
import { type ReactNode } from 'react';
/** Mirrors the host {@link CodebaseEntry} shape (src/codebases.ts). */
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
}
/** One table row with test / delete actions. Exported for layout-regression tests. */
export declare function CodebaseRow(props: {
    view: CodebaseView;
    onTest: (slug: string) => void;
    onDelete: (slug: string) => void;
    busy: boolean;
}): ReactNode;
/** The full codebase manager panel. */
export declare function CodebaseManager(): ReactNode;
export {};
//# sourceMappingURL=codebases.d.ts.map