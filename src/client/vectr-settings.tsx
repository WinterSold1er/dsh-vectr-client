/**
 * Top-level **Settings → Vectr** section shell.
 *
 * 阶段2: the codebase manager is merged INTO the workspace console, so there is
 * no longer a separate Codebases tab. This shell is now a thin single-panel host
 * that injects the shared stylesheet and renders {@link WorkspaceConsole} (which
 * owns both the workspace table and the per-workspace codebase sub-tables).
 *
 * @module dsh-vectr-client/client/vectr-settings
 */

import { VectrStyles } from './buttons'
import { WorkspaceConsole } from './index'

/** Tab-bar + active-panel host for the Vectr settings section. */
export function VectrSettings() {
  return (
    <div>
      <VectrStyles />
      <WorkspaceConsole />
    </div>
  )
}
