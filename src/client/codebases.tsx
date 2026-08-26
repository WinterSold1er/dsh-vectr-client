/**
 * Browser half of the multi-codebase manager (feature B).
 *
 * Mounted into the same Settings → Plugins tab as the workspace console. It
 * fetches the host's `/api/vectr/codebases` endpoints and renders a create
 * form plus a table with per-row test / delete actions. Secrets (passwords)
 * are submitted on create but never read back or shown.
 *
 * @module dsh-vectr-client/client/codebases
 */

import { useEffect, useState, type ReactNode } from 'react'

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

/** Minimal structural view of the Cordis client context this half needs. */
interface ClientContext {
  slots: {
    inject(name: string, factory: () => { name: string; id?: string; order?: number; label?: () => string; locale?: string; inject?: () => unknown; children?: Record<string, unknown> }, component: unknown): () => void
  }
  effect(disposer: () => void, name?: string): void
}

/** One table row with test / delete actions. */
function CodebaseRow(props: {
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
      <td>{view.slug}</td>
      <td>{view.type}</td>
      <td title={view.path}>{view.path}</td>
      <td>{address}</td>
      <td>{view.localPort ?? '—'}</td>
      <td>{view.status === 'up'
        ? <span style={{ color: 'green' }}>up</span>
        : <span style={{ color: 'red' }}>{view.status}{view.error ? ` (${view.error})` : ''}</span>}</td>
      <td>{view.tunnelPid !== undefined ? String(view.tunnelPid) : '—'}</td>
      <td>
        <button type="button" disabled={busy} onClick={() => onTest(view.slug)}>test</button>
        <button type="button" disabled={busy} onClick={() => onDelete(view.slug)} style={{ marginLeft: 4 }}>delete</button>
      </td>
    </tr>
  )
}

/** The full codebase manager panel. */
function CodebaseManager(): ReactNode {
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
      <form onSubmit={submit} style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: 6, marginBottom: 10, maxWidth: 520 }}>
        <label>type</label>
        <select value={type} onChange={(e) => setType(e.target.value as 'local' | 'remote')}>
          <option value="local">local</option>
          <option value="remote">remote</option>
        </select>
        <label>slug</label>
        <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="my-codebase" required />
        <label>path</label>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/abs/path" required />
        {type === 'remote'
          ? (
            <>
              <label>host</label>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="user@host" required />
              <label>auth</label>
              <select value={auth} onChange={(e) => setAuth(e.target.value as 'key' | 'password')}>
                <option value="key">key</option>
                <option value="password">password</option>
              </select>
              {auth === 'password'
                ? (
                  <>
                    <label>password</label>
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••" />
                  </>
                )
                : null}
            </>
          )
          : null}
        <span />
        <button type="submit" disabled={creating || slug.length === 0 || path.length === 0}>{creating ? '…' : 'create'}</button>
        {formError !== null
          ? <span style={{ color: 'red', gridColumn: '1 / span 2' }}>{formError}</span>
          : null}
      </form>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <button type="button" disabled={loading} onClick={refresh}>refresh</button>
        <span>{loading ? 'loading…' : views === null ? '' : `${views.length} codebase(s)`}</span>
        {flash !== null ? <span style={{ color: 'gray' }}>{flash}</span> : null}
      </div>
      {error !== null
        ? <p style={{ color: 'red' }}>failed to load codebases: {error}</p>
        : null}
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th>slug</th>
            <th>type</th>
            <th>path</th>
            <th>address</th>
            <th>local port</th>
            <th>status</th>
            <th>tunnel</th>
            <th>actions</th>
          </tr>
        </thead>
        <tbody>
          {views?.map((view) => (
            <CodebaseRow key={view.slug} view={view} onTest={test} onDelete={del} busy={busySlug === view.slug} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Services required by the client half (informational; host resolves them). */
export const inject = ['slots']

/** Mount the codebase manager into the Settings → Plugins tab (alongside the workspace console). */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.plugins.tab', () => ({
    name: 'settings.plugins.tab',
    id: 'vectr-codebases',
    order: 21,
    label: () => 'Vectr Codebases',
    children: {},
  }), CodebaseManager)
}
