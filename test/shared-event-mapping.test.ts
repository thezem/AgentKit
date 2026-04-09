import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgent } from '../src/agent-client.ts'
import { CodexClient } from '../src/codex-client.ts'
import { ClaudeSession } from '../src/providers/claude-session.ts'
import { AsyncQueue } from '../src/utils.ts'
import { FakeTransport } from './helpers/fake-transport.ts'

type ClaudeRuntimeOptions = {
  canUseTool?: (
    toolName: string,
    toolInput: Record<string, unknown>,
    sdkOptions: {
      blockedPath?: string
      decisionReason?: string
      title?: string
      description?: string
      displayName?: string
      suggestions?: unknown
      toolUseID: string
      agentID?: string
      signal: AbortSignal
    },
  ) => Promise<unknown>
  onElicitation?: (request: Record<string, unknown>) => Promise<unknown>
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

test('codex stream events normalize to shared AgentEvent contract', async () => {
  const fakeTransport = new FakeTransport()
  fakeTransport.respondWith('thread/start', { thread: createThreadData('thread-codex-1') })
  fakeTransport.respondWith('turn/start', { turn: { id: 'turn-codex-1' } })

  const CodexCtor = CodexClient as unknown as {
    create: (options?: Record<string, unknown>) => Promise<CodexClient>
    new (transport: FakeTransport, options: Record<string, unknown>): CodexClient
  }
  const originalCreate = CodexCtor.create
  const fakeCodexClient = new CodexCtor(fakeTransport, {})
  CodexCtor.create = async () => fakeCodexClient

  try {
    const agent = await createAgent({ provider: 'codex' })
    const session = await agent.openSession({ name: 'shared-codex' })
    const stream = await session.stream('summarize', {
      handlers: {
        onToolApproval: async () => 'allow',
        onUserInput: async () => ['yes'],
      },
    })

    const eventsPromise = (async () => {
      const events: Array<{ type: string; payload?: unknown }> = []
      for await (const event of stream) {
        events.push({ type: event.type, payload: event })
      }
      return events
    })()

    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: {
        threadId: 'thread-codex-1',
        turn: { id: 'turn-codex-1', status: 'inProgress', items: [], error: null },
      },
    })
    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-codex-1',
        turnId: 'turn-codex-1',
        itemId: 'msg-1',
        delta: 'Hello ',
      },
    })
    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'item/reasoning/textDelta',
      params: {
        threadId: 'thread-codex-1',
        turnId: 'turn-codex-1',
        itemId: 'reason-1',
        delta: 'thinking',
      },
    })
    fakeTransport.simulateServerRequest({
      jsonrpc: '2.0',
      id: 101,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-codex-1',
        turnId: 'turn-codex-1',
        itemId: 'approval-1',
        command: 'ls',
      },
    })
    fakeTransport.simulateServerRequest({
      jsonrpc: '2.0',
      id: 102,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-codex-1',
        turnId: 'turn-codex-1',
        itemId: 'input-1',
        questions: [
          {
            id: 'q1',
            header: 'Confirm',
            question: 'Continue?',
            isOther: false,
            isSecret: false,
            options: [{ label: 'yes' }, { label: 'no' }],
          },
        ],
      },
    })
    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'item/plan/delta',
      params: {
        threadId: 'thread-codex-1',
        turnId: 'turn-codex-1',
        itemId: 'plan-1',
        delta: 'plan step',
      },
    })
    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-codex-1',
        turnId: 'turn-codex-1',
        item: { type: 'agentMessage', id: 'msg-1', text: 'Hello world' },
      },
    })
    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-codex-1',
        turn: {
          id: 'turn-codex-1',
          status: 'completed',
          error: null,
          items: [{ type: 'agentMessage', id: 'msg-1', text: 'Hello world' }],
        },
      },
    })

    const events = await eventsPromise
    const types = events.map(event => event.type)

    assert.deepEqual(types, [
      'run.started',
      'status.updated',
      'message.delta',
      'reasoning.delta',
      'approval.tool',
      'user.input',
      'plan.delta',
      'item.completed',
      'run.completed',
    ])

    assert.deepEqual(fakeTransport.responses, [
      {
        id: 101,
        result: { decision: 'accept' },
      },
      {
        id: 102,
        result: { answers: { q1: { answers: ['yes'] } } },
      },
    ])

    const planDelta = events.find(event => event.type === 'plan.delta')?.payload as
      | { type: 'plan.delta'; item: { id: string; kind: string; text?: string; raw?: unknown } }
      | undefined
    assert.ok(planDelta)
    assert.equal(planDelta.item.id, 'plan-1')
    assert.equal(planDelta.item.kind, 'plan')
    assert.equal(planDelta.item.text, 'plan step')

    const itemCompleted = events.find(event => event.type === 'item.completed')?.payload as
      | { type: 'item.completed'; item: { id: string; kind: string; text?: string; status?: string; raw?: unknown } }
      | undefined
    assert.ok(itemCompleted)
    assert.equal(itemCompleted.item.id, 'msg-1')
    assert.equal(itemCompleted.item.kind, 'message')
    assert.equal(itemCompleted.item.text, 'Hello world')
    assert.equal(itemCompleted.item.status, 'completed')

    const completion = events.find(event => event.type === 'run.completed')?.payload as
      | { type: 'run.completed'; runId: string; result: Record<string, unknown> }
      | undefined
    assert.ok(completion)
    assert.equal(completion.runId, 'turn-codex-1')
    assert.equal(completion.result.provider, 'codex')
    assert.equal(completion.result.sessionId, 'thread-codex-1')
    assert.equal(completion.result.turnId, 'turn-codex-1')
    assert.equal(completion.result.status, 'completed')
    assert.equal(completion.result.text, 'Hello world')
    assert.equal((completion.result.handle as { name?: string }).name, 'shared-codex')
    assert.ok(Array.isArray(completion.result.items))
    assert.equal((completion.result.items as Array<{ type?: string }>)[0]?.type, 'agentMessage')
    assert.equal((completion.result.handle as { version?: number }).version, 1)
    assert.equal((completion.result.handle as { state?: { resumeKey?: string } }).state?.resumeKey, 'thread-codex-1')
  } finally {
    CodexCtor.create = originalCreate
    await fakeCodexClient.close()
  }
})

test('codex start().events normalize to shared AgentEvent contract', async () => {
  const fakeTransport = new FakeTransport()
  fakeTransport.respondWith('thread/start', { thread: createThreadData('thread-codex-start-1') })
  fakeTransport.respondWith('turn/start', { turn: { id: 'turn-codex-start-1' } })

  const CodexCtor = CodexClient as unknown as {
    create: (options?: Record<string, unknown>) => Promise<CodexClient>
    new (transport: FakeTransport, options: Record<string, unknown>): CodexClient
  }
  const originalCreate = CodexCtor.create
  const fakeCodexClient = new CodexCtor(fakeTransport, {})
  CodexCtor.create = async () => fakeCodexClient

  try {
    const agent = await createAgent({ provider: 'codex' })
    const session = await agent.openSession({ name: 'shared-codex-start' })
    const run = await session.start('summarize')

    const eventsPromise = (async () => {
      const events: string[] = []
      for await (const event of run.events) {
        events.push(event.type)
      }
      return events
    })()

    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-codex-start-1',
        turnId: 'turn-codex-start-1',
        itemId: 'msg-1',
        delta: 'Hello ',
      },
    })
    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-codex-start-1',
        turn: {
          id: 'turn-codex-start-1',
          status: 'completed',
          error: null,
          items: [],
        },
      },
    })

    assert.deepEqual(await eventsPromise, ['run.started', 'message.delta', 'run.completed'])
    const result = await run.result
    assert.equal(result.turnId, 'turn-codex-start-1')
  } finally {
    CodexCtor.create = originalCreate
    await fakeCodexClient.close()
  }
})

test('claude stream events normalize to shared AgentEvent contract', async () => {
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
    const session = new ClaudeSession('shared-claude')
    const stream = await session.stream('hello', {
      handlers: {
        onToolApproval: async () => 'allow',
        onUserInput: async () => 'provided-by-user',
      },
    })

    const eventsPromise = (async () => {
      const events: Array<{ type: string; payload?: unknown }> = []
      for await (const event of stream) {
        events.push({ type: event.type, payload: event })
      }
      return events
    })()

    const runtime = runtimeRef as FakeClaudeRuntime
    const runtimeOptions = runtime.getRuntimeOptions()
    runtime.emit({
      type: 'stream_event',
      session_id: 'claude-session-1',
      event: {
        delta: {
          text: 'Hello ',
        },
      },
    })
    runtime.emit({
      type: 'assistant',
      session_id: 'claude-session-1',
      uuid: 'assistant-uuid-1',
      message: {
        content: [{ type: 'text', text: 'Hello final' }],
      },
    })
    runtime.emit({
      type: 'tool_use',
      session_id: 'claude-session-1',
      tool_name: 'Bash',
      tool_use_id: 'tool-1',
      input: { command: 'pwd' },
    })
    runtime.emit({
      type: 'system',
      subtype: 'status',
      status: 'running',
      permissionMode: 'default',
    })

    await runtimeOptions.canUseTool?.(
      'Bash',
      { command: 'pwd' },
      {
        toolUseID: 'tool-1',
        signal: AbortSignal.timeout(1000),
      },
    )

    await runtimeOptions.onElicitation?.({
      message: 'Need an answer',
      requestedSchema: {
        properties: {
          answer: {
            description: 'Your answer',
          },
        },
      },
    })

    runtime.emit({
      type: 'unknown_event',
      payload: true,
    })
    runtime.emit({
      type: 'result',
      subtype: 'success',
      session_id: 'claude-session-1',
      result: 'Hello final',
      stop_reason: 'end_turn',
      terminal_reason: null,
      errors: [],
    })

    const events = await eventsPromise
    const types = events.map(event => event.type)

    assert.deepEqual(types, [
      'run.started',
      'approval.tool',
      'message.delta',
      'user.input',
      'message.completed',
      'item.started',
      'status.updated',
      'provider.notification',
      'run.completed',
    ])

    const itemStarted = events.find(event => event.type === 'item.started')?.payload as
      | { type: 'item.started'; item: { kind: string; toolName?: string; status?: string; raw?: unknown } }
      | undefined
    assert.ok(itemStarted)
    assert.equal(itemStarted.item.kind, 'tool')
    assert.equal(itemStarted.item.toolName, 'Bash')
    assert.equal(itemStarted.item.status, 'in_progress')

    const completion = events.find(event => event.type === 'run.completed')?.payload as
      | { type: 'run.completed'; runId: string; result: Record<string, unknown> }
      | undefined
    assert.ok(completion)
    assert.equal(completion.runId, '1')
    assert.equal(completion.result.provider, 'claude')
    assert.equal(completion.result.sessionId, 'claude-session-1')
    assert.equal(completion.result.status, 'completed')
    assert.equal(completion.result.text, 'Hello final')
    assert.ok(Array.isArray(completion.result.items))
    assert.equal((completion.result.handle as { version?: number }).version, 1)
    assert.equal((completion.result.handle as { state?: { resumeKey?: string } }).state?.resumeKey, 'claude-session-1')
    assert.equal((completion.result.handle as { state?: { resumeAt?: string } }).state?.resumeAt, 'assistant-uuid-1')
    assert.equal((completion.result.resumeState as { resumeSessionAt?: string }).resumeSessionAt, 'assistant-uuid-1')

    await session.close()
  } finally {
    ClaudeSessionCtor.runtimeFactory = originalFactory
  }
})

test('claude user input errors map to error event and failed completion', async () => {
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
    const session = new ClaudeSession('shared-claude-error')
    const stream = await session.stream('hello')

    const eventsPromise = (async () => {
      const events: Array<{ type: string; payload?: unknown }> = []
      for await (const event of stream) {
        events.push({ type: event.type, payload: event })
      }
      return events
    })()

    const runtime = runtimeRef as FakeClaudeRuntime
    const runtimeOptions = runtime.getRuntimeOptions()
    await runtimeOptions.onElicitation?.({
      message: 'Need input',
      requestedSchema: {
        properties: {
          answer: { description: 'missing handler path' },
        },
      },
    })

    runtime.emit({
      type: 'result',
      subtype: 'success',
      session_id: 'claude-session-2',
      result: 'ignored',
      stop_reason: 'end_turn',
      terminal_reason: null,
      errors: [],
    })

    const events = await eventsPromise
    const types = events.map(event => event.type)

    assert.ok(types.includes('user.input'))
    assert.ok(types.includes('error'))
    assert.ok(types.includes('run.completed'))

    const completion = events.find(event => event.type === 'run.completed')?.payload as
      | { type: 'run.completed'; runId: string; result: Record<string, unknown> }
      | undefined
    assert.ok(completion)
    assert.equal(completion.runId, '1')
    assert.equal(completion.result.provider, 'claude')
    assert.equal(completion.result.status, 'failed')
    assert.equal(completion.result.text, 'Claude requested user input, but no onUserInput handler is configured')

    await session.close()
  } finally {
    ClaudeSessionCtor.runtimeFactory = originalFactory
  }
})

test('claude tool activity stays normalized when tool_name is absent', async () => {
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
    const session = new ClaudeSession('shared-claude-tool-fallback')
    const stream = await session.stream('hello')

    const eventsPromise = (async () => {
      const events: Array<{ type: string; payload?: unknown }> = []
      for await (const event of stream) {
        events.push({ type: event.type, payload: event })
      }
      return events
    })()

    const runtime = runtimeRef as FakeClaudeRuntime
    runtime.emit({
      type: 'tool_use',
      session_id: 'claude-session-3',
      tool_use_id: 'tool-use-fallback-1',
      input: { command: 'pwd' },
    })
    runtime.emit({
      type: 'result',
      subtype: 'success',
      session_id: 'claude-session-3',
      result: 'done',
      stop_reason: 'end_turn',
      terminal_reason: null,
      errors: [],
    })

    const events = await eventsPromise
    const itemStarted = events.find(event => event.type === 'item.started')?.payload as
      | { type: 'item.started'; item: { id: string; kind: string; toolName?: string } }
      | undefined

    assert.ok(itemStarted)
    assert.equal(itemStarted.item.id, 'tool-use-fallback-1')
    assert.equal(itemStarted.item.kind, 'tool')
    assert.equal(itemStarted.item.toolName, undefined)

    await session.close()
  } finally {
    ClaudeSessionCtor.runtimeFactory = originalFactory
  }
})
