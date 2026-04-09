import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgent } from '../src/agent-client.ts'
import { CodexClient } from '../src/codex-client.ts'
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

async function waitForRequest(fakeTransport: FakeTransport, method: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fakeTransport.requestLog.some(entry => entry.method === method)) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  assert.fail(`Timed out waiting for request method ${method}`)
}

test('start() returns a stable runId and result resolves from the shared run path', async () => {
  const fakeTransport = new FakeTransport()
  fakeTransport.respondWith('thread/start', { thread: createThreadData('thread-1') })
  fakeTransport.respondWith('turn/start', { turn: { id: 'turn-1' } })

  const CodexCtor = CodexClient as unknown as {
    create: (options?: Record<string, unknown>) => Promise<CodexClient>
    new (transport: FakeTransport, options: Record<string, unknown>): CodexClient
  }
  const originalCreate = CodexCtor.create
  const fakeCodexClient = new CodexCtor(fakeTransport, {})
  CodexCtor.create = async () => fakeCodexClient

  try {
    const agent = await createAgent({ provider: 'codex' })
    const session = await agent.openSession({ name: 'agent-run-codex' })
    const run = await session.start('hello')

    assert.equal(run.runId, 'turn-1')

    const eventsPromise = (async () => {
      const types: string[] = []
      for await (const event of run.events) {
        types.push(event.type)
      }
      return types
    })()

    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: 'Hello ',
      },
    })
    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'msg-1', text: 'Hello final' },
      },
    })
    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
          error: null,
          items: [{ type: 'agentMessage', id: 'msg-1', text: 'Hello final' }],
        },
      },
    })

    const [eventTypes, result] = await Promise.all([eventsPromise, run.result])
    assert.deepEqual(eventTypes, ['run.started', 'message.delta', 'provider.notification', 'run.completed'])
    assert.equal(result.turnId, 'turn-1')
    assert.equal(result.text, 'Hello final')
  } finally {
    CodexCtor.create = originalCreate
    await fakeCodexClient.close()
  }
})

test('run() and stream() both delegate to start()', async () => {
  const fakeTransport = new FakeTransport()
  fakeTransport.respondWith('thread/start', { thread: createThreadData('thread-2') })
  fakeTransport.respondWith('turn/start', { turn: { id: 'turn-2' } })
  fakeTransport.respondWith('turn/start', { turn: { id: 'turn-3' } })

  const CodexCtor = CodexClient as unknown as {
    create: (options?: Record<string, unknown>) => Promise<CodexClient>
    new (transport: FakeTransport, options: Record<string, unknown>): CodexClient
  }
  const originalCreate = CodexCtor.create
  const fakeCodexClient = new CodexCtor(fakeTransport, {})
  CodexCtor.create = async () => fakeCodexClient

  try {
    const agent = await createAgent({ provider: 'codex' })
    const session = await agent.openSession({ name: 'agent-run-delegation' })

    const runPromise = session.run('hello')
    await waitForRequest(fakeTransport, 'turn/start')
    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-2',
        turn: {
          id: 'turn-2',
          status: 'completed',
          error: null,
          items: [],
        },
      },
    })
    const runResult = await runPromise
    assert.equal(runResult.turnId, 'turn-2')

    const stream = await session.stream('hello again')
    const eventsPromise = (async () => {
      const types: string[] = []
      for await (const event of stream) {
        types.push(event.type)
      }
      return types
    })()

    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-2',
        turn: {
          id: 'turn-3',
          status: 'completed',
          error: null,
          items: [],
        },
      },
    })

    assert.deepEqual(await eventsPromise, ['run.started', 'run.completed'])
  } finally {
    CodexCtor.create = originalCreate
    await fakeCodexClient.close()
  }
})

test('AgentRun interrupt() targets the active run', async () => {
  const fakeTransport = new FakeTransport()
  fakeTransport.respondWith('thread/start', { thread: createThreadData('thread-3') })
  fakeTransport.respondWith('turn/start', { turn: { id: 'turn-4' } })
  fakeTransport.respondWith('turn/interrupt', {})

  const CodexCtor = CodexClient as unknown as {
    create: (options?: Record<string, unknown>) => Promise<CodexClient>
    new (transport: FakeTransport, options: Record<string, unknown>): CodexClient
  }
  const originalCreate = CodexCtor.create
  const fakeCodexClient = new CodexCtor(fakeTransport, {})
  CodexCtor.create = async () => fakeCodexClient

  try {
    const agent = await createAgent({ provider: 'codex' })
    const session = await agent.openSession({ name: 'agent-run-interrupt' })
    const run = await session.start('interrupt me')

    await run.interrupt()

    assert.deepEqual(fakeTransport.requestLog.at(-1), {
      method: 'turn/interrupt',
      params: {
        threadId: 'thread-3',
        turnId: 'turn-4',
      },
    })

    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-3',
        turn: {
          id: 'turn-4',
          status: 'interrupted',
          error: null,
          items: [],
        },
      },
    })

    const result = await run.result
    assert.equal(result.status, 'interrupted')
  } finally {
    CodexCtor.create = originalCreate
    await fakeCodexClient.close()
  }
})
