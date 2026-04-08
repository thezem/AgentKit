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
