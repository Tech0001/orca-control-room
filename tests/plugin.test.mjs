import test from 'node:test'
import assert from 'node:assert/strict'
import activate from '../main.mjs'

test('registers the global Control Room launcher command', () => {
  const registered = new Map()
  activate({
    commands: {
      register(id, handler) {
        registered.set(id, handler)
      }
    }
  })
  assert.equal(typeof registered.get('open-control-room'), 'function')
})
