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

import { useEffect, useState, type ReactNode } from 'react'
import { VectrSettings } from './vectr-settings'
import { scrollWrap, tableStyleWorkspaces, thStyle, tdStyle, ellipsisStyle } from './tableStyles'
import { BTN } from './buttons'
import { SessionHeaderAction } from './SessionHeaderAction'
import { VectrNavIcon } from './VectrNavIcon'
import { ConversationInputRightAction } from './ConversationInputRightAction'
import { VectrDialogRoot } from './VectrDialogRoot'

export { SessionHeaderAction, SessionsBoundHeaderAction } from './SessionHeaderAction'
export { SessionDrawerModal } from './SessionDrawerModal'
export { CodebaseModal } from './CodebaseModal'
export { MemoryViewer } from './MemoryViewer'
export { VectrNavIcon } from './VectrNavIcon'
export {
  ConversationInputRightAction,
  SessionsBoundInputRightAction,
  SessionBoundInputRightAction,
} from './ConversationInputRightAction'
export { VectrDialogRoot } from './VectrDialogRoot'
export { dialogCoordinator, DialogCoordinator } from './dialogCoordinator'

/** Sentinel workspace for entries that could not be inferred during migration. */
const UNASSIGNED_WORKSPACE = '__unassigned__'

/** Mirrors the host {@link WorkspaceView} shape (see src/workspaces.ts). */
interface WorkspaceView {
  workspace: string
  port: number
  pid?: number
  mode?: string
  live: boolean
  error?: string
  /** Precise liveness-failure reason enum from the host; absent when live. */
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

/** Mirrors the host {@link CodebaseEntry} view (src/codebases.ts), secrets stripped. */
interface CodebaseView {
  id: string
  slug: string
  type: 'local' | 'remote'
  path: string
  host?: string
  serverName: string
  localPort?: number
  remotePort?: number
  tunnelPid?: number
  status: 'up' | 'down' | 'error'
  error?: string
  /** Owning workspace (absolute); '__unassigned__' or absent ⇒ unassigned bucket. */
  workspace?: string
}

/** Minimal structural view of the Cordis client context this half needs. */
interface ClientContext {
  slots: {
    inject(key: string, callback: () => unknown): () => void
    register(
      options: {
        name: string
        id?: string
        order?: number
        label?: () => string
        icon?: unknown
        locale?: string
        inject?: () => unknown
        children?: Record<string, unknown>
      },
      component: unknown,
    ): () => void
  }
  effect(disposer: () => unknown, name?: string): void
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

/** Single status pill: up=green, down=gray, error=red (title shows the message). */
function StatusPill(props: { status: CodebaseView['status']; error?: string | undefined }): ReactNode {
  const { status, error } = props
  const color = status === 'up'
    ? 'var(--dsw-alias-state-success-primary)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary)'
      : 'var(--dsw-alias-label-secondary)'
  return (
    <span style={{ color, fontWeight: 600, whiteSpace: 'nowrap' }} title={error ?? ''}>
      {status}
    </span>
  )
}

/** Compact type indicator: 📁 local / 🌐 remote. */
function TypeCell(props: { type: 'local' | 'remote' }): ReactNode {
  const { type } = props
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {type === 'remote' ? '🌐 remote' : '📁 local'}
    </span>
  )
}

/** Render the `target` column: local → path; remote → `host:remotePort → 127.0.0.1:localPort`. */
function TargetCell(props: { view: CodebaseView }): ReactNode {
  const { view } = props
  const text = view.type === 'remote'
    ? `${view.host ?? '?'} → 127.0.0.1:${view.localPort ?? '?'} (remote ${view.remotePort ?? '?'})`
    : view.path
  return (
    <td style={tdStyle} title={text}>
      <span style={{ ...ellipsisStyle, maxWidth: 260 }}>{text}</span>
    </td>
  )
}

/** One codebase sub-row: 5 columns (name / type / target / status / actions). */
function CodebaseSubRow(props: {
  view: CodebaseView
  onTest: (slug: string) => void
  onDelete: (slug: string) => void
  onAssign: (slug: string, workspace: string) => void
  busy: boolean
  /** Show the inline "assign" action (unassigned bucket only). */
  showAssign: boolean
  /** Workspaces available as assign targets. */
  knownWorkspaces: string[]
}): ReactNode {
  const { view, onTest, onDelete, onAssign, busy, showAssign, knownWorkspaces } = props
  const [assigning, setAssigning] = useState(false)
  const [target, setTarget] = useState(knownWorkspaces[0] ?? '')
  return (
    <tr>
      <td style={tdStyle} title={view.slug}><span style={ellipsisStyle}>{view.slug}</span></td>
      <td style={tdStyle}><TypeCell type={view.type} /></td>
      <TargetCell view={view} />
      <td style={tdStyle}><StatusPill status={view.status} error={view.error} /></td>
      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
        {/* flex + nowrap keeps test/delete/(assign) on one line; gap replaces
            marginLeft so they never wrap when the column is squeezed (问题2). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
          <button type="button" className={BTN.action} disabled={busy} onClick={() => onTest(view.slug)}>test</button>
          <button type="button" className={BTN.danger} disabled={busy} onClick={() => onDelete(view.slug)}>delete</button>
          {showAssign
            ? assigning
              ? (
                <>
                  <select
                    className="vectr-select"
                    style={{ height: 26, fontSize: 12 }}
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    {knownWorkspaces.map((ws) => <option key={ws} value={ws}>{ws.split('/').slice(-2).join('/')}</option>)}
                    <option value={UNASSIGNED_WORKSPACE}>__unassigned__</option>
                  </select>
                  <button type="button" className={BTN.primary} disabled={busy} onClick={() => { setAssigning(false); onAssign(view.slug, target) }}>apply</button>
                  <button type="button" className={BTN.secondary} disabled={busy} onClick={() => setAssigning(false)}>cancel</button>
                </>
              )
              : <button type="button" className={BTN.secondary} disabled={busy} onClick={() => setAssigning(true)}>assign</button>
            : null}
        </div>
      </td>
    </tr>
  )
}

/** The 5-column codebase sub-table for one workspace section (no large minWidth). */
function CodebaseSubTable(props: {
  entries: CodebaseView[]
  onTest: (slug: string) => void
  onDelete: (slug: string) => void
  onAssign: (slug: string, workspace: string) => void
  busySlug: string | null
  showAssign: boolean
  knownWorkspaces: string[]
}): ReactNode {
  const { entries, onTest, onDelete, onAssign, busySlug, showAssign, knownWorkspaces } = props
  return (
    <div style={{ margin: '4px 0 8px 18px' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 460 }}>
        <thead>
          <tr>
            <th style={thStyle}>name</th>
            <th style={thStyle}>type</th>
            <th style={thStyle}>target</th>
            <th style={thStyle}>status</th>
            <th style={{ ...thStyle, minWidth: 130, whiteSpace: 'nowrap' }}>actions</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0
            ? (
              <tr>
                <td style={tdStyle} colSpan={5}>
                  <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>no codebases in this workspace yet</span>
                </td>
              </tr>
            )
            : entries.map((view) => (
              <CodebaseSubRow
                key={view.slug}
                view={view}
                onTest={onTest}
                onDelete={onDelete}
                onAssign={onAssign}
                busy={busySlug === view.slug}
                showAssign={showAssign}
                knownWorkspaces={knownWorkspaces}
              />
            ))}
        </tbody>
      </table>
    </div>
  )
}

/** Create form, pre-bound to a section workspace when `presetWorkspace` is given. */
function CodebaseCreateForm(props: {
  /** Section workspace; when set the form reports it and hides the picker. */
  presetWorkspace?: string
  /** All known workspaces, offered as assign targets when no preset. */
  knownWorkspaces: string[]
  onCreated: () => void
}): ReactNode {
  const { presetWorkspace, knownWorkspaces, onCreated } = props
  const [type, setType] = useState<'local' | 'remote'>('local')
  const [slug, setSlug] = useState('')
  const [path, setPath] = useState(presetWorkspace ?? '')
  const [host, setHost] = useState('')
  const [auth, setAuth] = useState<'key' | 'password'>('key')
  const [password, setPassword] = useState('')
  const [workspace, setWorkspace] = useState(presetWorkspace ?? (knownWorkspaces[0] ?? UNASSIGNED_WORKSPACE))
  const [formError, setFormError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const submit = (e: { preventDefault: () => void }): void => {
    e.preventDefault()
    setFormError(null)
    setCreating(true)
    // 阶段2: the form ALWAYS reports `workspace`. In a section it is the preset
    // (so the entry binds to that workspace); in the unassigned area it is the
    // user's pick. The backend REQUIRES `workspace` for remote, and reporting it
    // for local is what enables per-workspace binding isolation.
    const reportedWorkspace = presetWorkspace ?? workspace
    const body: Record<string, unknown> = { type, slug, path, workspace: reportedWorkspace }
    if (type === 'remote') {
      body.host = host
      body.auth = auth
      if (auth === 'password') body.password = password
    }
    fetch('/api/vectr/codebases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((res) => res.json() as Promise<{ ok?: boolean; error?: string }>)
      .then((result) => {
        if (result.error !== undefined) {
          setFormError(result.error)
        } else {
          setSlug('')
          setPath('')
          setHost('')
          setPassword('')
          onCreated()
        }
      })
      .catch((err: unknown) => setFormError(`create request error: ${String(err)}`))
      .finally(() => setCreating(false))
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0 4px 18px', maxWidth: 520 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <label className="vectr-label" htmlFor="cb-type">type</label>
          <select id="cb-type" className="vectr-select" value={type} onChange={(e) => setType(e.target.value as 'local' | 'remote')}>
            <option value="local">local</option>
            <option value="remote">remote</option>
          </select>
        </div>
        <div>
          <label className="vectr-label" htmlFor="cb-slug">slug</label>
          <input id="cb-slug" className="vectr-input" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="my-codebase" required />
        </div>
        <div>
          <label className="vectr-label" htmlFor="cb-path">path</label>
          <input id="cb-path" className="vectr-input" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/abs/path" required />
        </div>
      </div>
      {type === 'remote'
        ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div>
              <label className="vectr-label" htmlFor="cb-host">host</label>
              <input id="cb-host" className="vectr-input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="user@host" required />
            </div>
            <div>
              <label className="vectr-label" htmlFor="cb-auth">auth</label>
              <select id="cb-auth" className="vectr-select" value={auth} onChange={(e) => setAuth(e.target.value as 'key' | 'password')}>
                <option value="key">key</option>
                <option value="password">password</option>
              </select>
            </div>
            {auth === 'password'
              ? (
                <div>
                  <label className="vectr-label" htmlFor="cb-password">password</label>
                  <input id="cb-password" className="vectr-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••" />
                </div>
              )
              : null}
          </div>
        )
        : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: presetWorkspace === undefined ? '0 0 auto' : '1 1 240px', minWidth: 200 }}>
          <label className="vectr-label" htmlFor="cb-workspace">workspace</label>
          {presetWorkspace !== undefined
            ? <input id="cb-workspace" className="vectr-input" value={presetWorkspace} disabled title="bound to this workspace section" />
            : (
              <select id="cb-workspace" className="vectr-select" style={{ width: '100%' }} value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
                {knownWorkspaces.map((ws) => <option key={ws} value={ws}>{ws}</option>)}
                <option value={UNASSIGNED_WORKSPACE}>__unassigned__</option>
              </select>
            )}
        </div>
        <button type="submit" className={BTN.primary} disabled={creating || slug.length === 0 || path.length === 0}>{creating ? '…' : 'create'}</button>
      </div>
      {formError !== null
        ? <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{formError}</span>
        : null}
    </form>
  )
}

/** One workspace row + its expandable codebase sub-section. */
function WorkspaceRow(props: {
  view: WorkspaceView
  entries: CodebaseView[]
  expanded: boolean
  onToggle: () => void
  onReindex: (port: number) => void
  busyPort: boolean
  onTest: (slug: string) => void
  onDelete: (slug: string) => void
  onAssign: (slug: string, ws: string) => void
  busySlug: string | null
  knownWorkspaces: string[]
  onCreated: () => void
}): ReactNode {
  const { view, entries, expanded, onToggle, onReindex, busyPort, onTest, onDelete, onAssign, busySlug, knownWorkspaces, onCreated } = props
  const disabledReason = reindexDisabledReason(view)
  const disabled = disabledReason !== undefined || busyPort
  const s = view.status
  return (
    <>
      <tr>
        <td style={{ ...tdStyle, cursor: 'pointer', userSelect: 'none' }} onClick={onToggle} title={expanded ? 'collapse codebases' : 'expand codebases'}>
          <span style={{ display: 'inline-block', width: 12 }}>{expanded ? '▾' : '▸'}</span>
        </td>
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
            {busyPort ? '…' : 're-index'}
          </button>
        </td>
      </tr>
      {expanded
        ? (
          <tr>
            <td />
            <td colSpan={13} style={{ padding: 0, borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
              <CodebaseSubTable
                entries={entries}
                onTest={onTest}
                onDelete={onDelete}
                onAssign={onAssign}
                busySlug={busySlug}
                showAssign={false}
                knownWorkspaces={knownWorkspaces}
              />
              <CodebaseCreateForm presetWorkspace={view.workspace} knownWorkspaces={knownWorkspaces} onCreated={onCreated} />
            </td>
          </tr>
        )
        : null}
    </>
  )
}

/** The full merged console panel (workspaces + their codebases). */
export function WorkspaceConsole(): ReactNode {
  const [wsViews, setWsViews] = useState<WorkspaceView[] | null>(null)
  const [cbViews, setCbViews] = useState<CodebaseView[] | null>(null)
  const [wsError, setWsError] = useState<string | null>(null)
  const [cbError, setCbError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyPort, setBusyPort] = useState<number | null>(null)
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const refresh = (): void => {
    setLoading(true)
    setWsError(null)
    setCbError(null)
    const wsReq = fetch('/api/vectr/workspaces')
      .then((res) => {
        if (!res.ok) throw new Error(`workspaces endpoint returned ${res.status}`)
        return res.json() as Promise<WorkspaceView[]>
      })
      .then((data) => setWsViews(data))
      .catch((err: unknown) => setWsError(String(err)))
    const cbReq = fetch('/api/vectr/codebases')
      .then((res) => {
        if (!res.ok) throw new Error(`codebases endpoint returned ${res.status}`)
        return res.json() as Promise<CodebaseView[]>
      })
      .then((data) => setCbViews(data))
      .catch((err: unknown) => setCbError(String(err)))
    void Promise.allSettled([wsReq, cbReq]).finally(() => setLoading(false))
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

  const run = (slug: string, method: string, suffix: string, okFlash: string): void => {
    setBusySlug(slug)
    setFlash(null)
    fetch(`/api/vectr/codebases/${encodeURIComponent(slug)}${suffix}`, { method })
      .then((res) => res.json() as Promise<{ ok?: boolean; error?: string }>)
      .then((result) => {
        if (result.ok === false) setFlash(`failed: ${result.error ?? 'unknown error'}`)
        else { setFlash(okFlash); refresh() }
      })
      .catch((err: unknown) => setFlash(`request error: ${String(err)}`))
      .finally(() => setBusySlug(null))
  }

  const test = (slug: string): void => run(slug, 'POST', '/test', `tested ${slug}`)
  const del = (slug: string): void => run(slug, 'DELETE', '', `deleted ${slug}`)
  // Assign calls the real backend PATCH route (src/index.ts) to move a
  // codebase into a workspace; a 4xx from the host surfaces as a clear flash
  // rather than a silent no-op.
  const assign = (slug: string, ws: string): void => {
    setBusySlug(slug)
    setFlash(null)
    fetch(`/api/vectr/codebases/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: ws }),
    })
      .then(async (res) => {
        // Success is judged on the explicit HTTP status + absence of error, not
        // on a hard-coded "not implemented" string: any 4xx/5xx or error payload
        // is surfaced verbatim so ops is never misled.
        const result = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!res.ok || result.error !== undefined) {
          setFlash(`assign failed: ${result.error ?? 'unknown'}`)
        } else {
          setFlash(`assigned "${slug}" → "${ws}"`)
          refresh()
        }
      })
      .catch((err: unknown) => setFlash(`assign request error: ${String(err)}`))
      .finally(() => setBusySlug(null))
  }

  const toggle = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Group codebases by workspace; everything unassigned/undefined falls into the
  // unassigned bucket; workspaces present in codebases but absent from the
  // workspaces endpoint become orphan pseudo-sections (so no entry is hidden).
  // Both key sides are normalized (trailing slash trimmed) so a backend that
  // tolerates trailing slashes does not split one logical workspace into a
  // phantom orphan section (B1).
  const normWs = (w: string): string => w.replace(/\/+$/, '')
  const knownWorkspaces = (wsViews ?? []).map((w) => normWs(w.workspace))
  const byWs = new Map<string, CodebaseView[]>()
  const unassigned: CodebaseView[] = []
  for (const cb of cbViews ?? []) {
    const ws = cb.workspace
    if (ws === undefined || ws === UNASSIGNED_WORKSPACE) { unassigned.push(cb); continue }
    const key = normWs(ws)
    const list = byWs.get(key)
    if (list === undefined) byWs.set(key, [cb])
    else list.push(cb)
  }
  const orphans = [...byWs.keys()].filter((ws) => !knownWorkspaces.includes(ws))

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <button type="button" className={BTN.secondary} disabled={loading} onClick={refresh}>refresh</button>
        <span>{loading ? 'loading…' : `${knownWorkspaces.length} workspace(s) · ${cbViews?.length ?? 0} codebase(s)`}</span>
        {flash !== null ? <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{flash}</span> : null}
      </div>
      {wsError !== null
        ? <p style={{ color: 'var(--dsw-alias-state-error-primary)' }}>failed to load workspaces: {wsError}</p>
        : null}
      {cbError !== null
        ? <p style={{ color: 'var(--dsw-alias-state-error-primary)' }}>failed to load codebases: {cbError}</p>
        : null}
      {wsViews !== null && wsViews.length === 0
        ? <p style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>暂无工作区</p>
        : (
      <div style={scrollWrap}>
      <table style={tableStyleWorkspaces}>
        <thead>
          <tr>
            <th style={thStyle} />
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
          {wsViews?.map((view) => {
            const affiliated = byWs.get(view.workspace) ?? []
            const key = `ws:${view.workspace}`
            return (
              <WorkspaceRow
                key={key}
                view={view}
                entries={affiliated}
                expanded={expanded.has(key)}
                onToggle={() => toggle(key)}
                onReindex={reindex}
                busyPort={busyPort === view.port}
                onTest={test}
                onDelete={del}
                onAssign={assign}
                busySlug={busySlug}
                knownWorkspaces={knownWorkspaces}
                onCreated={refresh}
              />
            )
          })}
          {orphans.map((ws) => {
            const affiliated = byWs.get(ws) ?? []
            const key = `orphan:${ws}`
            // Orphan pseudo-row: reuse WorkspaceRow with a synthetic view so the
            // expand/collapse + sub-table machinery stays identical.
            const pseudo: WorkspaceView = { workspace: ws, port: 0, live: false, reason: 'not a running vectr daemon' }
            return (
              <WorkspaceRow
                key={key}
                view={pseudo}
                entries={affiliated}
                expanded={expanded.has(key)}
                onToggle={() => toggle(key)}
                onReindex={() => { /* no daemon to re-index */ }}
                busyPort={false}
                onTest={test}
                onDelete={del}
                onAssign={assign}
                busySlug={busySlug}
                knownWorkspaces={knownWorkspaces}
                onCreated={refresh}
              />
            )
          })}
        </tbody>
      </table>
      </div>
      )}

      {/* Unassigned pseudo-section: entries with workspace === '__unassigned__'. */}
      <div style={{ marginTop: 14 }}>
        <h4 style={{ margin: '0 0 6px', color: 'var(--dsw-alias-label-secondary)' }}>Unassigned codebases</h4>
        {unassigned.length === 0
          ? <p style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>none</p>
          : (
            <CodebaseSubTable
              entries={unassigned}
              onTest={test}
              onDelete={del}
              onAssign={assign}
              busySlug={busySlug}
              showAssign
              knownWorkspaces={knownWorkspaces}
            />
          )}
        <CodebaseCreateForm knownWorkspaces={knownWorkspaces} onCreated={refresh} />
      </div>
    </div>
  )
}

/** Services required by the client half (informational; host resolves them). */
export const inject = ['slots']

/** Order of the Vectr top-level Settings section in the host nav. The built-in
 * General/Models/Presets sections use 0–20; 200 keeps Vectr after them. */
const VECTR_SECTION_ORDER = 200

/** Mount the Vectr shell as a top-level **Settings → Vectr** section. The shell
 * owns the single merged panel (workspaces + their codebases). `slots.inject`
 * runs its callback as a Cordis effect, so the callback returns the disposer
 * `slots.register` yields (not a plain descriptor) or the loader rejects it. */
/**
 * Registers a slot injection wrapped inside ctx.effect so that Cordis HMR reload
 * cleans up previous injections, avoiding duplicate modals and buttons.
 */
function effectInject(ctx: ClientContext, key: string, callback: () => unknown, name: string): void {
  let executed = false
  ctx.effect(() => {
    executed = true
    return ctx.slots.inject(key, callback)
  }, name)
  if (!executed) {
    ctx.slots.inject(key, callback)
  }
}

/** Mount the Vectr shell as a top-level **Settings → Vectr** section. The shell
 * owns the single merged panel (workspaces + their codebases). `slots.inject`
 * runs its callback as a Cordis effect, so the callback returns the disposer
 * `slots.register` yields (not a plain descriptor) or the loader rejects it. */
export function apply(ctx: ClientContext): void {
  // Vectr ships a fixed English section/label by design (product terminology is
  // not user-localizable), so we do NOT wire `locale`/`i18n` here. The host's
  // `settings.section` slot accepts a `label` FUNCTION (not just a string), which
  // is the supported hook for i18n when a plugin needs it; we simply return the
  // constant. No `locale` key is passed because there is nothing to translate.
  effectInject(ctx, 'settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'vectr',
    order: VECTR_SECTION_ORDER,
    label: () => 'Vectr',
    icon: VectrNavIcon,
  }, VectrSettings), 'vectr: settings.section')

  // Mount session utility in conversation header, reacting dynamically to active session cwd.
  effectInject(ctx, 'conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'vectr-session-header-utility',
    order: 120,
    label: () => 'Vectr',
  }, SessionHeaderAction), 'vectr: conversation.session.header.utilities')

  // Mount quick trigger in conversation input bar for blank / new sessions
  effectInject(ctx, 'conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'vectr-conversation-input-right',
    order: 120,
    label: () => 'Vectr',
  }, ConversationInputRightAction), 'vectr: conversation.input.right')

  // Mount global dialog singleton in shell.overlay
  effectInject(ctx, 'shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'vectr-dialog-root',
    order: 100,
  }, VectrDialogRoot), 'vectr: shell.overlay')
}
