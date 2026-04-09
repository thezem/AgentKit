import assert from 'node:assert/strict'
import test from 'node:test'

import { providerRegistry } from '../src/providers/provider-registry.ts'
import type { ProviderAdapterFactory } from '../src/providers/provider-types.ts'
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

test('providerRegistry can register and fetch a fake provider factory', async () => {
  const snapshot = snapshotRegistry()

  try {
    providerRegistry.reset([
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
            return createMockAgentClient('codex')
          },
        }),
      },
    ])

    const provider = providerRegistry.get('codex')
    assert.equal(provider.id, 'codex')
    assert.equal((await provider.createClient({ provider: 'codex' })).provider, 'codex')
  } finally {
    restoreRegistry(snapshot)
  }
})

test('providerRegistry lists inventory from registered factories', async () => {
  const snapshot = snapshotRegistry()

  try {
    providerRegistry.reset([
      {
        id: 'codex',
        create: () => ({
          id: 'codex',
          async getInventory() {
            return {
              provider: 'codex',
              installed: true,
              runnable: true,
              authenticated: false,
              degraded: false,
              status: 'runnable',
              account: null,
            }
          },
          async isAvailable() {
            return true
          },
          async getAvailability() {
            return {
              provider: 'codex',
              available: true,
              authenticated: false,
              account: null,
            }
          },
          async createClient() {
            return createMockAgentClient('codex')
          },
        }),
      },
      {
        id: 'claude',
        create: () => ({
          id: 'claude',
          async getInventory() {
            return {
              provider: 'claude',
              installed: true,
              runnable: false,
              authenticated: false,
              degraded: true,
              status: 'degraded',
              account: null,
            }
          },
          async isAvailable() {
            return false
          },
          async getAvailability() {
            return {
              provider: 'claude',
              available: false,
              authenticated: false,
              account: null,
            }
          },
          async createClient() {
            return createMockAgentClient('claude')
          },
        }),
      },
    ])

    const inventory = await providerRegistry.getProviderInventory()
    assert.deepEqual(
      inventory.map((entry) => ({ provider: entry.provider, status: entry.status })),
      [
        { provider: 'codex', status: 'runnable' },
        { provider: 'claude', status: 'degraded' },
      ],
    )
  } finally {
    restoreRegistry(snapshot)
  }
})
