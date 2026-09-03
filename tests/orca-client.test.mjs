import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultOrcaCli, OrcaClient } from '../companion/orca-client.mjs'

test('uses the stable Linux CLI launcher instead of an AppImage PATH entry', () => {
  let inspectedPath
  const command = defaultOrcaCli('linux', {}, '/home/tester', (path) => {
    inspectedPath = path
    return true
  })

  assert.equal(inspectedPath, '/home/tester/.local/bin/orca-ide')
  assert.equal(command, '/home/tester/.local/bin/orca-ide')
})

test('honors an explicit Orca CLI command', () => {
  assert.equal(
    defaultOrcaCli('linux', { ORCA_CONTROL_ROOM_CLI: '/opt/orca-cli' }, '/home/tester'),
    '/opt/orca-cli'
  )
})

test('falls back to the platform CLI name when no stable launcher exists', () => {
  assert.equal(defaultOrcaCli('linux', {}, '/home/tester', () => false), 'orca-ide')
  assert.equal(defaultOrcaCli('darwin', {}, '/Users/tester', () => false), 'orca')
})

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
