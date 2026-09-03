import { createServer } from 'node:http'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindLane, enrichTerminal, normalizeConfig } from './model.mjs'
import { OrcaClient } from './orca-client.mjs'
import { refreshBoundTerminalScreens } from './screen-cache.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const publicRoot = join(root, 'public')
const MAX_BODY_BYTES = 64 * 1024
const handlePattern = /^term_[A-Za-z0-9-]+$/
const args = process.argv.slice(2)

function argument(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const port = Number.parseInt(argument('--port', '47831'), 10)
const token = argument('--token', process.env.ORCA_CONTROL_ROOM_TOKEN || '')
const devMode = args.includes('--dev')
const stateDirectory = argument('--state-dir', join(homedir(), '.config', 'orca-control-room'))
const configFile = join(stateDirectory, 'config.json')
const sessionFile = join(stateDirectory, 'session.json')
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid port')
if (!devMode && token.length < 32) throw new Error('A session token is required')
const sessionToken = token || 'development-only-token'
const orca = new OrcaClient()

let lastClientAt = Date.now()
let config = normalizeConfig(null)
let lastSnapshot = { terminals: [], worktrees: [] }
let lastSnapshotAt = 0
let snapshotPromise = null
const screenCache = new Map()

async function readConfig() {
  try {
    config = normalizeConfig(JSON.parse(await readFile(configFile, 'utf8')))
  } catch {
    config = normalizeConfig(null)
  }
}

async function writeConfig(next) {
  config = normalizeConfig(next)
  await mkdir(stateDirectory, { recursive: true })
  const temporary = `${configFile}.tmp`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, configFile)
}

async function refreshSnapshot(force = false) {
  if (!force && Date.now() - lastSnapshotAt < 1_000) return lastSnapshot
  if (snapshotPromise) return await snapshotPromise
  snapshotPromise = orca
    .snapshot()
    .then((value) => {
      lastSnapshot = value
      lastSnapshotAt = Date.now()
      return value
    })
    .finally(() => {
      snapshotPromise = null
    })
  return await snapshotPromise
}

async function buildState(force = false) {
  const snapshot = await refreshSnapshot(force)
  const terminals = snapshot.terminals.map((terminal) =>
    enrichTerminal(terminal, snapshot.worktrees)
  )
  const bound = config.lanes.map((lane) => ({ lane, terminal: bindLane(lane, terminals) }))
  await refreshBoundTerminalScreens(bound, screenCache, (handle) => orca.readLive(handle), {
    concurrency: 4,
    canRead: (terminal) => handlePattern.test(terminal.handle)
  })
  return {
    connected: true,
    updatedAt: Date.now(),
    config,
    lanes: bound.map(({ lane, terminal }) => ({
      ...lane,
      terminal,
      screen: terminal ? screenCache.get(terminal.stableId) ?? null : null
    })),
    available: terminals
  }
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  response.end(body)
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function authorized(request) {
  return request.headers['x-control-room-token'] === sessionToken
}

function assertMutationOrigin(request) {
  const expected = `http://127.0.0.1:${port}`
  if (request.headers.origin !== expected) throw new Error('Invalid request origin')
}

function validatedHandle(value) {
  if (typeof value !== 'string' || !handlePattern.test(value)) throw new Error('Invalid terminal')
  return value
}

function mimeType(path) {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

async function serveStatic(url, response) {
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  const safePath = normalize(requested).replace(/^(\.\.(?:[\\/]|$))+/, '')
  const file = join(publicRoot, safePath)
  if (!file.startsWith(publicRoot)) throw new Error('Invalid path')
  const body = await readFile(file)
  response.writeHead(200, {
    'content-type': mimeType(file),
    'content-length': body.length,
    'cache-control': devMode ? 'no-store' : 'no-cache',
    'content-security-policy':
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer'
  })
  response.end(body)
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(request)) return json(response, 401, { error: 'Unauthorized' })
      lastClientAt = Date.now()
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return json(response, 200, { ok: true })
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        return json(response, 200, await buildState(url.searchParams.get('force') === '1'))
      }
      if (request.method === 'GET' && url.pathname === '/api/transcript') {
        const handle = validatedHandle(url.searchParams.get('handle'))
        const transcript = await orca.readTranscript(handle)
        return json(response, 200, {
          lines: Array.isArray(transcript.tail) ? transcript.tail : [],
          truncated: transcript.truncated === true,
          oldestCursor: transcript.oldestCursor ?? null
        })
      }
      if (request.method === 'POST' && url.pathname === '/api/config') {
        assertMutationOrigin(request)
        await writeConfig(await readBody(request))
        return json(response, 200, { ok: true, config })
      }
      if (request.method === 'POST' && url.pathname === '/api/send') {
        assertMutationOrigin(request)
        const body = await readBody(request)
        const handle = validatedHandle(body.handle)
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4_096) {
          throw new Error('Message must contain 1–4096 characters')
        }
        const send = await orca.send(handle, body.text)
        return json(response, 200, { ok: true, send })
      }
      if (request.method === 'POST' && url.pathname === '/api/switch') {
        assertMutationOrigin(request)
        const body = await readBody(request)
        await orca.switchTo(validatedHandle(body.handle))
        return json(response, 200, { ok: true })
      }
      return json(response, 404, { error: 'Not found' })
    }
    if (request.method !== 'GET') return json(response, 405, { error: 'Method not allowed' })
    await serveStatic(url, response)
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})

await readConfig()
await mkdir(stateDirectory, { recursive: true })
await writeFile(sessionFile, `${JSON.stringify({ port, token: sessionToken, pid: process.pid })}\n`, {
  mode: 0o600
})

server.listen(port, '127.0.0.1')

const idleTimer = setInterval(() => {
  if (!devMode && Date.now() - lastClientAt > 10 * 60_000) server.close()
}, 30_000)
idleTimer.unref()

async function cleanExit() {
  clearInterval(idleTimer)
  await rm(sessionFile, { force: true }).catch(() => undefined)
  process.exit(0)
}

server.on('close', () => void cleanExit())
process.on('SIGTERM', () => server.close())
process.on('SIGINT', () => server.close())
