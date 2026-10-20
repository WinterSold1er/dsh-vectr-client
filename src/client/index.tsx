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

import { useEffect, useState, type ReactNode } from 'react'
import { formatMode, isMemoryOnly, isReservedPrimarySlug, normalizeMode, normalizePath, type VectrLanguageEntry } from '../domain'
import { VectrSettings } from './vectr-settings'
import { thStyle, tdStyle, ellipsisStyle } from './tableStyles'
import { BTN } from './buttons'
import { DaemonLauncher } from './DaemonLauncher'
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

/** One `status.languages` entry — the shared domain union ({@link VectrLanguageEntry}),
 * so the host mirror and this one cannot drift apart again. */
type LanguageEntry = VectrLanguageEntry

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
    /** Newer daemons send objects (`{language, files, chunks, symbols}`); older ones plain strings. */
    languages?: LanguageEntry[]
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
  /** Owning workspace (absolute); absent ⇒ not shown under any workspace card. */
  workspace?: string
  /** Whether this is the primary codebase of the workspace. */
  isPrimary?: boolean
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
  const mode = normalizeMode(view.mode)
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
  onTest: (slug: string, workspace?: string) => void
  onStart?: ((slug: string, workspace?: string) => void) | undefined
  onDelete: (slug: string) => void
  busy: boolean
}): ReactNode {
  const { view, onTest, onStart, onDelete, busy } = props
  return (
    <tr>
      <td style={tdStyle} title={view.slug}>
        <span style={ellipsisStyle}>
          {view.slug}
          {view.isPrimary && (
            <span
              style={{
                marginLeft: 4,
                padding: '1px 4px',
                borderRadius: 3,
                fontSize: 10,
                background: 'var(--dsw-alias-brand-tertiary)',
                color: 'var(--dsw-alias-brand-primary)',
                fontWeight: 600,
              }}
            >
              Primary
            </span>
          )}
        </span>
      </td>
      <td style={tdStyle}><TypeCell type={view.type} /></td>
      <TargetCell view={view} />
      <td style={tdStyle}><StatusPill status={view.status} error={view.error} /></td>
      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
        {/* flex + nowrap keeps test/start/delete/(assign) on one line */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
          <button type="button" className={BTN.action} disabled={busy} onClick={() => onTest(view.slug, view.workspace)}>test</button>
          {onStart && (view.type === 'remote' || view.status !== 'up') && (
            <button type="button" className={BTN.secondary} disabled={busy} title="自动拉起守护进程" onClick={() => onStart(view.slug, view.workspace)}>start</button>
          )}
          <button
            type="button"
            className={BTN.danger}
            disabled={busy || view.isPrimary === true}
            title={view.isPrimary ? 'Primary codebase cannot be deleted' : 'Delete codebase'}
            onClick={() => onDelete(view.slug)}
          >
            delete
          </button>
        </div>
      </td>
    </tr>
  )
}

/** The 5-column codebase sub-table for one workspace section (no large minWidth). */
function CodebaseSubTable(props: {
  entries: CodebaseView[]
  onTest: (slug: string, workspace?: string) => void
  onStart?: ((slug: string, workspace?: string) => void) | undefined
  onDelete: (slug: string) => void
  busySlug: string | null
}): ReactNode {
  const { entries, onTest, onStart, onDelete, busySlug } = props
  return (
    <div style={{ margin: '4px 0 8px' }}>
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
                onStart={onStart}
                onDelete={onDelete}
                busy={busySlug === view.slug}
              />
            ))}
        </tbody>
      </table>
    </div>
  )
}

/** Create form, bound to the workspace card it is rendered in. */
function CodebaseCreateForm(props: {
  /** Card workspace; every entry the form creates reports it. */
  presetWorkspace: string
  onCreated: () => void
}): ReactNode {
  const { presetWorkspace, onCreated } = props
  const [type, setType] = useState<'local' | 'remote'>('local')
  const [slug, setSlug] = useState('')
  const [path, setPath] = useState<string>(presetWorkspace)
  const [host, setHost] = useState('')
  const [auth, setAuth] = useState<'key' | 'password'>('key')
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const submit = (e: { preventDefault: () => void }): void => {
    e.preventDefault()
    setFormError(null)
    if (isReservedPrimarySlug(slug)) {
      setFormError('Slug "primary" is reserved for the primary codebase')
      return
    }
    setCreating(true)
    // 阶段2: the form ALWAYS reports `workspace` — the card it lives in owns the
    // entry. The backend REQUIRES `workspace` for remote, and reporting it for
    // local is what enables per-workspace binding isolation.
    const reportedWorkspace = presetWorkspace
    const normalizedPath = normalizePath(path)
    const body: Record<string, unknown> = {
      type,
      slug: slug.trim(),
      path: normalizedPath,
      workspace: reportedWorkspace,
    }
    if (type === 'remote') {
      body.host = host.trim()
      body.remotePath = normalizedPath
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
          <select
            id="cb-type"
            className="vectr-select"
            value={type}
            onChange={(e) => {
              const nextType = e.target.value as 'local' | 'remote'
              setType(nextType)
              if (nextType === 'remote') {
                setPath('')
              } else if (nextType === 'local' && !path) {
                setPath(presetWorkspace)
              }
            }}
          >
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
          <input
            id="cb-path"
            className="vectr-input"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={type === 'remote' ? '/remote/path/to/codebase' : '/abs/path'}
            required
          />
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
        <div style={{ flex: '1 1 240px', minWidth: 200 }}>
          <label className="vectr-label" htmlFor="cb-workspace">workspace</label>
          <input id="cb-workspace" className="vectr-input" value={presetWorkspace} disabled title="bound to this workspace card" />
        </div>
        <button type="submit" className={BTN.primary} disabled={creating || slug.length === 0 || path.length === 0}>{creating ? '…' : 'create'}</button>
      </div>
      {formError !== null
        ? <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{formError}</span>
        : null}
    </form>
  )
}

/** Display name of one language entry ('' when the entry carries no name). */
function languageName(entry: LanguageEntry): string {
  return typeof entry === 'string' ? entry : entry.language ?? ''
}

/** `typescript, markdown` for the languages cell ('' when nothing is named). */
function languagesLabel(languages: LanguageEntry[] | undefined): string {
  return (languages ?? []).map(languageName).filter((name) => name !== '').join(', ')
}

/** Per-language files/chunks/symbols for the languages cell tooltip, one line per
 * language, so the detail the daemon reports is not thrown away by the label. */
function languagesTitle(languages: LanguageEntry[] | undefined): string {
  return (languages ?? [])
    .map((entry) => typeof entry === 'string'
      ? entry
      : [
        languageName(entry),
        entry.files !== undefined ? `${entry.files} files` : '',
        entry.chunks !== undefined ? `${entry.chunks} chunks` : '',
        entry.symbols !== undefined ? `symbols: ${entry.symbols ? 'yes' : 'no'}` : '',
      ].filter((part) => part !== '').join(' · '))
    .filter((line) => line !== '')
    .join('\n')
}

/** Tooltip for the files cell: the chunk count and last-indexed timestamp live
 * here instead of in their own columns, so the table fits the settings modal. */
function indexSummary(status: WorkspaceView['status']): string {
  if (status === undefined) return ''
  return [
    status.total_chunks !== undefined ? `${status.total_chunks} chunks` : '',
    `last indexed: ${status.last_indexed ?? 'never'}`,
  ].filter((part) => part !== '').join(' · ')
}

/** Compact stat tile for the summary strip: a number plus a short label. */
function StatTile(props: { value: number; label: string }): ReactNode {
  return (
    <div className="vectr-stat">
      <span className="vectr-stat-value">{props.value}</span>
      <span className="vectr-stat-label">{props.label}</span>
    </div>
  )
}

/** Summary-strip counts, derived from the already-fetched workspace list. Every
 * row lands in exactly one bucket, so live + memoryOnly + offline === total. */
export function summarizeWorkspaces(views: WorkspaceView[] | null): {
  total: number
  live: number
  memoryOnly: number
  offline: number
} {
  let live = 0
  let memoryOnly = 0
  let offline = 0
  for (const view of views ?? []) {
    if (isMemoryOnly(view.mode)) memoryOnly += 1
    else if (view.live) live += 1
    else offline += 1
  }
  return { total: (views ?? []).length, live, memoryOnly, offline }
}

/** Fetch both management endpoints together. A failure keeps the real message
 * (`String(err)`, e.g. "Error: workspaces endpoint returned 500") so the panel
 * renders the actual error instead of silently showing nothing. */
export async function loadConsoleData(): Promise<{
  wsViews: WorkspaceView[] | null
  cbViews: CodebaseView[] | null
  wsError: string | null
  cbError: string | null
}> {
  const [wsResult, cbResult] = await Promise.allSettled([
    fetch('/api/vectr/workspaces').then((res) => {
      if (!res.ok) throw new Error(`workspaces endpoint returned ${res.status}`)
      return res.json() as Promise<WorkspaceView[]>
    }),
    fetch('/api/vectr/codebases').then((res) => {
      if (!res.ok) throw new Error(`codebases endpoint returned ${res.status}`)
      return res.json() as Promise<CodebaseView[]>
    }),
  ])
  return {
    wsViews: wsResult.status === 'fulfilled' ? wsResult.value : null,
    cbViews: cbResult.status === 'fulfilled' ? cbResult.value : null,
    wsError: wsResult.status === 'rejected' ? String(wsResult.reason) : null,
    cbError: cbResult.status === 'rejected' ? String(cbResult.reason) : null,
  }
}

/** One workspace as a card: identity + state pills + re-index on the header row,
 * the key index facts below it, and the codebase detail when expanded. */
export function WorkspaceCard(props: {
  view: WorkspaceView
  entries: CodebaseView[]
  expanded: boolean
  onToggle: () => void
  onReindex: (port: number) => void
  busyPort: boolean
  onTest: (slug: string, workspace?: string) => void
  onStart?: ((slug: string, workspace?: string) => void) | undefined
  onDelete: (slug: string) => void
  busySlug: string | null
  onCreated: () => void
}): ReactNode {
  const { view, entries, expanded, onToggle, onReindex, busyPort, onTest, onStart, onDelete, busySlug, onCreated } = props
  const disabledReason = reindexDisabledReason(view)
  const disabled = disabledReason !== undefined || busyPort
  const s = view.status
  const langs = languagesLabel(s?.languages)
  const diagnostic = view.reason ?? view.error
  return (
    <article className="vectr-card">
      <div className="vectr-card-head">
        <button
          type="button"
          className={BTN.action}
          aria-expanded={expanded}
          aria-label={expanded ? 'collapse codebases' : 'expand codebases'}
          title={expanded ? 'collapse codebases' : 'expand codebases'}
          onClick={onToggle}
        >
          <span className="vectr-caret">{expanded ? '▾' : '▸'}</span>
        </button>
        <div className="vectr-card-identity">
          <h4 className="vectr-card-title" title={view.workspace}>{view.workspace.split('/').slice(-2).join('/')}</h4>
          <p className="vectr-card-path" title={view.workspace}>{view.workspace}</p>
        </div>
        <div className="vectr-card-pills">
          {/* The liveness pill carries the raw reason/error diagnostic in its title. */}
          <span className={`vectr-pill ${view.live ? 'vectr-pill-live' : 'vectr-pill-offline'}`} title={diagnostic ?? (view.live ? 'daemon alive' : 'daemon offline')}>
            <span className="vectr-pill-dot" />
            {view.live ? 'online' : 'offline'}
          </span>
          {/* Only shown when the daemon actually reported a mode: a dead daemon
              would otherwise repeat "offline" in a second pill. */}
          {view.mode !== undefined
            ? <span className="vectr-pill" title={view.mode}>{formatMode(view.mode, view.live)}</span>
            : null}
          <span className={`vectr-pill ${s?.fully_ready === true ? 'vectr-pill-ready' : 'vectr-pill-pending'}`} title={s?.fully_ready === true ? 'index fully built' : 'index not fully ready yet'}>
            <span className="vectr-pill-dot" />
            {s?.fully_ready === true ? 'ready' : 'not ready'}
          </span>
        </div>
        <div className="vectr-card-actions">
          <button
            type="button"
            className={BTN.action}
            disabled={disabled}
            title={disabledReason ?? 'Re-index this workspace'}
            /* T23: the shared `:disabled` rule dims with opacity, which composited an
               already-muted host colour down to 1.46:1 on this card. Paint the disabled
               state with host tokens instead (label-tertiary is 7.36:1 in dark, 3.71:1
               in light on the card) so it stays legible while still reading as disabled. */
            style={disabled ? {
              color: 'var(--dsw-alias-label-tertiary)',
              borderColor: 'var(--dsw-alias-border-l2)',
              opacity: 1,
            } : undefined}
            onClick={() => onReindex(view.port)}
          >
            {busyPort ? '…' : 're-index'}
          </button>
        </div>
      </div>

      {diagnostic !== undefined
        ? <p className="vectr-card-diagnostic" title={view.error ?? diagnostic}>{diagnostic}</p>
        : null}

      <dl className="vectr-facts">
        <div className="vectr-fact">
          <dt className="vectr-fact-label">port</dt>
          <dd className="vectr-fact-value" title={view.pid !== undefined ? `pid ${view.pid}` : 'pid unknown'}>{view.port}</dd>
        </div>
        <div className="vectr-fact">
          <dt className="vectr-fact-label">files</dt>
          <dd className="vectr-fact-value" title={indexSummary(s)}>{s?.indexed_files ?? '—'}</dd>
        </div>
        <div className="vectr-fact">
          <dt className="vectr-fact-label">notes</dt>
          <dd className="vectr-fact-value">{s?.notes_count ?? '—'}</dd>
        </div>
        <div className="vectr-fact">
          <dt className="vectr-fact-label">languages</dt>
          <dd className="vectr-fact-value" title={languagesTitle(s?.languages)}>{langs === '' ? '—' : langs}</dd>
        </div>
      </dl>

      {expanded
        ? (
          <div className="vectr-card-detail">
            <CodebaseSubTable
              entries={entries}
              onTest={onTest}
              onStart={onStart}
              onDelete={onDelete}
              busySlug={busySlug}
            />
            <CodebaseCreateForm presetWorkspace={view.workspace} onCreated={onCreated} />
          </div>
        )
        : null}
    </article>
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
    void loadConsoleData()
      .then((data) => {
        setWsViews(data.wsViews)
        setCbViews(data.cbViews)
        setWsError(data.wsError)
        setCbError(data.cbError)
      })
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

  const test = (slug: string, ws?: string): void => {
    const wsParam = ws ? `?workspace=${encodeURIComponent(ws)}` : ''
    run(slug, 'POST', `/test${wsParam}`, `tested ${slug}`)
  }
  const start = (slug: string, ws?: string): void => {
    const wsParam = ws ? `?workspace=${encodeURIComponent(ws)}` : ''
    run(slug, 'POST', `/start${wsParam}`, `started ${slug}`)
  }
  const del = (slug: string): void => run(slug, 'DELETE', '', `deleted ${slug}`)
  const toggle = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <WorkspaceConsoleView
      wsViews={wsViews}
      cbViews={cbViews}
      wsError={wsError}
      cbError={cbError}
      loading={loading}
      flash={flash}
      busyPort={busyPort}
      busySlug={busySlug}
      expanded={expanded}
      onRefresh={refresh}
      onToggle={toggle}
      onReindex={reindex}
      onTest={test}
      onStart={start}
      onDelete={del}
    />
  )
}

/** The console's whole visual tree, driven purely by props: no hooks, no fetch.
 * Splitting it out of {@link WorkspaceConsole} is what makes the page renderable
 * headlessly (`renderToStaticMarkup` never runs effects, so a component that
 * fetches its own data could only ever be asserted in its empty state). */
export function WorkspaceConsoleView(props: {
  wsViews: WorkspaceView[] | null
  cbViews: CodebaseView[] | null
  wsError: string | null
  cbError: string | null
  loading: boolean
  flash: string | null
  busyPort: number | null
  busySlug: string | null
  expanded: ReadonlySet<string>
  onRefresh: () => void
  onToggle: (key: string) => void
  onReindex: (port: number) => void
  onTest: (slug: string, workspace?: string) => void
  onStart: (slug: string, workspace?: string) => void
  onDelete: (slug: string) => void
}): ReactNode {
  // The callbacks keep their local names so the render tree below is unchanged.
  const {
    wsViews, cbViews, wsError, cbError, loading, flash, busyPort, busySlug, expanded,
    onRefresh: refresh, onToggle: toggle, onReindex: reindex, onTest: test, onStart: start,
    onDelete: del,
  } = props

  // Group codebases under the workspace card that owns them. Both sides are
  // normalized (trailing slash trimmed) so a backend that tolerates trailing
  // slashes does not split one logical workspace across two cards (B1). A
  // codebase with no owning workspace is not shown.
  const normWs = (w: string): string => normalizePath(w)
  const byWs = new Map<string, CodebaseView[]>()
  for (const cb of cbViews ?? []) {
    const ws = cb.workspace
    if (ws === undefined) continue
    const key = normWs(ws)
    const list = byWs.get(key)
    if (list === undefined) byWs.set(key, [cb])
    else list.push(cb)
  }
  const summary = summarizeWorkspaces(wsViews)
  // An error is never dressed up as "empty": the error block above is the state.
  const showEmpty = wsError === null && wsViews !== null && wsViews.length === 0
  const showList = !showEmpty && wsViews !== null

  return (
    <div className="vectr-page">
      <div className="vectr-page-head">
        <div>
          {/* T28: our own standalone mark beside the page title — this is the
              surface the user actually looks at, and it must not read as a gear. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <VectrNavIcon size={16} title="Vectr" />
            <h3 className="vectr-page-title">Vectr 工作区</h3>
          </div>
          <p className="vectr-page-subtitle">每个已注册的工作区对应一个 vectr daemon；展开任意一行可以查看并管理它的代码库，re-index 会重建该 daemon 的索引。</p>
        </div>
        <div className="vectr-toolbar">
          <DaemonLauncher onChanged={refresh} />
          <button type="button" className={BTN.secondary} disabled={loading} onClick={refresh} aria-label="refresh workspace list">
            {loading ? 'refreshing…' : 'refresh'}
          </button>
          {flash !== null
            ? <span className="vectr-flash">{flash}</span>
            : loading
              ? <span className="vectr-flash">loading…</span>
              : null}
        </div>
      </div>

      <div className="vectr-stat-strip">
        <StatTile value={summary.total} label="已注册" />
        <StatTile value={summary.live} label="在线" />
        <StatTile value={summary.memoryOnly} label="仅记忆" />
        <StatTile value={summary.offline} label="离线" />
      </div>

      {wsError !== null ? <p className="vectr-error">failed to load workspaces: {wsError}</p> : null}
      {cbError !== null ? <p className="vectr-error">failed to load codebases: {cbError}</p> : null}

      {showEmpty
        ? (
          <div className="vectr-state">
            <p className="vectr-state-title">尚未注册任何 vectr 工作区</p>
            <p className="vectr-state-hint">在某个项目目录里首次使用 vectr 工具（或在该目录完成一次 vectr 初始化）后，这个工作区就会出现在这里。</p>
          </div>
        )
        : null}
      {showList
        ? (
          <div className="vectr-ws-list">
            {wsViews?.map((view) => {
              const affiliated = byWs.get(normWs(view.workspace)) ?? []
              const key = `ws:${view.workspace}`
              return (
                <WorkspaceCard
                  key={key}
                  view={view}
                  entries={affiliated}
                  expanded={expanded.has(key)}
                  onToggle={() => toggle(key)}
                  onReindex={reindex}
                  busyPort={busyPort === view.port}
                  onTest={test}
                  onStart={start}
                  onDelete={del}
                  busySlug={busySlug}
                  onCreated={refresh}
                />
              )
            })}
          </div>
        )
        : null}
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
