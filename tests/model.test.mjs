import test from 'node:test'
import assert from 'node:assert/strict'
import { bindLane, enrichTerminal, normalizeConfig, terminalStableId } from '../companion/model.mjs'

const terminal = {
  handle: 'term_123',
  worktreePath: '/work/agent-Lyra',
  worktreeId: 'repo::/work/agent-Lyra',
  tabId: 'tab-1',
  title: 'agent-Lyra',
  connected: true,
  writable: true,
  lastOutputAt: 42
}

test('normalizes persistent lanes and clamps the column count', () => {
  const config = normalizeConfig({
    columns: 99,
    lanes: [{ worktreePath: terminal.worktreePath, tabId: terminal.tabId, name: 'Lyra' }]
  })
  assert.equal(config.columns, 8)
  assert.equal(config.lanes.length, 1)
  assert.equal(config.lanes[0].name, 'Lyra')
  assert.equal(config.lanes[0].role, 'manager')
})

test('rebinds a lane after runtime terminal handles change', () => {
  const lane = {
    worktreePath: terminal.worktreePath,
    tabId: terminal.tabId
  }
  assert.equal(bindLane(lane, [{ ...terminal, handle: 'term_restarted' }]).handle, 'term_restarted')
})

test('rolls nested agents and child worktrees into the manager count', () => {
  const enriched = enrichTerminal(terminal, [
    {
      path: terminal.worktreePath,
      displayName: 'Lyra',
      childWorktreeIds: ['child-1'],
      agents: [{ parentPaneKey: null }, { parentPaneKey: 'manager-pane' }]
    }
  ])
  assert.equal(enriched.childCount, 2)
  assert.equal(enriched.stableId, terminalStableId(terminal))
})
