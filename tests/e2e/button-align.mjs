/**
 * Real bbox measurement for 问题2 (button alignment), runnable with the system
 * chromium (no bundled browser download). Mirrors the exact DOM the
 * `CodebaseRow` component emits (flex wrapper + `test`/`delete` buttons, th
 * `minWidth:110` + `white-space:nowrap`) and asserts both buttons share the same
 * vertical line (equal `boundingBox().y`) and do not wrap.
 *
 * Usage:
 *   npm i -D playwright-core --no-save   # small, no browser download
 *   node tests/e2e/button-align.mjs
 *
 * Requires chromium at /usr/bin/chromium (override via CHROMIUM_BIN env).
 */
import { chromium } from 'playwright-core'

const CHROMIUM = process.env.CHROMIUM_BIN ?? '/usr/bin/chromium'

const HTML = `<!doctype html><html><head><style>
.vectr-btn { font: inherit; cursor: pointer; }
.vectr-btn-dense { height: 28px; padding: 0 10px; border-radius: 14px; font-size: 12px; }
.vectr-btn-danger { color: #c0392b; }
table { border-collapse: collapse; }
th, td { padding: 6px 8px; border-bottom: 1px solid #ccc; text-align: left; }
.pathcell { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style></head><body>
<table style="width:100%;min-width:620px">
<thead><tr>
  <th>slug</th><th>type</th>
  <th>path</th><th>address</th><th>local port</th><th>status</th><th>tunnel</th>
  <th style="min-width:110px;white-space:nowrap">actions</th>
</tr></thead>
<tbody><tr>
  <td>vnm_gui</td><td>remote</td>
  <td><span class="pathcell">/home/edogawaconan/Code/Work/vnm_gui</span></td>
  <td>conan -&gt; 127.0.0.1:8760</td><td>8760</td><td>up</td><td>12345</td>
  <td style="white-space:nowrap">
    <div style="display:flex;align-items:center;gap:4px;white-space:nowrap">
      <button class="vectr-btn vectr-btn-dense" id="test">test</button>
      <button class="vectr-btn vectr-btn-dense vectr-btn-danger" id="del">delete</button>
    </div>
  </td>
</tr></tbody></table></body></html>`

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 400 } })
  await page.setContent(HTML)
  const testBox = await page.locator('#test').boundingBox()
  const delBox = await page.locator('#del').boundingBox()
  if (!testBox || !delBox) throw new Error('buttons not rendered')
  const sameLine = Math.abs(testBox.y - delBox.y) < 0.5
  const notWrapped = delBox.y >= testBox.y - 0.5 && Math.abs(delBox.y - testBox.y) < 0.5
  console.log('test  button bbox:', testBox)
  console.log('delete button bbox:', delBox)
  console.log('same line (|y diff| < 0.5):', sameLine, '-> diff =', Math.abs(testBox.y - delBox.y))
  if (!sameLine || !notWrapped) {
    console.error('FAIL: buttons are not on the same line')
    process.exit(1)
  }
  console.log('PASS: test/delete buttons render on the same line (no wrap)')
} finally {
  await browser.close()
}
