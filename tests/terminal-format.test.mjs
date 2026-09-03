import test from 'node:test'
import assert from 'node:assert/strict'
import {
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
