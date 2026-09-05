import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTROL_ROOM_VERSION } from './version.mjs'

const pluginRoot = dirname(fileURLToPath(import.meta.url))
const serverEntry = join(pluginRoot, 'companion', 'live-server.mjs')
const stateDirectory = join(homedir(), '.config', 'orca-control-room-live-terminals')
const sessionFile = join(stateDirectory, 'session.json')
const defaultPort = 47_832

async function readSession() {
  try {
    const parsed = JSON.parse(await readFile(sessionFile, 'utf8'))
    if (
      Number.isInteger(parsed.port) &&
      parsed.port > 0 &&
      parsed.port < 65_536 &&
      typeof parsed.token === 'string' &&
      parsed.token.length >= 32
    ) {
      return parsed
    }
  } catch {
    // A stale or absent session record simply starts a new companion.
  }
  return null
}

async function readHealth(session) {
  if (!session) return null
  try {
    const response = await fetch(`http://127.0.0.1:${session.port}/api/health`, {
      headers: { 'x-control-room-token': session.token },
      signal: AbortSignal.timeout(750)
    })
    if (!response.ok) return null
    const health = await response.json()
    return health?.ok === true ? health : null
  } catch {
    return null
  }
}

async function isHealthy(session) {
  return (await readHealth(session))?.version === CONTROL_ROOM_VERSION
}

async function stopObsoleteCompanion(session) {
  const health = await readHealth(session)
  if (!health || health.version === CONTROL_ROOM_VERSION) return
  const pid = Number.isInteger(health.pid) ? health.pid : session?.pid
  if (!Number.isInteger(pid) || pid < 2) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (!(await readHealth(session))) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Outdated Control Room companion did not stop')
}

async function waitForServer(session) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if (await isHealthy(session)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('Control Room companion did not become ready')
}

async function spawnCommand(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

async function openWindow(url) {
  if (process.platform === 'linux') {
    try {
      await spawnCommand('chromium', [`--app=${url}`])
      return
    } catch {
      await spawnCommand('xdg-open', [url])
      return
    }
  }
  if (process.platform === 'darwin') {
    await spawnCommand('open', [url])
    return
  }
  if (process.platform === 'win32') {
    await spawnCommand('rundll32.exe', ['url.dll,FileProtocolHandler', url])
    return
  }
  throw new Error(`Opening the Control Room is unsupported on ${process.platform}`)
}

export async function ensureCompanion() {
  const existing = await readSession()
  if (await isHealthy(existing)) return existing
  await stopObsoleteCompanion(existing)

  await access(serverEntry)
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  const session = { port: defaultPort, token: randomUUID() }
  const child = spawn(
    process.execPath,
    [serverEntry, '--port', String(session.port), '--token', session.token],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }
  )
  child.unref()
  await waitForServer(session)
  return session
}

async function openLiveTerminals() {
    const session = await ensureCompanion()
    const url = `http://127.0.0.1:${session.port}/#token=${encodeURIComponent(session.token)}`
    await openWindow(url)
    return { opened: true }
}

export default function activate(orca) {
  orca.commands.register('open-live-terminals', openLiveTerminals)
}

if (process.argv.includes('--open')) await openLiveTerminals()
