import assert from 'node:assert/strict'
import test from 'node:test'
import {
  composeAgentPrompt,
  shouldFocusComposer,
  shouldSubmitComposer
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
