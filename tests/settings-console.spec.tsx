/**
 * T3 — Settings → Vectr page redesign (`src/client/index.tsx`).
 *
 * Rendered with `tests/react-render.ts` (react-dom/server, loaded from the local
 * checkout — no jsdom, no new dependency). Assertions are on the real markup:
 * the summary numbers, the disabled state of the re-index control, the exact
 * error text that came out of the endpoint, the empty state, and the mounted
 * `DaemonLauncher` control.
 *
 * All fixtures are synthetic (`/home/dev/...`) — no real workspace path, port or
 * count from this machine is baked into the page or these assertions.
 *
 * @module tests/settings-console
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { renderToHtml } from './react-render'
import { WorkspaceCard, WorkspaceConsoleView, loadConsoleData, summarizeWorkspaces } from '../src/client/index'
import { VECTR_CSS } from '../src/client/buttons'

/** 4 workspaces: 2 plain live, 1 live memory-only (hyphen spelling from the CLI), 1 offline. */
const VIEWS = [
  {
    workspace: '/home/dev/alpha',
    port: 7411,
    pid: 101,
    mode: 'full',
    live: true,
    status: { indexed_files: 120, total_chunks: 480, fully_ready: true, notes_count: 7 },
  },
  {
    workspace: '/home/dev/beta',
    port: 7412,
    pid: 102,
    mode: 'full',
    live: true,
    status: { indexed_files: 44, total_chunks: 90, fully_ready: false, notes_count: 0 },
  },
  {
    workspace: '/home/dev/gamma',
    port: 7413,
    pid: 103,
    mode: 'memory-only',
    live: true,
    status: { indexed_files: 0, total_chunks: 0, fully_ready: true, notes_count: 3 },
  },
  {
    workspace: '/home/dev/delta',
    port: 7414,
    live: false,
    reason: 'PORT_CLOSED',
    error: 'daemon not alive: PORT_CLOSED',
    status: { fully_ready: false },
  },
]

const noop = (): void => {}

/** The view's props for a given payload; every callback is a no-op sentinel. */
function viewProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    wsViews: VIEWS,
    cbViews: [],
    wsError: null,
    cbError: null,
    loading: false,
    flash: null,
    busyPort: null,
    busySlug: null,
    expanded: new Set<string>(),
    onRefresh: noop,
    onToggle: noop,
    onReindex: noop,
    onTest: noop,
    onStart: noop,
    onDelete: noop,
    ...overrides,
  }
}

/** The re-index control of a rendered workspace table, as its own tag string. */
function reindexButton(html: string): string {
  const match = html.match(/<button[^>]*>re-index<\/button>/)
  if (match === null) throw new Error(`no re-index button in: ${html.slice(0, 400)}`)
  return match[0]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('T3 summary strip', () => {
  it('derives total / live / memory-only / offline from the fetched list', () => {
    expect(summarizeWorkspaces(VIEWS)).toEqual({ total: 4, live: 2, memoryOnly: 1, offline: 1 })
  })

  it('buckets every row exactly once, so the tiles partition the list', () => {
    const counts = summarizeWorkspaces(VIEWS)
    expect(counts.live + counts.memoryOnly + counts.offline).toBe(counts.total)
    expect(summarizeWorkspaces(null)).toEqual({ total: 0, live: 0, memoryOnly: 0, offline: 0 })
  })

  it('renders the four tiles with those exact numbers', () => {
    const html = renderToHtml(<WorkspaceConsoleView {...viewProps()} />)

    expect(html).toContain('<span class="vectr-stat-value">4</span><span class="vectr-stat-label">已注册</span>')
    expect(html).toContain('<span class="vectr-stat-value">2</span><span class="vectr-stat-label">在线</span>')
    expect(html).toContain('<span class="vectr-stat-value">1</span><span class="vectr-stat-label">仅记忆</span>')
    expect(html).toContain('<span class="vectr-stat-value">1</span><span class="vectr-stat-label">离线</span>')
  })
})

describe('T3 status pills and mode canonicalization', () => {
  it('renders a live workspace as the success pill', () => {
    const html = renderToHtml(<WorkspaceConsoleView {...viewProps()} />)
    expect(html).toContain('vectr-pill vectr-pill-live')
    expect(html).toContain('vectr-pill vectr-pill-offline')
  })

  it('canonicalizes the hyphen spelling `memory-only` to `memory_only` in the mode cell', () => {
    const html = renderToHtml(<WorkspaceConsoleView {...viewProps()} />)
    expect(html).toContain('>memory_only<')
    expect(html).not.toContain('>memory-only<')
  })

  it('moves the liveness diagnostic onto the pill title instead of dropping it', () => {
    const offlineOnly = VIEWS.filter((v) => !v.live)
    const html = renderToHtml(<WorkspaceConsoleView {...viewProps({ wsViews: offlineOnly })} />)
    expect(html).toContain('daemon not alive: PORT_CLOSED')
    expect(html).toContain('PORT_CLOSED')
  })
})

describe('T3 re-index control', () => {
  const cardProps = (view: Record<string, unknown>): Record<string, unknown> => ({
    view,
    entries: [],
    expanded: false,
    onToggle: noop,
    onReindex: noop,
    busyPort: false,
    onTest: noop,
    onStart: noop,
    onDelete: noop,
    busySlug: null,
    onCreated: noop,
  })

  it('leaves a memory-only row (hyphen spelling) with the re-index action DISABLED', () => {
    const html = renderToHtml(<WorkspaceCard {...cardProps(VIEWS[2])} />)
    const button = reindexButton(html)

    expect(button).toContain('disabled=""')
    // T23 (a): the control stays inside the no-wrap action cell of the head row.
    expect(html).toContain('class="vectr-card-actions"')
    expect(VECTR_CSS).toMatch(/\.vectr-card-head\s*\{[^}]*flex-wrap:\s*nowrap/)
    expect(VECTR_CSS).toMatch(/\.vectr-card-actions\s*\{[^}]*white-space:\s*nowrap/)
    expect(VECTR_CSS).toMatch(/\.vectr-card-actions\s*\{[^}]*flex-shrink:\s*0/)
    // T23 (b): painted with host tokens instead of the opacity dim that measured 1.46:1.
    expect(button).toContain('color:var(--dsw-alias-label-tertiary)')
    expect(button).toContain('border-color:var(--dsw-alias-border-l2)')
    expect(button).toContain('opacity:1')
    expect(button).not.toContain('opacity:0.4')
    // …and the tooltip still explains why, verbatim.
    expect(html).toContain('cannot be re-indexed')
    expect(html).toContain('memory_only')
  })

  it('enables the same control for a live, fully-ready workspace row (control case)', () => {
    const html = renderToHtml(<WorkspaceCard {...cardProps(VIEWS[0])} />)
    const button = reindexButton(html)

    expect(button).not.toContain('disabled')
    // The disabled-only presentation must not leak onto an enabled control.
    expect(button).not.toContain('var(--dsw-alias-label-tertiary)')
  })

  it('disables the control for an offline row and keeps its error text', () => {
    const html = renderToHtml(<WorkspaceCard {...cardProps(VIEWS[3])} />)
    expect(reindexButton(html)).toContain('disabled=""')
    expect(html).toContain('daemon not alive: PORT_CLOSED')
  })
})

describe('T3 error state', () => {
  it('surfaces the endpoint status as the real error text, never a blank table', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) =>
      String(input).endsWith('/api/vectr/workspaces')
        ? { ok: false, status: 500, json: async () => ({ error: 'nope' }) }
        : { ok: true, status: 200, json: async () => [] },
    )

    const data = await loadConsoleData()
    expect(data.wsError).toBe('Error: workspaces endpoint returned 500')
    expect(data.wsViews).toBeNull()

    const html = renderToHtml(<WorkspaceConsoleView {...viewProps({ wsViews: data.wsViews, wsError: data.wsError })} />)
    expect(html).toContain('failed to load workspaces: Error: workspaces endpoint returned 500')
    expect(html).not.toContain('尚未注册任何 vectr 工作区')
    expect(html).not.toContain('<table')
  })

  it('surfaces a transport failure with its own message', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:7411')
    })

    const data = await loadConsoleData()
    expect(data.cbError).toContain('ECONNREFUSED 127.0.0.1:7411')

    const html = renderToHtml(<WorkspaceConsoleView {...viewProps({ cbError: data.cbError })} />)
    expect(html).toContain('failed to load codebases: Error: ECONNREFUSED 127.0.0.1:7411')
  })
})

describe('T3 empty state', () => {
  it('renders the empty state (with a registration hint) instead of a bare table', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => [] }))
    const data = await loadConsoleData()
    expect(data.wsViews).toEqual([])
    expect(data.wsError).toBeNull()

    const html = renderToHtml(<WorkspaceConsoleView {...viewProps({ wsViews: data.wsViews, cbViews: data.cbViews })} />)
    expect(html).toContain('尚未注册任何 vectr 工作区')
    expect(html).toContain('vectr-state-hint')
    expect(html).not.toContain('<table')
  })
})

describe('T3 DaemonLauncher mount', () => {
  it('mounts the start-all control in the toolbar, ahead of refresh', () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: true, results: [] }) }))

    const html = renderToHtml(<WorkspaceConsoleView {...viewProps()} />)
    expect(html).toContain('<button type="button"')
    expect(html).toMatch(/<button[^>]*>一键启动全部 Daemon<\/button>/)

    const toolbar = html.slice(html.indexOf('<div class="vectr-toolbar">'))
    const launcherAt = toolbar.indexOf('一键启动全部 Daemon')
    const refreshAt = toolbar.indexOf('aria-label="refresh workspace list"')
    expect(launcherAt).toBeGreaterThan(-1)
    expect(refreshAt).toBeGreaterThan(-1)
    expect(launcherAt).toBeLessThan(refreshAt)
  })
})

/** A workspace row carrying a `status.languages` payload in either daemon shape. */
function languagesCard(languages: unknown[]): Record<string, unknown> {
  return {
    view: {
      workspace: '/home/dev/langs',
      port: 7420,
      pid: 420,
      mode: 'full',
      live: true,
      status: { indexed_files: 7192, total_chunks: 70999, fully_ready: true, notes_count: 1, languages },
    },
    entries: [],
    expanded: false,
    onToggle: noop,
    onReindex: noop,
    busyPort: false,
    onTest: noop,
    onStart: noop,
    onDelete: noop,
    busySlug: null,
    onCreated: noop,
  }
}

/** The `<th>` labels of a rendered console, in document order. */
function headerCells(html: string): string[] {
  const head = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'))
  return [...head.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((match) => match[1] as string)
}

describe('languages fact (daemon sends objects, older payloads plain strings)', () => {
  // Shape taken from a real `/v1/status`: [{language, files, chunks, symbols}, …].
  const OBJECT_SHAPE = [
    { language: 'typescript', files: 5441, chunks: 48961, symbols: true },
    { language: 'markdown', files: 1751, chunks: 22038, symbols: false },
  ]

  it('renders the language NAMES for the object payload, never [object Object]', () => {
    const html = renderToHtml(<WorkspaceCard {...languagesCard(OBJECT_SHAPE)} />)

    expect(html).toContain('>typescript, markdown<')
    expect(html).not.toContain('[object Object]')
  })

  it('still renders the legacy plain-string payload', () => {
    const html = renderToHtml(<WorkspaceCard {...languagesCard(['typescript', 'markdown'])} />)

    expect(html).toContain('>typescript, markdown<')
    expect(html).not.toContain('[object Object]')
  })

  it('keeps the per-language files/chunks detail in the fact tooltip', () => {
    const html = renderToHtml(<WorkspaceCard {...languagesCard(OBJECT_SHAPE)} />)

    expect(html).toContain('typescript · 5441 files · 48961 chunks · symbols: yes')
    expect(html).toContain('markdown · 1751 files · 22038 chunks · symbols: no')
  })

  it('skips entries with no language name instead of rendering a blank slot', () => {
    const html = renderToHtml(<WorkspaceCard {...languagesCard(['typescript', { files: 3 }, ''])} />)

    expect(html).toContain('>typescript<')
    expect(html).not.toContain(', ,')
    expect(html).not.toContain('[object Object]')
  })
})

describe('T18 the workspace list is cards, not a table', () => {
  it('renders one card per workspace, with the canonical mode visible in the card head', () => {
    const html = renderToHtml(<WorkspaceConsoleView {...viewProps()} />)

    expect(html.match(/<article class="vectr-card">/g)?.length).toBe(VIEWS.length)
    expect(html).not.toContain('<table')
    expect(html).toContain('>memory_only<')
    expect(html).toContain('dev/alpha')
  })

  it('keeps pid / chunks / last indexed reachable in card tooltips', () => {
    const html = renderToHtml(<WorkspaceConsoleView {...viewProps()} />)

    expect(html).toContain('pid 101')
    expect(html).toContain('480 chunks · last indexed: never')
    expect(html).toContain('>port<')
    expect(html).toContain('>files<')
    expect(html).not.toContain('>pid<')
    expect(html).not.toContain('>chunks<')
  })

  it('renders the reason / error diagnostic on an offline card', () => {
    const html = renderToHtml(<WorkspaceConsoleView {...viewProps()} />)

    expect(html).toContain('PORT_CLOSED')
    expect(html).toContain('daemon not alive: PORT_CLOSED')
  })

  it('expands a card into the codebase sub-table, header and body in sync', () => {
    const entry = {
      id: 'cb-1',
      slug: 'vectr',
      type: 'local',
      path: '/home/dev/alpha',
      serverName: 'vectr-alpha',
      status: 'up',
      workspace: '/home/dev/alpha',
    }
    const html = renderToHtml(<WorkspaceCard {...languagesCard([])} entries={[entry]} expanded />)
    const headers = headerCells(html)

    expect(headers).toEqual(['name', 'type', 'target', 'status', 'actions'])
    const bodyStart = html.indexOf('<tbody>')
    const firstRow = html.slice(bodyStart, html.indexOf('</tr>', bodyStart))
    expect([...firstRow.matchAll(/<td[\s>]/g)].length).toBe(headers.length)
  })
})

describe('T18 Unassigned element is gone', () => {
  /** Codebases that used to land in the Unassigned bucket: the sentinel and no owner at all. */
  const BUCKET_CODEBASES = [
    { id: 'cb-u1', slug: 'orphan-a', type: 'local', path: '/home/dev/u1', serverName: 's1', status: 'up', workspace: '__unassigned__' },
    { id: 'cb-u2', slug: 'orphan-b', type: 'local', path: '/home/dev/u2', serverName: 's2', status: 'down' },
  ]

  it('renders no Unassigned element (and no bucket codebase) for that payload', () => {
    const html = renderToHtml(<WorkspaceConsoleView {...viewProps({ cbViews: BUCKET_CODEBASES })} />)

    expect(html).not.toMatch(/unassigned/i)
    expect(html).not.toContain('__unassigned__')
    expect(html).not.toContain('orphan-a')
    expect(html).not.toContain('orphan-b')
    // …and the real cards are still there, so the assertion is not vacuous.
    expect(html.match(/<article class="vectr-card">/g)?.length).toBe(VIEWS.length)
  })

  it('does not invent a card for a workspace with no registered daemon', () => {
    const ghost = { id: 'cb-g', slug: 'ghost', type: 'local', path: '/home/dev/ghost', serverName: 's', status: 'up', workspace: '/home/dev/ghost' }
    const html = renderToHtml(<WorkspaceConsoleView {...viewProps({ cbViews: [ghost] })} />)

    expect(html).not.toContain('dev/ghost')
    expect(html.match(/<article class="vectr-card">/g)?.length).toBe(VIEWS.length)
  })
})
