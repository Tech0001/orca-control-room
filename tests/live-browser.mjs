import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { chromium } from 'playwright'
import { fakeRuntime } from './support/live-runtime.mjs'

const runtime = await fakeRuntime()
const directory = await mkdtemp(join(tmpdir(), 'control-room-live-browser-'))
const reservation = createServer()
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const token = randomUUID()
await writeFile(join(directory, 'pairing.json'), JSON.stringify(runtime.pairing), { mode: 0o600 })
await writeFile(join(directory, 'config.json'), JSON.stringify({ lanes: runtime.terminals.map(t => ({ ...t, name: t.title })) }))
const server = spawn(process.execPath, ['companion/live-server.mjs', '--port', String(port), '--state-dir', directory, '--token', token], {
  env: { ...process.env, ORCA_USER_DATA_PATH: directory }, stdio: ['ignore', 'pipe', 'pipe']
})
let output = ''
server.stdout.on('data', chunk => { output += chunk })
server.stderr.on('data', chunk => { output += chunk })
let browser
try {
  for (let i = 0; i < 100; i++) {
    if (output.includes('listening')) break
    if (server.exitCode !== null) throw new Error(output)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, permissions: ['clipboard-read', 'clipboard-write'] })
  await page.addInitScript(() => {
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
    body: JSON.stringify({ handles: runtime.terminals.map(t => t.handle) }) })
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
  const viewport = page.locator('[data-lane="1"] .xterm-viewport')
  await viewport.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
  runtime.output('term_test-B', '\r\nFresh output while reading history')
  await page.waitForTimeout(150)
  assert.ok(await viewport.evaluate(el => el.scrollTop < 100), 'New output preserves scrolled reading position')
  runtime.disconnectStreams()
  await page.waitForTimeout(250)
  await page.waitForFunction(() => [...document.querySelectorAll('.status')].filter(e => e.textContent === 'Live').length === 2, { timeout: 10000 })
  assert.equal(await page.locator('.xterm').count(), 2, 'Reconnect reuses existing DOM tiles')
  await page.locator('[data-lane="0"] button[aria-label="Maximize or restore terminal"]').click()
  assert.equal(await page.locator('.maximized').count(), 1)
  await page.locator('[data-lane="0"] button[aria-label="Maximize or restore terminal"]').click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(directory, 'two-live-terminals.png') })
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
  console.log('PASS: two real xterm renderers, safe clipboard shortcuts, raw keys, independent routing, focus, scrollback, reconnect, maximize, authentication, and detach-only cleanup')
  console.log(`Screenshot: ${join(directory, 'two-live-terminals.png')}`)
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await runtime.close()
}
