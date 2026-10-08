/**
 * End-to-End (E2E) Reproduction Script:
 * User executes `vectr init` in `/home/csy/Code/installer/mihomo` via Vectr panel,
 * but panel status remains "未运行 (Offline)".
 *
 * Environment:
 * - DSH Web: http://127.0.0.1:3080
 * - Workspace: /home/csy/Code/installer/mihomo
 * - Chromium: /home/csy/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
 * - Runner: Playwright Core
 */

import { chromium } from 'playwright-core'
import { execSync } from 'node:child_process'
import { existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const CHROMIUM_PATH = process.env.CHROMIUM_BIN ?? '/home/csy/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'
const BASE_URL = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const WORKSPACE_DIR = '/home/csy/Code/installer/mihomo'
const ARTIFACTS_DIR = resolve('tests/e2e/artifacts')

function getDshToken() {
  if (process.env.DSH_TOKEN) return process.env.DSH_TOKEN
  try {
    const out = execSync('journalctl --user -u deepseek-harness* -n 50 --no-pager', { encoding: 'utf8' })
    const match = out.match(/dsh web: https?:\/\/[^\/]+\/\?token=([a-zA-Z0-9_-]+)/)
    if (match) return match[1]
  } catch {}
  return 'j8cAWNTdp1x0zUW1oGUP5la7BXR_Bjiih4tsvhPOVRc'
}

async function fetchSessionStatus(workspace) {
  const url = `${BASE_URL}/api/vectr/session-status?workspace=${encodeURIComponent(workspace)}`
  const res = await fetch(url)
  return {
    status: res.status,
    data: await res.json()
  }
}

async function run() {
  console.log('======================================================================')
  console.log('🚀 Starting E2E Reproduction for Vectr Init Offline Issue')
  console.log('======================================================================')
  console.log(`Target Workspace: ${WORKSPACE_DIR}`)
  console.log(`DSH Base URL:     ${BASE_URL}`)
  console.log(`Chromium Path:    ${CHROMIUM_PATH}`)

  const token = getDshToken()
  console.log(`Auth Token:       ${token.slice(0, 8)}...`)

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

  // --- Step 1: Pre-run API status check ---
  const initialApi = await fetchSessionStatus(WORKSPACE_DIR)
  recordStep('Query initial API session-status', initialApi)
  recordAssertion('Initial API status is 200 OK', initialApi.status === 200, 200, initialApi.status)
  recordAssertion('Initial live is false', initialApi.data.live === false, false, initialApi.data.live)
  recordAssertion('Initial mode is offline', initialApi.data.mode === 'offline', 'offline', initialApi.data.mode)
  recordAssertion('Initial reason is no_instance_registered', initialApi.data.reason === 'no_instance_registered', 'no_instance_registered', initialApi.data.reason)
  recordAssertion('Initial canReindex is false', initialApi.data.canReindex === false, false, initialApi.data.canReindex)

  // --- Step 2: Clean up previous init artifacts to prove fresh file creation ---
  const generatedFiles = [
    join(WORKSPACE_DIR, 'CLAUDE.md'),
    join(WORKSPACE_DIR, '.mcp.json'),
    join(WORKSPACE_DIR, '.vectrignore'),
    join(WORKSPACE_DIR, '.claude'),
    join(WORKSPACE_DIR, '.cursor'),
    join(WORKSPACE_DIR, '.vscode'),
    join(WORKSPACE_DIR, '.codex')
  ]
  console.log('\n🧹 Cleaning previous init files in mihomo to ensure clean reproduction...')
  for (const f of generatedFiles) {
    if (existsSync(f)) {
      rmSync(f, { recursive: true, force: true })
    }
  }
  const filesCleaned = generatedFiles.every(f => !existsSync(f))
  recordStep('Clean workspace files', { filesCleaned })
  recordAssertion('Init artifacts cleaned before running', filesCleaned, true, filesCleaned)

  // --- Step 3: Launch Playwright & Open DSH Web ---
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 } })
    const page = await context.newPage()

    recordStep('Launch Chromium & Navigate to DSH Web', { url: `${BASE_URL}/?token=***` })
    await page.goto(`${BASE_URL}/?token=${token}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)

    // Switch workspace to mihomo
    const wsSelectorBtn = page.locator('button._9wgCQG_workspace')
    await wsSelectorBtn.click()
    await page.waitForTimeout(600)
    await page.locator('text=mihomo').last().click()
    await page.waitForTimeout(1000)

    const selectedWs = await wsSelectorBtn.innerText()
    recordStep('Select mihomo workspace in UI', { selectedWs })
    recordAssertion('Workspace button displays mihomo', selectedWs.includes('mihomo'), 'mihomo', selectedWs)

    // Open Vectr Drawer Modal
    const vectrTriggerBtn = page.locator('button:has-text("Vectr")').last()
    await vectrTriggerBtn.click()
    await page.waitForTimeout(1500)

    const modalCard = page.locator('.vectr-modal-card')
    const modalVisible = await modalCard.isVisible()
    recordAssertion('Vectr Drawer Modal is opened', modalVisible, true, modalVisible)

    // Inspect initial modal content
    const modalTextInitial = await modalCard.innerText()
    recordStep('Inspect initial Modal UI state', {
      hasOfflineBadge: modalTextInitial.includes('Offline'),
      hasNotRunningMetric: modalTextInitial.includes('未运行 (Offline)'),
      hasModelNotReady: modalTextInitial.includes('嵌入模型未就绪')
    })

    const initialScreenshotPath = join(ARTIFACTS_DIR, '01-initial-modal-offline.png')
    await page.screenshot({ path: initialScreenshotPath })
    recordAssertion('Initial UI status badge shows Offline', modalTextInitial.includes('Offline'), true, modalTextInitial.includes('Offline'))
    recordAssertion('Initial UI metric shows "未运行 (Offline)"', modalTextInitial.includes('未运行 (Offline)'), true, modalTextInitial.includes('未运行 (Offline)'))

    // --- Step 4: Switch to Ops Tab (维护与初始化) ---
    const opsTabBtn = page.locator('button:has-text("维护与初始化")')
    await opsTabBtn.click()
    await page.waitForTimeout(600)

    const modalTextOps = await modalCard.innerText()
    const opsScreenshotPath = join(ARTIFACTS_DIR, '02-ops-tab-ready-to-init.png')
    await page.screenshot({ path: opsScreenshotPath })

    recordStep('Switch to Ops Tab (维护与初始化)', {
      hasReindexDisabledReason: modalTextOps.includes('No Vectr daemon registered for this workspace'),
      hasInitButton: modalTextOps.includes('执行 vectr init')
    })
    recordAssertion('Re-index button is disabled with explanation', modalTextOps.includes('No Vectr daemon registered for this workspace'), true, modalTextOps.includes('No Vectr daemon registered for this workspace'))
    recordAssertion('Execute vectr init button is visible', modalTextOps.includes('执行 vectr init'), true, modalTextOps.includes('执行 vectr init'))

    // --- Step 5: Execute vectr init via UI ---
    console.log('\n⚡ Clicking "执行 vectr init" button in UI...')
    const initBtn = page.locator('button:has-text("执行 vectr init")')
    await initBtn.click()

    // Wait for the completion notification
    const initResultEl = page.locator('.vectr-modal-card div:has-text("Vectr 工作区初始化完成！")').first()
    await initResultEl.waitFor({ state: 'visible', timeout: 20000 })
    await page.waitForTimeout(2000)

    const initResultText = await initResultEl.innerText()
    const initSuccessScreenshotPath = join(ARTIFACTS_DIR, '03-init-success-notification.png')
    await page.screenshot({ path: initSuccessScreenshotPath })

    recordStep('Vectr init execution completed', { initResultText })
    recordAssertion('Init output confirms completion', initResultText.includes('Vectr 工作区初始化完成！'), true, initResultText.includes('Vectr 工作区初始化完成！'))
    recordAssertion('Init guidance advises manual vectr start in terminal', initResultText.includes('请在终端执行 vectr start'), true, initResultText.includes('请在终端执行 vectr start'))

    // --- Step 6: Verify Filesystem Artifacts Generated ---
    const claudeMdPath = join(WORKSPACE_DIR, 'CLAUDE.md')
    const mcpJsonPath = join(WORKSPACE_DIR, '.mcp.json')
    const vectrIgnorePath = join(WORKSPACE_DIR, '.vectrignore')
    const claudeSettingsPath = join(WORKSPACE_DIR, '.claude/settings.json')

    const claudeMdCreated = existsSync(claudeMdPath)
    const mcpJsonCreated = existsSync(mcpJsonPath)
    const vectrIgnoreCreated = existsSync(vectrIgnorePath)
    const claudeSettingsCreated = existsSync(claudeSettingsPath)

    recordStep('Verify generated workspace files', {
      claudeMdCreated,
      mcpJsonCreated,
      vectrIgnoreCreated,
      claudeSettingsCreated
    })
    recordAssertion('CLAUDE.md was generated by vectr init', claudeMdCreated, true, claudeMdCreated)
    recordAssertion('.mcp.json was generated by vectr init', mcpJsonCreated, true, mcpJsonCreated)
    recordAssertion('.vectrignore was generated by vectr init', vectrIgnoreCreated, true, vectrIgnoreCreated)
    recordAssertion('.claude/settings.json was generated by vectr init', claudeSettingsCreated, true, claudeSettingsCreated)

    // Check .mcp.json content
    if (mcpJsonCreated) {
      const mcpContent = JSON.parse(readFileSync(mcpJsonPath, 'utf8'))
      recordAssertion('.mcp.json contains vectr server configuration', Boolean(mcpContent?.mcpServers?.vectr), true, Boolean(mcpContent?.mcpServers?.vectr))
    }

    // --- Step 7: Post-Init Refresh and Status Verification ---
    console.log('\n🔄 Clicking refresh button to update status in UI...')
    const refreshBtn = page.locator('button:has-text("刷新")')
    await refreshBtn.click()
    await page.waitForTimeout(2500)

    const modalTextAfterRefresh = await modalCard.innerText()
    const postRefreshScreenshotPath = join(ARTIFACTS_DIR, '04-post-refresh-still-offline.png')
    await page.screenshot({ path: postRefreshScreenshotPath })

    recordStep('Post-refresh Modal UI state verification', {
      hasOfflineBadge: modalTextAfterRefresh.includes('Offline'),
      hasNotRunningMetric: modalTextAfterRefresh.includes('未运行 (Offline)'),
      hasModelNotReady: modalTextAfterRefresh.includes('嵌入模型未就绪'),
      reindexStillDisabled: modalTextAfterRefresh.includes('No Vectr daemon registered for this workspace')
    })

    // CRITICAL CORE ASSERTIONS:
    recordAssertion(
      'Core Bug Repro: Status badge STILL displays Offline after init',
      modalTextAfterRefresh.includes('Offline'),
      true,
      modalTextAfterRefresh.includes('Offline')
    )
    recordAssertion(
      'Core Bug Repro: Ready metric STILL displays "未运行 (Offline)" after init',
      modalTextAfterRefresh.includes('未运行 (Offline)'),
      true,
      modalTextAfterRefresh.includes('未运行 (Offline)')
    )
    recordAssertion(
      'Core Bug Repro: Re-index button is STILL disabled with "No Vectr daemon registered"',
      modalTextAfterRefresh.includes('No Vectr daemon registered for this workspace'),
      true,
      modalTextAfterRefresh.includes('No Vectr daemon registered for this workspace')
    )

    // --- Step 8: Post-Init API status check ---
    const postApi = await fetchSessionStatus(WORKSPACE_DIR)
    recordStep('Query post-init API session-status', postApi)
    recordAssertion('Post-init API status is 200 OK', postApi.status === 200, 200, postApi.status)
    recordAssertion('Post-init API live is STILL false', postApi.data.live === false, false, postApi.data.live)
    recordAssertion('Post-init API mode is STILL offline', postApi.data.mode === 'offline', 'offline', postApi.data.mode)
    recordAssertion('Post-init API reason is STILL no_instance_registered', postApi.data.reason === 'no_instance_registered', 'no_instance_registered', postApi.data.reason)
    recordAssertion('Post-init API canReindex is STILL false', postApi.data.canReindex === false, false, postApi.data.canReindex)

    report.success = report.assertions.every(a => a.passed)
  } finally {
    await browser.close()
  }

  // Save report to disk
  const reportPath = join(ARTIFACTS_DIR, 'reproduction-report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\n📄 Reproduction report written to: ${reportPath}`)

  console.log('\n======================================================================')
  console.log(`🎯 Reproduction Result: ${report.success ? 'ALL ASSERTIONS PASSED (Bug Successfully Reproduced!)' : 'SOME ASSERTIONS FAILED'}`)
  console.log('======================================================================')

  if (!report.success) {
    process.exit(1)
  }
}

run().catch(err => {
  console.error('Fatal execution error:', err)
  process.exit(1)
})
