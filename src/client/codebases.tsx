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

import { useEffect, useState, type ReactNode } from 'react'
import { scrollWrap, tableStyleCodebases, thStyle, tdStyle, ellipsisStyle } from './tableStyles'
import { BTN } from './buttons'

/** Mirrors the host {@link CodebaseEntry} shape (src/codebases.ts). */
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
}

/** One table row with test / delete actions. Exported for layout-regression tests.
 *  dead: rollback only — the 阶段2 merged panel renders `CodebaseSubRow`
 *  (src/client/index.tsx) instead; keep this for the legacy CodebaseManager
 *  rollback path, do not wire it back into the live panel. */
export function CodebaseRow(props: {
  view: CodebaseView
  onTest: (slug: string) => void
  onDelete: (slug: string) => void
  busy: boolean
}): ReactNode {
  const { view, onTest, onDelete, busy } = props
  const address = view.type === 'remote'
    ? `${view.host ?? '?'} → 127.0.0.1:${view.localPort ?? '?'}`
    : `127.0.0.1:${view.localPort ?? '?'}`
  return (
    <tr>
      <td style={tdStyle}>{view.slug}</td>
      <td style={tdStyle}>{view.type}</td>
      <td style={tdStyle} title={view.path}><span style={ellipsisStyle}>{view.path}</span></td>
      <td style={tdStyle}><span style={ellipsisStyle}>{address}</span></td>
      <td style={tdStyle}>{view.localPort ?? '—'}</td>
      <td style={tdStyle}>{view.status === 'up'
        ? <span style={{ color: 'var(--dsw-alias-state-success-primary)' }}>up</span>
        : <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{view.status}{view.error ? ` (${view.error})` : ''}</span>}</td>
      <td style={tdStyle}>{view.tunnelPid !== undefined ? String(view.tunnelPid) : '—'}</td>
      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
        {/* Flex + nowrap keeps the two inline buttons on one line; `gap` replaces
            the old marginLeft so they never wrap to a second row when the column
            is squeezed (问题2). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
          <button type="button" className={BTN.action} disabled={busy} onClick={() => onTest(view.slug)}>test</button>
          <button type="button" className={BTN.danger} disabled={busy} onClick={() => onDelete(view.slug)}>delete</button>
        </div>
      </td>
    </tr>
  )
}

/** The full codebase manager panel. */
export function CodebaseManager(): ReactNode {
  const [views, setViews] = useState<CodebaseView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  // Form state
  const [type, setType] = useState<'local' | 'remote'>('local')
  const [slug, setSlug] = useState('')
  const [path, setPath] = useState('')
  const [host, setHost] = useState('')
  const [auth, setAuth] = useState<'key' | 'password'>('key')
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = (): void => {
    setLoading(true)
    setError(null)
    fetch('/api/vectr/codebases')
      .then((res) => {
        if (!res.ok) throw new Error(`codebases endpoint returned ${res.status}`)
        return res.json() as Promise<CodebaseView[]>
      })
      .then((data) => setViews(data))
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [])

  const submit = (e: { preventDefault: () => void }): void => {
    e.preventDefault()
    setFormError(null)
    setCreating(true)
    const body: Record<string, unknown> = { type, slug, path }
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
        if ((result as { error?: string }).error !== undefined) {
          setFormError((result as { error?: string }).error ?? 'create failed')
        } else {
          setFlash(`codebase "${slug}" created`)
          setSlug('')
          setPath('')
          setHost('')
          setPassword('')
          refresh()
        }
      })
      .catch((err: unknown) => setFormError(`create request error: ${String(err)}`))
      .finally(() => setCreating(false))
  }

  const run = (slug: string, method: string, suffix: string, okFlash: string): void => {
    setBusySlug(slug)
    setFlash(null)
    fetch(`/api/vectr/codebases/${encodeURIComponent(slug)}${suffix}`, { method })
      .then((res) => res.json() as Promise<{ ok?: boolean; error?: string }>)
      .then((result) => {
        if ((result as { ok?: boolean }).ok === false) {
          setFlash(`failed: ${result.error ?? 'unknown error'}`)
        } else {
          setFlash(okFlash)
          refresh()
        }
      })
      .catch((err: unknown) => setFlash(`request error: ${String(err)}`))
      .finally(() => setBusySlug(null))
  }

  const test = (slug: string): void => run(slug, 'POST', '/test', `tested ${slug}`)
  const del = (slug: string): void => run(slug, 'DELETE', '', `deleted ${slug}`)

  return (
    <div>
      <h4 style={{ margin: '12px 0 6px' }}>Codebases</h4>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10, maxWidth: 520 }}>
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
        {type === 'remote'
          ? (
            <>
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
            </>
          )
          : null}
        <button type="submit" className={BTN.primary} disabled={creating || slug.length === 0 || path.length === 0}>{creating ? '…' : 'create'}</button>
        {formError !== null
          ? <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{formError}</span>
          : null}
      </form>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <button type="button" className={BTN.secondary} disabled={loading} onClick={refresh}>refresh</button>
        <span>{loading ? 'loading…' : views === null ? '' : `${views.length} codebase(s)`}</span>
        {flash !== null ? <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{flash}</span> : null}
      </div>
      {error !== null
        ? <p style={{ color: 'var(--dsw-alias-state-error-primary)' }}>failed to load codebases: {error}</p>
        : null}
      {views !== null && views.length === 0
        ? <p style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>暂无代码库</p>
        : (
      <div style={scrollWrap}>
      <table style={tableStyleCodebases}>
        <thead>
          <tr>
            <th style={thStyle}>slug</th>
            <th style={thStyle}>type</th>
            <th style={thStyle}>path</th>
            <th style={thStyle}>address</th>
            <th style={thStyle}>local port</th>
            <th style={thStyle}>status</th>
            <th style={thStyle}>tunnel</th>
            <th style={{ ...thStyle, minWidth: 110, whiteSpace: 'nowrap' }}>actions</th>
          </tr>
        </thead>
        <tbody>
          {views?.map((view) => (
            <CodebaseRow key={view.slug} view={view} onTest={test} onDelete={del} busy={busySlug === view.slug} />
          ))}
        </tbody>
      </table>
      </div>
      )}
    </div>
  )
}


