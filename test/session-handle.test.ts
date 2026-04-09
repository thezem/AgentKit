import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentError } from '../src/errors.ts'
import { normalizeSessionHandle, validateSessionHandle } from '../src/handle.ts'

test('normalizeSessionHandle upgrades a legacy codex handle to v1 and survives JSON round-trip', () => {
  const normalized = normalizeSessionHandle({
    provider: 'codex',
    sessionId: 'thread-1',
    name: 'project-a',
    resumeKey: 'thread-1',
  })

  assert.deepEqual(normalized, {
    version: 1,
    provider: 'codex',
    sessionId: 'thread-1',
    name: 'project-a',
    state: {
      resumeKey: 'thread-1',
    },
  })

  const parsed = JSON.parse(JSON.stringify(normalized))
  assert.deepEqual(validateSessionHandle(parsed), normalized)
})

test('normalizeSessionHandle upgrades a legacy claude handle to v1', () => {
  const normalized = normalizeSessionHandle({
    provider: 'claude',
    sessionId: 'claude-session-1',
    name: 'project-b',
    resumeKey: 'claude-session-1',
    resumeAt: 'assistant-uuid-1',
    raw: {
      sessionId: 'claude-session-1',
      resume: 'claude-session-1',
      resumeSessionAt: 'assistant-uuid-1',
    },
  })

  assert.deepEqual(normalized, {
    version: 1,
    provider: 'claude',
    sessionId: 'claude-session-1',
    name: 'project-b',
    state: {
      resumeKey: 'claude-session-1',
      resumeAt: 'assistant-uuid-1',
      raw: {
        sessionId: 'claude-session-1',
        resume: 'claude-session-1',
        resumeSessionAt: 'assistant-uuid-1',
      },
    },
  })
})

test('validateSessionHandle rejects missing version with INVALID_HANDLE', () => {
  assert.throws(
    () =>
      validateSessionHandle({
        provider: 'codex',
        sessionId: 'thread-1',
      }),
    error => {
      assert.ok(error instanceof AgentError)
      assert.equal(error.code, 'INVALID_HANDLE')
      return true
    },
  )
})

test('validateSessionHandle rejects malformed provider state with INVALID_HANDLE', () => {
  assert.throws(
    () =>
      validateSessionHandle({
        version: 1,
        provider: 'codex',
        sessionId: 'thread-1',
        state: {
          resumeKey: 42,
        },
      }),
    error => {
      assert.ok(error instanceof AgentError)
      assert.equal(error.code, 'INVALID_HANDLE')
      return true
    },
  )
})

test('validateSessionHandle rejects expired handles with EXPIRED_HANDLE', () => {
  assert.throws(
    () =>
      validateSessionHandle({
        version: 1,
        provider: 'claude',
        sessionId: 'claude-session-2',
        state: {
          resumeKey: 'claude-session-2',
          raw: {
            expired: true,
          },
        },
      }),
    error => {
      assert.ok(error instanceof AgentError)
      assert.equal(error.code, 'EXPIRED_HANDLE')
      return true
    },
  )
})
