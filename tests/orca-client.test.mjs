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

test('uses rendered terminal screens for director cards', async () => {
  let args
  const client = new OrcaClient('unused')
  client.run = async (nextArgs) => {
    args = nextArgs
    return { terminal: { tail: ['reply'], source: 'screen' } }
  }

  const result = await client.readScreen('term_123')

  assert.deepEqual(args, ['terminal', 'read', '--terminal', 'term_123', '--screen'])
  assert.equal(result.source, 'screen')
})

test('returns the accepted send receipt', async () => {
  const receipt = { accepted: true, bytesWritten: 6 }
  const client = new OrcaClient('unused')
  let timeout
  client.run = async (_args, nextTimeout) => {
    timeout = nextTimeout
    return { send: receipt }
  }

  assert.equal(await client.send('term_123', 'hello'), receipt)
  assert.equal(timeout, 60_000)
})

test('keeps direct terminal text and Enter as separate CLI input operations', async () => {
  const calls = []
  const client = new OrcaClient('unused')
  client.run = async (args, timeout) => {
    calls.push({ args, timeout })
    return { send: { accepted: true, bytesWritten: 1 } }
  }

  await client.sendInput('term_123', { text: '/model' })
  await client.sendInput('term_123', { enter: true })

  assert.deepEqual(calls, [
    {
      args: ['terminal', 'send', '--terminal', 'term_123', '--text', '/model'],
      timeout: 60_000
    },
    {
      args: ['terminal', 'send', '--terminal', 'term_123', '--enter'],
      timeout: 60_000
    }
  ])
})

test('sends terminal interrupts without combining them with text', async () => {
  const client = new OrcaClient('unused')
  let args
  client.run = async (nextArgs) => {
    args = nextArgs
    return { send: { accepted: true, bytesWritten: 1 } }
  }

  await client.sendInput('term_123', { interrupt: true })

  assert.deepEqual(args, ['terminal', 'send', '--terminal', 'term_123', '--interrupt'])
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
