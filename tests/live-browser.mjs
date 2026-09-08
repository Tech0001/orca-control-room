import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { chromium } from 'playwright'
import { fakeRuntime } from './support/live-runtime.mjs'

const runtime = await fakeRuntime({ count: 14 })
const directory = await mkdtemp(join(tmpdir(), 'control-room-live-browser-'))
const reservation = createServer()
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const token = randomUUID()
await writeFile(join(directory, 'pairing.json'), JSON.stringify(runtime.pairing), { mode: 0o600 })
await writeFile(join(directory, 'config.json'), JSON.stringify({ lanes: runtime.terminals.slice(0, 2).map(t => ({ ...t, name: t.title })) }))
await writeFile(join(directory, 'original-roster.json'), JSON.stringify({ lanes: runtime.terminals.slice(0, 11).map(t => ({ ...t, name: t.title })) }))
const server = spawn(process.execPath, ['companion/live-server.mjs', '--port', String(port), '--state-dir', directory, '--token', token], {
  env: { ...process.env, ORCA_USER_DATA_PATH: directory, ORCA_CONTROL_ROOM_ROSTER_PATH: join(directory, 'original-roster.json') }, stdio: ['ignore', 'pipe', 'pipe']
})
let output = ''
server.stdout.on('data', chunk => { output += chunk })
server.stderr.on('data', chunk => { output += chunk })
let browser, page
try {
  for (let i = 0; i < 100; i++) {
    if (output.includes('listening')) break
    if (server.exitCode !== null) throw new Error(output)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  page = await browser.newPage({ viewport: { width: 1500, height: 950 }, permissions: ['clipboard-read', 'clipboard-write'] })
  await page.addInitScript(() => {
    // Retain test-only access to xterm's public buffer/scroll API. In xterm 6,
    // the legacy .xterm-viewport scrollTop no longer measures terminal history.
    window.testTerminals = []
    Object.defineProperty(window, 'Terminal', {
      configurable: true,
      set(Terminal) {
        Object.defineProperty(window, 'Terminal', {
          configurable: true, writable: true,
          value: class extends Terminal {
            constructor(...args) { super(...args); window.testTerminals.push(this) }
          }
        })
      }
    })
    window.addEventListener('keydown', event => {
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') window.lastCopyKey = event
    }, true)
  })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${port}/#token=${token}`)
  await page.waitForFunction(() => [...document.querySelectorAll('.status')].filter(e => e.textContent === 'Live').length === 2)
  assert.equal(await page.locator('.xterm').count(), 2)
  const configured = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST',
    headers: { 'x-control-room-token': token, origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ handles: runtime.terminals.slice(0, 2).map(t => t.handle) }) })
  assert.equal(configured.status, 200, 'Split panes in the same tab remain independently selectable')
  await page.waitForTimeout(250)
  await page.waitForFunction(() => [...document.querySelectorAll('.status')].filter(e => e.textContent === 'Live').length === 2)
  const left = page.locator('[data-lane="0"] .xterm-helper-textarea')
  const right = page.locator('[data-lane="1"] .xterm-helper-textarea')
  await left.focus()
  await page.waitForTimeout(200)
  const screen = await page.locator('[data-lane="0"] .xterm-screen').boundingBox()
  const cols = parseInt(await page.locator('[data-lane="0"] footer span').first().textContent(), 10)
  await page.mouse.move(screen.x + 1, screen.y + 6)
  await page.mouse.down()
  await page.mouse.move(screen.x + screen.width / cols * 4, screen.y + 6, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.press('Control+Shift+C')
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'LIVE', 'Ctrl+Shift+C copies the native terminal selection')
  assert.equal(await page.evaluate(() => window.lastCopyKey.defaultPrevented), true, 'Copy cancels Chrome’s default inspect action')
  assert.equal(runtime.inputs.length, 0, 'Copy must not send any bytes to the agent')
  await page.mouse.click(screen.x + 1, screen.y + 6)
  await page.keyboard.press('Control+Shift+C')
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => window.lastCopyKey.defaultPrevented), true, 'Copy with no selection still cancels Chrome’s shortcut')
  assert.equal(runtime.inputs.length, 0, 'Copy without a selection must not interrupt the agent')
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'LIVE', 'Empty selection leaves the clipboard intact')
  await page.keyboard.press('Control+C')
  await page.waitForTimeout(100)
  assert.equal(runtime.inputs.at(-1)?.text, '\x03', 'Plain Ctrl+C remains the native interrupt key')
  await page.keyboard.type('/model')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Shift+Enter')
  await right.focus()
  await page.keyboard.type('hello B')
  await page.waitForTimeout(400)
  assert.equal(runtime.inputs.filter(x => x.terminal === 'term_test-A').map(x => x.text).join(''), '\x03/model\x1b[B\r\x1b\r')
  assert.equal(runtime.inputs.filter(x => x.terminal === 'term_test-B').map(x => x.text).join(''), 'hello B')
  runtime.output('term_test-A', '\r\n\x1b[33mOther agent finished\x1b[0m\r\n')
  await page.waitForTimeout(150)
  assert.ok(await right.evaluate(el => el === document.activeElement), 'Other lane output must not steal focus')
  runtime.output('term_test-B', Array.from({ length: 120 }, (_, i) => `\r\nHistory line ${i}`).join(''))
  await page.waitForTimeout(150)
  const scrollPosition = () => page.evaluate(() => window.testTerminals[1].buffer.active.viewportY)
  const readHistory = async () => {
    await page.evaluate(() => window.testTerminals[1].scrollToTop())
    await page.waitForTimeout(150)
    assert.equal(await scrollPosition(), 0, 'The terminal is at the start of its actual history buffer')
  }
  await readHistory()
  runtime.output('term_test-B', '\r\nFresh output while reading history')
  await page.waitForTimeout(150)
  assert.equal(await scrollPosition(), 0, 'New output preserves scrolled reading position')
  // Real TUIs enable DECSET 1004: focus/blur arrive on xterm.onData just
  // like keystrokes, but must not trigger an input-driven jump to the bottom.
  await left.focus()
  runtime.output('term_test-B', '\x1b[?1004h')
  await page.waitForTimeout(250)
  await readHistory()
  const readingTop = await scrollPosition()
  const focusRequestStart = runtime.requests.length
  const historyScreen = await page.locator('[data-lane="1"] .xterm-screen').boundingBox()
  const historyCols = parseInt(await page.locator('[data-lane="1"] footer span').first().textContent(), 10)
  await page.mouse.move(historyScreen.x + 1, historyScreen.y + 6)
  await page.mouse.down()
  await page.waitForTimeout(150)
  assert.ok(await right.evaluate(el => el === document.activeElement), 'Clicking history still focuses the terminal for typing')
  assert.equal(await scrollPosition(), readingTop, 'Focus must not jump away from the text being selected')
  await page.mouse.move(historyScreen.x + historyScreen.width / historyCols * 4, historyScreen.y + 6, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.press('Control+Shift+C')
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'LIVE', 'Dragging after focus selects the original history text')
  await left.focus()
  await page.waitForTimeout(150)
  assert.equal(await scrollPosition(), readingTop, 'Leaving a terminal must also preserve its reading position')
  const focusRequests = runtime.requests.slice(focusRequestStart)
  assert.ok(focusRequests.some(r => r.method === 'terminal.send' && r.params.text === '\x1b[I'), 'Focus-in still reaches the native TUI')
  assert.ok(focusRequests.some(r => r.method === 'terminal.send' && r.params.text === '\x1b[O'), 'Focus-out still reaches the native TUI')
  assert.ok(focusRequests.filter(r => r.method === 'terminal.send').every(r => r.params.claimViewport !== true), 'Focus notifications are not sent as keystrokes')
  await right.focus()
  await page.waitForTimeout(150)
  assert.equal(await scrollPosition(), readingTop, 'Refocusing alone still preserves history')
  const typingRequestStart = runtime.requests.length
  await page.keyboard.type('typing-resumes')
  await page.waitForTimeout(150)
  assert.equal(await scrollPosition(), await page.evaluate(() => window.testTerminals[1].buffer.active.baseY), 'Actual typing still returns to the live prompt')
  assert.ok(runtime.requests.slice(typingRequestStart).some(r => r.method === 'terminal.send' && r.params.claimViewport === true && r.params.text === 't'), 'Typing still claims the pane dimensions')
  await readHistory()
  await right.evaluate(el => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'pasted-at-prompt')
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(150)
  assert.equal(await scrollPosition(), await page.evaluate(() => window.testTerminals[1].buffer.active.baseY), 'Pasting still returns to the live prompt')
  assert.ok(runtime.requests.some(r => r.method === 'terminal.send' && r.params.text === 'pasted-at-prompt' && r.params.claimViewport === true), 'Paste reaches the agent as real input')
  const wheelScreen = await page.locator('[data-lane="1"] .xterm-screen').boundingBox()
  await page.mouse.move(wheelScreen.x + 80, wheelScreen.y + 40)
  await page.mouse.wheel(0, -400)
  await page.waitForTimeout(250)
  assert.ok(await scrollPosition() < await page.evaluate(() => window.testTerminals[1].buffer.active.baseY), 'Mouse wheel can still scroll up through terminal history')
  await page.mouse.wheel(0, 10000)
  await page.waitForTimeout(250)
  assert.equal(await scrollPosition(), await page.evaluate(() => window.testTerminals[1].buffer.active.baseY), 'Mouse wheel can still scroll back down to the prompt')
  runtime.output('term_test-B', '\x1b[?1004l')
  await page.waitForTimeout(150)
  runtime.disconnectStreams()
  await page.waitForTimeout(250)
  await page.waitForFunction(() => [...document.querySelectorAll('.status')].filter(e => e.textContent === 'Live').length === 2, { timeout: 10000 })
  assert.equal(await page.locator('.xterm').count(), 2, 'Reconnect reuses existing DOM tiles')
  await page.locator('[data-lane="0"] button[aria-label="Maximize or restore terminal"]').click()
  assert.equal(await page.locator('.maximized').count(), 1)
  await page.locator('[data-lane="0"] button[aria-label="Maximize or restore terminal"]').click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(directory, 'two-live-terminals.png') })
  await page.setViewportSize({ width: 2600, height: 1400 })
  await page.locator('#manage').click()
  await page.locator('#lanes').waitFor({ state: 'visible' })
  for (const terminal of runtime.terminals.slice(2, 11)) {
    await page.locator('#available-terminals').selectOption(terminal.handle)
    await page.locator('#add-lane').click()
  }
  await page.locator('#layout-columns').selectOption('6')
  await page.locator('#save-lanes').click()
  await page.waitForFunction(() => document.querySelectorAll('.status.online').length === 11)
  assert.equal(await page.locator('.xterm').count(), 11, 'All eleven lanes connect, not just the first six')
  await page.locator('[data-lane="0"]').evaluate(el => { el.style.width = '600px'; el.style.height = '500px' })
  await page.waitForTimeout(350)
  const firstId = await page.locator('[data-lane="0"]').getAttribute('data-lane-id')
  await page.evaluate(() => { window.originalFirstPane = document.querySelector('[data-lane="0"]') })
  const subscriptionCount = runtime.methods.filter(m => m === 'terminal.subscribe').length
  await page.locator('#manage').click()
  await page.locator('#lanes').waitFor({ state: 'visible' })
  await page.locator('.lane-choice').first().getByRole('button', { name: 'Move lane down', exact: true }).click()
  await page.locator('.lane-choice input').nth(1).fill('Renamed first agent')
  await page.locator('#save-lanes').click()
  await page.waitForTimeout(250)
  assert.equal(await page.locator('[data-lane="1"]').getAttribute('data-lane-id'), firstId)
  assert.ok(await page.evaluate(() => window.originalFirstPane === document.querySelector('[data-lane="1"]')), 'Reordering preserves the terminal DOM and scrollback')
  assert.equal(runtime.methods.filter(m => m === 'terminal.subscribe').length, subscriptionCount, 'Reordering leaves existing streams connected')
  const aBox = await page.locator('[data-lane="1"]').boundingBox()
  const bBox = await page.locator('[data-lane="0"]').boundingBox()
  assert.ok(bBox.x < aBox.x, 'Actual visual order matches the saved roster')
  runtime.terminals[0].handle = 'term_test-A-restarted'
  await page.locator('[data-lane="0"] .xterm-helper-textarea').focus()
  await page.waitForTimeout(1100)
  await page.evaluate(async () => (await import('/live.js')).refresh())
  await page.waitForFunction(() => document.querySelectorAll('.status.online').length === 11)
  assert.ok(await page.evaluate(() => window.originalFirstPane === document.querySelector('[data-lane="1"]')), 'A replaced terminal handle keeps its existing tile and position')
  assert.ok(await page.locator('[data-lane="0"] .xterm-helper-textarea').evaluate(el => el === document.activeElement), 'Rebinding another lane does not steal focus')
  // A daemon can leave the same handle in inventory, but no writable PTY.
  const originalA = runtime.terminals[0]
  originalA.connected = false; originalA.writable = false
  const beforeRecoveryInputs = runtime.inputs.length
  const beforeActivations = runtime.methods.filter(m => m === 'session.tabs.activate').length
  await page.waitForTimeout(1100)
  await page.evaluate(async () => (await import('/live.js')).refresh())
  assert.equal(await page.locator('[data-lane="1"] .status').textContent(), 'Unavailable')
  assert.equal(await page.locator('#connection').textContent(), '10 live · 1 unavailable')
  assert.ok(await page.locator('[data-lane="1"] .lane-availability').isVisible())
  await page.screenshot({ path: join(directory, 'unavailable-lane.png') })
  assert.ok((await page.locator('[data-lane="1"] .xterm-screen').textContent()).includes('LIVE'), 'Offline lanes retain the last screen')
  await page.locator('[data-lane="1"] .xterm-helper-textarea').focus()
  await page.keyboard.type('must-not-send')
  await page.waitForTimeout(100)
  assert.equal(runtime.inputs.length, beforeRecoveryInputs, 'Typing into an unavailable pane never sends or buffers input')
  assert.equal(runtime.methods.filter(m => m === 'session.tabs.activate').length, beforeActivations, 'Polling never restarts agents')
  await page.locator('[data-lane="1"]').getByRole('button', { name: 'Reopen in Orca', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.status.online').length === 11)
  assert.equal(runtime.inputs.length, beforeRecoveryInputs, 'Recovery never sends a continue/resume prompt')
  const activation = runtime.requests.filter(r => r.method === 'session.tabs.activate').at(-1)
  assert.deepEqual(activation.params, { worktree: 'path:/test/shared-worktree', tabId: originalA.tabId,
    leafId: originalA.leafId, navigation: 'host', intent: 'user' })
  assert.ok(await page.evaluate(() => window.originalFirstPane === document.querySelector('[data-lane="1"]')), 'Native recovery keeps the original tile and ordering')
  // No inventory record at all: a saved tab still provides a recovery target.
  const missing = runtime.terminals.splice(0, 1)[0]
  await page.waitForTimeout(1100)
  await page.evaluate(async () => (await import('/live.js')).refresh())
  assert.equal(await page.locator('[data-lane="1"] .status').textContent(), 'Unavailable')
  await page.locator('[data-lane="1"]').getByRole('button', { name: 'Reopen in Orca', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.status.online').length === 11)
  // Restore fixture array order for subsequent roster checks.
  const restoredIndex = runtime.terminals.findIndex(t => t.leafId === missing.leafId)
  runtime.terminals.unshift(runtime.terminals.splice(restoredIndex, 1)[0])
  // A metadata outage is unknown, not proof of a dead process, and must recover
  // without restarting any agent when the service returns.
  const activationCount = runtime.methods.filter(m => m === 'session.tabs.activate').length
  await page.route('**/api/state', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture Orca unavailable' }) }))
  await page.evaluate(async () => (await import('/live.js')).refresh())
  assert.equal(await page.locator('.status.online').count(), 0)
  assert.equal(await page.locator('#connection').textContent(), 'Orca unavailable · retrying')
  assert.equal(await page.getByRole('button', { name: 'Reopen in Orca', exact: true }).count(), 0, 'Unknown liveness does not offer a restart')
  await page.unroute('**/api/state')
  await page.evaluate(async () => (await import('/live.js')).refresh())
  await page.waitForFunction(() => document.querySelectorAll('.status.online').length === 11)
  assert.equal(runtime.methods.filter(m => m === 'session.tabs.activate').length, activationCount, 'Transport recovery only reattaches views')
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.status.online').length === 11)
  assert.equal(await page.locator('[data-lane="1"] h2').textContent(), 'Renamed first agent', 'Names and order survive reload')
  assert.equal(await page.locator('[data-lane="1"]').evaluate(el => el.style.width), '600px', 'Saved sizes follow lane identity after reorder and reload')
  assert.equal(await page.locator('[data-lane="1"]').evaluate(el => el.style.height), '500px')
  await page.locator('#reset-sizes').click()
  await page.waitForTimeout(250)
  assert.equal(await page.locator('[data-lane="1"]').evaluate(el => el.style.width), '', 'Reset sizes restores the responsive grid')
  await page.screenshot({ path: join(directory, 'eleven-live-terminals.png') })
  const expanded = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST',
    headers: { 'x-control-room-token': token, origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ handles: runtime.terminals.map(t => t.handle) }) })
  assert.equal(expanded.status, 200)
  await page.evaluate(async () => (await import('/live.js')).refresh())
  await page.waitForFunction(() => document.querySelectorAll('.status.online').length === 14)
  await page.locator('#manage').click()
  await page.locator('#lanes').waitFor({ state: 'visible' })
  while (await page.locator('.lane-choice').count()) await page.locator('.lane-choice').last().getByRole('button', { name: 'Remove lane from view', exact: true }).click()
  await page.locator('#save-lanes').click()
  await page.waitForFunction(() => document.querySelectorAll('.xterm').length === 0, null, { timeout: 5000 })
  assert.ok(await page.locator('#empty').isVisible(), 'Empty roster has an actionable empty state')
  await page.locator('#empty-manage').click()
  await page.locator('#available-terminals').selectOption(runtime.terminals[1].handle)
  await page.locator('#add-lane').click()
  await page.locator('#save-lanes').click()
  await page.waitForFunction(() => document.querySelectorAll('.status.online').length === 1)
  assert.equal(await page.locator('.xterm').count(), 1, 'A single lane works after removing the full roster')
  await page.locator('#manage').click()
  await page.locator('#lanes').waitFor({ state: 'visible' })
  await page.locator('#import-roster').click()
  await page.waitForFunction(() => document.querySelectorAll('.lane-choice').length === 11)
  await page.locator('[data-close="lanes"]').click()
  assert.equal(await page.locator('.xterm').count(), 1, 'Cancel does not apply the imported draft')
  await page.locator('#manage').click()
  await page.locator('#lanes').waitFor({ state: 'visible' })
  await page.locator('#import-roster').click()
  await page.waitForFunction(() => document.querySelectorAll('.lane-choice').length === 11)
  await page.locator('#layout-columns').selectOption('3')
  await page.locator('#font-size').fill('11')
  await page.locator('#save-lanes').click()
  await page.waitForFunction(() => document.querySelectorAll('.status.online').length === 11)
  const savedConfig = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))
  assert.equal(savedConfig.columns, 3)
  assert.equal(savedConfig.fontSize, 11)
  assert.equal(JSON.parse(await readFile(join(directory, 'original-roster.json'), 'utf8')).lanes.length, 11, 'Import never changes the original roster')
  assert.deepEqual(errors, [])
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/state`)
  assert.equal(unauthorized.status, 401)
  const badOrigin = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST', headers: { 'x-control-room-token': token, origin: 'http://evil.example' }, body: '{}' })
  assert.equal(badOrigin.status, 403)
  const session = JSON.parse(await readFile(join(directory, 'session.json')))
  assert.equal(session.port, port)
  await browser.close(); browser = null
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.ok(!runtime.methods.some(m => /close|kill|stop/.test(m)), 'Closing the page must not stop agent terminals')
  console.log('PASS: 0/1/2/11/14 lanes, persistent order and naming, safe rebinding, raw keys, clipboard, focus/blur selection, typing/paste scroll, scrollback, reconnect, unavailable lanes, native recovery, outage recovery, maximize, authentication, detach-only cleanup')
  console.log(`Screenshot: ${join(directory, 'two-live-terminals.png')}`)
  console.log(`Eleven lanes: ${join(directory, 'eleven-live-terminals.png')}`)
} catch (error) {
  console.error(await page?.evaluate(() => ({ connection: document.getElementById('connection')?.textContent, dialogError: document.getElementById('lanes-error')?.textContent, draftRows: document.querySelectorAll('.lane-choice').length, tiles: document.querySelectorAll('.xterm').length })))
  console.error(output)
  throw error
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await runtime.close()
}
