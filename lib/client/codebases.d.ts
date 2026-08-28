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
/** The full codebase manager panel. */
export declare function CodebaseManager(): ReactNode;
//# sourceMappingURL=codebases.d.ts.map