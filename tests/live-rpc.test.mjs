import test from 'node:test'
import assert from 'node:assert/strict'
import { LiveRpc, parsePairing } from '../companion/live-rpc.mjs'
import { isQueryReply, inputChunks } from '../companion/public/live-protocol.mjs'
import { fakeRuntime } from './support/live-runtime.mjs'

test('loopback pairing accepts runtime links and rejects network/phone grants', () => {
  const offer = { v: 1, endpoint: 'ws://127.0.0.1:1234', scope: 'runtime',
    deviceToken: 'a'.repeat(48), publicKeyB64: Buffer.alloc(32, 1).toString('base64') }
  const code = value => `orca://pair?code=${Buffer.from(JSON.stringify(value)).toString('base64url')}`
  assert.equal(parsePairing(code(offer)).endpoint, offer.endpoint + '/')
  assert.equal(parsePairing('http://127.0.0.1/web-index.html#pairing=' + encodeURIComponent(code(offer))).scope, 'runtime')
  assert.throws(() => parsePairing(code({ ...offer, scope: 'mobile' })), /runtime/)
  assert.throws(() => parsePairing(code({ ...offer, endpoint: 'ws://192.168.1.2:1234' })), /loopback/)
  assert.throws(() => parsePairing(code({ ...offer, endpoint: 'https://127.0.0.1' })), /loopback/)
})

test('raw keys remain input, query replies are separate, paste chunks preserve Unicode', () => {
  for (const key of ['\x1b[A', '\x1b[B', '\r', '\x03', '/model', '\x1b[200~hello\x1b[201~']) assert.equal(isQueryReply(key), false)
  for (const query of ['\x1b[2;4R', '\x1b[?1;2c', '\x1b]11;rgb:0000/0000/0000\x07']) assert.equal(isQueryReply(query), true)
  const paste = 'a'.repeat(15999) + '🌲' + 'b'.repeat(17000)
  const chunks = inputChunks(paste)
  assert.equal(chunks.map(s => Buffer.from(s).toString()).join(''), paste)
  assert.ok(chunks.every(s => s.length <= 16000))
})

test('two authenticated streams stay independent and closing viewers does not close terminals', async t => {
  const runtime = await fakeRuntime()
  t.after(() => runtime.close())
  const a = await new LiveRpc(runtime.pairing).connect()
  const b = await new LiveRpc(runtime.pairing).connect()
  t.after(() => { a.close(); b.close() })
  const framesA = [], framesB = []
  a.subscribe({ terminal: 'term_test-A' }, frame => framesA.push(frame))
  b.subscribe({ terminal: 'term_test-B' }, frame => framesB.push(frame))
  const completion = []
  const slow = a.request('terminal.send', { terminal: 'term_test-A', text: 'slow-A' }).then(() => completion.push('A'))
  await b.request('terminal.send', { terminal: 'term_test-B', text: '\x1b[B\r' })
  completion.push('B')
  assert.deepEqual(completion, ['B'])
  await slow
  assert.ok(framesA.some(f => f.type === 'scrollback' && f.serialized.includes('term_test-A')))
  assert.ok(framesB.some(f => f.type === 'scrollback' && f.serialized.includes('term_test-B')))
  assert.equal(runtime.inputs[1].text, '\x1b[B\r')
  a.close(); b.close()
  assert.ok(!runtime.methods.some(m => /close|kill|stop/.test(m)))
})

test('incorrect pairing fails without exposing credentials', async t => {
  const runtime = await fakeRuntime()
  t.after(() => runtime.close())
  await assert.rejects(new LiveRpc({ ...runtime.pairing, deviceToken: 'invalid-credential' }).connect(), /rejected/)
})
