import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAgent,
  getAvailableProviders,
  getProviderAvailability,
  getProviderInventory,
  getProviderInventoryEntry,
} from '../src/agent-client.ts'
import { CodexClient } from '../src/codex-client.ts'
import { InputValidationError, ProviderProbeTimeoutError } from '../src/errors.ts'
import { providerRegistry } from '../src/providers/provider-registry.ts'
import { FakeTransport } from './helpers/fake-transport.ts'
import { createMockAgentClient } from './helpers/mock-provider.ts'

type Registry = typeof providerRegistry

type RegistrySnapshot = {
  get: Registry['get']
  getProviderInventory: Registry['getProviderInventory']
}

function snapshotRegistry(): RegistrySnapshot {
  return {
    get: providerRegistry.get,
    getProviderInventory: providerRegistry.getProviderInventory,
  }
}

function restoreRegistry(snapshot: RegistrySnapshot): void {
  providerRegistry.get = snapshot.get
  providerRegistry.getProviderInventory = snapshot.getProviderInventory
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
  providerRegistry.get = (provider => {
    assert.equal(provider, 'codex')
    return {
      id: 'codex',
      async getInventory() {
        throw new Error('unused')
      },
      async isAvailable() {
        return true
      },
      async getAvailability() {
        throw new Error('unused')
      },
      async createClient() {
        return createMockAgentClient('codex')
      },
    }
  }) as Registry['get']

  try {
    const agent = await createAgent({ provider: 'codex' })
    assert.equal(agent.provider, 'codex')
  } finally {
    restoreRegistry(snapshot)
  }
})

test('createAgent("claude") returns claude provider client', async () => {
  const snapshot = snapshotRegistry()
  providerRegistry.get = (provider => {
    assert.equal(provider, 'claude')
    return {
      id: 'claude',
      async getInventory() {
        throw new Error('unused')
      },
      async isAvailable() {
        return true
      },
      async getAvailability() {
        throw new Error('unused')
      },
      async createClient() {
        return createMockAgentClient('claude')
      },
    }
  }) as Registry['get']

  try {
    const agent = await createAgent({ provider: 'claude' })
    assert.equal(agent.provider, 'claude')
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
  providerRegistry.getProviderInventory = (async () => [
    {
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
    },
    {
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
    },
  ]) as Registry['getProviderInventory']

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
  providerRegistry.get = (provider => ({
    id: provider,
    async getInventory() {
      return {
        provider,
        installed: true,
        runnable: true,
        authenticated: false,
        degraded: false,
        status: 'runnable',
        account: null,
        raw: { provider },
      }
    },
    async isAvailable() {
      return true
    },
    async getAvailability() {
      throw new Error('unused')
    },
    async createClient() {
      return createMockAgentClient(provider)
    },
  })) as Registry['get']

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
  providerRegistry.getProviderInventory = (async () => {
    throw timeoutError
  }) as Registry['getProviderInventory']
  providerRegistry.get = (() => {
    throw timeoutError
  }) as Registry['get']

  try {
    await assert.rejects(getProviderInventory(), ProviderProbeTimeoutError)
    await assert.rejects(getProviderAvailability('codex'), ProviderProbeTimeoutError)
  } finally {
    restoreRegistry(snapshot)
  }
})

test('getProviderInventoryEntry returns selected provider inventory', async () => {
  const snapshot = snapshotRegistry()
  providerRegistry.get = (provider => ({
    id: provider,
    async getInventory() {
      return {
        provider,
        installed: true,
        runnable: true,
        authenticated: true,
        degraded: false,
        status: 'authenticated',
        capabilitySupport: { provider, supportsResume: true },
        version: '9.9.9',
        executablePath: `/bin/${provider}`,
        executableSource: 'path' as const,
        diagnostics: {
          probeMode: 'deep',
          probeStrategy: 'runtime-init',
        },
        account: { id: provider },
        raw: { marker: provider },
      }
    },
    async isAvailable() {
      return true
    },
    async getAvailability() {
      throw new Error('unused')
    },
    async createClient() {
      return createMockAgentClient(provider)
    },
  })) as Registry['get']

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
  providerRegistry.getProviderInventory = (async () => [
    {
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
    },
    {
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
    },
  ]) as Registry['getProviderInventory']

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
