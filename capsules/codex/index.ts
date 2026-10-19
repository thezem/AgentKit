/**
 * Codex capsule: drives the locally signed-in `codex` CLI through `codex app-server`
 * (JSON-RPC over stdio). No API key; uses whatever `codex login` stored.
 *
 *   import { createCodexClient } from './capsules/codex/index.ts'
 *   const codex = createCodexClient()
 *   const session = await codex.createSession({ cwd: process.cwd() })
 *   const result = await session.run('hello')
 */
import type {
  AgentModel,
  PersistenceHandle,
  ProviderCatalog,
  ProviderClient,
  ProviderSession,
  SessionConfig,
  SessionSummary,
} from '../shared/contract.ts'
import { findBinary, runCapture } from '../shared/runtime.ts'
import { CodexRpc } from './internals/rpc.ts'
import { CODEX_CAPABILITIES, CODEX_MODES, CodexSession, DEFAULT_CODEX_MODE, threadParams } from './internals/session.ts'

export interface CodexCapsuleConfig {
  /** Path to the codex binary. Default: `codex` on PATH. */
  binary?: string
  /** Extra args before `app-server`, e.g. ['-c', 'model_reasoning_summary=detailed']. */
  args?: string[]
  /** Extra env for the app-server (e.g. CODEX_HOME). */
  env?: Record<string, string>
  /** Per-request timeout for JSON-RPC calls. Default 120s. */
  requestTimeoutMs?: number
}

export { CODEX_CAPABILITIES, CODEX_MODES }
export type { CodexSession }

function fastInfo(tiers: Array<{ id: string; name: string; description?: string }> | undefined) {
  const fast = tiers?.find((tier) => tier.name.toLowerCase() === 'fast' || tier.id === 'fast')
  return fast ? { supportsFastMode: true, fastModeDescription: fast.description } : { supportsFastMode: false }
}

export function createCodexClient(config: CodexCapsuleConfig = {}): ProviderClient {
  let binaryPromise: Promise<string | null> | null = null
  const binary = () => (binaryPromise ??= findBinary('codex', config.binary))
  const live = new Set<CodexRpc>()

  async function connect(cwd: string, env?: Record<string, string>): Promise<CodexRpc> {
    const bin = await binary()
    if (!bin) throw new Error('codex CLI not found on PATH (npm i -g @openai/codex, then `codex login`)')
    const rpc = new CodexRpc(bin, config.args ?? [], { cwd, env: { ...config.env, ...env } })
    live.add(rpc)
    void rpc.exited.then(() => live.delete(rpc))
    await rpc.request('initialize', {
      clientInfo: { name: 'agentkit', title: 'AgentKit', version: '0.2.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    rpc.notify('initialized', {})
    return rpc
  }

  async function withRpc<T>(cwd: string, fn: (rpc: CodexRpc) => Promise<T>): Promise<T> {
    const rpc = await connect(cwd)
    try {
      return await fn(rpc)
    } finally {
      await rpc.dispose()
    }
  }

  return {
    provider: 'codex',
    label: 'Codex',
    capabilities: CODEX_CAPABILITIES,

    async isAvailable() {
      const bin = await binary()
      if (!bin) return false
      const probe = await runCapture(bin, ['--version'])
      return probe.code === 0
    },

    async fetchCatalog(options = {}): Promise<ProviderCatalog> {
      return withRpc(options.cwd ?? process.cwd(), async (rpc) => {
        const response = await rpc.request('model/list', {})
        const models: AgentModel[] = (response.data ?? [])
          .filter((model: any) => !model.hidden)
          .map((model: any) => ({
            provider: 'codex',
            id: model.model ?? model.id,
            label: model.displayName ?? model.id,
            description: model.description,
            isDefault: model.isDefault,
            defaultThinkingOptionId: model.defaultReasoningEffort ?? undefined,
            ...fastInfo(model.serviceTiers),
            thinkingOptions: (model.supportedReasoningEfforts ?? []).map((option: any) => ({
              id: option.reasoningEffort,
              label: option.reasoningEffort,
              description: option.description,
              isDefault: option.reasoningEffort === model.defaultReasoningEffort,
            })),
          }))
        return { models, modes: CODEX_MODES, defaultModeId: DEFAULT_CODEX_MODE }
      })
    },

    async createSession(session: SessionConfig): Promise<ProviderSession> {
      const modeId = session.modeId ?? DEFAULT_CODEX_MODE
      const rpc = await connect(session.cwd, session.env)
      try {
        const started = await rpc.request('thread/start', threadParams(session, modeId))
        return new CodexSession(rpc, started.thread.id, session, {
          modeId,
          model: session.model ?? started.model ?? null,
          effort: session.thinkingOptionId ?? started.reasoningEffort ?? null,
          fast: session.fast,
        })
      } catch (error) {
        await rpc.dispose()
        throw error
      }
    },

    async resumeSession(handle: PersistenceHandle, overrides: Partial<SessionConfig> = {}): Promise<ProviderSession> {
      const meta = (handle.metadata ?? {}) as { modeId?: string; model?: string; effort?: string; fast?: boolean }
      const session: SessionConfig = { cwd: handle.cwd, ...overrides }
      const modeId = overrides.modeId ?? meta.modeId ?? DEFAULT_CODEX_MODE
      const rpc = await connect(session.cwd, session.env)
      try {
        const resumed = await rpc.request('thread/resume', {
          threadId: handle.sessionId,
          excludeTurns: true,
          ...threadParams({ ...session, model: overrides.model ?? meta.model }, modeId),
        })
        return new CodexSession(rpc, resumed.thread.id, session, {
          modeId,
          model: overrides.model ?? resumed.model ?? meta.model ?? null,
          effort: overrides.thinkingOptionId ?? meta.effort ?? resumed.reasoningEffort ?? null,
          fast: overrides.fast ?? meta.fast,
        })
      } catch (error) {
        await rpc.dispose()
        throw error
      }
    },

    async listSessions(options = {}): Promise<SessionSummary[]> {
      return withRpc(options.cwd ?? process.cwd(), async (rpc) => {
        const response = await rpc.request('thread/list', {
          limit: options.limit ?? 50,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.query ? { searchTerm: options.query } : {}),
        })
        return (response.data ?? []).map((thread: any) => ({
          provider: 'codex',
          sessionId: thread.id,
          cwd: thread.cwd,
          title: thread.name ?? thread.preview ?? null,
          updatedAt: new Date((thread.updatedAt ?? thread.createdAt) * 1000),
        }))
      })
    },

    async archiveSession(handle: PersistenceHandle): Promise<void> {
      await withRpc(handle.cwd, (rpc) => rpc.request('thread/archive', { threadId: handle.sessionId }))
    },

    async shutdown() {
      await Promise.all([...live].map((rpc) => rpc.dispose()))
      live.clear()
    },
  }
}
