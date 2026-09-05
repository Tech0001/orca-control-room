import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { LiveRpc, parsePairing, currentEndpoint } from './live-rpc.mjs'
import { saveClipboardImage, MAX_ATTACHMENT_BYTES } from './attachments.mjs'
import { CONTROL_ROOM_VERSION as version } from '../version.mjs'
import { isQueryReply } from './public/live-protocol.mjs'
import { normalizeConfig, selectConfig, bindLane as bind, MAX_LANES } from './live-model.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const argument = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const port = Number(argument('--port', '47832'))
const stateDir = argument('--state-dir', join(homedir(), '.config', 'orca-control-room-live-terminals'))
const token = argument('--token', process.env.ORCA_CONTROL_ROOM_TOKEN || randomUUID())
if (!Number.isInteger(port) || port < 1 || port > 65535 || token.length < 32) throw new Error('Invalid server options')
const origin = `http://127.0.0.1:${port}`
const configPath = join(stateDir, 'config.json')
const pairingPath = join(stateDir, 'pairing.json')
const sessionPath = join(stateDir, 'session.json')
const rosterPath = process.env.ORCA_CONTROL_ROOM_ROSTER_PATH || join(homedir(), '.config', 'orca-control-room', 'config.json')
let pairing = null
let config = { lanes: [] }
let directoryRpc = null
let directoryPromise = null
let lastClientAt = Date.now()
const terminalSockets = new Set()

async function privateJson(path, value) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}

try { config = JSON.parse(await readFile(configPath, 'utf8')) } catch {
  // Seed the saved roster once; never write the original Control Room's state.
  try {
    config = JSON.parse(await readFile(rosterPath, 'utf8'))
  } catch {}
}
config = normalizeConfig(config)
try {
  const saved = JSON.parse(await readFile(pairingPath, 'utf8'))
  pairing = parsePairing(Buffer.from(JSON.stringify(saved)).toString('base64url'))
} catch {}

async function connectDirectory() {
  if (!pairing) throw new Error('Pair this experimental view with Orca first')
  if (directoryRpc && !directoryRpc.closed) return directoryRpc
  if (!directoryPromise) {
    directoryPromise = (async () => {
      const rpc = new LiveRpc(pairing, { endpoint: await currentEndpoint(pairing), onClose: () => {
        if (directoryRpc === rpc) directoryRpc = null
      } })
      await rpc.connect()
      directoryRpc = rpc
      return rpc
    })().finally(() => { directoryPromise = null })
  }
  return directoryPromise
}

let directoryCache = null, terminalListPromise = null
async function listTerminals() {
  if (directoryCache && Date.now() - directoryCache.at < 1000) return directoryCache.terminals
  if (!terminalListPromise) terminalListPromise = (async () => {
    const result = await (await connectDirectory()).request('terminal.list', { includeVisualLayouts: false })
    const terminals = (result.terminals || []).map(t => ({ handle: t.handle, tabId: t.tabId, leafId: t.leafId,
      worktreePath: t.worktreePath, title: t.title || t.worktreePath?.split('/').at(-1) || 'Terminal',
      connected: t.connected, writable: t.writable }))
    directoryCache = { at: Date.now(), terminals }
    return terminals
  })().finally(() => { terminalListPromise = null })
  return terminalListPromise
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(value))
}

function matchesToken(candidate) {
  return typeof candidate === 'string' && Buffer.byteLength(candidate) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(candidate), Buffer.from(token))
}

async function body(request, max = 128 * 1024, raw = false) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > max) throw new Error('Request is too large')
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  return raw ? bytes : JSON.parse(bytes.toString('utf8') || '{}')
}

const staticFiles = {
  '/': ['public/live.html', 'text/html'],
  '/live.js': ['public/live.js', 'text/javascript'],
  '/live-protocol.mjs': ['public/live-protocol.mjs', 'text/javascript'],
  '/live.css': ['public/live.css', 'text/css'],
  '/styles.css': ['public/styles.css', 'text/css'],
  '/vendor/xterm.js': ['../node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/vendor/xterm.css': ['../node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
  '/vendor/fit.js': ['../node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript']
}

const server = createServer(async (request, response) => {
  try {
    if (request.headers.host !== `127.0.0.1:${port}`) return json(response, 403, { error: 'Invalid host' })
    const path = new URL(request.url, origin).pathname
    if (path.startsWith('/api/')) {
      if (!matchesToken(request.headers['x-control-room-token'])) return json(response, 401, { error: 'Unauthorized' })
      lastClientAt = Date.now()
      if (request.method === 'POST' && request.headers.origin !== origin) return json(response, 403, { error: 'Invalid origin' })
      if (request.method === 'GET' && path === '/api/health') return json(response, 200, { ok: true, version, pid: process.pid })
      if (request.method === 'GET' && path === '/api/state') {
        if (!pairing) return json(response, 200, { ...config, paired: false, version, maxLanes: MAX_LANES, available: [] })
        const available = await listTerminals()
        return json(response, 200, { ...config, paired: true, version, available, maxLanes: MAX_LANES,
          lanes: config.lanes.map(l => ({ ...l, terminal: bind(l, available) || null })) })
      }
      if (request.method === 'GET' && path === '/api/roster') {
        try { return json(response, 200, normalizeConfig(JSON.parse(await readFile(rosterPath, 'utf8')))) }
        catch { return json(response, 200, normalizeConfig(null)) }
      }
      if (request.method === 'POST' && path === '/api/pair') {
        const offer = parsePairing((await body(request)).code)
        const probe = new LiveRpc(offer, { endpoint: await currentEndpoint(offer) })
        try { await probe.connect(); await probe.request('status.get') } finally { probe.close() }
        await privateJson(pairingPath, offer)
        pairing = offer
        directoryCache = null
        directoryRpc?.close(); directoryRpc = null
        for (const socket of terminalSockets) socket.close(1000, 'Pairing changed')
        return json(response, 200, { ok: true })
      }
      if (request.method === 'POST' && path === '/api/config') {
        const data = await body(request)
        const available = await listTerminals()
        const next = selectConfig(data, config, available)
        await privateJson(configPath, next)
        config = next
        // Renaming, reordering, or adding another lane must not interrupt current streams.
        for (const socket of terminalSockets) {
          const lane = config.lanes.find(l => l.id === socket.laneId)
          if (bind(lane, available)?.handle !== socket.terminalHandle) socket.close(1000, 'Lane removed or reassigned')
        }
        return json(response, 200, { ok: true })
      }
      if (request.method === 'POST' && path === '/api/attachment') {
        const attachment = await saveClipboardImage(await body(request, MAX_ATTACHMENT_BYTES, true), join(stateDir, 'attachments'))
        return json(response, 201, { attachment })
      }
      return json(response, 404, { error: 'Not found' })
    }
    if (request.method !== 'GET' || !staticFiles[path]) return json(response, 404, { error: 'Not found' })
    const [file, type] = staticFiles[path]
    const bytes = await readFile(join(root, file))
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' })
    response.end(bytes)
  } catch (error) { json(response, 400, { error: error.message }) }
})

function viewport(value) {
  if (!value || !Number.isInteger(value.cols) || !Number.isInteger(value.rows) ||
      value.cols < 2 || value.cols > 1000 || value.rows < 2 || value.rows > 500) throw new Error('Invalid terminal dimensions')
  return { cols: value.cols, rows: value.rows }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false })
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/live' || request.headers.origin !== origin || request.headers.host !== `127.0.0.1:${port}` || wss.clients.size >= Math.max(8, config.lanes.length * 3)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return
  }
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws))
})

wss.on('connection', ws => {
  let rpc = null, handle = null, ready = false, queued = 0
  let chain = Promise.resolve()
  const client = { type: 'desktop', id: `control-room-live-${randomUUID()}` }
  const timer = setTimeout(() => ws.close(1008, 'Authentication required'), 5000)
  const emit = frame => {
    if (ws.readyState !== WebSocket.OPEN) return
    if (ws.bufferedAmount > 4 * 1024 * 1024) return ws.close(1013, 'Viewer fell behind; reconnecting')
    ws.send(JSON.stringify(frame))
  }
  ws.on('close', () => { clearTimeout(timer); rpc?.close(); terminalSockets.delete(ws) })
  ws.on('error', () => { rpc?.close() })
  ws.on('message', (bytes, binary) => {
    if (binary || ++queued > 128) { ws.close(1008, 'Input queue exceeded'); return }
    chain = chain.then(async () => {
      lastClientAt = Date.now()
      if (ws.readyState !== WebSocket.OPEN) return
      const message = JSON.parse(bytes.toString('utf8'))
      if (!rpc) {
        if (message.type !== 'attach' || !matchesToken(message.token)) throw new Error('Unauthorized')
        clearTimeout(timer)
        const available = await listTerminals()
        const lane = config.lanes.find(l => bind(l, available)?.handle === message.handle)
        if (!lane) throw new Error('Choose this terminal in the experimental lane settings first')
        handle = message.handle
        ws.laneId = lane.id
        ws.terminalHandle = handle
        rpc = new LiveRpc(pairing, { endpoint: await currentEndpoint(pairing), onClose: reason => {
          emit({ type: 'error', message: reason }); ws.close(1012, 'Orca connection ended')
        } })
        await rpc.connect()
        if (ws.readyState !== WebSocket.OPEN) return rpc.close()
        terminalSockets.add(ws)
        rpc.subscribe({ terminal: handle, client, viewport: viewport(message.viewport),
          capabilities: { desktopViewportClaims: 1 } }, frame => {
          if (frame.type === 'scrollback') ready = true
          emit(frame)
          if (frame.type === 'end') ws.close(1000, 'Terminal ended')
        })
        return
      }
      if (!ready) throw new Error('Wait for the live terminal screen before typing')
      if (message.type === 'query-reply') {
        if (typeof message.data !== 'string' || message.data.length > 4096 || !isQueryReply(message.data)) throw new Error('Invalid terminal response')
        await rpc.request('terminal.send', { terminal: handle, text: message.data, client })
      } else if (message.type === 'input') {
        if (typeof message.data !== 'string' || !message.data.length || message.data.length > 32000) throw new Error('Invalid terminal input')
        const result = await rpc.request('terminal.send', { terminal: handle, text: message.data, client,
          viewport: viewport(message.viewport), claimViewport: true })
        if (result.send?.accepted !== true) throw new Error('Orca refused input; another view may control this terminal')
        emit({ type: 'input-ack', id: message.id })
      } else if (message.type === 'resize') {
        const result = await rpc.request('terminal.updateViewport', { terminal: handle, client,
          viewport: viewport(message.viewport), claim: message.claim === true })
        emit({ type: 'viewport-ack', ...result })
      } else throw new Error('Unsupported terminal action')
    }).catch(error => {
      emit({ type: 'error', message: error.message })
      ws.close(1011, 'Reconnect before sending more input')
    }).finally(() => { queued-- })
  })
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', resolve)
})
await privateJson(sessionPath, { port, token, pid: process.pid, version })
await privateJson(configPath, config)
console.log(`Control Room Live Terminals ${version} listening on ${origin}`)
const idleTimer = setInterval(() => {
  if (!terminalSockets.size && Date.now() - lastClientAt > 10 * 60000) shutdown()
}, 30000)
idleTimer.unref()
let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  clearInterval(idleTimer)
  directoryRpc?.close()
  for (const ws of wss.clients) ws.close(1001, 'Experimental companion stopped')
  server.close()
  try {
    const session = JSON.parse(await readFile(sessionPath, 'utf8'))
    if (session.pid === process.pid) await rm(sessionPath)
  } catch {}
  const timer = setTimeout(() => process.exit(0), 1200)
  timer.unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
