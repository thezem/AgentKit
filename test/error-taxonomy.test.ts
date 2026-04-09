import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentError,
  ConcurrentTurnError,
  InputValidationError,
  ProviderProbeTimeoutError,
  QueueOverflowError,
  TransportRequestTimeoutError,
} from '../src/errors.ts'

test('public AgentError wrappers expose normalized code, retryability, and provider metadata', () => {
  const input = new InputValidationError('Bad input', 'provider')
  assert.ok(input instanceof AgentError)
  assert.equal(input.code, 'INPUT_VALIDATION')
  assert.equal(input.retryable, false)
  assert.equal(input.provider, undefined)

  const timeout = new TransportRequestTimeoutError('turn/start', 7, 500)
  assert.equal(timeout.code, 'TRANSPORT_REQUEST_TIMEOUT')
  assert.equal(timeout.retryable, true)
  assert.equal(timeout.provider, 'codex')

  const concurrency = new ConcurrentTurnError('thread-1')
  assert.equal(concurrency.code, 'CONCURRENT_TURN')
  assert.equal(concurrency.retryable, true)
  assert.equal(concurrency.provider, 'codex')

  const overflow = new QueueOverflowError('thread-1', 'turn-1', 16)
  assert.equal(overflow.code, 'QUEUE_OVERFLOW')
  assert.equal(overflow.retryable, true)
  assert.equal(overflow.provider, 'codex')

  const probe = new ProviderProbeTimeoutError('claude', 3000)
  assert.equal(probe.code, 'PROVIDER_PROBE_TIMEOUT')
  assert.equal(probe.retryable, true)
  assert.equal(probe.provider, 'claude')
})

test('AgentError preserves explicit causes', () => {
  const cause = new Error('root cause')
  const error = new InputValidationError('Invalid payload', 'input', { cause })

  assert.equal(error.cause, cause)
  assert.equal(error.retryable, false)
})
