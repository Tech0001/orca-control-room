import test from 'node:test'
import assert from 'node:assert/strict'
import { terminalLineKind } from '../companion/public/terminal-format.js'

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
    ['ordinary agent response', 'plain']
  ]

  for (const [line, expected] of examples) assert.equal(terminalLineKind(line), expected, line)
})
