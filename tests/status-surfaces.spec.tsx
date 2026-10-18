/**
 * T2 — Unified status surfaces: the drawer and the header capsule must agree.
 *
 * Both surfaces are driven by ONE resolution path (`resolveUnifiedStatus`) plus
 * the canonical mode (`formatMode`). This suite renders BOTH of them headlessly
 * for the same payloads and asserts their output, so a surface that re-derives
 * status from a raw `status.fully_ready` ternary, or compares a raw `mode`
 * string, cannot pass.
 *
 * Rendering is headless (`renderToStaticMarkup` via `./react-render`): effects do
 * not run, so the drawer gets its data through the `state` prop, and the header
 * is rendered through its hook-free presentational path.
 *
 * Layer unwrapped for the header: `ActiveSessionHeaderAction` (fetch + useState,
 * not payload-injectable) -> `HeaderCapsule`. The hook-bound component itself is
 * still rendered once below to prove that wiring survives.
 *
 * @module tests/status-surfaces.spec
 */

import { describe, expect, it } from 'vitest'
import { resolveUnifiedStatus, type SessionVectrState, type VectrMode } from '../src/domain'
import { SessionDrawerModal } from '../src/client/SessionDrawerModal'
import { ActiveSessionHeaderAction, HeaderCapsule } from '../src/client/SessionHeaderAction'
import { renderToHtml } from './react-render'

const WORKSPACE = '/tmp/status-surfaces-ws'
const PORT = 8778

interface StatusFlags {
  fully_ready?: boolean
  reindex_in_progress?: boolean
  embed_model?: string
  indexed_files?: number
  total_chunks?: number
}

interface StatusCase {
  name: string
  live?: boolean
  mode: string
  status?: StatusFlags | null
  reason?: string
  error?: string
  /** The one kind both surfaces must render for this payload. */
  kind: string
  drawerShows: string[]
  drawerHides: string[]
  headerShows: string[]
  headerHides: string[]
}

/**
 * One payload table for both surfaces. `kind` is the shared truth: every string
 * below is the rendering of exactly that kind, so the drawer and the header
 * cannot drift apart without failing.
 */
const CASES: StatusCase[] = [
  {
    name: 'memory-only spelled with a hyphen (the registry wire value)',
    mode: 'memory-only',
    status: { fully_ready: false, reindex_in_progress: true, indexed_files: 42, total_chunks: 99 },
    kind: 'memory_only',
    drawerShows: ['仅记忆 (Memory Only)', 'N/A (仅记忆)', '无代码目录正常工作', '不建索引'],
    drawerHides: ['已就绪 (Ready)', '构建中', '未运行 (Offline)'],
    headerShows: ['Vectr [mem:8778]'],
    headerHides: ['idx:', 'Vectr [8778]'],
  },
  {
    name: 'fully ready while a background re-index runs (the live /home/csy payload)',
    mode: 'full',
    status: { fully_ready: true, reindex_in_progress: true, embed_model: 'BAAI/bge-m3' },
    kind: 'ready',
    drawerShows: ['已就绪 (Ready)', 'Background re-index in progress', 'bge-m3'],
    drawerHides: ['构建中', 'idx:'],
    headerShows: ['Vectr [8778]', 'vectr-indicator-dot vectr-dot-busy', 'Background re-index in progress'],
    headerHides: ['idx:', 'vectr-indicator-dot vectr-dot-live'],
  },
  {
    name: 'not ready with re-index in progress resolves to indexing',
    mode: 'full',
    status: { fully_ready: false, reindex_in_progress: true },
    kind: 'indexing',
    drawerShows: ['构建中'],
    drawerHides: ['已就绪 (Ready)', 'Background re-index in progress'],
    headerShows: ['Vectr [idx:8778]'],
    headerHides: ['vectr-indicator-dot vectr-dot-busy'],
  },
  {
    name: 'fully ready and quiet',
    mode: 'full',
    status: { fully_ready: true, reindex_in_progress: false },
    kind: 'ready',
    drawerShows: ['已就绪 (Ready)'],
    drawerHides: ['构建中', 'Background re-index in progress'],
    headerShows: ['Vectr [8778]', 'vectr-indicator-dot vectr-dot-live'],
    headerHides: ['idx:', 'vectr-indicator-dot vectr-dot-busy'],
  },
  {
    name: 'search only',
    mode: 'search_only',
    status: { fully_ready: true },
    kind: 'search_only',
    drawerShows: ['仅检索 (Search Only)'],
    drawerHides: ['已就绪 (Ready)', '构建中'],
    headerShows: ['Vectr [search:8778]'],
    headerHides: ['idx:'],
  },
  {
    name: 'offline daemon',
    live: false,
    mode: 'full',
    status: null,
    kind: 'offline',
    drawerShows: ['未运行 (Offline)'],
    drawerHides: ['已就绪 (Ready)', '构建中'],
    headerShows: ['Vectr [off]'],
    headerHides: ['idx:'],
  },
  {
    name: 'daemon error',
    mode: 'full',
    status: {},
    error: 'connect ECONNREFUSED 127.0.0.1:8778',
    kind: 'offline',
    drawerShows: ['未运行 (Offline)'],
    drawerHides: ['已就绪 (Ready)', '构建中'],
    headerShows: ['Vectr [err]', 'connect ECONNREFUSED 127.0.0.1:8778'],
    headerHides: ['idx:'],
  },
]

/** Fill a partial payload with the empty expectations the one-off cases ignore. */
function oneCase(partial: Partial<StatusCase> & { mode: string }): StatusCase {
  return {
    name: partial.mode,
    kind: '',
    drawerShows: [],
    drawerHides: [],
    headerShows: [],
    headerHides: [],
    ...partial,
  }
}

/** The exact resolver input both surfaces consume for a case. */
function resolverInput(c: StatusCase) {
  return {
    live: c.live !== false,
    mode: c.mode,
    status: c.status ? c.status : undefined,
    reason: c.reason,
    error: c.error,
  }
}

/**
 * Build the session state exactly as the host delivers it. The `mode` cast is
 * deliberate: the registry emits hyphenated modes (`memory-only`) which the
 * canonical client union `VectrMode` does not model. That mismatch is the bug
 * under test, so the fixture must reproduce it rather than normalise it away.
 *
 * `canReindex` is forced true even for memory-only on purpose — the memory-only
 * affordance must come from the canonical mode, not from the host flag.
 */
function sessionState(c: StatusCase): SessionVectrState {
  const input = resolverInput(c)
  const state: SessionVectrState = {
    workspace: WORKSPACE,
    live: input.live,
    mode: c.mode as VectrMode,
    codebases: [],
    canReindex: true,
  }
  if (input.status) state.status = input.status
  if (input.reason !== undefined) state.reason = input.reason
  if (input.error !== undefined) state.error = input.error
  return state
}

function renderDrawer(state: SessionVectrState | null): string {
  return renderToHtml(
    <SessionDrawerModal
      workspace={WORKSPACE}
      state={state}
      loading={false}
      isOpen={true}
      onClose={() => undefined}
      onRefresh={() => undefined}
    />,
  )
}

function drawerOf(partial: Partial<StatusCase> & { mode: string }): string {
  return renderDrawer(sessionState(oneCase(partial)))
}

function headerOf(partial: Partial<StatusCase> & { mode: string }): string {
  const c = oneCase(partial)
  return renderToHtml(
    <HeaderCapsule
      unifiedStatus={resolveUnifiedStatus(resolverInput(c))}
      port={PORT}
      sessionCwd={WORKSPACE}
      onOpen={() => undefined}
    />,
  )
}

describe('T2 — drawer and header render one resolved status', () => {
  for (const c of CASES) {
    it(`${c.name}: one payload -> kind '${c.kind}' on both surfaces`, () => {
      // The shared truth both surfaces are asserted against.
      expect(resolveUnifiedStatus(resolverInput(c)).kind).toBe(c.kind)

      const drawerHtml = renderDrawer(sessionState(c))
      const headerHtml = headerOf(c)

      for (const text of c.drawerShows) {
        expect(drawerHtml, `drawer should render ${text}`).toContain(text)
      }
      for (const text of c.drawerHides) {
        expect(drawerHtml, `drawer must not render ${text}`).not.toContain(text)
      }
      for (const text of c.headerShows) {
        expect(headerHtml, `header should render ${text}`).toContain(text)
      }
      for (const text of c.headerHides) {
        expect(headerHtml, `header must not render ${text}`).not.toContain(text)
      }
    })
  }
})

describe('T2 — the raw `fully_ready` ternary is gone from the drawer', () => {
  it('shows the ready copy for a fully_ready daemon even while it re-indexes', () => {
    const html = drawerOf({ mode: 'full', status: { fully_ready: true, reindex_in_progress: true } })
    expect(html).toContain('已就绪 (Ready)')
    expect(html).not.toContain('构建中')
    // `idx:` is the header's indexing badge; a fully_ready payload must never
    // produce it on either surface.
    expect(html).not.toContain('idx:')
    expect(headerOf({ mode: 'full', status: { fully_ready: true, reindex_in_progress: true } })).not.toContain('idx:')
  })

  it('shows the indexing copy only when the daemon is genuinely not ready', () => {
    const html = drawerOf({ mode: 'full', status: { fully_ready: false, reindex_in_progress: true } })
    expect(html).toContain('构建中…')
    expect(html).not.toContain('已就绪 (Ready)')
  })

  it('surfaces the background re-index as one extra line, and only when set', () => {
    const withBackground = drawerOf({ mode: 'full', status: { fully_ready: true, reindex_in_progress: true } })
    const quiet = drawerOf({ mode: 'full', status: { fully_ready: true, reindex_in_progress: false } })

    expect(withBackground).toContain('Background re-index in progress')
    expect(quiet).not.toContain('Background re-index in progress')
    // Both are ready: the extra line must not turn into a second status claim.
    expect(withBackground).toContain('已就绪 (Ready)')
    expect(quiet).toContain('已就绪 (Ready)')
  })
})

describe('T2 — mode spelling cannot flip the drawer', () => {
  it('renders a hyphenated `memory-only` identically to the canonical `memory_only`', () => {
    const flags = { indexed_files: 42, total_chunks: 99 }
    const hyphen = drawerOf({ mode: 'memory-only', status: flags })
    const underscore = drawerOf({ mode: 'memory_only', status: flags })

    expect(hyphen).toContain('仅记忆 (Memory Only)')
    expect(hyphen).toBe(underscore)
  })

  it('does not fall back to the code-index metrics for a hyphenated memory-only workspace', () => {
    const html = drawerOf({ mode: 'memory-only', status: { indexed_files: 42, total_chunks: 99 } })
    expect(html).toContain('N/A (仅记忆)')
    expect(html).toContain('无代码目录正常工作')
    expect(html).toContain('不建索引')
    expect(html).not.toContain('>42<')
    expect(html).not.toContain('>99<')
  })
})

describe('T2 — the hook-bound header still renders its capsule', () => {
  it('renders the real capsule component with no fetched state (offline, not a crash)', () => {
    const html = renderToHtml(<ActiveSessionHeaderAction sessionCwd={WORKSPACE} />)
    expect(html).toContain('vectr-header-capsule')
    expect(html).toContain('Vectr [off]')
    expect(html).not.toContain('idx:')
  })
})
