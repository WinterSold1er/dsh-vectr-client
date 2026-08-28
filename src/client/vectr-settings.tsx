/**
 * Top-level **Settings → Vectr** section shell (改动1).
 *
 * Replaces the old `settings.plugins.tab` injection that mounted the workspace
 * console and the codebase manager as two separate Plugins-tab panels. Now a
 * single top-level `settings.section` (id `vectr`) hosts both panels behind a
 * tab bar: `Workspaces` and `Codebases`. Each panel keeps fetching its own data
 * from the host; this shell only owns which tab is active.
 *
 * Both panels stay MOUNTED at all times; the inactive one is hidden with
 * `display:none` (review B1). This preserves each panel's local form/fetch
 * state across tab switches and avoids re-fetching + unmounted-setState warnings.
 *
 * @module dsh-vectr-client/client/vectr-settings
 */

import { useState, type CSSProperties, type ReactNode } from 'react'
import { WorkspaceConsole } from './index'
import { CodebaseManager } from './codebases'
import { VectrStyles } from './buttons'

type Tab = 'workspaces' | 'codebases'

/** Selected color tracks the host business-primary token (deepseek-500), so it
 * follows light/dark automatically instead of a hardcoded `#2b6cb0`. */
const ACTIVE_COLOR = 'var(--dsw-alias-state-business-primary)'
const INACTIVE_COLOR = 'var(--dsw-alias-label-secondary)'

const tabButtonStyle = (active: boolean): CSSProperties => ({
  padding: '4px 10px',
  marginRight: 4,
  cursor: 'pointer',
  border: 'none',
  borderBottom: active ? `2px solid ${ACTIVE_COLOR}` : '2px solid transparent',
  background: 'none',
  color: active ? ACTIVE_COLOR : INACTIVE_COLOR,
  fontWeight: active ? 600 : 400,
  font: 'inherit',
})

/** Tab-bar + active-panel host for the Vectr settings section. */
export function VectrSettings(): ReactNode {
  const [tab, setTab] = useState<Tab>('workspaces')
  return (
    <div>
      <VectrStyles />
      <div style={{ display: 'flex', marginBottom: 10 }}>
        <button
          type="button"
          style={tabButtonStyle(tab === 'workspaces')}
          onClick={() => setTab('workspaces')}
        >
          Workspaces
        </button>
        <button
          type="button"
          style={tabButtonStyle(tab === 'codebases')}
          onClick={() => setTab('codebases')}
        >
          Codebases
        </button>
      </div>
      {/* Both panels mounted; toggled via display so state survives tab switches. */}
      <div style={{ display: tab === 'workspaces' ? 'block' : 'none' }}>
        <WorkspaceConsole />
      </div>
      <div style={{ display: tab === 'codebases' ? 'block' : 'none' }}>
        <CodebaseManager />
      </div>
    </div>
  )
}
