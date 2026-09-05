import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createStaggeredScreenRefresher,
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

function binding(id) {
  return {
    terminal: {
      ...terminal,
      stableId: id,
      handle: `term_${id}`
    }
  }
}

test('staggered screen refreshes never overlap', async () => {
  let active = 0
  let maximumActive = 0
  const order = []
  const refresher = createStaggeredScreenRefresher(
    async ({ terminal: current }) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      order.push(current.stableId)
      await Promise.resolve()
      active -= 1
    },
    { gapMs: 0, minimumIntervalMs: 0 }
  )

  refresher.schedule([binding('one'), binding('two'), binding('three')], { force: true })
  await refresher.whenIdle()

  assert.equal(maximumActive, 1)
  assert.deepEqual(order, ['one', 'two', 'three'])
})

test('staggered screen refreshes respect each lane interval', async () => {
  let clock = 1_000
  const reads = []
  const refresher = createStaggeredScreenRefresher(
    async ({ terminal: current }) => reads.push(current.stableId),
    { gapMs: 0, minimumIntervalMs: 100, now: () => clock }
  )
  const lanes = [binding('one'), binding('two')]

  refresher.schedule(lanes)
  await refresher.whenIdle()
  refresher.schedule(lanes)
  await refresher.whenIdle()
  assert.deepEqual(reads, ['one', 'two'])

  clock += 100
  refresher.schedule(lanes)
  await refresher.whenIdle()
  assert.deepEqual(reads, ['one', 'two', 'one', 'two'])
})

test('a recently used terminal moves to the front of the staggered queue', async () => {
  const order = []
  let releaseFirst
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const refresher = createStaggeredScreenRefresher(
    async ({ terminal: current }) => {
      order.push(current.stableId)
      if (current.stableId === 'one') await firstBlocked
    },
    { gapMs: 0, minimumIntervalMs: 0 }
  )

  refresher.schedule([binding('one'), binding('two'), binding('three')], { force: true })
  assert.equal(refresher.prioritizeHandle('term_three'), true)
  releaseFirst()
  await refresher.whenIdle()

  assert.deepEqual(order, ['one', 'three', 'two'])
})

test('repeated state polls do not duplicate queued screen refreshes', async () => {
  const order = []
  let releaseFirst
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const refresher = createStaggeredScreenRefresher(
    async ({ terminal: current }) => {
      order.push(current.stableId)
      if (current.stableId === 'one') await firstBlocked
    },
    { gapMs: 0, minimumIntervalMs: 0 }
  )
  const lanes = [binding('one'), binding('two')]

  refresher.schedule(lanes, { force: true })
  refresher.schedule(lanes, { force: true })
  releaseFirst()
  await refresher.whenIdle()

  assert.deepEqual(order, ['one', 'two'])
})

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

test('keeps a single replaceable frame while the viewport advances repeatedly', () => {
  let history = mergeTerminalHistory([], [], ['one', 'two', 'three'])
  history = mergeTerminalHistory(history, ['one', 'two', 'three'], ['two', 'three', 'four'])
  history = mergeTerminalHistory(history, ['two', 'three', 'four'], ['three', 'four', 'five'])

  assert.deepEqual(history, ['one', 'two', 'three', 'four', 'five'])
})

test('replaces a redrawn viewport instead of duplicating it around a stable footer', () => {
  const firstFrame = [
    '● Metakit pins the requested pairing.',
    '  I am preparing the intake matrix.',
    '/rc'
  ]
  const nextFrame = [
    '● Metakit pins the requested pairing.',
    '  I am preparing the intake matrix.',
    '● The current image gate still defaults to rc.2.',
    '/rc'
  ]

  assert.deepEqual(mergeTerminalHistory(firstFrame, firstFrame, nextFrame), nextFrame)
})

test('replaces reflowed frame rows rather than retaining both layouts', () => {
  const firstFrame = ['● A long response wraps at this', 'terminal width.', '/rc']
  const nextFrame = ['● A long response wraps', 'at this terminal width.', '/rc']

  assert.deepEqual(mergeTerminalHistory(firstFrame, firstFrame, nextFrame), nextFrame)
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

test('restores paragraph breaks when screen and transcript wrap text differently', () => {
  assert.deepEqual(
    restoreTranscriptParagraphs(
      [
        '● One additional finding matters for your earlier MPT',
        'question: Metakit now includes an actual committed-state',
        'framework, with an MPT state dictionary and',
        'historical-root catalog—not just proof-verification',
        'operators.',
        'Upstream committed-state design',
        '(https://github.com/Constellation-Labs/metakit/blob/v1.8.0-rc.12/docs/committed-namespaces.md)',
        'So yes: move forward onto the RC baseline and adapt.',
        'Keep correctness checks, drop unnecessary historical-',
        'compatibility work.'
      ],
      [
        'older output',
        '',
        '● One additional finding matters for your earlier MPT',
        'question: Metakit now includes an actual committed-state',
        'framework, with an MPT state dictionary and',
        'historical-root catalog—not just proof-verification',
        'operators.',
        '',
        'Upstream committed-state design',
        '(https://github.com/Constellation-Labs/metakit/blob/v1.8.0',
        '-rc.12/docs/committed-namespaces.md)',
        '',
        'So yes: move forward onto the RC baseline and adapt.',
        'Keep correctness checks, drop unnecessary historical-',
        'compatibility work.'
      ]
    ),
    [
      '● One additional finding matters for your earlier MPT',
      'question: Metakit now includes an actual committed-state',
      'framework, with an MPT state dictionary and',
      'historical-root catalog—not just proof-verification',
      'operators.',
      '',
      'Upstream committed-state design',
      '(https://github.com/Constellation-Labs/metakit/blob/v1.8.0-rc.12/docs/committed-namespaces.md)',
      '',
      'So yes: move forward onto the RC baseline and adapt.',
      'Keep correctness checks, drop unnecessary historical-',
      'compatibility work.'
    ]
  )
})

test('does not split a continuous wrapped list on noisy transcript blanks', () => {
  assert.deepEqual(
    restoreTranscriptParagraphs(
      [
        '● Verification',
        '- Full suite: 1,328/1,328',
        '- Focused suite: 22/22 in default, Turkish, and',
        '  Lithuanian runs',
        '- Independent JavaScript oracle: 12/12',
        '- Documentation, formatting, and packet checksums',
        '  passed'
      ],
      [
        '● Verification',
        '',
        '- Full suite: 1,328/1,328',
        '- Focused suite: 22/22 in default, Turkish, and',
        '  Lithuanian runs',
        '',
        '- Independent JavaScript oracle: 12/12',
        '- Documentation, formatting, and packet checksums',
        '  passed'
      ]
    ),
    [
      '● Verification',
      '',
      '- Full suite: 1,328/1,328',
      '- Focused suite: 22/22 in default, Turkish, and',
      '  Lithuanian runs',
      '- Independent JavaScript oracle: 12/12',
      '- Documentation, formatting, and packet checksums',
      '  passed'
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

test('retries transcript enrichment once when transcript output lags behind the screen', async () => {
  const cache = new Map()
  let transcriptReads = 0
  const readScreen = async () => ({
    tail: ['● First paragraph.', 'Second paragraph.'],
    source: 'screen'
  })
  const options = {
    readTranscript: async () => ({
      tail:
        ++transcriptReads === 1
          ? ['● First paragraph.', 'Second paragraph.']
          : ['● First paragraph.', '', 'Second paragraph.']
    })
  }

  await refreshBoundTerminalScreens([{ terminal }], cache, readScreen, options)
  await refreshBoundTerminalScreens([{ terminal }], cache, readScreen, options)
  await refreshBoundTerminalScreens([{ terminal }], cache, readScreen, options)

  assert.equal(transcriptReads, 2)
  assert.deepEqual(cache.get(terminal.stableId).lines, [
    '● First paragraph.',
    '',
    'Second paragraph.'
  ])
})

test('replaces changed redraw rows in the active frame', () => {
  assert.deepEqual(
    mergeTerminalHistory(
      ['answer', 'working 1'],
      ['answer', 'working 1'],
      ['answer', 'working 2']
    ),
    ['answer', 'working 2']
  )
})

test('keeps only the latest timed working row', () => {
  assert.deepEqual(
    mergeTerminalHistory(
      ['answer', 'Working (1m 23s • esc to interrupt)'],
      ['answer', 'Working (1m 23s • esc to interrupt)'],
      ['answer', 'Working (1m 29s • esc to interrupt)']
    ),
    ['answer', 'Working (1m 29s • esc to interrupt)']
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
