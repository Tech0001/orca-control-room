import test from 'node:test'
import assert from 'node:assert/strict'
import { createLaneRecovery, isWritable } from '../companion/live-recovery.mjs'

const lane = { id: 'lane-A', worktreePath: '/project', tabId: 'shared-tab', leafId: 'leaf-A' }
const savedTab = { type: 'terminal', parentTabId: lane.tabId, leafId: lane.leafId }
function fixture({ terminals = [], tabs = [savedTab], fail = '', wait = Promise.resolve() } = {}) {
  const calls = []
  const model = { lane }
  const recover = createLaneRecovery({ getLane: id => id === lane.id ? model.lane : null,
    listTerminals: async options => { calls.push(['terminal.list', options]); return terminals },
    connectDirectory: async () => ({ request: async (method, params) => {
      calls.push([method, params])
      if (method === fail) throw new Error('fixture failure')
      if (method === 'session.tabs.list') return { tabs }
      await wait
      return {}
    } })
  })
  return { recover, calls, model }
}

test('reopening validates the exact saved split pane, then uses native desktop activation', async () => {
  const { recover, calls } = fixture()
  assert.deepEqual(await recover(lane.id), { ok: true, alreadyActive: false })
  assert.deepEqual(calls, [
    ['terminal.list', { fresh: true }],
    ['session.tabs.list', { worktree: 'path:/project' }],
    ['session.tabs.activate', { worktree: 'path:/project', tabId: 'shared-tab', leafId: 'leaf-A', navigation: 'host', intent: 'user' }]
  ])
})

test('already writable panes only reconnect; a different live split pane is not a match', async () => {
  const terminal = { ...lane, handle: 'term-active', connected: true, writable: true }
  const active = fixture({ terminals: [terminal] })
  assert.deepEqual(await active.recover(lane.id), { ok: true, alreadyActive: true })
  assert.equal(active.calls.length, 1)
  const other = fixture({ terminals: [{ ...terminal, leafId: 'leaf-B' }] })
  await other.recover(lane.id)
  assert.equal(other.calls.at(-1)[0], 'session.tabs.activate')
})

test('missing, ambiguous and incomplete saved identities never create replacement agents', async () => {
  for (const tabs of [[], [{ ...savedTab, leafId: 'leaf-B' }], [savedTab, savedTab]]) {
    const { recover, calls } = fixture({ tabs })
    await assert.rejects(recover(lane.id), /missing or ambiguous/)
    assert.ok(!calls.some(([method]) => method === 'session.tabs.activate'))
  }
  const { recover, calls, model } = fixture()
  await assert.rejects(recover('unknown-lane'), /Lane not found/)
  model.lane = { ...lane, leafId: '' }
  await assert.rejects(recover(lane.id), /no saved pane identity/)
  assert.equal(calls.length, 0)
})

test('concurrent reopen requests share one activation; failures do not auto-retry', async () => {
  let finish
  const wait = new Promise(resolve => { finish = resolve })
  const { recover, calls } = fixture({ wait })
  const first = recover(lane.id), second = recover(lane.id)
  assert.equal(first, second)
  finish()
  await Promise.all([first, second])
  assert.equal(calls.filter(([method]) => method === 'session.tabs.activate').length, 1)
  const failure = fixture({ fail: 'session.tabs.activate' })
  await assert.rejects(failure.recover(lane.id), /did not confirm/)
  assert.equal(failure.calls.filter(([method]) => method === 'session.tabs.activate').length, 1)
  const unavailable = fixture({ fail: 'session.tabs.list' })
  await assert.rejects(unavailable.recover(lane.id), /Cannot inspect/)
  assert.equal(unavailable.calls.length, 2)
})

test('changing a lane during inspection cancels recovery', async () => {
  let current = lane
  const recover = createLaneRecovery({ getLane: () => current, listTerminals: async () => [],
    connectDirectory: async () => ({ request: async method => {
      assert.equal(method, 'session.tabs.list')
      current = { ...lane, leafId: 'replacement' }
      return { tabs: [savedTab] }
    } }) })
  await assert.rejects(recover(lane.id), /settings changed/)
})

test('writable requires affirmative connection and write evidence, not merely a handle', () => {
  for (const terminal of [null, {}, { connected: true }, { connected: false, writable: true }, { connected: true, writable: false }]) {
    assert.equal(isWritable(terminal), false)
  }
  assert.equal(isWritable({ connected: true, writable: true }), true)
})
