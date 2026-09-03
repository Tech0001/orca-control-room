import test from 'node:test'
import assert from 'node:assert/strict'
import {
  filterTerminalUiNoise,
  isTransientTerminalStatus,
  terminalLineKind,
  terminalMessageBlocks
} from '../companion/public/terminal-format.js'

test('classifies common agent terminal lines for safe semantic highlighting', () => {
  const examples = [
    ['', 'blank'],
    ['› review the implementation', 'prompt'],
    ['Error: request failed', 'error'],
    ['Warning: context is nearly full', 'warning'],
    ['✔ Tests passed', 'success'],
    ['╭── Working ──╮', 'frame'],
    ['$ npm test', 'command'],
    ['• Updated the implementation', 'bullet'],
    ['## Summary', 'heading'],
    ['Baked for 46s', 'status'],
    ['✻ Combobulating…', 'status'],
    ['ordinary agent response', 'plain']
  ]

  for (const [line, expected] of examples) assert.equal(terminalLineKind(line), expected, line)
})

test('groups user prompts, agent replies, tools, and activity into readable blocks', () => {
  const blocks = terminalMessageBlocks(
    [
      '❯ Can you review this?',
      '  Include the network path.',
      '● I found the issue.',
      '  The bridge is missing.',
      '● Bash(ip addr)',
      '  ⎿ eth0 is up',
      '✻ Stewing…',
      '✻ Churned for 4s · done'
    ],
    'Lyra'
  )

  assert.deepEqual(
    blocks.map(({ kind, label, lines }) => ({
      kind,
      label,
      lines: lines.map((line) => line.text)
    })),
    [
      { kind: 'user', label: 'You', lines: ['Can you review this?', 'Include the network path.'] },
      { kind: 'agent', label: 'Lyra', lines: ['I found the issue.', 'The bridge is missing.'] },
      { kind: 'tool', label: 'Tool', lines: ['Bash(ip addr)', '⎿ eth0 is up'] },
      { kind: 'activity', label: 'Thinking', lines: ['Stewing…'] },
      { kind: 'activity', label: 'Activity', lines: ['Churned for 4s · done'] }
    ]
  )
})

test('recognizes only unfinished whimsical activity as transient', () => {
  assert.equal(isTransientTerminalStatus('✻ Stewing…'), true)
  assert.equal(isTransientTerminalStatus('✻ Combobulating...'), true)
  assert.equal(isTransientTerminalStatus('✻ Churned for 4s · done'), false)
})

test('removes Codex permission dialogs, usage notices, and idle footer chrome', () => {
  const lines = [
    '● A real reply remains visible.',
    'You have 1 usage limit reset available. Run /usage to',
    'use one.',
    'Update Model Permissions',
    'You',
    '1. Ask for approval (current)  Codex can read and',
    '                               edit files in the current workspace.',
    '2. Approve for me              Only ask for unsafe actions.',
    '3. Full Access                 Codex can edit other files.',
    'Press enter to confirm or esc to go back',
    'Enable full access?',
    'When Codex runs with full access, it can edit any',
    'file on your computer without your approval.',
    '1. Yes, continue anyway  Apply full access for this session',
    '2. Cancel                Go back without enabling full access',
    'Press enter to confirm or esc to go back',
    '● Permissions updated to Full Access',
    '› Ask Codex to do anything',
    '  gpt-5.6-sol xhigh · ~/Documents/GitHub/agent-Capella'
  ]

  assert.deepEqual(filterTerminalUiNoise(lines), ['● A real reply remains visible.'])
  assert.deepEqual(
    terminalMessageBlocks(lines, 'Capella').map(({ kind, lines: blockLines }) => ({
      kind,
      lines: blockLines.map((line) => line.text)
    })),
    [{ kind: 'agent', lines: ['A real reply remains visible.'] }]
  )
})

test('does not hide a real prompt asking about full access', () => {
  assert.deepEqual(filterTerminalUiNoise(['› Enable full access?', '● No.']), [
    '› Enable full access?',
    '● No.'
  ])
})
