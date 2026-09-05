import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import nacl from 'tweetnacl'
import { encryptFrame, decryptFrame } from '../../companion/live-rpc.mjs'

export async function fakeRuntime() {
  const keys = nacl.box.keyPair()
  const token = randomUUID()
  const inputs = []
  const methods = []
  const subscriptions = new Set()
  const terminals = ['A', 'B'].map(name => ({ handle: `term_test-${name}`, tabId: 'shared-tab', leafId: `leaf-${name}`,
    title: `Test ${name}`, worktreePath: '/test/shared-worktree', connected: true, writable: true }))
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => wss.once('listening', resolve))
  const pairing = { v: 1, endpoint: `ws://127.0.0.1:${wss.address().port}`, deviceToken: token,
    publicKeyB64: Buffer.from(keys.publicKey).toString('base64'), scope: 'runtime' }
  wss.on('connection', ws => {
    let sharedKey = null, authed = false
    const emit = (id, result) => ws.send(encryptFrame({ id, ok: true, result, _meta: { runtimeId: 'test-runtime' } }, sharedKey))
    ws.on('error', () => {})
    ws.on('close', () => { for (const sub of subscriptions) if (sub.ws === ws) subscriptions.delete(sub) })
    ws.on('message', raw => {
      if (!sharedKey) {
        const hello = JSON.parse(raw.toString())
        sharedKey = nacl.box.before(Buffer.from(hello.publicKeyB64, 'base64'), keys.secretKey)
        ws.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }
      const request = decryptFrame(raw.toString(), sharedKey)
      if (!authed) {
        authed = request.deviceToken === token
        ws.send(encryptFrame(authed ? { type: 'e2ee_authenticated' } : { error: { code: 'unauthorized' } }, sharedKey))
        return
      }
      methods.push(request.method)
      const { id, params: p = {} } = request
      if (request.method === 'status.get') emit(id, { app: { version: 'fixture' } })
      else if (request.method === 'terminal.list') emit(id, { terminals })
      else if (request.method === 'terminal.subscribe') {
        subscriptions.add({ ws, terminal: p.terminal, id, emit })
        emit(id, { type: 'scrollback', cols: 80, rows: 24, serialized: `\x1b[2J\x1b[H\x1b[32mLIVE ${p.terminal}\x1b[0m\r\nNative prompt > ` })
      } else if (request.method === 'terminal.send') {
        inputs.push(p)
        const delay = p.text === 'slow-A' ? 180 : 0
        setTimeout(() => {
          if (ws.readyState !== ws.OPEN) return
          emit(id, { send: { accepted: true, bytesWritten: Buffer.byteLength(p.text) } })
          for (const sub of subscriptions) if (sub.terminal === p.terminal) sub.emit(sub.id, { type: 'data', chunk: p.text })
        }, delay)
      } else if (request.method === 'terminal.updateViewport') {
        emit(id, { updated: true, applied: true })
        if (p.claim) for (const sub of subscriptions) if (sub.terminal === p.terminal) {
          sub.emit(sub.id, { type: 'fit-override-changed', cols: p.viewport.cols, rows: p.viewport.rows })
        }
      } else emit(id, {})
    })
  })
  return { pairing, terminals, inputs, methods, subscriptions,
    output(handle, chunk) { for (const sub of subscriptions) if (sub.terminal === handle) sub.emit(sub.id, { type: 'data', chunk }) },
    disconnectStreams() { for (const sub of subscriptions) sub.ws.close() },
    async close() { for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)) }
  }
}
