import test from 'node:test'
import assert from 'node:assert/strict'
import { OrcaClient } from '../companion/orca-client.mjs'

test('uses background-safe terminal reads without the rendered-screen flag', async () => {
  let args
  const client = new OrcaClient('unused')
  client.run = async (nextArgs) => {
    args = nextArgs
    return { terminal: { tail: ['reply'], source: 'stream' } }
  }

  const result = await client.readLive('term_123')

  assert.deepEqual(args, [
    'terminal',
    'read',
    '--terminal',
    'term_123',
    '--limit',
    '240'
  ])
  assert.equal(args.includes('--screen'), false)
  assert.equal(result.source, 'stream')
})

test('returns the accepted send receipt', async () => {
  const receipt = { accepted: true, bytesWritten: 6 }
  const client = new OrcaClient('unused')
  client.run = async () => ({ send: receipt })

  assert.equal(await client.send('term_123', 'hello'), receipt)
})

test('surfaces a refused send with its reason', async () => {
  const client = new OrcaClient('unused')
  client.run = async () => ({
    send: {
      accepted: false,
      bytesWritten: 0,
      refusedReason: 'terminal is not writable'
    }
  })

  await assert.rejects(
    () => client.send('term_123', 'hello'),
    /terminal is not writable/
  )
})
