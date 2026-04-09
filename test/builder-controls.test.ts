import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgent, createSession } from '../src/agent-client.ts'
import { CodexClient } from '../src/codex-client.ts'
import { InputValidationError, UnsupportedCapabilityError } from '../src/errors.ts'
import { claudeCapabilities } from '../src/providers/claude-detection.ts'
import { ClaudeSession } from '../src/providers/claude-session.ts'
import { providerRegistry } from '../src/providers/provider-registry.ts'
import { createMockAgentClient } from './helpers/mock-provider.ts'
import { FakeTransport } from './helpers/fake-transport.ts'

type ClaudeRuntimeOptions = {
  canUseTool?: (...args: unknown[]) => Promise<unknown>
  onElicitation?: (...args: unknown[]) => Promise<unknown>
  permissionMode?: string
  allowDangerouslySkipPermissions?: boolean
}

class FakeClaudeRuntime {
  private readonly options: ClaudeRuntimeOptions
  setPermissionModeCalls: string[] = []
  setModelCalls: string[] = []

  constructor(options: ClaudeRuntimeOptions) {
    this.options = options
  }

  close(): void {}

  async interrupt(): Promise<void> {}

  async setModel(model: string): Promise<void> {
    this.setModelCalls.push(model)
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.setPermissionModeCalls.push(mode)
  }

  getRuntimeOptions(): ClaudeRuntimeOptions {
    return this.options
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {}
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

test('createSession rejects mixed accessMode and permissionMode usage', async () => {
  const snapshot = providerRegistry.getFactories()
  providerRegistry.reset([
    {
      id: 'codex',
      create: () => ({
        id: 'codex',
        async getInventory() {
          return {
            provider: 'codex' as const,
            installed: true,
            runnable: true,
            authenticated: true,
            degraded: false,
            status: 'authenticated' as const,
            account: { id: 'codex' },
          }
        },
        async isAvailable() {
          return true
        },
        async getAvailability() {
          return {
            provider: 'codex' as const,
            available: true,
            authenticated: true,
            account: { id: 'codex' },
          }
        },
        async createClient() {
          return createMockAgentClient('codex')
        },
      }),
    },
  ])

  try {
    await assert.rejects(
      createSession({
        provider: 'codex',
        name: 'mixed-config',
        accessMode: 'auto-edit',
        permissionMode: 'full-auto',
      }),
      error => {
        assert.ok(error instanceof InputValidationError)
        assert.equal(error.field, 'accessMode')
        assert.match(error.message, /accessMode/i)
        assert.match(error.message, /permissionMode/i)
        return true
      },
    )
  } finally {
    providerRegistry.reset(snapshot)
  }
})

test('claude capabilities expose builder-control switch semantics', () => {
  const capabilities = claudeCapabilities()

  assert.equal(capabilities.controls.modelSwitch, 'session')
  assert.equal(capabilities.controls.interactionModeSwitch, 'session')
  assert.equal(capabilities.controls.accessModeSwitch, 'session')
  assert.equal(capabilities.controls.permissionModeSwitch, 'session')
})

test('codex shared controls map to collaboration mode and sandbox settings', async () => {
  const fakeTransport = new FakeTransport()
  fakeTransport.respondWith('thread/start', { thread: createThreadData('thread-controls-1') })
  fakeTransport.respondWith('turn/start', { turn: { id: 'turn-controls-1' } })

  const CodexCtor = CodexClient as unknown as {
    create: (options?: Record<string, unknown>) => Promise<CodexClient>
    new (transport: FakeTransport, options: Record<string, unknown>): CodexClient
  }
  const originalCreate = CodexCtor.create
  const fakeCodexClient = new CodexCtor(fakeTransport, {})
  CodexCtor.create = async () => fakeCodexClient

  try {
    const agent = await createAgent({ provider: 'codex' })
    const capabilities = await agent.getCapabilities()
    assert.equal(capabilities.controls.modelSwitch, 'turn')
    assert.equal(capabilities.controls.interactionModeSwitch, 'turn')
    assert.equal(capabilities.controls.accessModeSwitch, 'turn')
    assert.equal(capabilities.controls.permissionModeSwitch, 'none')

    const session = await agent.openSession({
      name: 'controls',
      interactionMode: 'plan',
      accessMode: 'auto-edit',
    })

    const runPromise = session.run('map controls', {
      reasoningEffort: 'high',
    })

    await waitForRequest(fakeTransport, 'turn/start')
    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-controls-1',
        turn: {
          id: 'turn-controls-1',
          status: 'completed',
          error: null,
          items: [],
        },
      },
    })

    await runPromise

    const threadStart = fakeTransport.requestLog.find(entry => entry.method === 'thread/start')
    const turnStart = fakeTransport.requestLog.find(entry => entry.method === 'turn/start')

    assert.deepEqual(threadStart?.params, {
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      collaborationMode: {
        mode: 'plan',
        settings: {},
      },
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })

    assert.equal((turnStart?.params as Record<string, unknown>).approvalPolicy, 'never')
    assert.equal((turnStart?.params as Record<string, unknown>).effort, 'high')
    assert.deepEqual((turnStart?.params as Record<string, unknown>).collaborationMode, {
      mode: 'plan',
      settings: {
        reasoning_effort: 'high',
      },
    })
    assert.deepEqual((turnStart?.params as Record<string, unknown>).sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [process.cwd()],
      readOnlyAccess: { type: 'fullAccess' },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    })
  } finally {
    CodexCtor.create = originalCreate
    await fakeCodexClient.close()
  }
})

test('claude shared controls map chat/full-access to bypass permissions', async () => {
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
    const session = new ClaudeSession('builder-claude', undefined, {
      interactionMode: 'chat',
      accessMode: 'full-access',
    })

    const runtime = runtimeRef as FakeClaudeRuntime
    assert.equal(runtime.getRuntimeOptions().permissionMode, 'bypassPermissions')
    assert.equal(runtime.getRuntimeOptions().allowDangerouslySkipPermissions, true)

    await session.close()
  } finally {
    ClaudeSessionCtor.runtimeFactory = originalFactory
  }
})

test('claude rejects unsupported plan plus full-access combination', async () => {
  const ClaudeSessionCtor = ClaudeSession as unknown as {
    runtimeFactory: (input: { options: ClaudeRuntimeOptions }) => FakeClaudeRuntime
  }
  const originalFactory = ClaudeSessionCtor.runtimeFactory
  ClaudeSessionCtor.runtimeFactory = input => new FakeClaudeRuntime(input.options)

  try {
    assert.throws(() => new ClaudeSession('unsupported', undefined, {
      interactionMode: 'plan',
      accessMode: 'full-access',
    }), error => {
      assert.ok(error instanceof UnsupportedCapabilityError)
      assert.match(error.message, /unsupported/i)
      assert.match(error.message, /plan/i)
      assert.match(error.message, /full-access/i)
      return true
    })
  } finally {
    ClaudeSessionCtor.runtimeFactory = originalFactory
  }
})
