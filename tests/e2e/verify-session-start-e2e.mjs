/**
 * End-to-End (E2E) Test Suite:
 * Verify Vectr daemon one-click startup and auto-launch flow.
 *
 * Covers:
 * 1. Initial Offline state detection in SessionDrawerModal.
 * 2. One-click daemon launch via UI button (⚡ 启动守护进程) / POST /api/vectr/session-start.
 * 3. Real daemon process spawn, port binding, and ~/.vectr/instances.json registration.
 * 4. UI transition from "未运行 (Offline)" to live (Initializing -> ● Ready).
 * 5. Re-index enablement upon daemon becoming live and fully ready.
 * 6. Clean teardown and post-cleanup state restoration.
 *
 * Uses:
 * - Playwright Core with cached Chromium
 * - Live compiled `lib/index.js` and `lib/client.js`
 * - React 18 & ReactDOM 18 UMD
 */

import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import {
  SessionVectrService,
  VectrCliRunner,
  InstanceResolver,
  VectrApiClient,
  CodebaseService,
  readJsonBody,
  sendJson,
  readInstancesFile,
  resolveInstance,
  DEFAULT_INSTANCES_FILE
} from '../../lib/index.js'

const PORT = 3199
const BASE_URL = `http://127.0.0.1:${PORT}`
const CHROMIUM_PATH = process.env.CHROMIUM_BIN ?? '/home/csy/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'
const WORKSPACE_DIR = '/home/csy/Code/installer/mihomo'
const ARTIFACTS_DIR = resolve('tests/e2e/artifacts')

const REACT_PATH = '/home/csy/Code/installer/deepseek-harness/apps/web/node_modules/react/umd/react.production.min.js'
const REACT_DOM_PATH = '/home/csy/Code/installer/deepseek-harness/apps/web/node_modules/react-dom/umd/react-dom.production.min.js'
const CLIENT_JS_PATH = resolve('lib/client.js')

function makeHarnessHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Vectr E2E SessionDrawerModal Harness</title>
  <style>
    :root {
      --dsw-alias-border-l2: #e0e0e0;
      --dsw-alias-bg-layer-1: #ffffff;
      --dsw-alias-state-success-tertiary: #e6f4ea;
      --dsw-alias-state-success-primary: #137333;
      --dsw-alias-state-warn-tertiary: #fef7e0;
      --dsw-alias-state-warn-primary: #b06000;
      --dsw-alias-interactive-bg-hover-danger: #fce8e6;
      --dsw-alias-state-error-primary: #c5221f;
      --dsw-alias-brand-tertiary: #e8f0fe;
      --dsw-alias-brand-primary: #1a73e8;
      --dsw-alias-label-secondary: #5f6368;
      --dsw-alias-label-tertiary: #80868b;
    }
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f0f2f5;
    }
  </style>
  <script src="/react.js"></script>
  <script src="/react-dom.js"></script>
  <script>
    window.react_jsx_runtime = {
      jsx: (type, props) => React.createElement(type, props),
      jsxs: (type, props) => React.createElement(type, props),
      Fragment: React.Fragment
    };
    window.__ModuleLoader__ = {
      load: (mod) => {
        window.vectrModule = mod.factory((spec) => {
          if (spec === 'react') return window.React;
          if (spec === 'react/jsx-runtime') return window.react_jsx_runtime;
          return {};
        });
      }
    };
  </script>
  <script src="/client.js"></script>
</head>
<body>
  <div id="root"></div>
  <script>
    const { SessionDrawerModal } = window.vectrModule;

    function App() {
      const [state, setState] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const workspace = ${JSON.stringify(WORKSPACE_DIR)};

      const refresh = async () => {
        setLoading(true);
        try {
          const res = await fetch('/api/vectr/session-status?workspace=' + encodeURIComponent(workspace));
          const data = await res.json();
          setState(data);
        } catch (e) {
          console.error('refresh error', e);
        } finally {
          setLoading(false);
        }
      };

      React.useEffect(() => {
        refresh();
      }, []);

      return React.createElement(SessionDrawerModal, {
        workspace: workspace,
        state: state,
        loading: loading,
        isOpen: true,
        onClose: () => console.log('close'),
        onRefresh: refresh
      });
    }

    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(React.createElement(App));
  </script>
</body>
</html>`
}

async function createServer() {
  const cliRunner = new VectrCliRunner()
  const instanceResolver = new InstanceResolver()
  const apiClient = new VectrApiClient()
  const codebaseService = new CodebaseService()
  const sessionService = new SessionVectrService({
    cliRunner,
    instanceResolver,
    apiClient,
    codebaseService
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // Static assets
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(makeHarnessHtml())
      return
    }
    if (url.pathname === '/react.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      res.end(readFileSync(REACT_PATH))
      return
    }
    if (url.pathname === '/react-dom.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      res.end(readFileSync(REACT_DOM_PATH))
      return
    }
    if (url.pathname === '/client.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      res.end(readFileSync(CLIENT_JS_PATH))
      return
    }

    // API Routes
    if (url.pathname === '/api/vectr/session-status') {
      const ws = url.searchParams.get('workspace') ?? ''
      const status = await sessionService.getSessionStatus(ws)
      sendJson(res, 200, status)
      return
    }

    if (url.pathname === '/api/vectr/session-start') {
      const body = await readJsonBody(req)
      console.log('--> API /api/vectr/session-start received body:', body)
      try {
        const result = await sessionService.startWorkspace(body)
        console.log('--> API /api/vectr/session-start returned result:', result)
        sendJson(res, result.ok ? 200 : 400, result)
      } catch (err) {
        console.error('--> API /api/vectr/session-start threw error:', err)
        sendJson(res, 500, { ok: false, error: String(err) })
      }
      return
    }

    if (url.pathname === '/api/vectr/init') {
      const body = await readJsonBody(req)
      const result = await sessionService.initWorkspace(body)
      sendJson(res, result.ok ? 200 : 400, result)
      return
    }

    if (url.pathname === '/api/vectr/session-reindex') {
      const body = await readJsonBody(req)
      const result = await sessionService.triggerIndex(body.workspace)
      sendJson(res, result.ok ? 200 : 400, result)
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })

  await new Promise((res) => server.listen(PORT, '127.0.0.1', res))
  return server
}

async function run() {
  console.log('======================================================================')
  console.log('🚀 Running E2E Test: Verify Session Start & Ready State Transition')
  console.log('======================================================================')

  const report = {
    timestamp: new Date().toISOString(),
    workspace: WORKSPACE_DIR,
    steps: [],
    assertions: [],
    success: false
  }

  function recordStep(name, details) {
    console.log(`\n📌 [Step ${report.steps.length + 1}] ${name}`)
    console.log(`   Details:`, JSON.stringify(details, null, 2))
    report.steps.push({ step: report.steps.length + 1, name, details, time: new Date().toISOString() })
  }

  function recordAssertion(description, passed, expected, actual) {
    const icon = passed ? '✅ PASS' : '❌ FAIL'
    console.log(`   ${icon}: ${description}`)
    if (!passed) {
      console.log(`      Expected:`, expected)
      console.log(`      Actual:  `, actual)
    }
    report.assertions.push({ description, passed, expected, actual })
  }

  // Pre-test cleanup: ensure mihomo daemon is stopped
  try {
    execSync(`vectr stop ${WORKSPACE_DIR} 2>/dev/null`, { stdio: 'ignore' })
  } catch {}

  const server = await createServer()
  console.log(`Test server running at ${BASE_URL}`)

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  let boundPort = null
  let boundPid = null

  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 } })
    const page = await context.newPage()
    page.on('console', msg => console.log('PAGE LOG:', msg.text()))
    page.on('pageerror', err => console.log('PAGE ERROR:', err))

    // --- Phase 1: Initial state observation ---
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)

    const initialModalText = await page.locator('.vectr-modal-card').innerText()
    const startDaemonBtn = page.locator('button:has-text("⚡ 启动守护进程")').first()
    const startBtnVisible = await startDaemonBtn.isVisible()

    recordStep('Initial modal render', {
      hasOfflineBadge: initialModalText.includes('Offline'),
      hasNotRunningMetric: initialModalText.includes('未运行 (Offline)'),
      startBtnVisible
    })

    const initialScreenshot = join(ARTIFACTS_DIR, 'verify-01-initial-offline.png')
    await page.screenshot({ path: initialScreenshot })

    recordAssertion('Initial state badge shows Offline', initialModalText.includes('Offline'), true, initialModalText.includes('Offline'))
    recordAssertion('Initial state metric shows "未运行 (Offline)"', initialModalText.includes('未运行 (Offline)'), true, initialModalText.includes('未运行 (Offline)'))
    recordAssertion('One-click "⚡ 启动守护进程" button is visible when offline', startBtnVisible, true, startBtnVisible)

    // --- Phase 2: Click "⚡ 启动守护进程" ---
    console.log('\n⚡ Clicking "⚡ 启动守护进程" button...')
    const [startResponse] = await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/api/vectr/session-start') && resp.status() === 200),
      startDaemonBtn.click()
    ])
    const startData = await startResponse.json()
    console.log('   Response received:', startData)

    // Allow UI to process onRefresh()
    await page.waitForTimeout(1500)

    const liveModalText = await page.locator('.vectr-modal-card').innerText()
    recordStep('Daemon started and status transitioned to live in UI', {
      hasLivePort: liveModalText.includes('Port:'),
      hasInitializingOrReady: liveModalText.includes('Initializing') || liveModalText.includes('Ready')
    })

    const daemonLiveScreenshot = join(ARTIFACTS_DIR, 'verify-02-daemon-live-header.png')
    await page.screenshot({ path: daemonLiveScreenshot })

    recordAssertion('Status badge transitioned out of Offline', !liveModalText.includes('○ Offline'), true, !liveModalText.includes('○ Offline'))
    recordAssertion('One-click start button is hidden once live', !(await startDaemonBtn.isVisible()), true, !(await startDaemonBtn.isVisible()))
    recordAssertion('Modal displays bound port and PID', liveModalText.includes('Port:') && liveModalText.includes('PID'), true, true)

    // --- Phase 3: Wait for index to settle to Ready state ---
    console.log('\n⏳ Waiting for initial index to settle into fully Ready state...')
    let isFullyReady = false
    const pollDeadline = Date.now() + 20000

    while (Date.now() < pollDeadline) {
      const refreshBtn = page.locator('button:has-text("刷新")')
      await refreshBtn.click()
      await page.waitForTimeout(1000)

      const currentText = await page.locator('.vectr-modal-card').innerText()
      if (currentText.includes('Ready') && currentText.includes('已就绪 (Ready)')) {
        isFullyReady = true
        break
      }
    }

    const readyModalText = await page.locator('.vectr-modal-card').innerText()
    const readyScreenshot = join(ARTIFACTS_DIR, 'verify-03-live-fully-ready.png')
    await page.screenshot({ path: readyScreenshot })

    recordStep('Settled fully ready state', {
      isFullyReady,
      readyModalTextSnippet: readyModalText.slice(0, 300)
    })
    recordAssertion('Daemon settles into fully Ready state (● Ready)', isFullyReady, true, isFullyReady)
    recordAssertion('Ready metric shows "已就绪 (Ready)"', readyModalText.includes('已就绪 (Ready)'), true, readyModalText.includes('已就绪 (Ready)'))

    // Switch to Ops tab to verify start message and enabled Re-index
    await page.locator('button:has-text("维护与初始化")').click()
    await page.waitForTimeout(500)

    const opsModalText = await page.locator('.vectr-modal-card').innerText()
    const opsTabScreenshot = join(ARTIFACTS_DIR, 'verify-04-ops-tab-reindex-enabled.png')
    await page.screenshot({ path: opsTabScreenshot })

    recordStep('Inspect Ops tab after daemon started', {
      hasStartSuccessMsg: opsModalText.includes('Vectr 守护进程启动成功'),
      reindexEnabled: !opsModalText.includes('(No Vectr daemon registered for this workspace)')
    })

    recordAssertion('Ops tab displays daemon startup success banner', opsModalText.includes('Vectr 守护进程启动成功'), true, opsModalText.includes('Vectr 守护进程启动成功'))
    recordAssertion('Re-index disabled reason is gone', !opsModalText.includes('(No Vectr daemon registered for this workspace)'), true, !opsModalText.includes('(No Vectr daemon registered for this workspace)'))

    const reindexBtn = page.locator('button:has-text("立即触发 Re-index")')
    const reindexDisabled = await reindexBtn.isDisabled()
    recordAssertion('Re-index button is now enabled (not disabled)', !reindexDisabled, true, !reindexDisabled)

    // --- Phase 4: Verify OS process and instances.json registration ---
    const instancesRaw = readInstancesFile({ logger: { info: () => {}, warn: () => {} } }, DEFAULT_INSTANCES_FILE)
    const instanceEntry = resolveInstance(instancesRaw ?? {}, WORKSPACE_DIR)

    boundPort = instanceEntry?.port
    boundPid = instanceEntry?.pid

    recordStep('Verify registry entry in ~/.vectr/instances.json', { instanceEntry })
    recordAssertion('Workspace registered in instances.json', Boolean(instanceEntry), true, Boolean(instanceEntry))
    recordAssertion('Instance has valid port number', typeof boundPort === 'number' && boundPort > 1024, true, boundPort)
    recordAssertion('Instance has valid PID', typeof boundPid === 'number' && boundPid > 0, true, boundPid)

    // Check process is alive in OS
    let processAlive = false
    try {
      if (boundPid) {
        process.kill(boundPid, 0)
        processAlive = true
      }
    } catch {}
    recordAssertion('Vectr daemon process is alive in OS', processAlive, true, processAlive)

    // --- Phase 5: Teardown & Stop Daemon ---
    console.log('\n🧹 Cleaning up: Stopping Vectr daemon for mihomo...')
    try {
      execSync(`vectr stop ${WORKSPACE_DIR}`, { stdio: 'ignore' })
    } catch (e) {
      console.warn('vectr stop warning:', e)
    }
    await page.waitForTimeout(1000)

    // Click refresh in UI
    await page.locator('button:has-text("刷新")').click()
    await page.waitForTimeout(1500)

    const postStopModalText = await page.locator('.vectr-modal-card').innerText()
    const postStopScreenshot = join(ARTIFACTS_DIR, 'verify-05-stopped-cleaned.png')
    await page.screenshot({ path: postStopScreenshot })

    recordStep('Post-cleanup state verification', {
      hasOfflineBadge: postStopModalText.includes('Offline'),
      hasNotRunningMetric: postStopModalText.includes('未运行 (Offline)'),
      startBtnReappeared: await page.locator('button:has-text("⚡ 启动守护进程")').first().isVisible()
    })

    recordAssertion('Cleaned up state returns to Offline', postStopModalText.includes('Offline'), true, postStopModalText.includes('Offline'))
    recordAssertion('Start daemon button reappears when offline', await page.locator('button:has-text("⚡ 启动守护进程")').first().isVisible(), true, true)

    report.success = report.assertions.every(a => a.passed)
  } finally {
    await browser.close()
    await new Promise((res) => server.close(res))
    // Safety cleanup in case of crash
    try {
      execSync(`vectr stop ${WORKSPACE_DIR} 2>/dev/null`, { stdio: 'ignore' })
    } catch {}
  }

  // Save report
  const reportPath = join(ARTIFACTS_DIR, 'verify-session-start-report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\n📄 Verification report written to: ${reportPath}`)

  console.log('\n======================================================================')
  console.log(`🎯 Test Result: ${report.success ? 'ALL ASSERTIONS PASSED (Fix Verified!)' : 'SOME ASSERTIONS FAILED'}`)
  console.log('======================================================================')

  if (!report.success) {
    process.exit(1)
  }
}

run().catch(err => {
  console.error('Fatal execution error:', err)
  process.exit(1)
})
