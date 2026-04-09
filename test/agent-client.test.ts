import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAgent,
  createSession,
  getAvailableProviders,
  getProviderAvailability,
  getProviderInventory,
  getProviderInventoryEntry,
} from '../src/agent-client.ts'
import { CodexClient } from '../src/codex-client.ts'
import { InputValidationError, ProviderProbeTimeoutError } from '../src/errors.ts'
import { providerRegistry } from '../src/providers/provider-registry.ts'
import type { ProviderAdapterFactory } from '../src/providers/provider-types.ts'
import { FakeTransport } from './helpers/fake-transport.ts'
import { createMockAgentClient } from './helpers/mock-provider.ts'

type RegistrySnapshot = {
  factories: ProviderAdapterFactory[]
}

function snapshotRegistry(): RegistrySnapshot {
  return {
    factories: providerRegistry.getFactories(),
  }
}

function restoreRegistry(snapshot: RegistrySnapshot): void {
  providerRegistry.reset(snapshot.factories)
}

function registerProviders(factories: ProviderAdapterFactory[]): void {
  providerRegistry.reset(factories)
}

function createFactory(
  id: 'codex' | 'claude',
  overrides?: Partial<ReturnType<ProviderAdapterFactory['create']>>,
): ProviderAdapterFactory {
  return {
    id,
    create: () => ({
      id,
      async getInventory() {
        return {
          provider: id,
          installed: true,
          runnable: true,
          authenticated: true,
          degraded: false,
          status: 'authenticated',
          account: { id },
          raw: { provider: id },
          ...(overrides?.getInventory ? await overrides.getInventory() : {}),
        }
      },
      async isAvailable() {
        return true
      },
      async getAvailability() {
        return {
          provider: id,
          available: true,
          authenticated: true,
          account: { id },
        }
      },
      async createClient() {
        return createMockAgentClient(id)
      },
      ...overrides,
    }),
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

test('createAgent("codex") returns codex provider client', async () => {
  const snapshot = snapshotRegistry()
  registerProviders([createFactory('codex'), createFactory('claude')])

  try {
    const agent = await createAgent({ provider: 'codex' })
    assert.equal(agent.provider, 'codex')
  } finally {
    restoreRegistry(snapshot)
  }
})

test('createAgent("claude") returns claude provider client', async () => {
  const snapshot = snapshotRegistry()
  registerProviders([createFactory('codex'), createFactory('claude')])

  try {
    const agent = await createAgent({ provider: 'claude' })
    assert.equal(agent.provider, 'claude')
  } finally {
    restoreRegistry(snapshot)
  }
})

test('createSession opens a session for the selected provider and preserves AgentSession behavior', async () => {
  const snapshot = snapshotRegistry()
  const calls: Array<{ phase: string; options?: Record<string, unknown> }> = []
  const session = createMockAgentClient('claude').session('wrapped')
  const client = {
    ...createMockAgentClient('claude'),
    async openSession(options?: Record<string, unknown>) {
      calls.push({ phase: 'openSession', options })
      return session
    },
    async close() {
      calls.push({ phase: 'closeClient' })
    },
  }

  registerProviders([
    createFactory('codex'),
    {
      id: 'claude',
      create: () => ({
        id: 'claude',
        async getInventory() {
          return {
            provider: 'claude',
            installed: true,
            runnable: true,
            authenticated: true,
            degraded: false,
            status: 'authenticated',
            account: { id: 'claude' },
          }
        },
        async isAvailable() {
          return true
        },
        async getAvailability() {
          return {
            provider: 'claude',
            available: true,
            authenticated: true,
            account: { id: 'claude' },
          }
        },
        async createClient(options?: Record<string, unknown>) {
          calls.push({ phase: 'createClient', options })
          return client
        },
      }),
    },
  ])

  try {
    const wrapped = await createSession({
      provider: 'claude',
      claude: { executable: 'claude' },
      defaults: { cwd: '/tmp/workspace', model: 'sonnet' },
      name: 'hello-session',
      includePartialMessages: true,
    })

    assert.equal(wrapped.provider, 'claude')
    assert.equal(wrapped.name, 'wrapped')
    const result = await wrapped.run('hello world')
    assert.equal(result.provider, 'claude')
    assert.equal(result.status, 'completed')

    await wrapped.close()

    assert.deepEqual(calls, [
      {
        phase: 'createClient',
        options: {
          provider: 'claude',
          claude: { executable: 'claude' },
          defaults: { cwd: '/tmp/workspace', model: 'sonnet' },
        },
      },
      {
        phase: 'openSession',
        options: {
          name: 'hello-session',
          includePartialMessages: true,
        },
      },
      {
        phase: 'closeClient',
      },
    ])
  } finally {
    restoreRegistry(snapshot)
  }
})

test('createSession forwards provider defaults and explicit session options correctly', async () => {
  const snapshot = snapshotRegistry()
  const calls: Array<{ phase: string; options?: Record<string, unknown> }> = []

  registerProviders([
    {
      id: 'codex',
      create: () => ({
        id: 'codex',
        async getInventory() {
          return {
            provider: 'codex',
            installed: true,
            runnable: true,
            authenticated: true,
            degraded: false,
            status: 'authenticated',
            account: { id: 'codex' },
          }
        },
        async isAvailable() {
          return true
        },
        async getAvailability() {
          return {
            provider: 'codex',
            available: true,
            authenticated: true,
            account: { id: 'codex' },
          }
        },
        async createClient(options?: Record<string, unknown>) {
          calls.push({ phase: 'createClient', options })
          return {
            ...createMockAgentClient('codex'),
            async openSession(sessionOptions?: Record<string, unknown>) {
              calls.push({ phase: 'openSession', options: sessionOptions })
              return createMockAgentClient('codex').session('forwarded')
            },
            async close() {
              calls.push({ phase: 'closeClient' })
            },
          }
        },
      }),
    },
    createFactory('claude'),
  ])

  try {
    const session = await createSession({
      provider: 'codex',
      codex: { cwd: 'G:\\PI\\codex-sdk-node' },
      defaults: {
        cwd: 'G:\\PI\\codex-sdk-node',
        model: 'gpt-5.4',
        permissionMode: 'default',
      },
      name: 'provider-defaults',
      model: 'gpt-5.4-mini',
      permissionMode: 'full-auto',
      additionalDirectories: ['G:\\shared'],
    })

    await session.close()

    assert.deepEqual(calls, [
      {
        phase: 'createClient',
        options: {
          provider: 'codex',
          codex: { cwd: 'G:\\PI\\codex-sdk-node' },
          defaults: {
            cwd: 'G:\\PI\\codex-sdk-node',
            model: 'gpt-5.4',
            permissionMode: 'default',
          },
        },
      },
      {
        phase: 'openSession',
        options: {
          name: 'provider-defaults',
          model: 'gpt-5.4-mini',
          permissionMode: 'full-auto',
          additionalDirectories: ['G:\\shared'],
        },
      },
      {
        phase: 'closeClient',
      },
    ])
  } finally {
    restoreRegistry(snapshot)
  }
})

test('createSession closes the private client if openSession fails', async () => {
  const snapshot = snapshotRegistry()
  const calls: string[] = []

  registerProviders([
    {
      id: 'codex',
      create: () => ({
        id: 'codex',
        async getInventory() {
          return {
            provider: 'codex',
            installed: true,
            runnable: true,
            authenticated: true,
            degraded: false,
            status: 'authenticated',
            account: { id: 'codex' },
          }
        },
        async isAvailable() {
          return true
        },
        async getAvailability() {
          return {
            provider: 'codex',
            available: true,
            authenticated: true,
            account: { id: 'codex' },
          }
        },
        async createClient() {
          calls.push('createClient')
          return {
            ...createMockAgentClient('codex'),
            async openSession() {
              calls.push('openSession')
              throw new Error('open failed')
            },
            async close() {
              calls.push('closeClient')
            },
          }
        },
      }),
    },
    createFactory('claude'),
  ])

  try {
    await assert.rejects(
      createSession({
        provider: 'codex',
        name: 'boom',
      }),
      /open failed/,
    )

    assert.deepEqual(calls, ['createClient', 'openSession', 'closeClient'])
  } finally {
    restoreRegistry(snapshot)
  }
})

test('createSession close rejects with the original session close error and still closes the private client', async () => {
  const snapshot = snapshotRegistry()
  const calls: string[] = []
  const sessionCloseError = new Error('session close failed')

  registerProviders([
    createFactory('codex', {
      async createClient() {
        return {
          ...createMockAgentClient('codex'),
          async openSession() {
            return {
              ...createMockAgentClient('codex').session('close-test'),
              async close() {
                calls.push('closeSession')
                throw sessionCloseError
              },
            }
          },
          async close() {
            calls.push('closeClient')
          },
        }
      },
    }),
    createFactory('claude'),
  ])

  try {
    const session = await createSession({ provider: 'codex' })
    await assert.rejects(session.close(), error => {
      assert.equal(error, sessionCloseError)
      return true
    })
    assert.deepEqual(calls, ['closeSession', 'closeClient'])
  } finally {
    restoreRegistry(snapshot)
  }
})

test('createAgent throws InputValidationError for unknown provider id', async () => {
  await assert.rejects(createAgent({ provider: 'unknown' as 'codex' }), error => {
    assert.ok(error instanceof InputValidationError)
    assert.equal(error.code, 'INVALID_PROVIDER')
    assert.equal(error.retryable, false)
    assert.equal(error.provider, undefined)
    assert.equal(error.field, 'provider')
    return true
  })
})

test('session caching returns same handle and clearSession invalidates it', () => {
  const client = createMockAgentClient('codex')

  const first = client.session('project-a')
  const second = client.session('project-a')
  assert.equal(first, second)

  client.clearSession('project-a')

  const third = client.session('project-a')
  assert.notEqual(first, third)
})

test('persisted handle survives local cache eviction and can resume the same codex thread', async () => {
  const fakeTransport = new FakeTransport()
  fakeTransport.respondWith('thread/start', { thread: createThreadData('thread-1') })
  fakeTransport.respondWith('turn/start', { turn: { id: 'turn-1' } })
  fakeTransport.respondWith('thread/resume', { thread: createThreadData('thread-1') })

  const CodexCtor = CodexClient as unknown as {
    create: (options?: Record<string, unknown>) => Promise<CodexClient>
    new (transport: FakeTransport, options: Record<string, unknown>): CodexClient
  }
  const originalCreate = CodexCtor.create
  const fakeCodexClient = new CodexCtor(fakeTransport, {})
  CodexCtor.create = async () => fakeCodexClient

  try {
    const agent = await createAgent({ provider: 'codex' })
    const cached = agent.session('persist-me')

    const resultPromise = cached.run('hello')

    await waitForRequest(fakeTransport, 'turn/start')
    fakeTransport.simulateNotification({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'msg-1', text: 'hello world' },
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
          items: [{ type: 'agentMessage', id: 'msg-1', text: 'hello world' }],
        },
      },
    })

    const result = await resultPromise
    assert.equal(result.handle?.version, 1)
    assert.equal(result.handle?.provider, 'codex')
    assert.equal(result.handle?.state?.resumeKey, 'thread-1')
    assert.equal(result.handle?.sessionId, 'thread-1')

    agent.clearSession('persist-me')

    const recached = agent.session('persist-me')
    assert.notEqual(recached, cached)
    assert.equal(recached.getHandle(), null)

    const resumed = await agent.resumeSession(result.handle as NonNullable<typeof result.handle>, { name: 'resumed' })
    assert.equal(resumed.getHandle()?.state?.resumeKey, 'thread-1')
    assert.equal(resumed.getSessionInfo().sessionId, 'thread-1')

    assert.deepEqual(
      fakeTransport.requestLog.map(entry => entry.method),
      ['thread/start', 'turn/start', 'thread/resume'],
    )
  } finally {
    CodexCtor.create = originalCreate
    await fakeCodexClient.close()
  }
})

test('getAvailableProviders maps inventory entries to availability results', async () => {
  const snapshot = snapshotRegistry()
  registerProviders([
    createFactory('codex', {
      async getInventory() {
        return {
          provider: 'codex',
          installed: true,
          runnable: true,
          authenticated: true,
          degraded: false,
          status: 'authenticated',
          capabilitySupport: { provider: 'codex', supportsResume: true },
          version: '1.2.3',
          executablePath: '/usr/local/bin/codex',
          executableSource: 'path',
          diagnostics: {
            probeMode: 'deep',
            probeStrategy: 'runtime-init',
          },
          account: { email: 'user@example.com' },
          raw: { source: 'test', detail: 'codex' },
        }
      },
    }),
    createFactory('claude', {
      async getInventory() {
        return {
          provider: 'claude',
          installed: true,
          runnable: false,
          authenticated: false,
          degraded: true,
          status: 'degraded',
          capabilitySupport: { provider: 'claude', supportsResume: true },
          version: '0.2.0',
          executablePath: 'C:\\claude\\claude.exe',
          executableSource: 'configured',
          diagnostics: {
            probeMode: 'cheap',
            probeStrategy: 'sdk-import',
            failureReason: 'not authenticated',
          },
          account: null,
          raw: { source: 'test', detail: 'claude' },
        }
      },
    }),
  ])

  try {
    const availability = await getAvailableProviders()
    assert.deepEqual(availability, [
      {
        provider: 'codex',
        available: true,
        authenticated: true,
        account: { email: 'user@example.com' },
        raw: { source: 'test', detail: 'codex' },
      },
      {
        provider: 'claude',
        available: false,
        authenticated: false,
        account: null,
        raw: { source: 'test', detail: 'claude' },
      },
    ])

    assert.equal('version' in availability[0], false)
    assert.equal('capabilitySupport' in availability[0], false)
    assert.equal('executablePath' in availability[0], false)
    assert.equal('diagnostics' in availability[0], false)
  } finally {
    restoreRegistry(snapshot)
  }
})

test('getProviderAvailability returns one mapped entry', async () => {
  const snapshot = snapshotRegistry()
  registerProviders([
    createFactory('codex', {
      async getInventory() {
        return {
          provider: 'codex',
          installed: true,
          runnable: true,
          authenticated: false,
          degraded: false,
          status: 'runnable',
          account: null,
          raw: { provider: 'codex' },
        }
      },
    }),
    createFactory('claude'),
  ])

  try {
    const availability = await getProviderAvailability('codex')
    assert.deepEqual(availability, {
      provider: 'codex',
      available: true,
      authenticated: false,
      account: null,
      raw: { provider: 'codex' },
    })
  } finally {
    restoreRegistry(snapshot)
  }
})

test('getProviderInventory and getProviderAvailability surface probe timeout failures', async () => {
  const snapshot = snapshotRegistry()
  const timeoutError = new ProviderProbeTimeoutError('codex', 5)
  registerProviders([
    {
      id: 'codex',
      create: () => ({
        id: 'codex',
        async getInventory() {
          throw timeoutError
        },
        async isAvailable() {
          throw timeoutError
        },
        async getAvailability() {
          throw timeoutError
        },
        async createClient() {
          throw timeoutError
        },
      }),
    },
    createFactory('claude'),
  ])

  try {
    await assert.rejects(getProviderInventory(), ProviderProbeTimeoutError)
    await assert.rejects(getProviderAvailability('codex'), ProviderProbeTimeoutError)
  } finally {
    restoreRegistry(snapshot)
  }
})

test('getProviderInventoryEntry returns selected provider inventory', async () => {
  const snapshot = snapshotRegistry()
  registerProviders([
    createFactory('codex'),
    createFactory('claude', {
      async getInventory() {
        return {
          provider: 'claude',
          installed: true,
          runnable: true,
          authenticated: true,
          degraded: false,
          status: 'authenticated',
          capabilitySupport: { provider: 'claude', supportsResume: true },
          version: '9.9.9',
          executablePath: '/bin/claude',
          executableSource: 'path' as const,
          diagnostics: {
            probeMode: 'deep',
            probeStrategy: 'runtime-init',
          },
          account: { id: 'claude' },
          raw: { marker: 'claude' },
        }
      },
    }),
  ])

  try {
    const entry = await getProviderInventoryEntry('claude')
    assert.equal(entry.provider, 'claude')
    assert.equal(entry.authenticated, true)
    assert.equal(entry.version, '9.9.9')
    assert.equal(entry.executablePath, '/bin/claude')
    assert.equal(entry.executableSource, 'path')
    assert.deepEqual(entry.diagnostics, {
      probeMode: 'deep',
      probeStrategy: 'runtime-init',
    })
    assert.deepEqual(entry.raw, { marker: 'claude' })
    assert.equal(entry.capabilitySupport?.provider, 'claude')
  } finally {
    restoreRegistry(snapshot)
  }
})

test('getProviderInventory preserves rich discovery metadata for all providers', async () => {
  const snapshot = snapshotRegistry()
  registerProviders([
    createFactory('codex', {
      async getInventory() {
        return {
          provider: 'codex',
          installed: true,
          runnable: true,
          authenticated: true,
          degraded: false,
          status: 'authenticated',
          capabilitySupport: {
            provider: 'codex',
            sessionLifecycle: { open: true, resume: true, list: false, clearLocalCache: true, deleteRemote: false },
            controls: { interrupt: true, modelSwitch: 'turn', permissionModeSwitch: 'none' },
            interactions: { partialMessages: true, toolApproval: true, userInputRequests: true, dynamicToolCalls: true },
            discovery: { inventory: true, modelListing: true, skillsListing: true, skillConfiguration: true },
            semantics: { sessionIdentity: 'thread-id', resumeHandle: 'structured', longLivedRuntime: false },
            supportsResume: true,
            supportsInterrupt: true,
            supportsModelSwitch: true,
            supportsPermissionModeSwitch: false,
            supportsPartialMessages: true,
            supportsToolApproval: true,
            supportsUserInputRequests: true,
          },
          version: '1.0.0',
          executablePath: '/usr/bin/codex',
          executableSource: 'path',
          diagnostics: {
            probeMode: 'deep',
            probeStrategy: 'runtime-init',
            notes: ['ok'],
          },
          account: { email: 'codex@example.com' },
          raw: { provider: 'codex', source: 'test' },
        }
      },
    }),
    createFactory('claude', {
      async getInventory() {
        return {
          provider: 'claude',
          installed: true,
          runnable: true,
          authenticated: false,
          degraded: false,
          status: 'runnable',
          capabilitySupport: {
            provider: 'claude',
            sessionLifecycle: { open: true, resume: true, list: false, clearLocalCache: true, deleteRemote: false },
            controls: { interrupt: true, modelSwitch: 'session', permissionModeSwitch: 'session' },
            interactions: { partialMessages: true, toolApproval: true, userInputRequests: true, dynamicToolCalls: false },
            discovery: { inventory: true, modelListing: true, skillsListing: false, skillConfiguration: false },
            semantics: { sessionIdentity: 'runtime-session', resumeHandle: 'structured', longLivedRuntime: true },
            supportsResume: true,
            supportsInterrupt: true,
            supportsModelSwitch: true,
            supportsPermissionModeSwitch: true,
            supportsPartialMessages: true,
            supportsToolApproval: true,
            supportsUserInputRequests: true,
          },
          version: '0.2.92',
          executablePath: 'C:\\Claude\\claude.exe',
          executableSource: 'configured',
          diagnostics: {
            probeMode: 'cheap',
            probeStrategy: 'sdk-import',
          },
          account: null,
          raw: { provider: 'claude', source: 'test' },
        }
      },
    }),
  ])

  try {
    const inventory = await getProviderInventory()
    assert.equal(inventory.length, 2)
    assert.equal(inventory[0].provider, 'codex')
    assert.equal(inventory[0].version, '1.0.0')
    assert.equal(inventory[0].executablePath, '/usr/bin/codex')
    assert.equal(inventory[0].executableSource, 'path')
    assert.equal(inventory[0].capabilitySupport?.provider, 'codex')
    assert.deepEqual(inventory[0].diagnostics, {
      probeMode: 'deep',
      probeStrategy: 'runtime-init',
      notes: ['ok'],
    })
    assert.deepEqual(inventory[0].raw, { provider: 'codex', source: 'test' })

    assert.equal(inventory[1].provider, 'claude')
    assert.equal(inventory[1].version, '0.2.92')
    assert.equal(inventory[1].executablePath, 'C:\\Claude\\claude.exe')
    assert.equal(inventory[1].executableSource, 'configured')
    assert.equal(inventory[1].capabilitySupport?.provider, 'claude')
    assert.deepEqual(inventory[1].diagnostics, {
      probeMode: 'cheap',
      probeStrategy: 'sdk-import',
    })
    assert.deepEqual(inventory[1].raw, { provider: 'claude', source: 'test' })
  } finally {
    restoreRegistry(snapshot)
  }
})
