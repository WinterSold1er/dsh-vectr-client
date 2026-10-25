/**
 * T4 — not-started workspace cards + single-daemon start (`src/client/index.tsx`).
 *
 * Rendered with `tests/react-render.ts` (react-dom/server, loaded from the local
 * checkout — no jsdom, no new dependency). Assertions are on the real markup: the
 * `not started` pill, the `start daemon` control, the registry `title` on the
 * heading, the em dash where a port would be — plus the exact request `POST
 * /api/vectr/daemons/start` must make (path, method, JSON header, `{ workspace }`
 * body) and every failure shape of that endpoint: non-2xx with and without an
 * `error` field, a 200 that omits `port`, and a `fetch` that rejects.
 *
 * All fixtures are synthetic (`/home/dev/...`) — no real workspace path, port or
 * count from this machine is baked into the page or these assertions.
 *
 * @module tests/client-workspace-cards
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { renderToHtml } from './react-render'
import {
  StartDaemonButtonView,
  WorkspaceCard,
  WorkspaceConsoleView,
  startWorkspaceDaemon,
  summarizeWorkspaces,
} from '../src/client/index'
import type { StartDaemonButtonViewProps } from '../src/client/index'

/** A live row from `GET /api/vectr/workspaces`. */
const LIVE_VIEW = {
  workspace: '/home/dev/live-one',
  port: 7411,
  pid: 101,
  mode: 'full',
  live: true,
  status: { indexed_files: 120, total_chunks: 480, fully_ready: true, notes_count: 7 },
}

/** A registered row whose daemon was never started: no `port` key at all. */
const NOT_STARTED_VIEW = {
  workspace: '/home/dev/never-started',
  title: 'never-started',
  live: false,
  reason: 'not started',
}

const noop = (): void => {}

type CardProps = Parameters<typeof WorkspaceCard>[0]
type ConsoleProps = Parameters<typeof WorkspaceConsoleView>[0]

/** Props for one rendered card; every callback is a no-op sentinel. */
function cardProps(view: unknown): CardProps {
  return {
    // The fixtures are the endpoint's two shapes; `WorkspaceView` is not exported,
    // so the cast lives here, at the props boundary, and nowhere in the assertions.
    view: view as unknown as CardProps['view'],
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

/** Props for one rendered console; every callback is a no-op sentinel. */
function consoleProps(wsViews: unknown[]): ConsoleProps {
  return {
    wsViews: wsViews as unknown as ConsoleProps['wsViews'],
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
  }
}

/** The start control's three props, kept as one typed factory. */
function buttonProps(busy: boolean, error: string | null): StartDaemonButtonViewProps {
  return { busy, error, onStart: noop }
}

/** What the stubbed `fetch` actually received, so the request itself is asserted. */
interface SeenRequest {
  url: string
  method: string | undefined
  body: string | undefined
  contentType: string
}

/** Stub `fetch` with a fixed response and record the call that produced it. */
function stubFetch(response: unknown, http: { ok?: boolean; status?: number } = {}): SeenRequest {
  const seen: SeenRequest = { url: '', method: undefined, body: undefined, contentType: '' }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(input)
    seen.method = init?.method
    seen.body = typeof init?.body === 'string' ? init.body : undefined
    seen.contentType = new Headers(init?.headers as HeadersInit).get('content-type') ?? ''
    return { ok: http.ok ?? true, status: http.status ?? 200, json: async () => response }
  })
  return seen
}

/** Assert the call failed, and hand back its error text for the real assertion. */
function failureOf(result: Awaited<ReturnType<typeof startWorkspaceDaemon>>): string {
  if (result.ok === true) throw new Error(`expected a failure, got ${JSON.stringify(result)}`)
  return result.error
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('not-started workspace card', () => {
  it('renders the offline pill with the `not started` reason for a registered-but-never-started row', () => {
    const html = renderToHtml(<WorkspaceCard {...cardProps(NOT_STARTED_VIEW)} />)

    expect(html).toContain('vectr-pill vectr-pill-offline')
    expect(html).toMatch(/>not started</)
  })

  it('offers a `start daemon` button for that row', () => {
    const html = renderToHtml(<WorkspaceCard {...cardProps(NOT_STARTED_VIEW)} />)

    expect(html).toMatch(/>start daemon</)
  })

  it('prefers the registry title on the heading and keeps the full path in the title attribute', () => {
    const html = renderToHtml(<WorkspaceCard {...cardProps(NOT_STARTED_VIEW)} />)

    expect(html).toContain('>never-started</h4>')
    expect(html).toContain('title="/home/dev/never-started"')
  })

  it('renders no start button for a live row, and keeps its online pill and real port', () => {
    const html = renderToHtml(<WorkspaceCard {...cardProps(LIVE_VIEW)} />)

    expect(html).not.toMatch(/>start daemon</)
    expect(html).toContain('vectr-pill vectr-pill-live')
    expect(html).toContain('7411')
  })

  it('shows an em dash for the port fact of a row without one, never the text `undefined`', () => {
    const html = renderToHtml(<WorkspaceCard {...cardProps(NOT_STARTED_VIEW)} />)

    expect(html).not.toContain('undefined')
    expect(html).toContain('—')
  })

  it('gates the control per row: a live + not-started console offers exactly one start button', () => {
    const html = renderToHtml(<WorkspaceConsoleView {...consoleProps([LIVE_VIEW, NOT_STARTED_VIEW])} />)

    expect(html.match(/>start daemon</g)?.length).toBe(1)
    expect(html.match(/vectr-pill vectr-pill-live/g)?.length).toBe(1)
    expect(html.match(/vectr-pill vectr-pill-offline/g)?.length).toBe(1)
  })
})

describe('POST /api/vectr/daemons/start', () => {
  it('posts to the daemon-start path with method POST and a JSON content type', async () => {
    const seen = stubFetch({ ok: true, port: 7412, pid: 202 })

    await startWorkspaceDaemon('/home/dev/never-started')

    expect(seen.url).toBe('/api/vectr/daemons/start')
    expect(seen.method).toBe('POST')
    expect(seen.contentType).toContain('application/json')
  })

  it('sends exactly { workspace } as the JSON body', async () => {
    const seen = stubFetch({ ok: true, port: 7412, pid: 202 })

    await startWorkspaceDaemon('/home/dev/never-started')

    expect(seen.body).toBeDefined()
    expect(JSON.parse(seen.body as string)).toEqual({ workspace: '/home/dev/never-started' })
  })

  it('resolves the port and pid the endpoint reported', async () => {
    stubFetch({ ok: true, port: 7412, pid: 202 })

    expect(await startWorkspaceDaemon('/home/dev/never-started')).toEqual({ ok: true, port: 7412, pid: 202 })
  })
})

describe('start failure paths', () => {
  it('returns the error text a non-2xx endpoint sent', async () => {
    stubFetch({ ok: false, error: 'daemon spawn failed: EACCES' }, { ok: false, status: 500 })

    expect(failureOf(await startWorkspaceDaemon('/home/dev/never-started'))).toBe('daemon spawn failed: EACCES')
  })

  it('falls back to the HTTP status when the failure body has no `error` field', async () => {
    stubFetch({}, { ok: false, status: 503 })

    const error = failureOf(await startWorkspaceDaemon('/home/dev/never-started'))

    expect(error).not.toBe('')
    expect(error).toContain('503')
  })

  it('treats a 200 that omits `port` as a contract failure, not a success', async () => {
    stubFetch({ ok: true })

    expect(await startWorkspaceDaemon('/home/dev/never-started')).toEqual({
      ok: false,
      error: 'start endpoint returned no port',
    })
  })

  it('lets a rejecting fetch propagate its message instead of swallowing it', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })

    await expect(startWorkspaceDaemon('/home/dev/x')).rejects.toThrow('network down')
  })
})

describe('inline error + busy states', () => {
  it('renders the start failure inline, verbatim, on the control', () => {
    const html = renderToHtml(<StartDaemonButtonView {...buttonProps(false, 'daemon spawn failed: EACCES')} />)

    expect(html).toContain('daemon spawn failed: EACCES')
    expect(html).toContain('vectr-error')
    // The card's action cell inherits `white-space: nowrap`; the error text must opt back in to wrapping.
    expect(html).toContain('white-space:normal')
  })

  it('disables the control and relabels it while a start is in flight', () => {
    const html = renderToHtml(<StartDaemonButtonView {...buttonProps(true, null)} />)

    expect(html).toContain('disabled=""')
    expect(html).toContain('starting…')
    expect(html).not.toMatch(/>start daemon</)
  })

  it('renders the idle control enabled with the `start daemon` label and no error slot', () => {
    const html = renderToHtml(<StartDaemonButtonView {...buttonProps(false, null)} />)

    expect(html).toMatch(/>start daemon</)
    expect(html).not.toContain('disabled')
  })
})

describe('summary strip coherence', () => {
  it('counts a registered-but-not-started row as offline, not as memory-only', () => {
    expect(summarizeWorkspaces([LIVE_VIEW, NOT_STARTED_VIEW] as never)).toEqual({
      total: 2,
      live: 1,
      memoryOnly: 0,
      offline: 1,
    })
  })

  it('keeps the tiles a partition of that list: total === live + memoryOnly + offline', () => {
    const counts = summarizeWorkspaces([LIVE_VIEW, NOT_STARTED_VIEW] as never)

    expect(counts.total).toBe(counts.live + counts.memoryOnly + counts.offline)
  })
})
