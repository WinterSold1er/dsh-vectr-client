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

import { useEffect, useState, type ReactNode } from 'react'
import { VectrSettings } from './vectr-settings'
import { scrollWrap, tableStyleWorkspaces, thStyle, tdStyle, ellipsisStyle } from './tableStyles'
import { BTN } from './buttons'

/** Mirrors the host {@link WorkspaceView} shape (see src/workspaces.ts). */
interface WorkspaceView {
  workspace: string
  port: number
  pid?: number
  mode?: string
  live: boolean
  error?: string
  /** Precise liveness-failure reason enum from the host (PROCESS_DEAD_ESRCH / PORT_CLOSED / HTTP_PROBE_TIMEOUT / HTTP_PROBE_UNREACHABLE); absent when live. */
  reason?: string
  status?: {
    indexed_files?: number
    total_chunks?: number
    languages?: string[]
    last_indexed?: string | null
    notes_count?: number
    fully_ready?: boolean
    reindex_in_progress?: boolean
    embed_model?: string
    [key: string]: unknown
  }
}

/** Minimal structural view of the Cordis client context this half needs. */
interface ClientContext {
  slots: {
    inject(key: string, callback: () => unknown): () => void
    register(options: { name: string; id?: string; order?: number; label?: () => string; locale?: string; inject?: () => unknown; children?: Record<string, unknown> }, component: unknown): () => void
  }
  effect(disposer: () => void, name?: string): void
}

/** Reason a row's re-index button is disabled, or undefined when enabled. */
function reindexDisabledReason(view: WorkspaceView): string | undefined {
  if (!view.live) return view.error ?? 'daemon offline'
  const mode = view.mode
  if (mode === 'memory_only' || mode === 'search_only') return `daemon in '${mode}' mode cannot be re-indexed`
  if (view.status?.reindex_in_progress) return 're-index already in progress'
  if (view.status?.fully_ready === false) return 'daemon not fully_ready yet'
  return undefined
}

/** One table row. */
function WorkspaceRow(props: {
  view: WorkspaceView
  onReindex: (port: number) => void
  busy: boolean
}): ReactNode {
  const { view, onReindex, busy } = props
  const disabledReason = reindexDisabledReason(view)
  const disabled = disabledReason !== undefined || busy
  const s = view.status
  return (
    <tr>
      <td style={tdStyle} title={view.workspace}><span style={ellipsisStyle}>{view.workspace.split('/').slice(-2).join('/')}</span></td>
      <td style={tdStyle}>{view.live
        ? <span style={{ color: 'var(--dsw-alias-state-success-primary)' }}>online</span>
        : <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>offline</span>}</td>
      <td style={tdStyle} title={view.error ?? ''}><span style={ellipsisStyle}>{view.reason ?? view.error ?? '—'}</span></td>
      <td style={tdStyle}>{view.port}</td>
      <td style={tdStyle}>{view.pid ?? '—'}</td>
      <td style={tdStyle}>{view.mode ?? '—'}</td>
      <td style={tdStyle}>{s?.indexed_files ?? '—'}</td>
      <td style={tdStyle}>{s?.total_chunks ?? '—'}</td>
      <td style={tdStyle}><span style={ellipsisStyle}>{s?.languages?.join(', ') ?? '—'}</span></td>
      <td style={tdStyle}><span style={ellipsisStyle}>{s?.last_indexed ?? '—'}</span></td>
      <td style={tdStyle}>{s?.notes_count ?? '—'}</td>
      <td style={tdStyle}>{(s?.fully_ready ?? false) ? 'yes' : 'no'}</td>
      <td style={tdStyle}>
        <button
          type="button"
          className={BTN.action}
          disabled={disabled}
          title={disabledReason ?? 'Re-index this workspace'}
          onClick={() => onReindex(view.port)}
        >
          {busy ? '…' : 're-index'}
        </button>
      </td>
    </tr>
  )
}

/** The full console panel. */
export function WorkspaceConsole(): ReactNode {
  const [views, setViews] = useState<WorkspaceView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyPort, setBusyPort] = useState<number | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  const refresh = (): void => {
    setLoading(true)
    setError(null)
    fetch('/api/vectr/workspaces')
      .then((res) => {
        if (!res.ok) throw new Error(`workspaces endpoint returned ${res.status}`)
        return res.json() as Promise<WorkspaceView[]>
      })
      .then((data) => setViews(data))
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [])

  const reindex = (port: number): void => {
    setBusyPort(port)
    setFlash(null)
    fetch('/api/vectr/trigger-index', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    })
      .then((res) => res.json() as Promise<{ ok: boolean; error?: string }>)
      .then((result) => {
        if (result.ok) setFlash(`re-index triggered for port ${port}`)
        else setFlash(`re-index failed: ${result.error ?? 'unknown error'}`)
        refresh()
      })
      .catch((err: unknown) => setFlash(`re-index request error: ${String(err)}`))
      .finally(() => setBusyPort(null))
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <button type="button" className={BTN.secondary} disabled={loading} onClick={refresh}>refresh</button>
        <span>{loading ? 'loading…' : views === null ? '' : `${views.length} workspace(s)`}</span>
        {flash !== null ? <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{flash}</span> : null}
      </div>
      {error !== null
        ? <p style={{ color: 'var(--dsw-alias-state-error-primary)' }}>failed to load workspaces: {error}</p>
        : null}
      {views !== null && views.length === 0
        ? <p style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>暂无工作区</p>
        : (
      <div style={scrollWrap}>
      <table style={tableStyleWorkspaces}>
        <thead>
          <tr>
            <th style={thStyle}>workspace</th>
            <th style={thStyle}>status</th>
            <th style={thStyle}>reason</th>
            <th style={thStyle}>port</th>
            <th style={thStyle}>pid</th>
            <th style={thStyle}>mode</th>
            <th style={thStyle}>files</th>
            <th style={thStyle}>chunks</th>
            <th style={thStyle}>languages</th>
            <th style={thStyle}>last indexed</th>
            <th style={thStyle}>notes</th>
            <th style={thStyle}>ready</th>
            <th style={thStyle}>action</th>
          </tr>
        </thead>
        <tbody>
          {views?.map((view) => (
            <WorkspaceRow key={`${view.workspace}:${view.port}`} view={view} onReindex={reindex} busy={busyPort === view.port} />
          ))}
        </tbody>
      </table>
      </div>
      )}
    </div>
  )
}

/** Services required by the client half (informational; host resolves them). */
export const inject = ['slots']

/** Order of the Vectr top-level Settings section in the host nav. The built-in
 * General/Models/Presets sections use 0–20; 200 keeps Vectr after them. */
const VECTR_SECTION_ORDER = 200

/** Mount the Vectr shell as a top-level **Settings → Vectr** section. The shell
 * owns the Workspaces/Codebases tab bar and renders {@link WorkspaceConsole} and
 * the codebase manager; neither panel self-registers anymore. `slots.inject`
 * runs its callback as a Cordis effect, so the callback returns the disposer
 * `slots.register` yields (not a plain descriptor) or the loader rejects it. */
export function apply(ctx: ClientContext): void {
  // Vectr ships a fixed English section/label by design (product terminology is
  // not user-localizable), so we do NOT wire `locale`/`i18n` here. The host's
  // `settings.section` slot accepts a `label` FUNCTION (not just a string), which
  // is the supported hook for i18n when a plugin needs it; we simply return the
  // constant. No `locale` key is passed because there is nothing to translate.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'vectr',
    order: VECTR_SECTION_ORDER,
    label: () => 'Vectr',
  }, VectrSettings))
}
