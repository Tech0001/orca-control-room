import assert from 'node:assert/strict'
import test from 'node:test'
import {
  composeAgentPrompt,
  shouldFocusComposer,
  shouldSubmitComposer,
  terminalInputAction
} from '../companion/public/composer-format.js'

test('composeAgentPrompt preserves multiline text and appends image paths', () => {
  assert.equal(
    composeAgentPrompt('first line\nsecond line', [{ path: '/tmp/example.png' }]),
    'first line\nsecond line\n\n[Attached image 1: /tmp/example.png]'
  )
  assert.equal(composeAgentPrompt('', [{ path: '/tmp/example.png' }]), '[Attached image 1: /tmp/example.png]')
})

test('Enter submits while Shift+Enter and composition do not', () => {
  assert.equal(shouldSubmitComposer({ key: 'Enter', shiftKey: false, isComposing: false }), true)
  assert.equal(shouldSubmitComposer({ key: 'Enter', shiftKey: true, isComposing: false }), false)
  assert.equal(shouldSubmitComposer({ key: 'Enter', shiftKey: false, isComposing: true }), false)
  assert.equal(shouldSubmitComposer({ key: 'a', shiftKey: false, isComposing: false }), false)
})

test('conversation clicks focus the composer unless text is selected', () => {
  assert.equal(shouldFocusComposer(null), true)
  assert.equal(shouldFocusComposer({ isCollapsed: true }), true)
  assert.equal(shouldFocusComposer({ isCollapsed: false }), false)
})

test('direct terminal mode maps menu navigation and printable input', () => {
  const event = (key, overrides = {}) => ({
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    ...overrides
  })

  assert.deepEqual(terminalInputAction(event('/')), { text: '/', preventDefault: false })
  assert.deepEqual(terminalInputAction(event('ArrowDown')), {
    key: 'ArrowDown',
    preventDefault: true
  })
  assert.deepEqual(terminalInputAction(event('Enter')), { key: 'Enter', preventDefault: true })
  assert.deepEqual(terminalInputAction(event('Tab', { shiftKey: true })), {
    key: 'ShiftTab',
    preventDefault: true
  })
})

test('direct terminal mode preserves browser shortcuts but supports Ctrl+C interrupt', () => {
  const base = {
    shiftKey: false,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    isComposing: false
  }

  assert.deepEqual(terminalInputAction({ ...base, key: 'c' }, false), {
    key: 'Interrupt',
    preventDefault: true
  })
  assert.equal(terminalInputAction({ ...base, key: 'c' }, true), null)
  assert.equal(terminalInputAction({ ...base, key: 'a' }), null)
})
