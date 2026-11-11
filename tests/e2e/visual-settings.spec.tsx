/**
 * task-11 — Vectr visual gate.
 *
 * Run:
 *   npx vitest run tests/e2e/visual-settings.spec.tsx
 *   VQA_BASELINE=1 npx vitest run tests/e2e/visual-settings.spec.tsx   # write into artifacts/baseline/
 *   CHROMIUM_BIN=/path/to/chrome  VECTR_HOST_CSS=/path/to/dsh-checkout  VQA_THEME=dark
 *
 * What is real (nothing here is mocked):
 *   markup  – react-dom/server (tests/react-render.ts) renders the SHIPPED components:
 *             WorkspaceConsoleView / WorkspaceCard / DaemonLauncherView / MemoryViewer /
 *             CodebaseModal / SessionDrawerModal / StaticInputRightAction / HeaderCapsule.
 *   CSS     – the shipped VECTR_CSS string from src/client/buttons.tsx, PLUS the host's own
 *             token sheets (design-platform.css / base.css / focus.css / brand-font.css) read
 *             from the running DSH host checkout, so --dsw-alias-* resolve exactly as they do
 *             in the live Settings panel.
 *   browser – chromium through playwright-core (executablePath resolved, no download).
 *
 * Output:
 *   tests/e2e/artifacts/vqa-NN-<scene>-<desktop|phone>.png   1440x900 and 390x844, verified
 *   tests/e2e/artifacts/visual-qa-report.json                the measured numbers
 *   stdout: the same numbers, printed.
 *
 * The host panel at 127.0.0.1:3080 is NOT touched: `/` answers 401 and a screenshot of a
 * login wall would prove nothing. The page under test is assembled here from real components.
 *
 * Gate availability: chromium and the host token sheet are resolved up front. If either is
 * missing the spec FAILS — it writes { ran: false, reason } and throws. A visual gate that
 * skips quietly and still reports green proves nothing, so silence is not an option:
 *   VQA_ALLOW_SKIP=1   opt in to a loud, explicitly-labelled skip
 * Without that variable the missing toolchain is a test failure, not a warning.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { renderToHtml } from '../react-render'
import { VECTR_CSS, VectrStyles } from '../../src/client/buttons'
import { WorkspaceConsoleView } from '../../src/client/index'
import { DaemonLauncherView, type StartAllResponse } from '../../src/client/DaemonLauncher'
import { MemoryViewer, MemoryNoteListView } from '../../src/client/MemoryViewer'
import { CodebaseModal } from '../../src/client/CodebaseModal'
import { SessionDrawerModal } from '../../src/client/SessionDrawerModal'
import { StaticInputRightAction } from '../../src/client/ConversationInputRightAction'
import { HeaderCapsule } from '../../src/client/SessionHeaderAction'
import { resolveUnifiedStatus } from '../../src/domain/rules'
import type { SessionVectrState } from '../../src/domain/types'

/* ------------------------------------------------------------------ environment */

const HERE = dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = join(HERE, 'artifacts')
const OUT_DIR = process.env.VQA_BASELINE === '1' ? join(ARTIFACTS, 'baseline') : ARTIFACTS
const REPORT_PATH = join(
  ARTIFACTS,
  process.env.VQA_BASELINE === '1' ? 'visual-qa-report-baseline.json' : 'visual-qa-report.json',
)

/** Viewports the gate is measured at: a desktop settings panel and a small phone. */
const VIEWPORTS = [
  { key: 'desktop', width: 1440, height: 900 },
  { key: 'phone', width: 390, height: 844 },
] as const
type ViewportKey = (typeof VIEWPORTS)[number]['key']

const THEME = process.env.VQA_THEME === 'dark' ? 'dark' : 'light'

/** Chromium: the harness has no /usr/bin/chromium, so resolve any real binary we can find. */
function resolveChromium(): string | null {
  const envBin = process.env.CHROMIUM_BIN
  if (envBin !== undefined && existsSync(envBin)) return envBin
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  const cache = join(process.env.HOME ?? '', '.cache', 'ms-playwright')
  if (existsSync(cache)) {
    const dirs = readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const d of dirs) {
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = join(cache, d, rel)
        if (existsSync(p)) return p
      }
    }
  }
  return null
}

/**
 * The host token sheets. Ranked so the sheet that actually defines the accent alias
 * (--dsw-alias-state-done-primary, the violet the panel is built on) wins: only the
 * running host (0.2.2-rc.1) has it, older 0.2.x checkouts do not.
 */
function resolveHostCss(): { dir: string; version: string; hasAccent: boolean } | null {
  const roots: string[] = []
  const envRoot = process.env.VECTR_HOST_CSS
  if (envRoot !== undefined) roots.push(envRoot)
  const base = '/home/csy/Code/installer'
  if (existsSync(base)) {
    for (const d of readdirSync(base)) roots.push(join(base, d))
  }
  const scored: Array<{ dir: string; version: string; hasAccent: boolean; rank: number }> = []
  for (const root of roots) {
    const styles = join(root, 'packages', 'client', 'ui-theme', 'src', 'styles')
    const sheet = join(styles, 'design-platform.css')
    if (!existsSync(sheet)) continue
    let version = 'unknown'
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }
      version = pkg.version ?? 'unknown'
    } catch {
      /* keep 'unknown' */
    }
    const css = readFileSync(sheet, 'utf8')
    const hasAccent = css.includes('--dsw-alias-state-done-primary:')
    scored.push({ dir: styles, version, hasAccent, rank: envRoot !== undefined && root === envRoot ? 3 : hasAccent ? 2 : 1 })
  }
  scored.sort((a, b) => b.rank - a.rank)
  const best = scored[0]
  return best === undefined ? null : { dir: best.dir, version: best.version, hasAccent: best.hasAccent }
}

/** Inline the host sheets; @font-face urls become file:// so Montserrat really loads offline. */
function hostStyleTags(stylesDir: string): string {
  const parts: string[] = []
  for (const [name, required] of [
    ['design-platform.css', true],
    ['base.css', false],
    ['focus.css', false],
    ['brand-font.css', false],
  ] as const) {
    const p = join(stylesDir, name)
    if (!existsSync(p)) {
      if (required) throw new Error(`host token sheet missing: ${p}`)
      console.warn(`[visual-qa] host sheet missing, skipped: ${p}`)
      continue
    }
    const css = readFileSync(p, 'utf8').replace(/url\(\.?\/?([^)'"]+\.woff2)\)/g, `url("file://${stylesDir}/$1")`)
    parts.push(`/* ---- host: ${name} ---- */\n${css}`)
  }
  return `<style>\n${parts.join('\n')}\n</style>`
}

/* ------------------------------------------------------------------ fixtures */

const noop = (): void => undefined

const WS_VIEWS = [
  {
    workspace: '/home/dev/alpha',
    port: 7411,
    pid: 101,
    mode: 'full',
    live: true,
    registered: true,
    title: 'alpha',
    status: {
      indexed_files: 1284,
      total_chunks: 9021,
      languages: [
        { language: 'typescript', files: 812, chunks: 6010, symbols: 1420 },
        { language: 'rust', files: 143, chunks: 1980, symbols: 402 },
      ],
      last_indexed: '2026-11-11T02:41:00Z',
      notes_count: 14,
      fully_ready: true,
    },
  },
  {
    workspace: '/home/dev/beta',
    port: 7412,
    mode: 'memory-only',
    live: true,
    registered: true,
    title: 'beta',
    status: { indexed_files: 0, total_chunks: 0, notes_count: 6, fully_ready: true, last_indexed: '2026-11-10T18:02:00Z' },
  },
  {
    workspace: '/home/dev/gamma',
    port: 7413,
    mode: 'full',
    live: false,
    registered: false,
    title: 'gamma',
    reason: 'PORT_CLOSED',
    error: 'daemon not alive: PORT_CLOSED',
    status: { fully_ready: false },
  },
]

const CB_VIEWS = [
  {
    id: 'cb-1',
    slug: 'alpha-primary',
    type: 'local' as const,
    path: '/home/dev/alpha',
    serverName: 'vectr-alpha',
    status: 'up' as const,
    workspace: '/home/dev/alpha',
    isPrimary: true,
  },
  {
    id: 'cb-2',
    slug: 'vnm_gui',
    type: 'remote' as const,
    path: '/home/dev/remote/vnm_gui',
    host: 'conan',
    serverName: 'vectr-conan',
    localPort: 8760,
    remotePort: 8760,
    status: 'down' as const,
    error: 'tunnel not established',
    workspace: '/home/dev/alpha',
  },
]

const consoleView = (over: Record<string, unknown>): string =>
  renderToHtml(
    <div className="vectr-settings">
      <VectrStyles />
      <WorkspaceConsoleView
        wsViews={WS_VIEWS}
        cbViews={CB_VIEWS}
        wsError={null}
        cbError={null}
        loading={false}
        flash={null}
        busyPort={null}
        busySlug={null}
        expanded={new Set<string>(['ws:/home/dev/alpha'])}
        onRefresh={noop}
        onToggle={noop}
        onReindex={noop}
        onTest={noop}
        onStart={noop}
        onDelete={noop}
        {...over}
      />
    </div>,
  )

const drawerState = (kind: 'ready' | 'memory_only' | 'offline'): SessionVectrState => {
  const state: SessionVectrState = {
    workspace: '/home/dev/alpha',
    live: kind !== 'offline',
    mode: kind === 'memory_only' ? ('memory-only' as SessionVectrState['mode']) : 'full',
    port: kind === 'offline' ? undefined : 7411,
    pid: kind === 'offline' ? undefined : 101,
    codebases: [
      { slug: 'alpha-primary', type: 'local', status: 'up', isPrimary: true },
      { slug: 'vnm_gui', type: 'remote', status: 'down', error: 'tunnel not established' },
    ],
    canReindex: true,
  }
  if (kind !== 'offline') {
    state.status = {
      indexed_files: 1284,
      total_chunks: 9021,
      languages: [{ language: 'typescript', files: 812, chunks: 6010, symbols: 1420 }],
      notes_count: 14,
      fully_ready: true,
      last_indexed: '2026-11-11T02:41:00Z',
    }
  } else {
    state.reason = 'PORT_CLOSED'
    state.error = 'daemon not alive: PORT_CLOSED'
  }
  return state
}

const startAllResult = (): StartAllResponse => ({
  ok: true,
  started: 2,
  alreadyRunning: 1,
  failed: 1,
  results: [
    { workspace: '/home/dev/alpha', port: 7411, status: 'started' },
    { workspace: '/home/dev/beta', port: 7412, status: 'already-running' },
    { workspace: '/home/dev/gamma', port: null, status: 'failed', error: 'address already in use: 7413' },
  ],
})

/* Fixture for the Memory tab: the shape of a real `vectr_recall` full-detail render — one index
 * line per note plus its body — long enough that a 390x844 sheet cannot show it in one screen.
 * Fixture data in exactly the sense WS_VIEWS above is fixture data: no daemon is contacted, and
 * nothing here pretends to be this workspace's real memory. */
const RECALL_FIXTURE = [
  '# Working Notes — index (18 entries; use vectr_recall(note_id=N) to expand)',
  '',
  '[#159] finding/medium (layout-reviewer) · task-15 residual findings: gate skip path, scrollSheet coverage, nested scrollport sink  (3m ago)',
  '  A capped box inside a scrolling sheet eats the wheel: with the pointer parked over it the inner list scrolled 0->862 while the sheet stayed at 0.',
  '',
  '[#158] finding/high (layout-reviewer) · task-15 review verdict: sheet layout APPROVED with evidence  (3m ago)',
  '  Card = screen at 390x844 (390x844@0,0, radius 0), body clientHeight 414 < scrollHeight 566, driven to 152/152 with the last control inside the box.',
  '',
  '[#157] decision/high · 为什么用共享 sheet 布局修手机 Init 不可达（而不是页面滚动或砍内容）  (27m ago)',
  '  One scroll layer per sheet keeps the head, metric grid and tab strip fixed; page-level scrolling would move the backdrop and the tab row with it.',
  '',
  '[#156] finding/high (layout-refactor) · 滚动可达性必须用真实 wheel 驱动，不能用 scrollTop 赋值  (35m ago)',
  '  el.scrollTop = el.scrollHeight works on an overflow:hidden box in Chromium, so a scripted scroll proves nothing; hit-tested wheel input does.',
  '',
  '[#155] finding/high (layout-refactor) · Sheet layout root fix: .vectr-sheet-body scroll layer + phone full-bleed  (36m ago)',
  '  A flex item\'s automatic minimum is its min-content: the old inline minHeight:320 kept the body taller than the card clip, so Init never reached.',
  '',
  '[#154] finding/high · task-12 UI 对抗审查 APPROVE：守卫/视觉门变异验证 + 降级按钮与 icon id 证据  (7h ago)',
  '  Mutation checks: flip the guard back, the gate must fail; flip the stylesheet rule back, the visual assertions must fail.',
  '',
  '[#119] finding/medium (settings-icon-wire) · SettingsSectionRow.icon wired via slot-options cast  (17d ago)',
  '  The host slot accepts a narrower option shape than the row renders; the cast is at the slot boundary, not inside the row.',
  '',
  '[#92] task/high (lead) · DELIVERED (f8fa29d): use-flow README with real screenshots, rest trimmed  (22d ago)',
  '',
  '[#63] gotcha/medium (settings-ui) · T23: disabled card action — nowrap head + token-painted disabled state (not opacity)  (23d ago)',
  '  opacity on a dense row reads as a rendering bug to the host theme; the disabled state has to be painted with the state tokens.',
  '',
  '[#52] finding/high (ui-verifier) · T15: D1/D2/D3 all PASS on redeployed 3088 build  (24d ago)',
  '  languages real names, sticky pinned 302->302, memory_only visible unscrolled — measured on the deployed bundle, not a local render.',
  '',
  '[#48] finding/medium (settings-ui) · T10: Settings→Vectr table is 11 columns, minWidth 680, bounded scrollport  (24d ago)',
  '  The table is wider than the panel on purpose; .vectr-scroll hands the overflow sideways instead of compressing the columns.',
  '',
  '[#45] finding/high (ui-verifier) · T9: Settings→Vectr live render on 3088 — nav path, class names, capsule defect  (24d ago)',
  '  languages-column rendered "[object Object]" — the cell rendered the language record instead of its name.',
].join('\n')

const RESUME_FIXTURE = [
  '# Resume — pick up where you left off',
  '',
  'Last task  : task-16 手机端去掉 sheet 内嵌套滚动陷阱（Memory 列表）',
  'Snapshot   : sheet-layout-task14 (2026-11-11T23:58:00Z)',
  'Open gotchas (4):',
  '  [src/client/buttons.tsx]  .vectr-scrollport 的 max-height 必须能在手机媒体查询里被取消，否则内层吃掉滚轮。',
  '  [tests/e2e/visual-settings.spec.tsx]  视觉门走 SSR，不跑 effects：需要数据必须由组件从 props 拿到。',
  '  [src/client/SessionDrawerModal.tsx]  initialTab 是视觉门进入非默认面板的唯一入口，默认值不能被改。',
  '  [package.json]  视觉门不允许新增依赖：react-dom 从本地 dsh checkout 里取。',
  'Snapshots (3): sheet-layout-task14, visual-gate-mutation, memory-only-downgrade',
].join('\n')

/* ------------------------------------------------------------------ scenes */

interface Scene {
  name: string
  body: string
  /** Scroll the sheet body to its bottom after the resting shot and take a second artifact.
   *  Used by the panel that is taller than a phone screen (task-14's Init tab). */
  scrollSheet?: boolean
  /** Assert the sheet invariants (one bounded scroll layer, the phone full-bleed frame, no
   *  capped nested box) without driving this sheet to its bottom. */
  sheetCheck?: boolean
  /** Park the wheel on the nested note list and record which layer actually moved. */
  nestedProbe?: boolean
}

const scenes: Scene[] = [
  {
    name: '01-panel-ready',
    body: consoleView({}),
  },
  {
    name: '02-panel-states',
    body: [
      '<div class="vectr-settings">',
      renderToHtml(<VectrStyles />),
      '<section class="vx-block"><p class="vectr-eyebrow">loading (first paint)</p>',
      consoleView({ wsViews: null, cbViews: null, loading: true }),
      '</section>',
      '<section class="vx-block"><p class="vectr-eyebrow">empty (no workspace yet)</p>',
      consoleView({ wsViews: [], cbViews: [] }),
      '</section>',
      '<section class="vx-block"><p class="vectr-eyebrow">error (daemon list failed)</p>',
      consoleView({ wsViews: null, cbViews: null, wsError: 'daemon list failed: ECONNREFUSED 127.0.0.1:7413' }),
      '</section>',
      '</div>',
    ].join('\n'),
  },
  {
    name: '03-memory-ops',
    body: [
      '<div class="vectr-settings">',
      renderToHtml(<VectrStyles />),
      '<section class="vx-block"><p class="vectr-eyebrow">working memory</p>',
      renderToHtml(<MemoryViewer workspace="/home/dev/alpha" port={7411} live={true} />),
      '</section>',
      '<section class="vx-block"><p class="vectr-eyebrow">daemon launcher (1 failure)</p>',
      renderToHtml(<DaemonLauncherView busy={false} data={startAllResult()} error={null} onRun={noop} />),
      '</section>',
      '<section class="vx-block"><p class="vectr-eyebrow">daemon launcher (transport error)</p>',
      renderToHtml(
        <DaemonLauncherView busy={false} data={null} error="start-all endpoint returned 503" onRun={noop} />,
      ),
      '</section>',
      '<section class="vx-block"><p class="vectr-eyebrow">conversation input action</p>',
      renderToHtml(<StaticInputRightAction workspace="/home/dev/alpha" />),
      '</section>',
      '</div>',
    ].join('\n'),
  },
  {
    name: '04-codebase-modal',
    body: [
      '<div class="vectr-settings">',
      renderToHtml(<VectrStyles />),
      consoleView({}),
      renderToHtml(
        <CodebaseModal workspace="/home/dev/alpha" isOpen={true} onClose={noop} onSuccess={noop} />,
      ),
      '</div>',
    ].join('\n'),
  },
  {
    name: '05-session-drawer',
    body: [
      '<div class="vectr-settings">',
      renderToHtml(<VectrStyles />),
      renderToHtml(
        <HeaderCapsule
          unifiedStatus={resolveUnifiedStatus({ live: true, mode: 'full', status: { fully_ready: true }, port: 7411 })}
          port={7411}
          sessionCwd="/home/dev/alpha"
          onOpen={noop}
        />,
      ),
      renderToHtml(
        <SessionDrawerModal
          workspace="/home/dev/alpha"
          state={drawerState('ready')}
          loading={false}
          isOpen={true}
          onClose={noop}
          onRefresh={noop}
        />,
      ),
      '</div>',
    ].join('\n'),
  },
  {
    /* The degraded half of that header: a daemon that is live but running in working
     * memory with no persistent index, which is what the warn-filled chip is for. Without
     * this scene the warn fill would only ever be asserted in source and never measured on
     * a render. */
    name: '06-session-drawer-memory-only',
    body: [
      '<div class="vectr-settings">',
      renderToHtml(<VectrStyles />),
      renderToHtml(
        <HeaderCapsule
          unifiedStatus={resolveUnifiedStatus({
            live: true,
            mode: 'memory-only',
            status: { fully_ready: false },
            port: 7411,
          })}
          port={7411}
          sessionCwd="/home/dev/beta"
          onOpen={noop}
        />,
      ),
      renderToHtml(
        <SessionDrawerModal
          workspace="/home/dev/beta"
          state={drawerState('memory_only')}
          loading={false}
          isOpen={true}
          onClose={noop}
          onRefresh={noop}
        />,
      ),
      '</div>',
    ].join('\n'),
  },
  {
    /* task-14 — the phone complaint itself. '维护与初始化 (Init)' is the tallest panel in the
     * drawer and 390x844 is the viewport where it used to be cut off, so the gate renders it
     * open on that tab. SSR markup only (nothing is hydrated), so initialTab is the only way
     * to land there without faking the DOM. Rendered from the offline daemon state on purpose:
     * it is the fullest version of the panel — the start-daemon row is up alongside the
     * reindex and init blocks, which is what makes the scroll assertion non-trivial. */
    name: '07-session-drawer-init',
    scrollSheet: true,
    body: [
      '<div class="vectr-settings">',
      renderToHtml(<VectrStyles />),
      renderToHtml(
        <SessionDrawerModal
          workspace="/home/dev/alpha"
          state={drawerState('offline')}
          loading={false}
          isOpen={true}
          onClose={noop}
          onRefresh={noop}
          initialTab="ops"
        />,
      ),
      '</div>',
    ].join('\n'),
  },
  {
    /* The Memory tab as the drawer itself mounts it: SessionDrawerModal renders MemoryViewer, and
     * initialTab is the only way the gate lands on it (SSR markup, nothing hydrated — the same
     * seam scene 07 uses for the Init tab). Rendered from the live daemon state, because that is
     * the version with the recall form up. This is the empty-state half: no note list exists yet,
     * so the sheet must own exactly one scroll layer here. */
    name: '08-session-drawer-memory',
    sheetCheck: true,
    body: [
      '<div class="vectr-settings">',
      renderToHtml(<VectrStyles />),
      renderToHtml(
        <SessionDrawerModal
          workspace="/home/dev/alpha"
          state={drawerState('ready')}
          loading={false}
          isOpen={true}
          onClose={noop}
          onRefresh={noop}
          initialTab="memory"
        />,
      ),
      '</div>',
    ].join('\n'),
  },
  {
    /* The Memory tab with its note lists actually filled in — the shape task-15's review found
     * untested (no scene ever instantiated .vectr-scrollport) and the one that acted as a scroll
     * sink on a phone. MemoryViewer is the shipped panel, rendered from the live daemon state;
     * MemoryNoteListView is the component it renders for BOTH sub-tabs once a daemon answers,
     * shown here in its filled state because renderToStaticMarkup never runs the fetch
     * (tests/react-render.ts). The backdrop + card + sheet-body divs mirror the wrapper
     * SessionDrawerModal renders (it builds its own sheet and cannot be handed a child); every
     * element inside them is shipped markup. The wheel is then parked ON the list, where a thumb
     * reading notes lands. */
    name: '09-memory-list-in-sheet',
    nestedProbe: true,
    body: [
      '<div class="vectr-settings">',
      renderToHtml(<VectrStyles />),
      '<section class="vx-block"><p class="vectr-eyebrow">note list inside a sheet</p>',
      '<div class="vectr-modal-backdrop" role="dialog" aria-modal="true" aria-label="Working memory">',
      '<div class="vectr-modal-card">',
      '<div class="vectr-sheet-body">',
      renderToHtml(<MemoryViewer workspace="/home/dev/alpha" port={7411} live={true} />),
      renderToHtml(<MemoryNoteListView text={RECALL_FIXTURE} />),
      renderToHtml(<MemoryNoteListView text={RESUME_FIXTURE} variant="resume" />),
      '</div>',
      '</div>',
      '</div>',
      '</section>',
      '</div>',
    ].join('\n'),
  },
]

/** Scenes that MUST expose a sheet scroll layer: for these a missing .vectr-sheet-body is a
 *  defect, not a scene that happens not to contain a modal. */
const SHEET_SCENES = new Set(
  scenes.filter((s) => s.scrollSheet === true || s.sheetCheck === true || s.nestedProbe === true).map((s) => s.name),
)

/** Scenes where the wheel is driven from inside the nested note list instead of the sheet. */
const NESTED_SCENES = new Set(scenes.filter((s) => s.nestedProbe === true).map((s) => s.name))

/* ------------------------------------------------------------------ page assembly */

/**
 * Harness chrome (NOT product CSS): the Settings-panel container the host would put the
 * panel inside, plus the host body defaults. Kept to 6 declarations so nothing here can
 * mask a defect in VECTR_CSS.
 */
const CHROME_CSS = `
.vx-stage { min-height: 100vh; padding: 24px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); font-size: 13px; box-sizing: border-box; }
.vx-block { margin-bottom: 28px; }
`

function pageHtml(styles: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vectr visual QA</title>
${styles}
<style>${CHROME_CSS}</style>
<style>${VECTR_CSS}</style>
</head>
<body${THEME === 'dark' ? ' data-ds-dark-theme' : ''}>
<div class="vx-stage">
${body}
</div>
</body>
</html>`
}

/* ------------------------------------------------------------------ measurements (run inside chromium) */

interface ControlMetric {
  tag: string
  cls: string
  label: string
  h: number
  w: number
  disabled: boolean
  /** true when a radio/checkbox was measured through the label that wraps it. */
  viaLabel: boolean
}

interface FocusMetric {
  tag: string
  cls: string
  outlineStyle: string
  outlineWidth: string
  outlineColor: string
  focusVisible: boolean
}

interface ContrastMetric {
  text: string
  cls: string
  fontSize: number
  fontWeight: number
  color: string
  bg: string
  ratio: number
  exempt: string
}

interface MotionMetric {
  sel: string
  animationName: string
  animationDuration: string
  transitionProperty: string
  transitionDuration: string
}

/**
 * A selector counts as motion-reduced when nothing can move: no animation, or an animation
 * with a zero duration, and no transition with a non-zero duration. transition-property is
 * `all` by default even when nothing was declared, so durations are the only honest read.
 */
function motionNeutral(m: MotionMetric): boolean {
  const animOff = m.animationName === 'none' || m.animationDuration === '0s'
  const transOff = m.transitionDuration === '0s' || m.transitionProperty === 'none'
  return animOff && transOff
}

/** A selector counts as carrying motion when something can actually move. */
function motionLive(m: MotionMetric): boolean {
  return (m.animationName !== 'none' && m.animationDuration !== '0s') || m.transitionDuration !== '0s'
}

interface OverflowMetric {
  docScrollWidth: number
  docClientWidth: number
  docScrollHeight: number
  viewportHeight: number
  offenders: Array<{ sel: string; scrollWidth: number; clientWidth: number }>
  /** Wrappers that overflow their own box but sit inside a deliberate scrollport: the
   * scrollport is what the user scrolls, so the page never runs sideways. Printed, not
   * asserted. */
  insideScrollport: Array<{ sel: string; scrollWidth: number; clientWidth: number }>
  ellipsisClipped: Array<{ sel: string; scrollWidth: number; clientWidth: number }>
}

interface VisibilityMetric {
  /** Characters of real text whose box intersects the viewport the screenshot is taken at.
   * A scene that renders nothing inside the viewport would screenshot as a white page and
   * still pass every numeric assertion, so this is measured and gated. */
  inViewportChars: number
  totalChars: number
  /** Rects of the scene's key containers, to show where the render actually landed. */
  regions: Array<{ sel: string; x: number; y: number; w: number; h: number }>
}

interface TokenReport {
  /** Alias painted with no literal fallback that the host stylesheet does not define. */
  deadNoFallback: string[]
  /** Same, but the use site carries a literal fallback, so the paint survives. */
  deadWithFallback: string[]
}

interface SceneReport {
  scene: string
  viewport: string
  png: string
  pngWidth: number
  pngHeight: number
  /** The sheet layout as measured at its resting (top) scroll position. */
  sheet: SheetMetric
  /** For a scrollSheet scene: the same surface scrolled to its bottom, plus that artifact. */
  pngBottom?: string | undefined
  pngBottomWidth?: number | undefined
  pngBottomHeight?: number | undefined
  sheetBottom?: SheetMetric | undefined
  /** For a nestedProbe scene: what a real wheel parked on the note list actually moved. */
  nested?: NestedScrollProbe | undefined
  /** For a nestedProbe scene: the artifact taken after that wheel drive. */
  pngWheel?: string | undefined
  pngWheelWidth?: number | undefined
  pngWheelHeight?: number | undefined
  overflow: OverflowMetric
  visibility: VisibilityMetric
  controls: ControlMetric[]
  focusables: number
  focus: FocusMetric[]
  motion: MotionMetric[]
  motionNormal: MotionMetric[]
  strays: Array<{ sel: string; animationName: string }>
  contrast: { checked: number; min: number; worst: ContrastMetric[]; failures: ContrastMetric[]; pills: ContrastMetric[] }
  tokens: TokenReport
  accent: {
    vxOnBody: string
    vxOnMark: string
    markColor: string
    markPresent: boolean
    markMatchesAccent: boolean
  }
  fonts: {
    status: string
    montserrat500: boolean
    montserrat400: boolean
    faces: string[]
    computedFamily: string
    computedControlFamily: string
    /** What the eyebrow and the metric numerals actually compute to — the brand face
     * must show up here, not just be declared in the sheet. */
    eyebrowFamily: string
    metricFamily: string
    /** Whether the scene mounted the element at all — scenes differ, and an assertion
     * about a rule that is not in the page would prove nothing. */
    eyebrowPresent: boolean
    metricPresent: boolean
    /** Computed family of a body-text element and of a control: neither may have picked
     * up the display face. */
    bodyFamily: string
  }
  consoleErrors: string[]
  pageErrors: string[]
}

const MIN_CONTROL_HEIGHT = 28
const MIN_CONTRAST = 4.5

/**
 * Out-of-scope defects this gate cannot fix by itself. They are recorded and printed on
 * every run (and written into the report) rather than silently allowed: each one names
 * the file that owns it. index.tsx / vectr-settings.tsx belong to task-10 and are off
 * limits to this harness, so the finding goes to the Lead instead of an edit.
 */
const KNOWN_DEFECTS: Record<string, string> = {
  /* Cleared by task-13. The one entry here exempted
   * src/client/index.tsx's "Primary" badge painting background --dsw-alias-brand-tertiary,
   * an alias no host stylesheet defines (grep -rn -- "--dsw-alias-brand-tertiary" over the
   * deepseek-harness-0.2.2-rc.1 checkout returns 0 hits, against brand-primary /
   * -invert / -new-… at design-platform.css:200-202 light and :324-326 dark). The badge is
   * now a label-tertiary hairline tag, so nothing paints the phantom alias and there is
   * nothing to exempt. An entry left here after the fix would be an open door: the next
   * badge built on the same token would pass the gate silently. */
}

/**
 * Contrast failures owned by files this harness is not allowed to edit. Keyed by
 * `class|foreground colour` so an exemption is a named, countable thing printed in full on
 * every run — never a way to make a number go away. An unlisted failure still fails the gate.
 */
const KNOWN_CONTRAST: Record<string, string> = {
  /* Cleared by task-13. The one entry here exempted `(no class)|rgb(34, 197, 94)`:
   * src/client/index.tsx's StatusPill painting the word "up" with
   * --dsw-alias-state-success-primary (green-500, 2.28:1 on the light panel — the gate
   * measured 2.28:1 in all four scenes that render a codebase row). StatusPill now paints
   * the word with the label aliases and moves green-500 / red-600 into the decorative dot,
   * so "up"/"down" must show up as a contrast failure again if the colour ever goes back
   * onto the text: with this map empty, `contrastOwned` has nothing to absorb it. */
}

/** PNG IHDR width/height — objective proof of the screenshot dimensions. */
function pngSize(path: string): { width: number; height: number } {
  const buf = readFileSync(path)
  if (buf.length < 24 || buf.subarray(1, 4).toString('ascii') !== 'PNG') {
    throw new Error(`not a PNG (or too small): ${path} (${buf.length} bytes)`)
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/* ------------------------------------------------------------------ sheet measurement */

/** Phone touch-target floor (WCAG 2.5.5 / Apple HIG): 44px on the smaller axis. */
const MIN_TOUCH_HEIGHT = 44

interface SheetMetric {
  found: boolean
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** More content than room: the scrollport has something to scroll. */
  scrollable: boolean
  /** The card that owns this scroll layer, and whether it is the frame or the screen. */
  cardRect: { x: number; y: number; w: number; h: number }
  cardCls: string
  cardRadius: string
  viewportW: number
  viewportH: number
  /** The last enabled focusable control inside the scrollport in DOM order — the thing a
   * user has to scroll to reach. If THAT one is reachable, everything above it is. */
  lastControl: string | null
  lastControlRect: { top: number; bottom: number; left: number; right: number } | null
  /** …sits fully inside the scrollport's own visible box… */
  lastControlInside: boolean
  /** …and inside the visual viewport, so it can actually be seen and tapped. */
  lastControlInViewport: boolean
  /** Enabled controls still hanging below the scrollport's bottom edge at this position.
   * Empty after scrolling to the bottom == the whole panel is reachable. */
  belowFold: string[]
  /** Enabled controls inside the sheet smaller than the touch floor (radio/checkbox measured
   * through their label, the way a thumb actually aims at them). */
  smallTargets: string[]
  /** Every scroll layer the sheet owns (its body plus any nested list). A nested one that
   * does not contain its overscroll hands the scroll to the layer above it — the phone
   * "which layer did I just grab?" failure. */
  scrollLayers: Array<{ cls: string; overscroll: string; room: number }>
  /** Boxes INSIDE the card that can scroll vertically and are capped by a max-height. A capped
   * nested box is a wheel sink: the flick lands on it, it scrolls, and the sheet behind it never
   * moves. A phone sheet has to own none of them — .vectr-sheet-body is the one layer a thumb
   * is aiming at. Desktop is allowed to have them (a pointer wheel over a nested box is normal). */
  cappedLayers: Array<{ cls: string; maxHeight: string; overflowY: string; room: number }>
  /** What the SHIPPED stylesheet declares for the two sheet scroll selectors. A nested list
   * only exists once a daemon answers, so the containment of its rule is checked where it can
   * always be checked: the CSSOM. */
  declaredLayers: Array<{ sel: string; overscroll: string }>
  /** Proof the page did not move: only the sheet scrolled. */
  docScrollTop: number
  docScrollLeft: number
  docScrollHeight: number
}

/** Read the sheet out of the live layout: one bounded scroll layer, its card, the control at
 * the end of it, and the document's own scroll position. */
async function measureSheet(page: import('playwright-core').Page): Promise<SheetMetric> {
  return page.evaluate((minTouch: number) => {
    const empty: SheetMetric = {
      found: false,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      scrollable: false,
      cardRect: { x: 0, y: 0, w: 0, h: 0 },
      cardCls: '',
      cardRadius: '',
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      lastControl: null,
      lastControlRect: null,
      lastControlInside: false,
      lastControlInViewport: false,
      belowFold: [],
      smallTargets: [],
      scrollLayers: [],
      cappedLayers: [],
      declaredLayers: [],
      docScrollTop: 0,
      docScrollLeft: 0,
      docScrollHeight: 0,
    }
    const body = document.querySelector('.vectr-sheet-body')
    const card = body !== null ? body.closest('.vectr-modal-card') : null
    if (body === null || card === null) return empty

    const labelOf = (el: Element): string => {
      const html = el as HTMLElement
      const cls = typeof html.className === 'string' && html.className !== '' ? `.${html.className.trim().split(/\s+/).join('.')}` : ''
      const text =
        (el.textContent ?? '').trim() ||
        el.getAttribute('aria-label') ||
        (el as HTMLInputElement).placeholder ||
        (el.closest('label')?.textContent ?? '').trim() ||
        ''
      return `${el.tagName.toLowerCase()}${cls} "${text.slice(0, 40)}"`
    }

    // Enabled, painted focusables only: a disabled control is not one a user has to reach,
    // and a zero-box one is not one they can aim at.
    const focusables = Array.from(
      body.querySelectorAll('button, input, select, a[href], [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && (el as HTMLButtonElement).disabled !== true
    })

    const bRect = body.getBoundingClientRect()
    const cRect = card.getBoundingClientRect()
    const doc = document.scrollingElement ?? document.documentElement

    const scrollLayers = Array.from(card.querySelectorAll('.vectr-sheet-body, .vectr-scrollport')).map((el) => ({
      cls: (el as HTMLElement).className.trim(),
      overscroll: getComputedStyle(el).overscrollBehavior,
      room: el.scrollHeight - el.clientHeight,
    }))

    // Any box INSIDE the card that can scroll vertically and is capped by a max-height, however
    // the cap got there (class or inline). This is the wheel-sink shape: the flick lands on the
    // capped box, it scrolls, and the sheet behind it stays put.
    const cappedLayers = Array.from(card.querySelectorAll<HTMLElement>('.vectr-modal-card *'))
      .filter((el) => {
        const cs = getComputedStyle(el)
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && cs.maxHeight !== 'none'
      })
      .map((el) => {
        const cs = getComputedStyle(el)
        return {
          cls: el.className.trim() || el.tagName.toLowerCase(),
          maxHeight: cs.maxHeight,
          overflowY: cs.overflowY,
          room: el.scrollHeight - el.clientHeight,
        }
      })

    // The stylesheet's own claim about the two sheet scroll selectors. VECTR_CSS is injected
    // twice on this page (the gate injects it and <VectrStyles /> does), so keep one entry per
    // selector and let a non-containing declaration win over a containing one.
    const wanted = ['.vectr-scrollport', '.vectr-sheet-body']
    const declared = new Map<string, string>()
    for (const styleSheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList
      try {
        rules = styleSheet.cssRules
      } catch {
        // A cross-origin sheet throws here; this page only injects its own, so skipping is
        // skipping a sheet we could not read, not skipping a defect.
        continue
      }
      for (const rule of Array.from(rules)) {
        const styleRule = rule as CSSStyleRule
        if (typeof styleRule.selectorText !== 'string' || !wanted.includes(styleRule.selectorText)) continue
        const value = styleRule.style.overscrollBehavior === '' ? '(not declared)' : styleRule.style.overscrollBehavior
        const seen = declared.get(styleRule.selectorText)
        if (seen === undefined || seen === 'contain') declared.set(styleRule.selectorText, value)
      }
    }
    const declaredLayers = Array.from(declared, ([sel, overscroll]) => ({ sel, overscroll }))

    const smallTargets: string[] = []
    for (const el of focusables) {
      const input = el as HTMLInputElement
      const target = input.type === 'radio' || input.type === 'checkbox' ? (el.closest('label') ?? el) : el
      const h = target.getBoundingClientRect().height
      if (h < minTouch) smallTargets.push(`${labelOf(el)} ${Math.round(h * 100) / 100}px`)
    }

    const belowFold: string[] = []
    for (const el of focusables) {
      if (el.getBoundingClientRect().bottom > bRect.bottom + 1) belowFold.push(labelOf(el))
    }

    const last = focusables.length > 0 ? (focusables[focusables.length - 1] as HTMLElement) : null
    const lr = last !== null ? last.getBoundingClientRect() : null

    return {
      found: true,
      scrollTop: Math.round(body.scrollTop),
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      scrollable: body.scrollHeight > body.clientHeight,
      cardRect: {
        x: Math.round(cRect.x),
        y: Math.round(cRect.y),
        w: Math.round(cRect.width),
        h: Math.round(cRect.height),
      },
      cardCls: typeof card.className === 'string' ? card.className.trim() : '',
      cardRadius: getComputedStyle(card).borderRadius,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      lastControl: last !== null ? labelOf(last) : null,
      lastControlRect:
        lr !== null
          ? { top: Math.round(lr.top), bottom: Math.round(lr.bottom), left: Math.round(lr.left), right: Math.round(lr.right) }
          : null,
      lastControlInside:
        lr !== null &&
        lr.top >= bRect.top - 1 &&
        lr.bottom <= bRect.bottom + 1 &&
        lr.left >= bRect.left - 1 &&
        lr.right <= bRect.right + 1,
      lastControlInViewport:
        lr !== null && lr.top >= -1 && lr.bottom <= window.innerHeight + 1 && lr.right <= window.innerWidth + 1,
      belowFold,
      smallTargets,
      scrollLayers,
      cappedLayers,
      declaredLayers,
      docScrollTop: Math.round(doc.scrollTop),
      docScrollLeft: Math.round(doc.scrollLeft),
      docScrollHeight: doc.scrollHeight,
    }
  }, MIN_TOUCH_HEIGHT)
}

/** Drive a scroll the way a person does — a real wheel over the middle of the sheet.
 *  Assigning `scrollTop` directly would prove nothing: an `overflow: hidden` box accepts a
 *  scripted scrollTop just fine while a thumb over it gets nothing. Hit-tested wheel input is
 *  what separates "scrollable by a user" from "movable by a script"; if the sheet cannot take
 *  the scroll, the document under it takes it instead, and the doc-scroll assertions say so. */
async function scrollSheetToBottom(page: import('playwright-core').Page): Promise<void> {
  const target = await page.evaluate(() => {
    const el = document.querySelector('.vectr-sheet-body')
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      need: el.scrollHeight - el.clientHeight,
    }
  })
  if (target === null) return
  await page.mouse.move(target.x, target.y)
  const step = Math.min(Math.max(target.need, 1), 400)
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, step)
    const at = await page.evaluate(() => {
      const el = document.querySelector('.vectr-sheet-body')
      return el === null ? 0 : el.scrollTop
    })
    if (at >= target.need - 1) return
  }
}

/** Where a real wheel landed when the pointer was parked on the nested note list. */
interface NestedScrollProbe {
  found: boolean
  /** The pointer spot: the middle of the note list — where a thumb lands when the list is what
   * the person is reading. */
  pointerX: number
  pointerY: number
  innerCls: string
  innerMaxHeight: string
  innerOverflowY: string
  innerRoom: number
  innerScrollTopStart: number
  innerScrollTopEnd: number
  sheetCls: string
  sheetRoom: number
  sheetClientHeight: number
  sheetScrollTopStart: number
  sheetScrollTopEnd: number
  wheelSteps: number
  wheelStepPx: number
  /** Proof the page still did not move while all of this happened. */
  docScrollTopEnd: number
  docScrollHeightEnd: number
  /** The list's last painted text line (measured with a Range over its last text node). */
  lastLineRect: { top: number; bottom: number } | null
  lastLineInsideSheet: boolean
  listRect: { top: number; bottom: number; h: number }
}

/** Park the pointer on the nested list and wheel — the way a person reading the list does it —
 *  then report WHICH layer moved. A capped inner box swallows the wheel and the sheet behind it
 *  stays at 0; a phone sheet has to take the scroll itself. Assigning scrollTop would answer
 *  nothing (see scrollSheetToBottom), so every scroll here is hit-tested wheel input. */
async function probeWheelOverNestedList(page: import('playwright-core').Page): Promise<NestedScrollProbe> {
  const none: NestedScrollProbe = {
    found: false,
    pointerX: 0,
    pointerY: 0,
    innerCls: '',
    innerMaxHeight: '',
    innerOverflowY: '',
    innerRoom: 0,
    innerScrollTopStart: 0,
    innerScrollTopEnd: 0,
    sheetCls: '',
    sheetRoom: 0,
    sheetClientHeight: 0,
    sheetScrollTopStart: 0,
    sheetScrollTopEnd: 0,
    wheelSteps: 0,
    wheelStepPx: 0,
    docScrollTopEnd: 0,
    docScrollHeightEnd: 0,
    lastLineRect: null,
    lastLineInsideSheet: false,
    listRect: { top: 0, bottom: 0, h: 0 },
  }

  const start = await page.evaluate(() => {
    const sheet = document.querySelector('.vectr-sheet-body')
    const list = sheet === null ? null : sheet.querySelector('.vectr-scrollport')
    if (sheet === null || list === null) return null
    const r = list.getBoundingClientRect()
    const s = sheet.getBoundingClientRect()
    // Park on the part of the list a thumb can actually land on: the visible overlap of the list
    // box, the sheet's box and the viewport. Off-screen coordinates would make playwright aim the
    // wheel at something else entirely and the probe would measure the wrong layer.
    const top = Math.max(r.top, s.top, 0)
    const bottom = Math.min(r.bottom, s.bottom, window.innerHeight)
    const left = Math.max(r.left, s.left, 0)
    const right = Math.min(r.right, s.right, window.innerWidth)
    if (bottom <= top || right <= left) return null
    const cs = getComputedStyle(list)
    return {
      x: Math.round((left + right) / 2),
      y: Math.round((top + bottom) / 2),
      innerCls: (list as HTMLElement).className.trim(),
      innerMaxHeight: cs.maxHeight,
      innerOverflowY: cs.overflowY,
      innerRoom: list.scrollHeight - list.clientHeight,
      innerScrollTop: list.scrollTop,
      sheetCls: (sheet as HTMLElement).className.trim(),
      sheetRoom: sheet.scrollHeight - sheet.clientHeight,
      sheetClientHeight: sheet.clientHeight,
      sheetScrollTop: sheet.scrollTop,
    }
  })
  if (start === null) return none

  await page.mouse.move(start.x, start.y)
  const step = Math.min(Math.max(start.sheetRoom, 1), 400)
  let steps = 0
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, step)
    steps++
    const at = await page.evaluate(() => {
      const el = document.querySelector('.vectr-sheet-body')
      return el === null ? 0 : el.scrollTop
    })
    if (at >= start.sheetRoom - 1) break
  }

  const end = await page.evaluate(() => {
    const sheet = document.querySelector('.vectr-sheet-body')
    const list = sheet === null ? null : sheet.querySelector('.vectr-scrollport')
    if (sheet === null || list === null) return null
    const doc = document.scrollingElement ?? document.documentElement
    const lRect = list.getBoundingClientRect()
    const sRect = sheet.getBoundingClientRect()

    // The last painted line of note text: a Range over the list's last non-empty text node,
    // taken in the list's own scroll position. "The box is inside the sheet" is not enough —
    // the line a user came here to read has to be inside the sheet's visible box.
    const walker = document.createTreeWalker(list, NodeFilter.SHOW_TEXT)
    let last: Text | null = null
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const t = n as Text
      if ((t.textContent ?? '').trim() !== '') last = t
    }
    let lastLineRect: { top: number; bottom: number } | null = null
    if (last !== null) {
      const range = document.createRange()
      range.selectNodeContents(last)
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
      const r = rects.length > 0 ? rects[rects.length - 1] : null
      if (r !== null) lastLineRect = { top: Math.round(r.top), bottom: Math.round(r.bottom) }
    }

    return {
      innerScrollTop: list.scrollTop,
      sheetCls: (sheet as HTMLElement).className.trim(),
      sheetRoom: sheet.scrollHeight - sheet.clientHeight,
      sheetClientHeight: sheet.clientHeight,
      sheetScrollTop: sheet.scrollTop,
      docScrollTop: Math.round(doc.scrollTop),
      docScrollHeight: doc.scrollHeight,
      listRect: {
        top: Math.round(lRect.top),
        bottom: Math.round(lRect.bottom),
        h: Math.round(lRect.height),
      },
      sheetBottom: Math.round(sRect.bottom),
      viewportBottom: window.innerHeight,
      lastLineRect,
    }
  })
  if (end === null) return { ...none, wheelSteps: steps, wheelStepPx: step }

  return {
    found: true,
    pointerX: start.x,
    pointerY: start.y,
    innerCls: start.innerCls,
    innerMaxHeight: start.innerMaxHeight,
    innerOverflowY: start.innerOverflowY,
    innerRoom: start.innerRoom,
    innerScrollTopStart: start.innerScrollTop,
    innerScrollTopEnd: end.innerScrollTop,
    sheetCls: end.sheetCls,
    sheetRoom: end.sheetRoom,
    sheetClientHeight: end.sheetClientHeight,
    sheetScrollTopStart: start.sheetScrollTop,
    sheetScrollTopEnd: end.sheetScrollTop,
    wheelSteps: steps,
    wheelStepPx: step,
    docScrollTopEnd: end.docScrollTop,
    docScrollHeightEnd: end.docScrollHeight,
    lastLineRect: end.lastLineRect,
    lastLineInsideSheet:
      end.lastLineRect !== null &&
      end.lastLineRect.top >= 0 &&
      end.lastLineRect.bottom <= Math.min(end.sheetBottom, end.viewportBottom) + 1,
    listRect: end.listRect,
  }
}

/** What one measurement pass produces (all of it read out of the live layout). */
type Measurements = Pick<
  SceneReport,
  'overflow' | 'visibility' | 'controls' | 'focusables' | 'focus' | 'motion' | 'strays' | 'contrast' | 'tokens' | 'accent' | 'fonts'
>

/** Measure one loaded page. Everything below runs in the browser, on the real layout. */
async function measure(page: import('playwright-core').Page): Promise<Measurements> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    const out: Array<{ sel: string; scrollWidth: number; clientWidth: number }> = []
    const clipped: Array<{ sel: string; scrollWidth: number; clientWidth: number }> = []
    const inside: Array<{ sel: string; scrollWidth: number; clientWidth: number }> = []
    const inScrollport = (el: Element): boolean => {
      for (let p = el.parentElement; p !== null && p !== document.body; p = p.parentElement) {
        const pcs = getComputedStyle(p)
        if (pcs.overflowX === 'auto' || pcs.overflowX === 'scroll') return true
      }
      return false
    }
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (el.scrollWidth <= el.clientWidth + 1) continue
      const cs = getComputedStyle(el)
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue
      const tag = el.tagName.toLowerCase()
      const cls = typeof el.className === 'string' && el.className !== '' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''
      const sel = `${tag}${cls}`
      const rec = { sel, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
      if (inScrollport(el)) inside.push(rec)
      else if (cs.overflowX === 'hidden' && cs.textOverflow === 'ellipsis') clipped.push(rec)
      else out.push(rec)
    }
    return {
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      docScrollHeight: doc.scrollHeight,
      viewportHeight: window.innerHeight,
      offenders: out.slice(0, 12),
      insideScrollport: inside.slice(0, 12),
      ellipsisClipped: clipped.slice(0, 12),
    }
  })

  const controls = await page.evaluate(() => {
    const out: Array<{ tag: string; cls: string; label: string; h: number; w: number; disabled: boolean; viaLabel: boolean }> = []
    for (const el of Array.from(document.querySelectorAll('button, input, select, a[role="button"]'))) {
      const input = el as HTMLInputElement
      // A radio or checkbox is aimed at through its label: the label is the click target a
      // user actually aims at, so it is what has to clear the minimum, not the ~15px native
      // glyph inside it.
      const wrap = (input.type === 'radio' || input.type === 'checkbox') ? el.closest('label') : null
      const target = wrap ?? el
      const r = target.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const html = el as HTMLElement
      const cls = typeof html.className === 'string' && html.className !== '' ? html.className.trim().split(/\s+/).join('.') : ''
      const label = (
        (el.textContent ?? '').trim() ||
        el.getAttribute('aria-label') ||
        (el as HTMLInputElement).placeholder ||
        (wrap !== null ? (wrap.textContent ?? '').trim() : '') ||
        ''
      ).slice(0, 42)
      out.push({
        tag: el.tagName.toLowerCase(),
        cls,
        label,
        h: Math.round(r.height * 100) / 100,
        w: Math.round(r.width * 100) / 100,
        disabled: (el as HTMLButtonElement).disabled === true,
        viaLabel: wrap !== null,
      })
    }
    return out
  })

  // Keyboard walk. :focus-visible only matches keyboard navigation — calling .focus()
  // in the page would report rings that a keyboard user never gets.
  const focusableCount = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('button, input, select, a[href], [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }).length,
  )
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (el !== null) el.blur()
  })
  const seen: FocusMetric[] = []
  for (let i = 0; i < focusableCount; i += 1) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (el === null || el === document.body || el === document.documentElement) return null
      const cs = getComputedStyle(el)
      return {
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === 'string' ? el.className.trim().split(/\s+/).join('.') : '',
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        outlineColor: cs.outlineColor,
        focusVisible: el.matches(':focus-visible'),
      }
    })
    if (info !== null) seen.push(info)
  }

  const motionSelectors = [
    '.vectr-skeleton-row',
    '.vectr-modal-backdrop',
    '.vectr-modal-card',
    '.vectr-btn',
    '.vectr-card',
    '.vectr-stat',
    '.vectr-state',
    '.vectr-note-card',
    '.vectr-tab-btn',
    '.vectr-header-capsule',
  ]
  const motion = await page.evaluate((sels: string[]) => {
    const out: Array<{
      sel: string
      animationName: string
      animationDuration: string
      transitionProperty: string
      transitionDuration: string
    }> = []
    for (const sel of sels) {
      const el = document.querySelector(sel)
      if (el === null) continue
      const cs = getComputedStyle(el)
      out.push({
        sel,
        animationName: cs.animationName,
        animationDuration: cs.animationDuration,
        transitionProperty: cs.transitionProperty,
        transitionDuration: cs.transitionDuration,
      })
    }
    // Any element still animating under reduced motion is a stray the sheet missed.
    const strays: Array<{ sel: string; animationName: string }> = []
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const cs = getComputedStyle(el)
      if (cs.animationName !== 'none' && cs.animationDuration !== '0s') {
        const html = el as HTMLElement
        const cls = typeof html.className === 'string' && html.className !== '' ? `.${html.className.trim().split(/\s+/).join('.')}` : ''
        strays.push({ sel: `${el.tagName.toLowerCase()}${cls}`, animationName: cs.animationName })
      }
    }
    return { declared: out, strays }
  }, motionSelectors)

  const contrast = await page.evaluate(() => {
    type RGBA = { r: number; g: number; b: number; a: number }
    const parse = (s: string): RGBA | null => {
      const m = /rgba?\(([^)]+)\)/.exec(s)
      if (m === null) return null
      const p = m[1].split(/[,/\s]+/).filter((x) => x !== '').map((x) => Number.parseFloat(x))
      if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null
      return { r: p[0] ?? 0, g: p[1] ?? 0, b: p[2] ?? 0, a: p.length > 3 ? (p[3] ?? 1) : 1 }
    }
    const over = (fg: RGBA, bg: RGBA): RGBA => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    })
    const chan = (v: number): number => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    const lum = (c: RGBA): number => 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b)
    const ratio = (a: RGBA, b: RGBA): number => {
      const l1 = lum(a)
      const l2 = lum(b)
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    }
    // Opaque RGB seen *through* an element's own background box, composited over its
    // ancestors. A transparent layer paints nothing, so its opacity is irrelevant there.
    const behind = (el: Element | null): RGBA => {
      if (el === null) return { r: 255, g: 255, b: 255, a: 1 }
      const base = behind(el.parentElement)
      const cs = getComputedStyle(el)
      const bg = parse(cs.backgroundColor)
      if (bg === null || bg.a <= 0) return base
      const op = Number.parseFloat(cs.opacity || '1')
      return over({ ...bg, a: bg.a * op }, base)
    }
    const rows: Array<{
      text: string
      cls: string
      fontSize: number
      fontWeight: number
      color: string
      bg: string
      ratio: number
      exempt: string
    }> = []
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const html = el as HTMLElement
      const own = Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '' && !(n instanceof Comment),
      )
      if (!own) continue
      const cs = getComputedStyle(html)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      const r = html.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const fontSize = Number.parseFloat(cs.fontSize)
      const fontWeight = Number.parseInt(cs.fontWeight, 10)
      const fgRaw = parse(cs.color)
      const parentOpacity = (() => {
        let e: Element | null = html
        let acc = 1
        while (e !== null && e !== undefined) {
          acc *= Number.parseFloat(getComputedStyle(e).opacity || '1')
          e = e.parentElement
        }
        return acc
      })()
      if (fgRaw === null) continue
      const bg = behind(html)
      const fg = fgRaw.a < 1 || parentOpacity < 1 ? over({ ...fgRaw, a: fgRaw.a * parentOpacity }, bg) : fgRaw
      const disabled = html.closest(':disabled') !== null
      const large = fontSize >= 24 || (fontSize >= 18.5 && fontWeight >= 700)
      rows.push({
        text: (html.textContent ?? '').trim().slice(0, 48),
        cls: typeof html.className === 'string' && html.className !== '' ? html.className.trim().split(/\s+/).join('.') : '(no class)',
        fontSize,
        fontWeight,
        color: cs.color,
        bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
        ratio: Math.round(ratio(fg, bg) * 100) / 100,
        exempt: disabled ? 'disabled control (WCAG 1.4.3 exempt)' : large ? 'large text (3:1 bar)' : '',
      })
    }
    const asserted = rows.filter((r) => r.exempt === '')
    const failures = asserted.filter((r) => r.ratio < 4.5).sort((a, b) => a.ratio - b.ratio)
    const sorted = rows.slice().sort((a, b) => a.ratio - b.ratio)
    return {
      checked: asserted.length,
      min: asserted.length === 0 ? 1 : Math.min(...asserted.map((r) => r.ratio)),
      worst: sorted.slice(0, 14),
      /** Every status chip in the scene, whatever its ratio — the chips are what this
       * gate exists to keep honest, so their numbers are printed and asserted even when
       * they are comfortably above the floor and never reach the `worst` list. */
      pills: rows.filter((r) => r.cls.includes('vectr-pill')),
      failures,
    }
  })

  // Token integrity: every host alias this plugin paints must resolve, unless the use
  // site wrote a literal fallback. Sources = VECTR_CSS + every inline style attribute
  // the components actually emitted. Resolved against <body>, because design-platform.css
  // declares the aliases on body, not on :root.
  const tokens = await page.evaluate((cssText: string) => {
    const texts = [
      cssText,
      ...Array.from(document.querySelectorAll('[style]')).map((el) => el.getAttribute('style') ?? ''),
    ]
    const noFallback = new Set<string>()
    const withFallback = new Set<string>()
    for (const t of texts) {
      for (const m of t.matchAll(/var\((--dsw-[a-z0-9-]+)\s*\)/g)) if (m[1] !== undefined) noFallback.add(m[1])
      for (const m of t.matchAll(/var\((--dsw-[a-z0-9-]+)\s*,/g)) if (m[1] !== undefined) withFallback.add(m[1])
    }
    const scope = getComputedStyle(document.body)
    const deadNoFallback: string[] = []
    const deadWithFallback: string[] = []
    for (const name of noFallback) if (scope.getPropertyValue(name).trim() === '') deadNoFallback.push(name)
    for (const name of withFallback) if (scope.getPropertyValue(name).trim() === '') deadWithFallback.push(name)
    return { deadNoFallback: deadNoFallback.sort(), deadWithFallback: deadWithFallback.sort() }
  }, VECTR_CSS)

  // The accent is the whole identity of this panel, and a custom property that reads a
  // host alias can be guaranteed-invalid without any visible error (see buttons.tsx).
  // Read it out of the live cascade: an empty value means every var(--vx-accent)
  // declaration in the sheet — colour, border colour, focus ring — was silently dropped.
  const accent = await page.evaluate(() => {
    const norm = (s: string): string => s.replace(/\s+/g, '')
    const onBody = getComputedStyle(document.body).getPropertyValue('--vx-accent').trim()
    const mark = document.querySelector<HTMLElement>('.vectr-mark')
    if (mark === null) return { vxOnBody: onBody, vxOnMark: '', markColor: '', markPresent: false, markMatchesAccent: onBody !== '' }
    const onMark = getComputedStyle(mark).getPropertyValue('--vx-accent').trim()
    const color = getComputedStyle(mark).color
    return {
      vxOnBody: onBody,
      vxOnMark: onMark,
      markColor: color,
      markPresent: true,
      markMatchesAccent: norm(onMark) !== '' && norm(onMark) === norm(color),
    }
  })

  const visibility = await page.evaluate((keySels: string[]) => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let inViewport = 0
    let total = 0
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const text = (n.textContent ?? '').trim()
      if (text === '') continue
      total += text.length
      range.selectNode(n)
      const r = range.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.right >= 0 && r.left <= vw && r.bottom >= 0 && r.top <= vh) inViewport += text.length
    }
    const regions: Array<{ sel: string; x: number; y: number; w: number; h: number }> = []
    for (const sel of keySels) {
      const el = document.querySelector(sel)
      if (el === null) continue
      const r = el.getBoundingClientRect()
      regions.push({
        sel,
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      })
    }
    return { inViewportChars: inViewport, totalChars: total, regions }
  }, ['body', '.vectr-modal-backdrop', '.vectr-modal-card', '.vectr-page', '.vectr-card', '.vectr-header-capsule'])

  const fonts = await page.evaluate(() => {
    const faces: string[] = []
    document.fonts.forEach((f: FontFace) => faces.push(`${f.family} ${f.weight} ${f.status}`))
    const probe =
      document.querySelector<HTMLElement>('.vx-stage') ?? document.querySelector<HTMLElement>('.vectr-page') ?? document.body
    const control = document.querySelector<HTMLElement>('.vectr-tab-btn') ?? document.querySelector<HTMLElement>('button')
    const eyebrow = document.querySelector<HTMLElement>('.vectr-eyebrow')
    const metric =
      document.querySelector<HTMLElement>('.vectr-stat-value') ??
      document.querySelector<HTMLElement>('.vectr-metric-value') ??
      document.querySelector<HTMLElement>('.vectr-fact-value')
    const body =
      document.querySelector<HTMLElement>('.vectr-meta') ??
      document.querySelector<HTMLElement>('.vectr-state-hint') ??
      document.querySelector<HTMLElement>('.vectr-stat-label')
    return {
      status: document.fonts.status,
      montserrat500: document.fonts.check('500 13px Montserrat'),
      montserrat400: document.fonts.check('400 13px Montserrat'),
      faces: faces.slice(0, 12),
      computedFamily: getComputedStyle(probe).fontFamily,
      computedControlFamily: control !== null ? getComputedStyle(control).fontFamily : '(no control rendered)',
      eyebrowFamily: eyebrow !== null ? getComputedStyle(eyebrow).fontFamily : '(no .vectr-eyebrow in this scene)',
      metricFamily: metric !== null ? getComputedStyle(metric).fontFamily : '(no metric value in this scene)',
      eyebrowPresent: eyebrow !== null,
      metricPresent: metric !== null,
      bodyFamily: body !== null ? getComputedStyle(body).fontFamily : '(no body-text element in this scene)',
    }
  })

  return {
    overflow,
    visibility,
    controls,
    focusables: focusableCount,
    focus: seen,
    motion: motion.declared,
    strays: motion.strays,
    contrast,
    tokens,
    accent,
    fonts,
  }
}

/* ------------------------------------------------------------------ gate */

const chromiumBin = resolveChromium()
const hostCss = resolveHostCss()
const environmentReady = chromiumBin !== null && hostCss !== null

describe('Vectr visual gate (chromium, real components)', () => {
  it(
    'screenshots every surface at 1440x900 + 390x844 and passes the objective assertions',
    async () => {
      if (!environmentReady) {
        const reason = `chromium=${chromiumBin ?? 'NOT FOUND'} hostCss=${hostCss?.dir ?? 'NOT FOUND'}`
        const allowed = process.env.VQA_ALLOW_SKIP === '1'
        mkdirSync(ARTIFACTS, { recursive: true })
        writeFileSync(REPORT_PATH, JSON.stringify({ ran: false, reason, skipped: allowed }, null, 2))
        // The old shape of this guard warned and returned, so a run that checked nothing looked
        // identical to a run that checked everything. Missing toolchain is a failure by default
        // now; VQA_ALLOW_SKIP=1 is the only way to opt into a skip, and the skip stays loud and
        // lands in the report as { ran: false, skipped: true } either way.
        if (!allowed) {
          throw new Error(
            `[visual-qa] cannot run: ${reason}. Without chromium and the host token sheet this ` +
              'gate asserts nothing, so it fails rather than passing quietly. Set VQA_ALLOW_SKIP=1 ' +
              'to opt into an explicit, labelled skip.',
          )
        }
        console.warn(`[visual-qa] SKIP (VQA_ALLOW_SKIP=1): ${reason} — no assertion ran.`)
        return
      }
      const bin = chromiumBin
      const host = hostCss
      console.log(`[visual-qa] chromium: ${bin}`)
      console.log(`[visual-qa] host tokens: ${host.dir} (version ${host.version}, --dsw-alias-state-done-primary defined: ${String(host.hasAccent)})`)
      console.log(`[visual-qa] theme: ${THEME}   out: ${OUT_DIR}`)

      mkdirSync(OUT_DIR, { recursive: true })
      // Only this harness's own files are cleaned; other suites' artifacts are left alone.
      for (const f of readdirSync(OUT_DIR)) {
        if (f.startsWith('vqa-') && f.endsWith('.png')) rmSync(join(OUT_DIR, f))
      }
      // The page is written to disk and loaded as file:// so the host's @font-face
      // (Montserrat .woff2) resolves; a data: URL page has an opaque origin and Chromium
      // refuses the local font files, which would silently fake the typography.
      const pagesDir = join(OUT_DIR, '_pages')
      mkdirSync(pagesDir, { recursive: true })

      const styles = hostStyleTags(host.dir)
      const browser = await chromium.launch({
        executablePath: bin,
        args: [
          '--no-sandbox',
          '--disable-gpu',
          '--font-render-hinting=none',
          '--force-color-profile=srgb',
          '--allow-file-access-from-files',
        ],
      })
      const reports: SceneReport[] = []
      const consoleErrors: string[] = []
      const pageErrors: string[] = []
      try {
        for (const scene of scenes) {
          const htmlPath = join(pagesDir, `${scene.name}.html`)
          writeFileSync(htmlPath, pageHtml(styles, scene.body))
          for (const vp of VIEWPORTS) {
            const context = await browser.newContext({
              viewport: { width: vp.width, height: vp.height },
              deviceScaleFactor: 1,
              reducedMotion: 'no-preference',
            })
            const page = await context.newPage()
            page.on('console', (msg) => {
              if (msg.type() === 'error') consoleErrors.push(`${scene.name}/${vp.key}: ${msg.text()}`)
            })
            page.on('pageerror', (err) => {
              pageErrors.push(`${scene.name}/${vp.key}: ${err.message}`)
            })
            page.on('requestfailed', (req) => {
              pageErrors.push(`${scene.name}/${vp.key}: requestfailed ${req.url()} ${req.failure()?.errorText ?? ''}`)
            })
            await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
            await page.evaluate(() => document.fonts.ready)

            const normal = await measure(page)

            // Reduced-motion pass: emulate the media query, then re-measure.
            await page.emulateMedia({ reducedMotion: 'reduce' })
            const reduced = await measure(page)

            // The shot is taken in the reduced-motion state on purpose. Flipping the media
            // query back off restarts the modal's 140ms fade-in/scale-up, and the screenshot
            // then lands at animation time 0: the backdrop and card both paint at opacity 0
            // and the PNG is a white page that passes every numeric assertion. Reduced motion
            // is the deterministic, fully-painted state, and it is the state every assertion
            // in this report was measured in.
            await page.evaluate(() => {
              const el = document.activeElement as HTMLElement | null
              if (el !== null) el.blur()
            })
            await page.evaluate(() => {
              // The keyboard walk focuses controls sitting inside a scrollport, and the browser
              // scrolls them into view. The artifact is the surface at its initial scroll
              // position — on both axes, because a sheet body is a vertical scrollport too.
              window.scrollTo(0, 0)
              for (const el of Array.from(document.querySelectorAll('body *'))) {
                if (el.scrollLeft !== 0) el.scrollLeft = 0
                if (el.scrollTop !== 0) el.scrollTop = 0
              }
            })
            await page.evaluate(() => document.fonts.ready)
            const sheet = await measureSheet(page)
            const png = join(OUT_DIR, `vqa-${scene.name}-${vp.key}.png`)
            await page.screenshot({ path: png })

            // A panel taller than the screen is only fixed if its LAST control can actually be
            // reached: drive the sheet's own scrollport to the end, shoot it, re-measure there.
            let pngBottom: string | undefined
            let pngBottomWidth: number | undefined
            let pngBottomHeight: number | undefined
            let sheetBottom: SheetMetric | undefined
            if (scene.scrollSheet === true) {
              await scrollSheetToBottom(page)
              await page.evaluate(() => document.fonts.ready)
              pngBottom = join(OUT_DIR, `vqa-${scene.name}-${vp.key}-bottom.png`)
              await page.screenshot({ path: pngBottom })
              const bottomSize = pngSize(pngBottom)
              pngBottomWidth = bottomSize.width
              pngBottomHeight = bottomSize.height
              sheetBottom = await measureSheet(page)
            }

            // A nested list is only safe if the wheel a person lands ON the list reaches the
            // sheet. Park the pointer on the list, wheel, and record which layer moved.
            let pngWheel: string | undefined
            let pngWheelWidth: number | undefined
            let pngWheelHeight: number | undefined
            let nested: NestedScrollProbe | undefined
            if (scene.nestedProbe === true) {
              nested = await probeWheelOverNestedList(page)
              await page.evaluate(() => document.fonts.ready)
              pngWheel = join(OUT_DIR, `vqa-${scene.name}-${vp.key}-wheel.png`)
              await page.screenshot({ path: pngWheel })
              const wheelSize = pngSize(pngWheel)
              pngWheelWidth = wheelSize.width
              pngWheelHeight = wheelSize.height
            }

            await page.emulateMedia({ reducedMotion: null })
            const size = pngSize(png)
            const report: SceneReport = {
              scene: scene.name,
              viewport: vp.key,
              png,
              pngWidth: size.width,
              pngHeight: size.height,
              sheet,
              pngBottom,
              pngBottomWidth,
              pngBottomHeight,
              sheetBottom,
              nested,
              pngWheel,
              pngWheelWidth,
              pngWheelHeight,
              ...reduced,
              motionNormal: normal.motion,
              consoleErrors: [],
              pageErrors: [],
            }
            reports.push(report)
            await context.close()
          }
        }
      } finally {
        await browser.close()
        rmSync(pagesDir, { recursive: true, force: true })
      }

      /* ---------------- print the measured numbers ---------------- */
      for (const r of reports) {
        const short = r.png.replace(`${process.cwd()}/`, '')
        console.log(
          `\n=== ${r.scene} @ ${r.viewport} (${r.pngWidth}x${r.pngHeight}) -> ${short} ` +
            `doc ${r.overflow.docScrollWidth}/${r.overflow.docClientWidth} scrollH ${r.overflow.docScrollHeight}/${r.overflow.viewportHeight}`,
        )
        const tooSmall = r.controls.filter((c) => c.h < MIN_CONTROL_HEIGHT)
        console.log(
          `  controls: ${r.controls.length} total, min height ${
            r.controls.length === 0 ? 'n/a' : Math.min(...r.controls.map((c) => c.h))
          }; under ${MIN_CONTROL_HEIGHT}px: ${tooSmall.length}` +
            (tooSmall.length === 0 ? '' : ` -> ${tooSmall.map((c) => `${c.tag}.${c.cls || '-'} "${c.label}" ${c.h}px`).join(' | ')}`),
        )
        console.log(
          `  horizontal overflow: ${r.overflow.offenders.length === 0 ? 'none' : r.overflow.offenders.map((o) => `${o.sel} ${o.scrollWidth}>${o.clientWidth}`).join(' | ')}` +
            `  (ellipsis-clipped by design: ${r.overflow.ellipsisClipped.length}; inside a scrollport: ${r.overflow.insideScrollport.length}` +
            `${r.overflow.insideScrollport.length === 0 ? '' : ` -> ${r.overflow.insideScrollport.map((o) => `${o.sel} ${o.scrollWidth}>${o.clientWidth}`).join(' | ')}`})`,
        )
        console.log(
          `  in-viewport text: ${r.visibility.inViewportChars}/${r.visibility.totalChars} chars inside the shot ` +
            `| regions: ${r.visibility.regions.map((x) => `${x.sel} ${x.w}x${x.h}@${x.x},${x.y}`).join(' | ')}`,
        )
        if (r.sheet.found) {
          const room = r.sheet.scrollHeight - r.sheet.clientHeight
          console.log(
            `  sheet: ${r.sheet.cardCls} ${r.sheet.cardRect.w}x${r.sheet.cardRect.h}@${r.sheet.cardRect.x},${r.sheet.cardRect.y} ` +
              `radius=${r.sheet.cardRadius} | body ${r.sheet.clientHeight}px of room for ${r.sheet.scrollHeight}px of content ` +
              `(${r.sheet.scrollable ? `scrolls ${room}px` : 'fits without scrolling'}) ` +
              `| doc scroll ${r.sheet.docScrollTop},${r.sheet.docScrollLeft} docH ${r.sheet.docScrollHeight}/${r.sheet.viewportH} ` +
              `| layers: ${r.sheet.scrollLayers.map((l) => `${l.cls}=${l.overscroll}/${l.room}px`).join(', ')}` +
              (r.sheet.belowFold.length === 0
                ? ''
                : `\n    controls below the sheet's bottom edge at rest: ${r.sheet.belowFold.join(' | ')}`) +
              (r.sheet.smallTargets.length === 0
                ? ''
                : `\n    controls under the ${MIN_TOUCH_HEIGHT}px touch target: ${r.sheet.smallTargets.join(' | ')}`),
          )
          if (r.sheetBottom !== undefined) {
            console.log(
              `  sheet driven to its end -> ${r.pngBottom?.replace(`${process.cwd()}/`, '')}: ` +
                `scrollTop ${r.sheetBottom.scrollTop}/${r.sheetBottom.scrollHeight - r.sheetBottom.clientHeight} ` +
                `| last control ${r.sheetBottom.lastControl ?? '(none)'} rect ${JSON.stringify(r.sheetBottom.lastControlRect)} ` +
                `inside-sheet=${String(r.sheetBottom.lastControlInside)} in-viewport=${String(r.sheetBottom.lastControlInViewport)} ` +
                `| still below the edge: ${r.sheetBottom.belowFold.length} | doc scroll ${r.sheetBottom.docScrollTop}`,
            )
          }
          if (r.nested !== undefined) {
            console.log(
              `  wheel parked ON the note list at (${r.nested.pointerX},${r.nested.pointerY}) ` +
                `| inner ${r.nested.innerCls} maxHeight=${r.nested.innerMaxHeight} overflowY=${r.nested.innerOverflowY} ` +
                `room=${r.nested.innerRoom} scrollTop ${r.nested.innerScrollTopStart}->${r.nested.innerScrollTopEnd} ` +
                `| sheet room ${r.nested.sheetRoom} scrollTop ${r.nested.sheetScrollTopStart}->${r.nested.sheetScrollTopEnd} ` +
                `after ${r.nested.wheelSteps} wheels of ${r.nested.wheelStepPx}px ` +
                `| last note line ${JSON.stringify(r.nested.lastLineRect)} inside-sheet=${String(r.nested.lastLineInsideSheet)} ` +
                `| capped boxes inside the card: ${r.sheet.cappedLayers.length === 0 ? 'none' : r.sheet.cappedLayers.map((c) => `${c.cls} maxH=${c.maxHeight} room=${c.room}`).join(', ')}` +
                ` | doc scroll ${r.nested.docScrollTopEnd}`,
            )
          }
        }
        const badFocus = r.focus.filter(
          (f) =>
            f.outlineStyle === 'none' ||
            Number.parseFloat(f.outlineWidth) < 2 ||
            f.outlineColor === 'rgba(0, 0, 0, 0)' ||
            !f.focusVisible,
        )
        console.log(
          `  focus-visible: ${r.focus.length}/${r.focusables} walked by Tab, ` +
            `:focus-visible matched ${r.focus.filter((f) => f.focusVisible).length}, ` +
            `ring>=2px+visible: ${r.focus.length - badFocus.length}, weak: ${badFocus.length}` +
            (badFocus.length === 0 ? '' : ` -> ${badFocus.map((f) => `${f.tag}.${f.cls || '-'} fv=${String(f.focusVisible)} outline=${f.outlineStyle} ${f.outlineWidth} ${f.outlineColor}`).join(' | ')}`),
        )
        const motionOff = r.motion.filter(motionNeutral)
        const motionLeft = r.motion.filter((m) => !motionNeutral(m))
        const liveMotion = r.motionNormal.filter(motionLive)
        console.log(
          `  motion (no preference): ${liveMotion.length}/${r.motionNormal.length} selectors actually move ` +
            `-> ${liveMotion.map((m) => `${m.sel} anim=${m.animationName}/${m.animationDuration} trans=${m.transitionDuration}`).join(' | ')}`,
        )
        console.log(
          `  prefers-reduced-motion: ${motionOff.length}/${r.motion.length} selectors neutralised` +
            (motionLeft.length === 0 ? '' : `; left moving: ${motionLeft.map((m) => `${m.sel} anim=${m.animationName}/${m.animationDuration} trans=${m.transitionProperty}/${m.transitionDuration}`).join(' | ')}`) +
            `; strays under reduce: ${r.strays.length}` +
            (r.strays.length === 0 ? '' : ` -> ${r.strays.map((m) => `${m.sel} ${m.animationName}`).join(' | ')}`),
        )
        const contrastOwned = r.contrast.failures.filter((f) => KNOWN_CONTRAST[`${f.cls}|${f.color}`] === undefined)
        const contrastKnown = r.contrast.failures.filter((f) => KNOWN_CONTRAST[`${f.cls}|${f.color}`] !== undefined)
        console.log(
          `  contrast: ${r.contrast.checked} text nodes asserted, min ${r.contrast.min}:1, below ${MIN_CONTRAST}:1 -> ${contrastOwned.length} owned` +
            (contrastKnown.length === 0 ? '' : ` + ${contrastKnown.length} owned elsewhere (listed below)`) +
            (r.contrast.failures.length === 0
              ? ''
              : `\n${r.contrast.failures
                  .slice(0, 10)
                  .map((f) => `    ${f.ratio}:1  ${f.cls}  "${f.text}"  ${f.color} on ${f.bg}  ${f.fontSize}px/${f.fontWeight}`)
                  .join('\n')}`),
        )
        for (const f of contrastKnown) {
          console.log(
            `  KNOWN CONTRAST DEFECT (owned by a file this harness may not edit): ${f.ratio}:1 ${f.cls} "${f.text}" — ${KNOWN_CONTRAST[`${f.cls}|${f.color}`]}`,
          )
        }
        // Status chips, printed with their numbers whatever they score. They are the
        // surface this gate exists to keep honest: the word must clear the floor on
        // whatever the chip composites onto, and a fill that silently stopped applying
        // would show up here as a chip sitting on the panel background.
        console.log(
          `  status chips: ` +
            (r.contrast.pills.length === 0
              ? '(none in this scene)'
              : r.contrast.pills
                  .map((p) => `${p.text.trim()} ${p.ratio}:1 ${p.color} on ${p.bg} [${p.cls}]`)
                  .join(' | ')),
        )
        expect(
          r.contrast.pills
            .filter((p) => p.ratio < MIN_CONTRAST)
            .map((p) => `${p.text.trim()} ${p.ratio}:1 ${p.color} on ${p.bg}`),
          `a status chip's word drops below ${MIN_CONTRAST}:1 in ${r.scene}/${r.viewport}`,
        ).toEqual([])
        const unowned = r.tokens.deadNoFallback.filter((t) => KNOWN_DEFECTS[t] === undefined)
        console.log(
          `  host aliases: dead(no fallback) ${r.tokens.deadNoFallback.length === 0 ? 'none' : r.tokens.deadNoFallback.join(' | ')}` +
            `  | dead(with literal fallback) ${r.tokens.deadWithFallback.length === 0 ? 'none' : r.tokens.deadWithFallback.join(' | ')}`,
        )
        if (r.tokens.deadNoFallback.some((t) => KNOWN_DEFECTS[t] !== undefined)) {
          console.log(
            `  KNOWN DEFECT (not fixable in this write scope): ` +
              r.tokens.deadNoFallback
                .filter((t) => KNOWN_DEFECTS[t] !== undefined)
                .map((t) => `${t} — ${KNOWN_DEFECTS[t]}`)
                .join(' ; '),
          )
        }
        if (unowned.length !== 0) console.log(`  UNEXPECTED dead alias: ${unowned.join(' | ')}`)
        console.log(
          `  accent: --vx-accent on body = ${r.accent.vxOnBody === '' ? '(UNRESOLVED — the whole accent layer was dropped)' : r.accent.vxOnBody}` +
            `; .vectr-mark paints ${r.accent.markColor === '' ? '(no .vectr-mark in this scene)' : r.accent.markColor}` +
            ` matches=${String(r.accent.markMatchesAccent)}`,
        )
        console.log(
          `  fonts: status=${r.fonts.status} Montserrat500=${String(r.fonts.montserrat500)} Montserrat400=${String(r.fonts.montserrat400)}` +
            `; @font-face set=[${r.fonts.faces.join(' | ')}]`,
        )
        console.log(`  font in force on panel text: ${r.fonts.computedFamily.slice(0, 90)}`)
        console.log(`  font in force on a control:  ${r.fonts.computedControlFamily.slice(0, 90)}`)
        console.log(
          `  display face in force: eyebrow=${r.fonts.eyebrowFamily.slice(0, 70)} | numerals=${r.fonts.metricFamily.slice(0, 70)}` +
            ` | body stays on ${r.fonts.bodyFamily.slice(0, 50)}`,
        )
      }

      // Coverage for the display-face gate: if no scene mounted the eyebrow or a numeral,
      // both positive assertions above would have skipped and the gate would say nothing
      // about the brand font. Counted, not assumed.
      const eyebrowScenes = reports.filter((r) => r.fonts.eyebrowPresent).length
      const numeralScenes = reports.filter((r) => r.fonts.metricPresent).length
      expect(
        [eyebrowScenes > 0, numeralScenes > 0],
        `the display-face rules were never mounted (eyebrow scenes=${eyebrowScenes}, numeral scenes=${numeralScenes}) — the Montserrat gate proved nothing`,
      ).toEqual([true, true])
      expect(
        reports.every((r) => r.fonts.montserrat500),
        'Montserrat 500 did not load in every scene — the computed stacks below it were hiding an unloaded @font-face',
      ).toBe(true)

      const chips = reports.flatMap((r) => r.contrast.pills)
      expect(
        chips.filter((p) => p.ratio < MIN_CONTRAST).map((p) => `${p.text.trim()} ${p.ratio}:1 on ${p.bg}`),
        `a status chip's word is below ${MIN_CONTRAST}:1 somewhere in the panel`,
      ).toEqual([])
      // The filled variants must actually be painting: amber-100 rgb(254, 245, 231) and
      // green-100 rgb(230, 250, 237) are the two fills the sheet declares. If a class
      // stopped applying — a typo, a lost specificity battle, an alias the host stopped
      // publishing — the chip would composite onto the panel background instead, and this
      // is where that would show up.
      const FILLS = ['rgb(254, 245, 231)', 'rgb(230, 250, 237)']
      const filledChips = chips.filter((p) => FILLS.includes(p.bg))
      console.log(
        `  filled chips: ${filledChips.map((p) => `${p.text.trim()} ${p.ratio}:1 on ${p.bg} [${p.cls}]`).join(' | ')}`,
      )
      expect(
        FILLS.filter((fill) => !filledChips.some((p) => p.bg === fill)),
        `no status chip composites onto these fills — a filled chip variant is declared but never applied: ${FILLS.filter((fill) => !filledChips.some((p) => p.bg === fill)).join(' / ')}`,
      ).toEqual([])

      writeFileSync(
        REPORT_PATH,
        JSON.stringify(
          {
            ran: true,
            chromium: bin,
            hostCssDir: host.dir,
            hostCssVersion: host.version,
            hostHasAccentToken: host.hasAccent,
            theme: THEME,
            knownDefects: KNOWN_DEFECTS,
            knownContrastDefects: KNOWN_CONTRAST,
            generatedAt: new Date().toISOString(),
            consoleErrors,
            pageErrors,
            scenes: reports,
          },
          null,
          2,
        ),
      )
      console.log(`\n[visual-qa] report: ${REPORT_PATH.replace(`${process.cwd()}/`, '')}`)

      /* ---------------- the assertions themselves ---------------- */
      expect(reports.length).toBe(scenes.length * VIEWPORTS.length)
      for (const r of reports) {
        const where = `${r.scene}/${r.viewport}`
        const vp = VIEWPORTS.find((v) => v.key === r.viewport)
        expect(r.pngWidth, `png width ${where}`).toBe(vp?.width ?? -1)
        expect(r.pngHeight, `png height ${where}`).toBe(vp?.height ?? -1)
        expect(
          r.overflow.docScrollWidth <= r.overflow.docClientWidth,
          `horizontal page overflow ${where}: ${r.overflow.docScrollWidth} > ${r.overflow.docClientWidth}`,
        ).toBe(true)
        expect(
          r.visibility.inViewportChars,
          `only ${r.visibility.inViewportChars}/${r.visibility.totalChars} text chars land inside the viewport ${where} — the screenshot would prove nothing`,
        ).toBeGreaterThanOrEqual(150)
        expect(r.overflow.offenders, `element-level horizontal overflow ${where}`).toHaveLength(0)
        expect(r.controls.length, `no controls rendered ${where}`).toBeGreaterThan(0)
        const small = r.controls.filter((c) => c.h < MIN_CONTROL_HEIGHT)
        expect(
          small.map((c) => `${c.tag}.${c.cls || '-'} "${c.label}" ${c.h}px${c.viaLabel ? ' (label target)' : ''}`),
          `control under ${MIN_CONTROL_HEIGHT}px ${where}`,
        ).toEqual([])
        expect(r.focusables, `no focusable control ${where}`).toBeGreaterThan(0)
        expect(r.focus.length, `keyboard Tab walk found nothing ${where}`).toBeGreaterThan(0)
        const weak = r.focus.filter(
          (f) =>
            f.outlineStyle === 'none' ||
            Number.parseFloat(f.outlineWidth) < 2 ||
            f.outlineColor === 'rgba(0, 0, 0, 0)' ||
            !f.focusVisible,
        )
        expect(
          weak.map((f) => `${f.tag}.${f.cls || '-'} fv=${String(f.focusVisible)} ${f.outlineStyle} ${f.outlineWidth} ${f.outlineColor}`),
          `weak or missing focus-visible ring ${where}`,
        ).toEqual([])
        const left = r.motion.filter((m) => !motionNeutral(m))
        expect(left.map((m) => `${m.sel} anim=${m.animationName}/${m.animationDuration} trans=${m.transitionProperty}/${m.transitionDuration}`), `motion not reduced ${where}`).toEqual([])
        expect(
          r.motionNormal.some(motionLive),
          `nothing moves in the normal pass ${where} — reduced-motion would be vacuously true`,
        ).toBe(true)
        expect(r.strays.map((m) => `${m.sel} ${m.animationName}`), `animation strays under reduced motion ${where}`).toEqual([])
        expect(
          r.contrast.failures
            .filter((f) => KNOWN_CONTRAST[`${f.cls}|${f.color}`] === undefined)
            .map((f) => `${f.ratio}:1 ${f.cls} "${f.text}" ${f.color}`),
          `contrast below ${MIN_CONTRAST}:1 ${where}`,
        ).toEqual([])
        expect(
          r.tokens.deadNoFallback.filter((t) => KNOWN_DEFECTS[t] === undefined),
          `host alias painted with no fallback that the host stylesheet does not define ${where}`,
        ).toEqual([])
        expect(
          r.accent.vxOnBody,
          `--vx-accent resolves to nothing on ${where}: every colour, border colour and focus ring built on it was silently dropped`,
        ).not.toBe('')
        expect(
          r.accent.markMatchesAccent,
          `--vx-accent computed ${r.accent.vxOnMark} on .vectr-mark but it paints ${r.accent.markColor} ${where}`,
        ).toBe(true)
        expect(
          r.fonts.computedFamily,
          `panel text is not on a resolved font stack ${where}`
        ).not.toBe('')
        expect(
          r.fonts.computedControlFamily,
          `a control falls back to the UA control font instead of the panel's stack ${where}`,
        ).toBe(r.fonts.computedFamily)
        // The display face must be the one the host publishes, and it must be in force on
        // exactly the rules that asked for it. Asserted on the computed stack, so a
        // declaration that dropped out (an unresolved var, a typo'd family, a rule that
        // lost to a later one) fails here instead of rendering in the body font unnoticed.
        // Scenes mount different surfaces, so the positive half runs only where that rule
        // is actually in the page; the coverage assertions after the loop prove the rules
        // were exercised somewhere, which is what keeps the "only where mounted" wording
        // from turning into a skip.
        if (r.fonts.eyebrowPresent) {
          expect(
            r.fonts.eyebrowFamily.includes('Montserrat'),
            `.vectr-eyebrow computes to ${r.fonts.eyebrowFamily} — the brand face (--dsw-font-family-brand, base.css:10) never reached it ${where}`,
          ).toBe(true)
        }
        if (r.fonts.metricPresent) {
          expect(
            r.fonts.metricFamily.includes('Montserrat'),
            `the metric numerals compute to ${r.fonts.metricFamily} — no display face ${where}`,
          ).toBe(true)
        }
        expect(
          r.fonts.bodyFamily.includes('Montserrat'),
          `body text picked up the display face (${r.fonts.bodyFamily}) — the brand stack was applied too broadly ${where}`,
        ).toBe(false)
        expect(
          r.fonts.computedFamily.includes('Montserrat'),
          `panel body text is on the display face (${r.fonts.computedFamily}) where it should inherit the host text stack ${where}`,
        ).toBe(false)

        /* ---- task-14: the sheet is ONE bounded scroll layer and its end is reachable ---- */
        if (SHEET_SCENES.has(r.scene)) {
          expect(
            r.sheet.found,
            `no .vectr-sheet-body scroll layer inside a modal card ${where} — the sheet refactor is not applied`,
          ).toBe(true)
        }
        if (r.sheet.found) {
          expect(
            r.sheet.cardRect.h <= r.sheet.viewportH,
            `the modal card is ${r.sheet.cardRect.h}px tall against a ${r.sheet.viewportH}px viewport: its lower half is off-screen ${where}`,
          ).toBe(true)
          expect(
            r.sheet.docScrollTop,
            `the document scrolled vertically (${r.sheet.docScrollTop}) instead of the sheet's own scrollport ${where}`,
          ).toBe(0)
          expect(
            r.sheet.docScrollLeft,
            `the document scrolled sideways (${r.sheet.docScrollLeft}) instead of the sheet's own scrollport ${where}`,
          ).toBe(0)
          expect(
            r.sheet.scrollLayers.filter((l) => l.overscroll !== 'contain').map((l) => `${l.cls} = ${l.overscroll}`),
            `a scroll layer inside the sheet hands its overscroll to the layer above it ${where}: ${r.sheet.scrollLayers
              .map((l) => `${l.cls}=${l.overscroll}(${l.room}px)`)
              .join(', ')}`,
          ).toEqual([])
          expect(
            r.sheet.declaredLayers.map((l) => l.sel).sort(),
            `the shipped stylesheet no longer declares both sheet scroll selectors ${where}`
          ).toEqual(['.vectr-scrollport', '.vectr-sheet-body'])
          expect(
            r.sheet.declaredLayers.filter((l) => l.overscroll !== 'contain').map((l) => `${l.sel}=${l.overscroll}`),
            `a sheet scroll selector in VECTR_CSS dropped its overscroll-behavior:contain ${where}`
          ).toEqual([])
          if (r.viewport === 'phone') {
            expect(
              r.sheet.cardRect.h,
              `a phone sheet fills the screen: card ${r.sheet.cardRect.h}px against a ${r.sheet.viewportH}px viewport ${where}`,
            ).toBe(r.sheet.viewportH)
            expect(r.sheet.cardRect.w, `a phone sheet spans the full width ${where}`).toBe(r.sheet.viewportW)
            expect(r.sheet.cardRadius, `the phone sheet kept the desktop frame border-radius ${where}`).toBe('0px')
            expect(
              r.sheet.smallTargets,
              `controls inside the phone sheet sit under the ${MIN_TOUCH_HEIGHT}px touch target ${where}`,
            ).toEqual([])
          } else {
            const cap = Math.round(r.sheet.viewportH * 0.88)
            expect(
              r.sheet.cardRect.h <= cap,
              `the desktop card ${r.sheet.cardRect.h}px breaks the min(88vh, 900px) cap (${cap}px) ${where}`,
            ).toBe(true)
            expect(r.sheet.cardRadius, `the desktop card lost its 12px frame ${where}`).toBe('12px')
          }
        }
        /* ---- task-16: no phone sheet may own a capped nested scroll box ----
         * The shape task-15's review measured: pointer over the capped list, the list scrolls
         * 0->862, the sheet behind stays 0. Measured on every scene that renders a sheet, not
         * only the one that drives it. */
        if (r.sheet.found && r.viewport === 'phone') {
          expect(
            r.sheet.cappedLayers.map((c) => `${c.cls} max-height=${c.maxHeight} overflow-y=${c.overflowY} room=${c.room}px`),
            `a phone sheet owns a capped nested scroll box, which eats the wheel the sheet is ` +
              `supposed to take ${where}: ${r.sheet.cappedLayers
                .map((c) => `${c.cls} max-height=${c.maxHeight} overflow-y=${c.overflowY} room=${c.room}px`)
                .join(', ')}`,
          ).toEqual([])
        }
        /* ---- task-16: the wheel parked on the note list must move the SHEET ---- */
        if (NESTED_SCENES.has(r.scene)) {
          expect(
            r.nested?.found,
            `no .vectr-scrollport was found inside the sheet to park the wheel on ${where} — the note list is not being rendered`
          ).toBe(true)
        }
        if (r.nested !== undefined) {
          const n = r.nested
          const drive = `${n.wheelSteps} wheels of ${n.wheelStepPx}px at (${n.pointerX},${n.pointerY})`
          if (r.viewport === 'phone') {
            expect(
              n.sheetRoom,
              `the sheet had nothing to scroll (${n.sheetClientHeight}px of room for ` +
                `${n.sheetClientHeight + n.sheetRoom}px of content) — a wheel assertion here would be vacuous ${where}`
            ).toBeGreaterThan(0)
            expect(
              n.innerMaxHeight,
              `the note list is height-capped inside a phone sheet (max-height ${n.innerMaxHeight}): the wheel sink is back ${where}`
            ).toBe('none')
            expect(
              n.innerOverflowY,
              `the note list is still its own scroll container on a phone (overflow-y ${n.innerOverflowY}) ${where}`
            ).toBe('visible')
            expect(
              n.innerScrollTopEnd,
              `the note list ate the wheel: parked on it, ${drive}, its own scrollTop reached ` +
                `${n.innerScrollTopEnd} of ${n.innerRoom}px while the pointer never left it ${where}`
            ).toBe(0)
            expect(
              n.sheetScrollTopEnd > n.sheetScrollTopStart,
              `the sheet never moved (${n.sheetScrollTopStart}->${n.sheetScrollTopEnd}) although ${drive} landed on the note list ${where}`
            ).toBe(true)
            expect(
              n.sheetScrollTopEnd >= n.sheetRoom - 1,
              `driving the sheet from its own note list only reached scrollTop ${n.sheetScrollTopEnd} of ${n.sheetRoom}px ${where}`
            ).toBe(true)
            expect(
              n.docScrollTopEnd,
              `the page took the scroll instead of the sheet (${n.docScrollTopEnd}) while the wheel was parked on the note list ${where}`
            ).toBe(0)
            expect(n.lastLineRect, `no painted note text was found inside the list ${where}`).not.toBeNull()
            expect(
              n.lastLineInsideSheet,
              `the last note line ${JSON.stringify(n.lastLineRect)} is still out of reach after the sheet was driven to its end ${where}`
            ).toBe(true)
          } else {
            /* Desktop keeps the nested list as its own capped scrollport: a pointer wheel over a
             * nested box is normal there, and lifting the cap on a 1440x900 panel would be an
             * unrequested change to a layout that already works. */
            expect(
              n.innerMaxHeight,
              `the desktop note list lost its height cap (max-height ${n.innerMaxHeight}) ${where}`
            ).not.toBe('none')
            expect(
              n.innerOverflowY,
              `the desktop note list is no longer a scroll container (overflow-y ${n.innerOverflowY}) ${where}`
            ).toBe('auto')
            expect(
              n.innerRoom,
              `the desktop note list has nothing to scroll (${n.innerRoom}px) — the .vectr-list-cap cap is not being applied ${where}`
            ).toBeGreaterThan(0)
            expect(
              r.sheet.cappedLayers.filter((c) => c.cls.includes('vectr-list-cap')).length,
              `the two capped note lists inside a desktop sheet are not both capped (${r.sheet.cappedLayers
                .map((c) => `${c.cls} max-height=${c.maxHeight}`)
                .join(', ')}) ${where}`
            ).toBe(2)
          }
        }
        if (r.sheetBottom !== undefined) {
          const roomAtRest = r.sheet.scrollHeight - r.sheet.clientHeight
          const roomAtEnd = r.sheetBottom.scrollHeight - r.sheetBottom.clientHeight
          if (r.viewport === 'phone') {
            expect(
              roomAtRest,
              `${r.scene} is a scrollSheet scene but its sheet had nothing to scroll on a phone (${r.sheet.clientHeight}px of room for ${r.sheet.scrollHeight}px of content) ${where}`,
            ).toBeGreaterThan(0)
          }
          expect(
            r.sheetBottom.scrollTop >= roomAtEnd - 1,
            `driving the sheet to its end only reached scrollTop ${r.sheetBottom.scrollTop} of ${roomAtEnd}px ${where} — the scrollport does not actually scroll`,
          ).toBe(true)
          expect(
            r.sheetBottom.belowFold,
            `controls still hang below the sheet's bottom edge after it was driven to its end ${where}`,
          ).toEqual([])
          expect(r.sheetBottom.lastControl, `no reachable control inside the sheet ${where}`).not.toBeNull()
          expect(
            r.sheetBottom.lastControlInside,
            `the panel's last control ${r.sheetBottom.lastControl} ${JSON.stringify(r.sheetBottom.lastControlRect)} is outside the sheet's visible box ${where}`,
          ).toBe(true)
          expect(
            r.sheetBottom.lastControlInViewport,
            `the panel's last control ${r.sheetBottom.lastControl} ${JSON.stringify(r.sheetBottom.lastControlRect)} is outside the ${r.sheetBottom.viewportW}x${r.sheetBottom.viewportH} viewport ${where}`,
          ).toBe(true)
          expect(
            r.sheetBottom.docScrollTop,
            `the page moved (scrollTop ${r.sheetBottom.docScrollTop}) while the sheet was scrolled ${where}`,
          ).toBe(0)
          expect(
            r.sheetBottom.docScrollHeight,
            `scrolling the sheet changed the document's own height (${r.sheet.docScrollHeight} -> ${r.sheetBottom.docScrollHeight}) ${where}`,
          ).toBe(r.sheet.docScrollHeight)
          expect(existsSync(r.pngBottom ?? ''), `the scrolled artifact is missing ${where}`).toBe(true)
          expect(r.pngBottomWidth, `scrolled artifact width ${where}`).toBe(vp?.width ?? -1)
          expect(r.pngBottomHeight, `scrolled artifact height ${where}`).toBe(vp?.height ?? -1)
        }
      }
      expect(consoleErrors, 'console errors').toEqual([])
      expect(pageErrors, 'page errors').toEqual([])
    },
    180_000,
  )
})
