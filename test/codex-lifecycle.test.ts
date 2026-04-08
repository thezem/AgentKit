import assert from 'node:assert/strict'
import test from 'node:test'

import { CodexClient } from '../src/codex-client.ts'
import { ConcurrentTurnError } from '../src/errors.ts'
import { CodexThread } from '../src/thread.ts'
import type { RequestHandlers, TurnItem } from '../src/types.ts'
import { FakeTransport } from './helpers/fake-transport.ts'

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

function createClient(transport: FakeTransport, handlers?: RequestHandlers): CodexClient {
  const ClientCtor = CodexClient as unknown as {
    new (transport: FakeTransport, options: { handlers?: RequestHandlers }): CodexClient
  }
  return new ClientCtor(transport, handlers ? { handlers } : {})
}

async function waitForThreadState(client: CodexClient, threadId: string, expected: 'idle' | 'starting' | 'active'): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (client.getThreadTurnState(threadId) === expected) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  assert.fail(`Thread ${threadId} did not reach state ${expected}`)
}

test('thread/start returns CodexThread with created id', async () => {
  const transport = new FakeTransport()
  transport.respondWith('thread/start', { thread: createThreadData('thread-created') })

  const client = createClient(transport)
  const thread = await client.threads.create()

  assert.equal(thread.id, 'thread-created')
})

test('thread/resume returns hydrated CodexThread', async () => {
  const transport = new FakeTransport()
  transport.respondWith('thread/resume', { thread: createThreadData('thread-resumed') })

  const client = createClient(transport)
  const thread = await client.threads.resume('thread-resumed')

  assert.equal(thread.id, 'thread-resumed')
})

test('thread/fork returns new thread id', async () => {
  const transport = new FakeTransport()
  transport.respondWith('thread/fork', { thread: createThreadData('thread-forked') })

  const client = createClient(transport)
  const thread = await client.threads.fork('thread-source')

  assert.equal(thread.id, 'thread-forked')
})

test('run() routes notifications into final result', async () => {
  const transport = new FakeTransport()
  transport.respondWith('turn/start', { turn: { id: 'turn-1' } })

  const client = createClient(transport)
  const thread = new CodexThread(client, createThreadData('thread-1'))

  const runPromise = client.runThread(thread, 'hello')
  await waitForThreadState(client, 'thread-1', 'active')

  const item: TurnItem = {
    type: 'agentMessage',
    id: 'msg-1',
    text: 'hello world',
  }

  transport.simulateNotification({
    jsonrpc: '2.0',
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'hello ' },
  })
  transport.simulateNotification({
    jsonrpc: '2.0',
    method: 'item/completed',
    params: { threadId: 'thread-1', turnId: 'turn-1', item },
  })
  transport.simulateNotification({
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        items: [item],
        status: 'completed',
        error: null,
      },
    },
  })

  const result = await runPromise
  assert.equal(result.turnId, 'turn-1')
  assert.equal(result.text, 'hello world')
  assert.equal(result.items.length, 1)
})

test('stream() yields events in notification order', async () => {
  const transport = new FakeTransport()
  transport.respondWith('turn/start', { turn: { id: 'turn-1' } })

  const client = createClient(transport)
  const thread = new CodexThread(client, createThreadData('thread-1'))
  const stream = await client.streamThread(thread, 'hello')
  await waitForThreadState(client, 'thread-1', 'active')
  const iterator = stream[Symbol.asyncIterator]()

  transport.simulateNotification({
    jsonrpc: '2.0',
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'A' },
  })

  const first = await iterator.next()
  assert.equal(first.done, false)
  assert.equal(first.value?.type, 'message.delta')

  transport.simulateNotification({
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        items: [],
        status: 'completed',
        error: null,
      },
    },
  })

  const second = await iterator.next()
  assert.equal(second.done, false)
  assert.equal(second.value?.type, 'turn.completed')
})

test('interrupt() forwards turn/interrupt for the active turn', async () => {
  const transport = new FakeTransport()
  transport.respondWith('turn/start', { turn: { id: 'turn-1' } })
  transport.respondWith('turn/interrupt', {})

  const client = createClient(transport)
  const thread = new CodexThread(client, createThreadData('thread-1'))
  const stream = await client.streamThread(thread, 'hello')
  await waitForThreadState(client, 'thread-1', 'active')

  await thread.interrupt()

  assert.deepEqual(transport.requestLog.at(-1), {
    method: 'turn/interrupt',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
    },
  })

  transport.simulateNotification({
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        items: [],
        status: 'interrupted',
        error: null,
      },
    },
  })

  const iterator = stream[Symbol.asyncIterator]()
  const completion = await iterator.next()
  assert.equal(completion.done, false)
  assert.equal(completion.value?.type, 'turn.completed')
  assert.equal(completion.value?.turn.status, 'interrupted')
})

test('concurrent run() on same thread rejects with ConcurrentTurnError', async () => {
  const transport = new FakeTransport()
  transport.respondWith('turn/start', { turn: { id: 'turn-1' } })

  const client = createClient(transport)
  const thread = new CodexThread(client, createThreadData('thread-1'))

  const firstRun = client.runThread(thread, 'first prompt')
  void firstRun.catch(() => {
    // Prevent unhandled rejection while the test intentionally keeps the first run pending.
  })
  await waitForThreadState(client, 'thread-1', 'active')

  await assert.rejects(client.runThread(thread, 'second prompt'), error => {
    assert.ok(error instanceof ConcurrentTurnError)
    return true
  })

  transport.simulateClose(new Error('cleanup close'))
  await assert.rejects(firstRun, /cleanup close/)
})

test('approval request uses onCommandApproval handler and responds', async () => {
  const transport = new FakeTransport()
  transport.respondWith('turn/start', { turn: { id: 'turn-1' } })

  const client = createClient(transport, {
    onCommandApproval: async () => 'accept',
  })
  const thread = new CodexThread(client, createThreadData('thread-1'))
  await client.streamThread(thread, 'hello')
  await waitForThreadState(client, 'thread-1', 'active')

  transport.simulateServerRequest({
    jsonrpc: '2.0',
    id: 101,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1' },
  })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(transport.responses[0], { id: 101, result: { decision: 'accept' } })
})

test('tool input request uses onToolInput handler and responds', async () => {
  const transport = new FakeTransport()
  transport.respondWith('turn/start', { turn: { id: 'turn-1' } })

  const client = createClient(transport, {
    onToolInput: async () => ({ q1: { answers: ['answer'] } }),
  })
  const thread = new CodexThread(client, createThreadData('thread-1'))
  await client.streamThread(thread, 'hello')
  await waitForThreadState(client, 'thread-1', 'active')

  transport.simulateServerRequest({
    jsonrpc: '2.0',
    id: 202,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'tool-1',
      questions: [{ id: 'q1', header: 'Q1', question: 'Pick one' }],
    },
  })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(transport.responses[0], {
    id: 202,
    result: { answers: { q1: { answers: ['answer'] } } },
  })
})

test('transport close during active turn rejects stream iterator', async () => {
  const transport = new FakeTransport()
  transport.respondWith('turn/start', { turn: { id: 'turn-1' } })

  const client = createClient(transport)
  const thread = new CodexThread(client, createThreadData('thread-1'))
  const stream = await client.streamThread(thread, 'hello')
  await waitForThreadState(client, 'thread-1', 'active')

  const collecting = (async () => {
    for await (const _event of stream) {
      // no-op
    }
  })()

  transport.simulateClose(new Error('stream crashed'))

  await assert.rejects(collecting, /stream crashed/)
})
