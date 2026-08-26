/**
 * Browser half of the vectr workspace console (feature A / C1).
 *
 * A thin React view mounted into the Settings → Plugins tab via the shared
 * `settings.plugins.tab` slot. All data lives on the host: this half only
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

/** Mirrors the host {@link WorkspaceView} shape (see src/workspaces.ts). */
interface WorkspaceView {
  workspace: string
  port: number
  pid?: number
  mode?: string
  live: boolean
  error?: string
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
    inject(name: string, factory: () => { name: string; id?: string; order?: number; label?: () => string; locale?: string; inject?: () => unknown; children?: Record<string, unknown> }, component: unknown): () => void
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
      <td title={view.workspace}>{view.workspace.split('/').slice(-2).join('/')}</td>
      <td>{view.live
        ? <span style={{ color: 'green' }}>online</span>
        : <span style={{ color: 'red' }}>offline{view.error ? ` (${view.error})` : ''}</span>}</td>
      <td>{view.port}</td>
      <td>{view.pid ?? '—'}</td>
      <td>{view.mode ?? '—'}</td>
      <td>{s?.indexed_files ?? '—'}</td>
      <td>{s?.total_chunks ?? '—'}</td>
      <td>{s?.languages?.join(', ') ?? '—'}</td>
      <td>{s?.last_indexed ?? '—'}</td>
      <td>{s?.notes_count ?? '—'}</td>
      <td>{(s?.fully_ready ?? false) ? 'yes' : 'no'}</td>
      <td>
        <button
          type="button"
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
function WorkspaceConsole(): ReactNode {
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
        <button type="button" disabled={loading} onClick={refresh}>refresh</button>
        <span>{loading ? 'loading…' : views === null ? '' : `${views.length} workspace(s)`}</span>
        {flash !== null ? <span style={{ color: 'gray' }}>{flash}</span> : null}
      </div>
      {error !== null
        ? <p style={{ color: 'red' }}>failed to load workspaces: {error}</p>
        : null}
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th>workspace</th>
            <th>status</th>
            <th>port</th>
            <th>pid</th>
            <th>mode</th>
            <th>files</th>
            <th>chunks</th>
            <th>languages</th>
            <th>last indexed</th>
            <th>notes</th>
            <th>ready</th>
            <th>action</th>
          </tr>
        </thead>
        <tbody>
          {views?.map((view) => (
            <WorkspaceRow key={`${view.workspace}:${view.port}`} view={view} onReindex={reindex} busy={busyPort === view.port} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Services required by the client half (informational; host resolves them). */
export const inject = ['slots']

/** Mount the workspace console into the Settings → Plugins tab. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.plugins.tab', () => ({
    name: 'settings.plugins.tab',
    id: 'vectr-workspaces',
    order: 20,
    label: () => 'Vectr Workspaces',
    children: {},
  }), WorkspaceConsole)
}
