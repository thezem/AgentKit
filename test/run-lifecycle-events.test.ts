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

test('run.started is emitted before other lifecycle events and run.completed uses the same runId', async () => {
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
    const session = await agent.openSession({ name: 'lifecycle-codex' })
    const run = await session.start('hello')

    const eventsPromise = (async () => {
      const events: Array<{ type: string; runId?: string; status?: string }> = []
      for await (const event of run.events) {
        events.push({
          type: event.type,
          ...('runId' in event ? { runId: event.runId } : {}),
          ...(event.type === 'status.updated' ? { status: event.status } : {}),
        })
      }
      return events
    })()

    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'inProgress', items: [], error: null },
      },
    })
    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', items: [], error: null },
      },
    })

    const [events, result] = await Promise.all([eventsPromise, run.result])
    assert.deepEqual(events, [
      { type: 'run.started', runId: 'turn-1' },
      { type: 'status.updated', runId: 'turn-1', status: 'inProgress' },
      { type: 'run.completed', runId: 'turn-1' },
    ])
    assert.equal(result.turnId, 'turn-1')
    assert.equal(result.status, 'completed')
  } finally {
    CodexCtor.create = originalCreate
    await fakeCodexClient.close()
  }
})
