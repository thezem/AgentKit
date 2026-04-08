import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgent, getProviderInventoryEntry } from '../../src/agent-client.ts'

const LIVE_FLAG = process.env.AGENTKIT_LIVE_SMOKE === '1'
const RUN_CODEX = process.env.AGENTKIT_LIVE_CODEX !== '0'
const RUN_CLAUDE = process.env.AGENTKIT_LIVE_CLAUDE === '1'

test('live smoke (optional): codex runtime open/run/resume/close', { timeout: 120_000 }, async (t) => {
  if (!LIVE_FLAG || !RUN_CODEX) {
    t.skip('Set AGENTKIT_LIVE_SMOKE=1 to run live Codex smoke test')
    return
  }

  const inventory = await getProviderInventoryEntry('codex', { probeMode: 'deep', probeTimeoutMs: 5000 })
  if (!inventory.runnable || !inventory.authenticated) {
    t.skip('Codex runtime not runnable/authenticated for live smoke')
    return
  }

  const agent = await createAgent({
    provider: 'codex',
    defaults: { cwd: process.cwd() },
  })

  try {
    const session = await agent.openSession({ name: 'live-codex-smoke' })
    const result = await session.run('Reply with exactly: live-codex-ok')
    assert.equal(result.provider, 'codex')
    assert.ok(result.handle)
    const resumed = await agent.resumeSession(result.handle!)
    const second = await resumed.run('Reply with exactly: live-codex-resume-ok')
    assert.equal(second.provider, 'codex')
    await resumed.close()
    await session.close()
  } finally {
    await agent.close()
  }
})

test('live smoke (optional): claude runtime open/run/resume/close', { timeout: 120_000 }, async (t) => {
  if (!LIVE_FLAG || !RUN_CLAUDE) {
    t.skip('Set AGENTKIT_LIVE_SMOKE=1 and AGENTKIT_LIVE_CLAUDE=1 to run live Claude smoke test')
    return
  }

  const inventory = await getProviderInventoryEntry('claude', { probeMode: 'deep', probeTimeoutMs: 5000 })
  if (!inventory.runnable || !inventory.authenticated) {
    t.skip('Claude runtime not runnable/authenticated for live smoke')
    return
  }

  const agent = await createAgent({
    provider: 'claude',
    defaults: { cwd: process.cwd() },
  })

  try {
    const session = await agent.openSession({ name: 'live-claude-smoke' })
    const result = await session.run('Reply with exactly: live-claude-ok')
    assert.equal(result.provider, 'claude')
    assert.ok(result.handle)
    const resumed = await agent.resumeSession(result.handle!)
    const second = await resumed.run('Reply with exactly: live-claude-resume-ok')
    assert.equal(second.provider, 'claude')
    await resumed.close()
    await session.close()
  } finally {
    await agent.close()
  }
})
