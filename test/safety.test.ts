import assert from 'node:assert/strict'
import test from 'node:test'

import { safety } from '../src/index.ts'
import type { AgentToolApprovalRequest } from '../src/agent-types.ts'

function createRequest(kind: string): AgentToolApprovalRequest {
  return {
    provider: 'codex',
    kind,
    payload: { sample: true },
  }
}

test('safety.readOnly denies all approval requests', async () => {
  const handlers = safety.readOnly()
  assert.ok(handlers.onToolApproval)

  assert.equal(await handlers.onToolApproval!(createRequest('read')), 'deny')
  assert.equal(await handlers.onToolApproval!(createRequest('edit')), 'deny')
  assert.equal(await handlers.onToolApproval!(createRequest('command')), 'deny')
  assert.equal(await handlers.onToolApproval!(createRequest('totally-unknown')), 'deny')
})

test('safety.acceptEditsOnly allows file edit kinds and denies command-like kinds', async () => {
  const handlers = safety.acceptEditsOnly()
  assert.ok(handlers.onToolApproval)

  assert.equal(await handlers.onToolApproval!(createRequest('file_edit')), 'allow')
  assert.equal(await handlers.onToolApproval!(createRequest('patch-apply')), 'allow')
  assert.equal(await handlers.onToolApproval!(createRequest('shell_command')), 'deny')
  assert.equal(await handlers.onToolApproval!(createRequest('read_only')), 'deny')
})

test('safety.confirmDangerous respects allowReadOnly, allowFileEdits, and allowCommands', async () => {
  const handlers = safety.confirmDangerous({
    allowReadOnly: true,
    allowFileEdits: false,
    allowCommands: true,
  })
  assert.ok(handlers.onToolApproval)

  assert.equal(await handlers.onToolApproval!(createRequest('read_only')), 'allow')
  assert.equal(await handlers.onToolApproval!(createRequest('read_file')), 'allow')
  assert.equal(await handlers.onToolApproval!(createRequest('edit_file')), 'deny')
  assert.equal(await handlers.onToolApproval!(createRequest('terminal_command')), 'allow')
})

test('safety.confirmDangerous treats approval.file as a file edit while keeping read_file read-only', async () => {
  const handlers = safety.confirmDangerous({
    allowReadOnly: true,
    allowFileEdits: false,
  })
  assert.ok(handlers.onToolApproval)

  assert.equal(await handlers.onToolApproval!(createRequest('approval.file')), 'deny')
  assert.equal(await handlers.onToolApproval!(createRequest('read_file')), 'allow')
})

test('safety.confirmDangerous denies unknown approval kinds conservatively', async () => {
  const handlers = safety.confirmDangerous({
    allowReadOnly: true,
    allowFileEdits: true,
    allowCommands: true,
  })
  assert.ok(handlers.onToolApproval)

  assert.equal(await handlers.onToolApproval!(createRequest('provider-native-special-case')), 'deny')
})
