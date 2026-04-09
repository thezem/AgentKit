import assert from 'node:assert/strict'
import test from 'node:test'

import * as root from '../src/index.ts'
import * as compatCodex from '../src/compat/codex.ts'

test('root entrypoint exposes provider-neutral exports only', () => {
  assert.equal('createAgent' in root, true)
  assert.equal('createSession' in root, true)
  assert.equal('safety' in root, true)
  assert.equal('getProviderInventory' in root, true)
  assert.equal('createCodex' in root, false)
  assert.equal('CodexClient' in root, false)
  assert.equal('CodexThread' in root, false)
  assert.equal('isCodexMessageDeltaEvent' in root, false)
})

test('compat/codex entrypoint exposes codex compatibility exports', () => {
  assert.equal('createCodex' in compatCodex, true)
  assert.equal('CodexClient' in compatCodex, true)
  assert.equal('CodexThread' in compatCodex, true)
  assert.equal('isCodexMessageDeltaEvent' in compatCodex, true)
})
