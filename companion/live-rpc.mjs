import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import nacl from 'tweetnacl'

const MAX_FRAME = 8 * 1024 * 1024

export function parsePairing(input) {
  if (typeof input !== 'string' || input.length > 32000) throw new Error('Invalid pairing link')
  let code = input.trim()
  if (code.startsWith('http')) {
    const url = new URL(code)
    code = new URLSearchParams(url.hash.slice(1)).get('pairing') || ''
  }
  if (code.startsWith('orca://')) {
    const url = new URL(code)
    if (url.hostname !== 'pair') throw new Error('Invalid pairing link')
    code = url.searchParams.get('code') || url.hash.slice(1)
  }
  let offer
  try { offer = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')) } catch {
    throw new Error('Paste the Orca runtime pairing link')
  }
  const endpoint = new URL(offer.endpoint)
  if (!['ws:', 'wss:'].includes(endpoint.protocol) ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password) {
    throw new Error('Choose “This computer only” in Orca; this prototype connects only to loopback')
  }
  if (offer.scope !== 'runtime') throw new Error('Use a runtime/browser pairing link, not a phone QR code')
  if (typeof offer.deviceToken !== 'string' || offer.deviceToken.length < 24 ||
      typeof offer.publicKeyB64 !== 'string' || Buffer.from(offer.publicKeyB64, 'base64').length !== 32) {
    throw new Error('Pairing link is missing its credentials')
  }
  return { v: offer.v, endpoint: endpoint.href, scope: offer.scope,
    deviceToken: offer.deviceToken, publicKeyB64: offer.publicKeyB64 }
}

export async function currentEndpoint(pairing) {
  const home = homedir()
  const directory = process.env.ORCA_USER_DATA_PATH || (process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'orca')
    : process.platform === 'win32' ? join(process.env.APPDATA || home, 'orca')
      : join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'orca'))
  try {
    const metadata = JSON.parse(await readFile(join(directory, 'orca-runtime.json'), 'utf8'))
    const transport = (metadata.transports || [metadata.transport]).find(t => t?.kind === 'websocket')
    const endpoint = new URL(transport.endpoint)
    // Keep the paired host identity; only rediscover its local listener after restart.
    const saved = new URL(pairing.endpoint)
    if (['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)) saved.port = endpoint.port
    return saved.href
  } catch { return pairing.endpoint }
}

export function encryptFrame(value, sharedKey) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const bytes = Buffer.from(JSON.stringify(value))
  return Buffer.concat([Buffer.from(nonce), Buffer.from(nacl.box.after(bytes, nonce, sharedKey))]).toString('base64')
}

export function decryptFrame(frame, sharedKey) {
  const bytes = Buffer.from(frame, 'base64')
  const plain = nacl.box.open.after(bytes.subarray(24), bytes.subarray(0, 24), sharedKey)
  if (!plain) throw new Error('Orca returned an invalid encrypted frame')
  return JSON.parse(Buffer.from(plain).toString('utf8'))
}

// Internal Orca transport adapter. Keep protocol-specific behavior out of the UI.
export class LiveRpc {
  constructor(pairing, { onClose = () => {}, endpoint = pairing.endpoint } = {}) {
    this.pairing = pairing
    this.endpoint = endpoint
    this.onClose = onClose
    this.pending = new Map()
    this.streams = new Map()
    this.closed = false
  }

  async connect() {
    const keys = nacl.box.keyPair()
    this.sharedKey = nacl.box.before(Buffer.from(this.pairing.publicKeyB64, 'base64'), keys.secretKey)
    return await new Promise((resolve, reject) => {
      let phase = 'hello'
      let settled = false
      const timeout = setTimeout(() => fail(new Error('Orca pairing connection timed out')), 10000)
      const fail = error => {
        if (!settled) { settled = true; reject(error) }
        this.failure = error.message
        this.close()
      }
      const ws = this.ws = new WebSocket(this.endpoint, { maxPayload: MAX_FRAME, perMessageDeflate: false })
      ws.on('error', () => fail(new Error('Cannot connect to Orca; check that it is running')))
      ws.on('close', () => {
        this.closed = true
        clearTimeout(timeout)
        clearInterval(this.heartbeat)
        if (!settled) { settled = true; reject(new Error('Orca closed the pairing connection')) }
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Connection closed; input was not retried')) }
        this.pending.clear()
        this.onClose(this.failure || 'Disconnected from Orca')
      })
      ws.on('open', () => ws.send(JSON.stringify({ type: 'e2ee_hello', publicKeyB64: Buffer.from(keys.publicKey).toString('base64') })))
      ws.on('message', (bytes, binary) => {
        try {
          if (binary) throw new Error('Unexpected binary terminal protocol; reconnect after updating the adapter')
          if (phase === 'hello') {
            if (JSON.parse(bytes.toString()).type !== 'e2ee_ready') throw new Error('Unsupported Orca handshake')
            phase = 'auth'
            return this.send({ type: 'e2ee_auth', deviceToken: this.pairing.deviceToken, clientCapabilities: [] })
          }
          const frame = decryptFrame(bytes.toString(), this.sharedKey)
          if (phase === 'auth') {
            if (frame.type !== 'e2ee_authenticated') throw new Error('Orca rejected this pairing; generate a new runtime link')
            phase = 'ready'
            clearTimeout(timeout)
            settled = true
            this.alive = true
            ws.on('pong', () => { this.alive = true })
            this.heartbeat = setInterval(() => {
              if (!this.alive) return fail(new Error('Orca stopped responding'))
              this.alive = false
              if (ws.readyState === WebSocket.OPEN) ws.ping()
            }, 15000)
            this.heartbeat.unref()
            return resolve(this)
          }
          this.alive = true
          if (this.streams.has(frame.id)) {
            if (!frame.ok) throw new Error(frame.error?.message || 'Terminal subscription failed')
            return this.streams.get(frame.id)(frame.result)
          }
          const pending = this.pending.get(frame.id)
          if (!pending) return
          this.pending.delete(frame.id)
          clearTimeout(pending.timer)
          if (frame.ok) pending.resolve(frame.result)
          else pending.reject(new Error(frame.error?.message || 'Orca request failed'))
        } catch (error) { fail(error) }
      })
    })
  }

  send(value) {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) throw new Error('Orca connection is closed')
    if (this.ws.bufferedAmount > MAX_FRAME) throw new Error('Orca connection is too slow; reconnect before continuing')
    this.ws.send(encryptFrame(value, this.sharedKey))
  }

  request(method, params = {}, timeoutMs = 10000) {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Orca request timed out; input was not retried'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ id, method, params, deviceToken: this.pairing.deviceToken }) } catch (error) {
        this.pending.delete(id); clearTimeout(timer); reject(error)
      }
    })
  }

  subscribe(params, onFrame) {
    const id = randomUUID()
    this.streams.set(id, onFrame)
    this.send({ id, method: 'terminal.subscribe', params, deviceToken: this.pairing.deviceToken })
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    if (this.ws?.readyState === WebSocket.CONNECTING) this.ws.terminate()
    else this.ws?.close()
    const timer = setTimeout(() => this.ws?.terminate(), 1000)
    timer.unref()
  }
}
