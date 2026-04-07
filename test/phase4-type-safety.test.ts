import assert from 'node:assert/strict'
import test from 'node:test'

import { CodexClient } from '../src/codex-client.ts'
import { AgentError, ConcurrentTurnError, InputValidationError } from '../src/errors.ts'
import type { AgentEvent, CodexStreamEvent, TurnItem, UserInput } from '../src/index.ts'
import {
  isAgentErrorEvent,
  isAgentMessageDeltaEvent,
  isCodexItemCompletedEvent,
  isCodexItemStartedEvent,
  isCodexMessageDeltaEvent,
  isTurnItemMessage,
} from '../src/type-guards.ts'
import { CodexThread } from '../src/thread.ts'
import { validateUserInput } from '../src/utils.ts'

class FakeTransport {
  requestCalls = 0
  onNotification(_cb: (payload: unknown) => void): void {}
  onServerRequest(_cb: (payload: unknown) => void): void {}
  onClosed(_cb: (error: unknown) => void): void {}
  async request<T = unknown>(_method: string, _params?: unknown): Promise<T> {
    this.requestCalls += 1
    throw new Error('request invoked')
  }
  respond(_id: number, _result: unknown): void {}
  respondError(_id: number, _message: string): void {}
  close(): void {}
}

function createThreadData(id: string) {
  return {
    id,
    preview: '',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'idle',
    path: null,
    cwd: process.cwd(),
    cliVersion: 'test',
    source: 'test',
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  }
}

test('ConcurrentTurnError is an AgentError subtype', () => {
  const err = new ConcurrentTurnError('thread-1')
  assert.equal(err instanceof AgentError, true)
  assert.equal(err.code, 'CONCURRENT_TURN')
})

test('validateUserInput accepts valid user input', () => {
  const input: UserInput = [
    { type: 'text', text: 'hello' },
    { type: 'image', url: 'https://example.com/image.png' },
    { type: 'localImage', path: 'C:\\tmp\\image.png' },
    { type: 'skill', name: 'dev-browser', path: '/skills/dev-browser' },
    { type: 'mention', name: 'GitHub', path: 'app://github' },
  ]
  validateUserInput(input)
})

test('validateUserInput rejects invalid URL with field info', () => {
  assert.throws(
    () => validateUserInput([{ type: 'image', url: 'not-a-url' }]),
    (error) => {
      assert.ok(error instanceof InputValidationError)
      assert.equal(error.field, 'items[0].url')
      return true
    },
  )
})

test('validateUserInput rejects empty plain string input', () => {
  assert.throws(
    () => validateUserInput('   '),
    (error) => {
      assert.ok(error instanceof InputValidationError)
      assert.equal(error.field, 'input')
      return true
    },
  )
})

test('invalid turn input fails before transport request', async () => {
  const transport = new FakeTransport()
  const ClientCtor = CodexClient as unknown as {
    new (transport: FakeTransport, options: Record<string, unknown>): CodexClient
  }
  const client = new ClientCtor(transport, {})
  const thread = new CodexThread(client, createThreadData('thread-1'))

  await assert.rejects(
    async () => client.runThread(thread, [{ type: 'image', url: 'not-a-url' }]),
    (error) => {
      assert.ok(error instanceof InputValidationError)
      return true
    },
  )

  assert.equal(transport.requestCalls, 0)
  assert.equal(client.getThreadTurnState(thread.id), 'idle')
})

test('type guards narrow turn/item events', () => {
  const item: TurnItem = { type: 'agentMessage', id: 'm1', text: 'hello' }
  assert.equal(isTurnItemMessage(item), true)

  const startedEvent: CodexStreamEvent = {
    type: 'item.started',
    threadId: 'thread-1',
    turnId: 'turn-1',
    item,
  }

  assert.equal(isCodexItemStartedEvent(startedEvent), true)
  assert.equal(isCodexItemCompletedEvent(startedEvent), false)

  const deltaEvent: CodexStreamEvent = {
    type: 'message.delta',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'm1',
    text: 'hi',
  }

  if (isCodexMessageDeltaEvent(deltaEvent)) {
    const text: string = deltaEvent.text
    assert.equal(text, 'hi')
  } else {
    assert.fail('expected message.delta guard to match')
  }
})

test('type guards narrow AgentEvent variants', () => {
  const event: AgentEvent = {
    provider: 'codex',
    type: 'message.delta',
    text: 'partial',
  }

  assert.equal(isAgentMessageDeltaEvent(event), true)

  if (isAgentErrorEvent(event)) {
    assert.fail('did not expect error event')
  }
})
