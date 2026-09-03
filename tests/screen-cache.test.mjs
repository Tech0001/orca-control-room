import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeTerminalHistory,
  refreshBoundTerminalScreens,
  restoreTranscriptParagraphs
} from '../companion/screen-cache.mjs'

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
  assert.deepEqual(cache.get(terminal.stableId).lines, ['frame 1', 'frame 2'])
  assert.equal(cache.get(terminal.stableId).changedAt, 101)
})

test('keeps earlier terminal rows when a post-send frame becomes shorter', () => {
  assert.deepEqual(
    mergeTerminalHistory(
      ['earlier reply', 'recent reply', 'prompt'],
      ['earlier reply', 'recent reply', 'prompt'],
      ['recent reply', 'prompt']
    ),
    ['earlier reply', 'recent reply', 'prompt']
  )
})

test('appends only new rows when the terminal viewport advances', () => {
  assert.deepEqual(
    mergeTerminalHistory(
      ['one', 'two', 'three'],
      ['one', 'two', 'three'],
      ['two', 'three', 'four']
    ),
    ['one', 'two', 'three', 'four']
  )
})

test('restores only transcript-confirmed paragraph breaks to a rendered screen', () => {
  assert.deepEqual(
    restoreTranscriptParagraphs(
      ['● First paragraph.', 'Second paragraph wraps', 'onto another line.', 'Final paragraph.'],
      [
        'older output',
        '',
        '● First paragraph.',
        '',
        '',
        'Second paragraph wraps',
        'onto another line.',
        '',
        'Final paragraph.'
      ]
    ),
    [
      '● First paragraph.',
      '',
      'Second paragraph wraps',
      'onto another line.',
      '',
      'Final paragraph.'
    ]
  )
})

test('enriches changed screens with transcript paragraphs and reuses them when unchanged', async () => {
  const cache = new Map()
  let transcriptReads = 0
  const readScreen = async () => ({
    tail: ['● First paragraph.', 'Second paragraph.'],
    source: 'screen'
  })
  const options = {
    readTranscript: async () => {
      transcriptReads += 1
      return { tail: ['● First paragraph.', '', 'Second paragraph.'] }
    }
  }

  await refreshBoundTerminalScreens([{ terminal }], cache, readScreen, options)
  await refreshBoundTerminalScreens([{ terminal }], cache, readScreen, options)

  assert.equal(transcriptReads, 1)
  assert.deepEqual(cache.get(terminal.stableId).lines, [
    '● First paragraph.',
    '',
    'Second paragraph.'
  ])
})

test('retains the old frame while adding changed redraw rows', () => {
  assert.deepEqual(
    mergeTerminalHistory(
      ['answer', 'working 1'],
      ['answer', 'working 1'],
      ['answer', 'working 2']
    ),
    ['answer', 'working 1', 'working 2']
  )
})

test('replaces transient thinking redraws instead of accumulating them', () => {
  assert.deepEqual(
    mergeTerminalHistory(
      ['answer', '✻ Stewing…'],
      ['answer', '✻ Stewing…'],
      ['answer', '✻ Combobulating…']
    ),
    ['answer', '✻ Combobulating…']
  )
  assert.deepEqual(
    mergeTerminalHistory(
      ['answer', '✻ Combobulating…'],
      ['answer', '✻ Combobulating…'],
      ['answer', 'final reply']
    ),
    ['answer', 'final reply']
  )
})

test('does not retain Codex permission dialog chrome in lane history', () => {
  assert.deepEqual(
    mergeTerminalHistory(
      ['answer', 'Update Model Permissions', '1. Full Access', 'Press enter to confirm or esc to go back'],
      ['answer'],
      ['answer', '● Permissions updated to Full Access']
    ),
    ['answer']
  )
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
