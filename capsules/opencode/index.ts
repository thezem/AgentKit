/**
 * OpenCode capsule: drives the locally installed, signed-in `opencode` (v2.x)
 * through `opencode serve` + `@opencode/client`. Provider credentials come from
 * `opencode auth login`; nothing is passed through AgentKit.
 *
 *   import { createOpenCodeClient } from './capsules/opencode/index.ts'
 *   const opencode = createOpenCodeClient()
 *   const session = await opencode.createSession({ cwd: process.cwd(), model: 'anthropic/claude-sonnet-5' })
 */
import os from 'node:os'
import type { PersistenceHandle, ProviderCatalog, ProviderClient, SessionConfig, SessionSummary } from '../shared/contract.ts'
import { findBinary, runCapture } from '../shared/runtime.ts'
import { startOpenCodeServer, type OpenCodeServer } from './internals/server.ts'
import { modelRef, OPENCODE_CAPABILITIES, OpenCodeSession, waitForLocation } from './internals/session.ts'

export interface OpenCodeCapsuleConfig {
  /** Path to the opencode binary. Default: `opencode` on PATH. */
  binary?: string
  /** Extra args before `serve`. */
  args?: string[]
  /** Env for the server process (e.g. OPENCODE_CONFIG_CONTENT). */
  env?: Record<string, string>
  /** Default agent (mode) for new sessions. Default: "build". */
  defaultMode?: string
}

export { OPENCODE_CAPABILITIES }
export type { OpenCodeSession }

export function createOpenCodeClient(config: OpenCodeCapsuleConfig = {}): ProviderClient {
  let binaryPromise: Promise<string | null> | null = null
  const binary = () => (binaryPromise ??= findBinary('opencode', config.binary))
  let shared: { server: Promise<OpenCodeServer>; users: number } | null = null
  const dedicated = new Set<OpenCodeServer>()

  async function launch(env?: Record<string, string>): Promise<OpenCodeServer> {
    const bin = await binary()
    if (!bin) throw new Error('opencode CLI not found on PATH (npm i -g opencode-ai, then `opencode auth login`)')
    return startOpenCodeServer({ binary: bin, args: config.args, env: { ...config.env, ...env }, cwd: os.homedir() })
  }

  /** Lease the shared server (ref-counted) or a dedicated one when the session needs isolated MCP. */
  async function acquire(isolated: boolean) {
    if (isolated) {
      const server = await launch()
      dedicated.add(server)
      return {
        client: server.client,
        exited: server.exited,
        release: async () => {
          dedicated.delete(server)
          await server.stop()
        },
      }
    }
    if (!shared) {
      const entry = { server: launch(), users: 0 }
      shared = entry
      entry.server.then(
        (server) => server.exited.then(() => shared === entry && (shared = null)),
        () => shared === entry && (shared = null),
      )
    }
    const entry = shared
    entry.users += 1
    try {
      const server = await entry.server
      let released = false
      return {
        client: server.client,
        exited: server.exited,
        release: async () => {
          if (released) return
          released = true
          entry.users -= 1
          if (entry.users === 0 && shared === entry) {
            shared = null
            await server.stop()
          }
        },
      }
    } catch (error) {
      entry.users -= 1
      throw error
    }
  }

  async function withClient<T>(fn: (client: any) => Promise<T>): Promise<T> {
    const lease = await acquire(false)
    try {
      return await fn(lease.client)
    } finally {
      await lease.release()
    }
  }

  async function attach(lease: Awaited<ReturnType<typeof acquire>>, info: any, session: SessionConfig) {
    const live = new OpenCodeSession(lease, info, session)
    try {
      await live.initialize()
      return live
    } catch (error) {
      await live.close().catch(() => lease.release())
      throw error
    }
  }

  return {
    provider: 'opencode',
    label: 'OpenCode',
    capabilities: OPENCODE_CAPABILITIES,

    async isAvailable() {
      const bin = await binary()
      if (!bin) return false
      const probe = await runCapture(bin, ['--version'])
      return probe.code === 0 && /\bv?2\.\d+/.test(probe.stdout)
    },

    async fetchCatalog(options = {}): Promise<ProviderCatalog> {
      return withClient(async (client) => {
        const location = { directory: options.cwd ?? os.homedir() }
        await waitForLocation(client, location)
        const [models, agents, providers, fallback] = await Promise.all([
          client.model.list({ location }),
          client.agent.list({ location }),
          client.provider.list({ location }),
          client.model.default({ location }).catch(() => ({ data: null })),
        ])
        if (!(providers.data ?? []).length) throw new Error('opencode has no connected providers; run `opencode auth login`')
        const defaultId = fallback.data ? `${fallback.data.providerID}/${fallback.data.id}` : null
        return {
          models: (models.data ?? [])
            .filter((model: any) => model.enabled)
            .map((model: any) => ({
              provider: 'opencode',
              id: `${model.providerID}/${model.id}`,
              label: model.name ?? model.id,
              isDefault: `${model.providerID}/${model.id}` === defaultId,
              contextWindowMaxTokens: model.limit?.context,
              source: model.providerID,
              thinkingOptions: (model.variants ?? []).map((variant: any) => ({ id: variant.id, label: variant.id })),
            })),
          modes: (agents.data ?? [])
            .filter((agent: any) => !agent.hidden && agent.mode !== 'subagent')
            .map((agent: any) => ({ id: agent.id, label: agent.name ?? agent.id, description: agent.description })),
          defaultModeId: config.defaultMode ?? 'build',
        }
      })
    },

    async createSession(session: SessionConfig) {
      const lease = await acquire(Object.keys(session.mcpServers ?? {}).length > 0 && !session.mcp?.shared)
      try {
        const info = await lease.client.session.create({
          location: { directory: session.cwd },
          title: session.title,
          agent: session.modeId ?? config.defaultMode ?? 'build',
          ...(session.model ? { model: modelRef(session.model, session.thinkingOptionId) } : {}),
          // Native passthrough, e.g. { permissions: [{ action: 'edit', resource: '*', effect: 'ask' }] }
          ...(session.providerOptions ?? {}),
        } as any)
        return await attach(lease, info, session)
      } catch (error) {
        await lease.release()
        throw error
      }
    },

    async resumeSession(handle: PersistenceHandle, overrides: Partial<SessionConfig> = {}) {
      const session: SessionConfig = { cwd: handle.cwd, ...overrides }
      const lease = await acquire(Object.keys(session.mcpServers ?? {}).length > 0 && !session.mcp?.shared)
      try {
        const client: any = lease.client
        const info = await client.session.get({ sessionID: handle.sessionId })
        if (overrides.modeId) await client.session.switchAgent({ sessionID: info.id, agent: overrides.modeId })
        if (overrides.model) await client.session.switchModel({ sessionID: info.id, model: modelRef(overrides.model, overrides.thinkingOptionId) })
        return await attach(lease, info, session)
      } catch (error) {
        await lease.release()
        throw error
      }
    },

    async listSessions(options = {}): Promise<SessionSummary[]> {
      return withClient(async (client) => {
        const page = await client.session.list({ directory: options.cwd, search: options.query, limit: options.limit ?? 50 })
        return (page.data ?? [])
          .filter((info: any) => !info.parentID && !info.time?.archived)
          .map((info: any) => ({
            provider: 'opencode',
            sessionId: info.id,
            cwd: info.location?.directory ?? '',
            title: info.title ?? null,
            updatedAt: new Date(info.time?.updated ?? Date.now()),
          }))
      })
    },

    async shutdown() {
      const entry = shared
      shared = null
      await Promise.all([entry?.server.then((s) => s.stop()).catch(() => undefined), ...[...dedicated].map((s) => s.stop())])
      dedicated.clear()
    },
  }
}
