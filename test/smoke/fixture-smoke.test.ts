import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgent } from '../../src/agent-client.ts'
import { providerRegistry } from '../../src/providers/provider-registry.ts'
import { createFixtureAgentClient } from '../helpers/smoke-fixtures.ts'

type Registry = typeof providerRegistry
type RegistrySnapshot = {
  get: Registry['get']
}

function snapshotRegistry(): RegistrySnapshot {
  return {
    get: providerRegistry.get,
  }
}

function restoreRegistry(snapshot: RegistrySnapshot): void {
  providerRegistry.get = snapshot.get
}

test('fixture smoke: README lifecycle flow works with open, run, resume, and close', async () => {
  const snapshot = snapshotRegistry()
  providerRegistry.get = ((provider) => ({
    id: provider,
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
      return createFixtureAgentClient(provider)
    },
  })) as Registry['get']

  try {
    const agent = await createAgent({
      provider: 'codex',
      defaults: { cwd: process.cwd() },
    })

    const opened = await agent.openSession({ name: 'demo' })
    const first = await opened.run('Summarize this repository in 3 bullets')
    assert.equal(first.status, 'completed')
    assert.ok(first.handle)
    assert.equal(first.handle?.provider, 'codex')

    const restored = await agent.resumeSession(first.handle!)
    const second = await restored.run('Now reply with one short follow-up')
    assert.equal(second.status, 'completed')
    assert.ok(second.text.startsWith('fixture:'))

    await opened.close()
    await restored.close()
    await agent.close()
  } finally {
    restoreRegistry(snapshot)
  }
})

test('fixture smoke: cached session reuse and clearSession behave as documented', async () => {
  const snapshot = snapshotRegistry()
  providerRegistry.get = ((provider) => ({
    id: provider,
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
      return createFixtureAgentClient(provider)
    },
  })) as Registry['get']

  try {
    const agent = await createAgent({ provider: 'codex' })
    const first = agent.session('my-project')
    const second = agent.session('my-project')
    assert.equal(first, second)

    agent.clearSession('my-project')
    const third = agent.session('my-project')
    assert.notEqual(first, third)

    await agent.close()
  } finally {
    restoreRegistry(snapshot)
  }
})

test('fixture smoke: stream wiring triggers approval and user input handlers', async () => {
  const snapshot = snapshotRegistry()
  providerRegistry.get = ((provider) => ({
    id: provider,
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
      return createFixtureAgentClient(provider)
    },
  })) as Registry['get']

  try {
    const agent = await createAgent({ provider: 'claude' })
    const session = await agent.openSession({ name: 'handlers' })

    const stream = await session.stream('run with handlers', {
      handlers: {
        onToolApproval: async () => 'allow',
        onUserInput: async () => 'yes',
      },
    })

    const events: Array<{ type: string; text?: string; status?: string }> = []
    for await (const event of stream) {
      events.push({
        type: event.type,
        ...(event.type === 'message.delta' ? { text: event.text } : {}),
        ...(event.type === 'status.updated' ? { status: event.status } : {}),
      })
    }

    const eventTypes = events.map((event) => event.type)
    assert.deepEqual(eventTypes, ['run.started', 'status.updated', 'approval.tool', 'user.input', 'message.delta', 'run.completed'])
    const delta = events.find((event) => event.type === 'message.delta')
    assert.equal(delta?.text, 'approval=allow;answer=yes')

    await session.close()
    await agent.close()
  } finally {
    restoreRegistry(snapshot)
  }
})
