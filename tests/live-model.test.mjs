import test from 'node:test'
import assert from 'node:assert/strict'
import { bindLane, normalizeConfig, selectConfig, MAX_LANES } from '../companion/live-model.mjs'

const terminals = Array.from({ length: 14 }, (_, i) => ({ handle: `handle-${i}`, tabId: 'same-tab', leafId: `leaf-${i}`, worktreePath: '/test/agents', title: `Agent ${i}` }))

test('supports empty, single, eleven, and larger ordered rosters with stable IDs', () => {
  for (const count of [0, 1, 2, 11, 14]) {
    const config = selectConfig({ handles: terminals.slice(0, count).map(t => t.handle) }, normalizeConfig(null), terminals)
    assert.equal(config.lanes.length, count)
    assert.deepEqual(config.lanes.map(l => l.handle), terminals.slice(0, count).map(t => t.handle))
    assert.deepEqual(normalizeConfig(JSON.parse(JSON.stringify(config))), config)
    assert.equal(new Set(config.lanes.map(l => l.id)).size, count)
  }
})

test('reordering and renaming preserve IDs and distinguish split panes', () => {
  const previous = selectConfig({ handles: ['handle-0', 'handle-1'] }, normalizeConfig(null), terminals)
  const config = selectConfig({ lanes: previous.lanes.toReversed().map(l => ({ ...l, name: 'Renamed' })), columns: 6, fontSize: 11 }, previous, terminals)
  assert.deepEqual(config.lanes.map(l => l.id), previous.lanes.toReversed().map(l => l.id))
  assert.deepEqual(config.lanes.map(l => bindLane(l, terminals)?.handle), ['handle-1', 'handle-0'])
  assert.equal(config.columns, 6)
  assert.equal(config.fontSize, 11)
  assert.equal(config.lanes[0].name, 'Renamed')
})

test('rebinds replaced runtime handles but never silently picks an ambiguous or wrong pane', () => {
  const old = { ...terminals[0], id: 'saved-lane', name: 'A' }
  const changed = [{ ...terminals[0], handle: 'new-handle' }, terminals[1]]
  assert.equal(bindLane(old, changed).handle, 'new-handle')
  assert.equal(bindLane({ ...old, leafId: '', handle: '' }, changed), null)
  assert.equal(bindLane({ ...old, leafId: 'missing-pane' }, changed), null)
  assert.equal(bindLane({ ...old, tabId: 'missing-tab' }, changed), null)
})

test('keeps unavailable saved lanes and rejects duplicates or invented terminals', () => {
  const previous = normalizeConfig({ lanes: [{ ...terminals[0], name: 'Offline' }] })
  const config = selectConfig({ lanes: [{ id: previous.lanes[0].id, handle: '', name: 'Offline' }] }, previous, [])
  assert.equal(config.lanes[0].id, previous.lanes[0].id)
  assert.throws(() => selectConfig({ handles: ['handle-0', 'handle-0'] }, previous, terminals), /only once/)
  assert.throws(() => selectConfig({ handles: ['invented'] }, previous, terminals), /no longer exists/)
  assert.throws(() => selectConfig({ lanes: Array(MAX_LANES + 1).fill({}) }, previous, terminals), /up to/)
})

test('normalizes old prototype and original rosters without mixing identity and position', () => {
  const config = normalizeConfig({ columns: 999, fontSize: 1, lanes: [{ ...terminals[1], name: 'B', order: 1 }, { ...terminals[0], name: 'A', order: 0 }] })
  assert.deepEqual(config.lanes.map(l => l.name), ['B', 'A'])
  assert.equal(config.columns, 12)
  assert.equal(config.fontSize, 9)
  assert.equal(normalizeConfig(null).columns, 0)
})
