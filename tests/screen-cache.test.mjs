import test from 'node:test'
import assert from 'node:assert/strict'
import { refreshBoundTerminalScreens } from '../companion/screen-cache.mjs'

const terminal = {
  stableId: '/work/agent-Lyra\u0000tab-1',
  handle: 'term_123',
  connected: true,
  lastOutputAt: 42
}

test('re-reads visible screens when Orca activity metadata does not change', async () => {
  const cache = new Map()
  let reads = 0
  let clock = 100
  const readScreen = async () => ({
    tail: [`frame ${++reads}`],
    source: 'screen'
  })

  await refreshBoundTerminalScreens([{ terminal }], cache, readScreen, { now: () => clock++ })
  await refreshBoundTerminalScreens([{ terminal }], cache, readScreen, { now: () => clock++ })

  assert.equal(reads, 2)
  assert.deepEqual(cache.get(terminal.stableId).lines, ['frame 2'])
  assert.equal(cache.get(terminal.stableId).changedAt, 101)
})

test('keeps the last readable frame while a screen read is retrying', async () => {
  const cache = new Map([
    [
      terminal.stableId,
      {
        lines: ['last good frame'],
        source: 'screen',
        draft: '',
        readAt: 100,
        changedAt: 100,
        error: null
      }
    ]
  ])

  await refreshBoundTerminalScreens(
    [{ terminal }],
    cache,
    async () => {
      throw new Error('temporary read failure')
    }
  )

  assert.deepEqual(cache.get(terminal.stableId).lines, ['last good frame'])
  assert.equal(cache.get(terminal.stableId).error, 'temporary read failure')
})
