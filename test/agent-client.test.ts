import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAgent,
  getAvailableProviders,
  getProviderAvailability,
  getProviderInventory,
  getProviderInventoryEntry,
} from '../src/agent-client.ts'
import { InputValidationError, ProviderProbeTimeoutError } from '../src/errors.ts'
import { providerRegistry } from '../src/providers/provider-registry.ts'
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

test('createAgent("codex") returns codex provider client', async () => {
  const snapshot = snapshotRegistry()
  providerRegistry.get = ((provider) => {
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
  providerRegistry.get = ((provider) => {
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
  await assert.rejects(createAgent({ provider: 'unknown' as 'codex' }), (error) => {
    assert.ok(error instanceof InputValidationError)
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
      account: { email: 'user@example.com' },
      raw: { source: 'test' },
    },
    {
      provider: 'claude',
      installed: true,
      runnable: false,
      authenticated: false,
      degraded: true,
      status: 'degraded',
      account: null,
      raw: { source: 'test' },
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
        raw: { source: 'test' },
      },
      {
        provider: 'claude',
        available: false,
        authenticated: false,
        account: null,
        raw: { source: 'test' },
      },
    ])
  } finally {
    restoreRegistry(snapshot)
  }
})

test('getProviderAvailability returns one mapped entry', async () => {
  const snapshot = snapshotRegistry()
  providerRegistry.get = ((provider) => ({
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
  providerRegistry.get = ((provider) => ({
    id: provider,
    async getInventory() {
      return {
        provider,
        installed: true,
        runnable: true,
        authenticated: true,
        degraded: false,
        status: 'authenticated',
        account: { id: provider },
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
  } finally {
    restoreRegistry(snapshot)
  }
})
