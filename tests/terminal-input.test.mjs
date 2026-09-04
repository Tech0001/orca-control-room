import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveTerminalInput } from '../companion/terminal-input.mjs'

test('maps supported terminal keys to PTY input', () => {
  assert.deepEqual(resolveTerminalInput({ key: 'ArrowUp' }), { text: '\x1b[A' })
  assert.deepEqual(resolveTerminalInput({ key: 'Enter' }), { enter: true })
  assert.deepEqual(resolveTerminalInput({ key: 'ShiftTab' }), { text: '\x1b[Z' })
  assert.deepEqual(resolveTerminalInput({ key: 'Interrupt' }), { interrupt: true })
})

test('preserves direct text exactly, including pasted newlines', () => {
  assert.deepEqual(resolveTerminalInput({ text: '/model\nnext' }), { text: '/model\nnext' })
})

test('rejects ambiguous, empty, and unsupported input', () => {
  assert.throws(() => resolveTerminalInput({}), /exactly one/)
  assert.throws(() => resolveTerminalInput({ text: '', key: 'Enter' }), /exactly one/)
  assert.throws(() => resolveTerminalInput({ text: '' }), /1–32,000/)
  assert.throws(() => resolveTerminalInput({ key: 'F13' }), /Unsupported/)
})
