import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgent } from '../src/agent-client.ts'
import { ClaudeSession } from '../src/providers/claude-session.ts'
import { AsyncQueue } from '../src/utils.ts'
import { CodexClient } from '../src/codex-client.ts'
import { AgentError } from '../src/errors.ts'
import { FakeTransport } from './helpers/fake-transport.ts'

type ClaudeRuntimeOptions = {
  canUseTool?: (...args: unknown[]) => Promise<unknown>
  onElicitation?: (...args: unknown[]) => Promise<unknown>
}

class FakeClaudeRuntime {
  private readonly queue = new AsyncQueue<unknown>()
  private readonly options: ClaudeRuntimeOptions

  constructor(options: ClaudeRuntimeOptions) {
    this.options = options
  }

  emit(message: unknown): void {
    this.queue.push(message)
  }

  async interrupt(): Promise<void> {}

  close(): void {
    this.queue.end()
  }

  async setModel(_model: string): Promise<void> {}

  async setPermissionMode(_mode: string): Promise<void> {}

  getRuntimeOptions(): ClaudeRuntimeOptions {
    return this.options
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.queue[Symbol.asyncIterator]()
  }
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

async function waitForRequest(fakeTransport: FakeTransport, method: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fakeTransport.requestLog.some(entry => entry.method === method)) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  assert.fail(`Timed out waiting for request method ${method}`)
}

test('codex session rejects concurrent run while a stream is active with RUN_IN_PROGRESS', async () => {
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
    const session = await agent.openSession({ name: 'codex-concurrency' })
    const stream = await session.stream('hello')

    void (async () => {
      for await (const _event of stream) {
        // keep the active stream attached until completion
      }
    })()

    await waitForRequest(fakeTransport, 'turn/start')

    await assert.rejects(session.run('second'), error => {
      assert.ok(error instanceof AgentError)
      assert.equal(error.code, 'RUN_IN_PROGRESS')
      assert.equal(error.provider, 'codex')
      return true
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
          items: [],
        },
      },
    })
  } finally {
    CodexCtor.create = originalCreate
    await fakeCodexClient.close()
  }
})

test('codex session interrupt without an active run rejects with NO_ACTIVE_RUN', async () => {
  const fakeTransport = new FakeTransport()

  const CodexCtor = CodexClient as unknown as {
    create: (options?: Record<string, unknown>) => Promise<CodexClient>
    new (transport: FakeTransport, options: Record<string, unknown>): CodexClient
  }
  const originalCreate = CodexCtor.create
  const fakeCodexClient = new CodexCtor(fakeTransport, {})
  CodexCtor.create = async () => fakeCodexClient

  try {
    const agent = await createAgent({ provider: 'codex' })
    const session = agent.session('codex-idle')

    await assert.rejects(session.interrupt(), error => {
      assert.ok(error instanceof AgentError)
      assert.equal(error.code, 'NO_ACTIVE_RUN')
      assert.equal(error.provider, 'codex')
      return true
    })
  } finally {
    CodexCtor.create = originalCreate
    await fakeCodexClient.close()
  }
})

test('claude session rejects concurrent stream while a run is active with RUN_IN_PROGRESS', async () => {
  const ClaudeSessionCtor = ClaudeSession as unknown as {
    runtimeFactory: (input: { options: ClaudeRuntimeOptions }) => FakeClaudeRuntime
  }
  const originalFactory = ClaudeSessionCtor.runtimeFactory
  let runtimeRef: FakeClaudeRuntime | null = null

  ClaudeSessionCtor.runtimeFactory = input => {
    runtimeRef = new FakeClaudeRuntime(input.options)
    return runtimeRef
  }

  try {
    const session = new ClaudeSession('claude-concurrency')
    const runPromise = session.run('hello')
    await new Promise(resolve => setTimeout(resolve, 0))

    await assert.rejects(session.stream('again'), error => {
      assert.ok(error instanceof AgentError)
      assert.equal(error.code, 'RUN_IN_PROGRESS')
      assert.equal(error.provider, 'claude')
      return true
    })

    runtimeRef?.emit({
      type: 'result',
      subtype: 'success',
      session_id: 'claude-session-1',
      result: 'Hello final',
      stop_reason: 'end_turn',
      terminal_reason: null,
      errors: [],
    })

    await runPromise
    await session.close()
  } finally {
    ClaudeSessionCtor.runtimeFactory = originalFactory
  }
})

test('claude session close then interrupt rejects with SESSION_CLOSED', async () => {
  const ClaudeSessionCtor = ClaudeSession as unknown as {
    runtimeFactory: (input: { options: ClaudeRuntimeOptions }) => FakeClaudeRuntime
  }
  const originalFactory = ClaudeSessionCtor.runtimeFactory

  ClaudeSessionCtor.runtimeFactory = input => new FakeClaudeRuntime(input.options)

  try {
    const session = new ClaudeSession('claude-closed')
    await session.close()

    await assert.rejects(session.interrupt(), error => {
      assert.ok(error instanceof AgentError)
      assert.equal(error.code, 'SESSION_CLOSED')
      assert.equal(error.provider, 'claude')
      return true
    })
  } finally {
    ClaudeSessionCtor.runtimeFactory = originalFactory
  }
})
