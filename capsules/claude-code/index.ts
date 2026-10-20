/**
 * Claude Code capsule: drives the locally signed-in Claude Code through
 * `@anthropic-ai/claude-agent-sdk`. Uses your `claude` login (no API key needed),
 * your ~/.claude settings, CLAUDE.md files, skills and hooks.
 *
 *   import { createClaudeCodeClient } from './capsules/claude-code/index.ts'
 *   const claude = createClaudeCodeClient()
 *   const session = await claude.createSession({ cwd: process.cwd() })
 *   const result = await session.run('hello')
 */
import { listSessions, query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PersistenceHandle, ProviderCatalog, ProviderClient, SessionConfig, SessionSummary } from '../shared/contract.ts'
import { findBinary, runCapture } from '../shared/runtime.ts'
import { CLAUDE_CAPABILITIES, CLAUDE_MODES, ClaudeSession, DEFAULT_CLAUDE_MODE, knownContextWindow } from './internals/session.ts'

export interface ClaudeCodeCapsuleConfig {
  /**
   * Claude Code executable. Default: the `claude` on PATH (your installed, signed-in CLI).
   * Pass `false` to use the CLI bundled inside the SDK instead.
   */
  binary?: string | false
  /** Which settings files Claude loads. Default: user + project + local, like the CLI. */
  settingSources?: Options['settingSources']
  /** Raw SDK options merged into every query. The escape hatch. */
  sdkOptions?: Partial<Options>
  /**
   * How `steer()` delivers into a running turn. Default `'next'`: Claude finishes the current step
   * (a running tool keeps going) and picks the message up at the next safe point.
   * `'now'` cuts the running step short.
   */
  steerPriority?: 'now' | 'next'
}

export { CLAUDE_CAPABILITIES, CLAUDE_MODES }
export type { ClaudeSession }

export function createClaudeCodeClient(config: ClaudeCodeCapsuleConfig = {}): ProviderClient {
  let binaryPromise: Promise<string | null> | null = null
  const binary = () => (binaryPromise ??= config.binary === false ? Promise.resolve(null) : findBinary('claude', config.binary || undefined))
  const sessions = new Set<ClaudeSession>()

  const runtime = async () => ({ binary: await binary(), settingSources: config.settingSources, extraOptions: config.sdkOptions, steerPriority: config.steerPriority })

  const track = (session: ClaudeSession) => {
    sessions.add(session)
    const close = session.close.bind(session)
    session.close = async () => {
      sessions.delete(session)
      await close()
    }
    return session
  }

  return {
    provider: 'claude',
    label: 'Claude Code',
    capabilities: CLAUDE_CAPABILITIES,

    async isAvailable() {
      if (config.binary === false) return true
      const bin = await binary()
      if (!bin) return false
      return (await runCapture(bin, ['--version'])).code === 0
    },

    /** Spins up a short-lived query just to ask Claude Code which models this account can use. */
    async fetchCatalog(options = {}): Promise<ProviderCatalog> {
      const bin = await binary()
      const idle: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
      const q = query({
        prompt: idle,
        options: { cwd: options.cwd ?? process.cwd(), ...(bin ? { pathToClaudeCodeExecutable: bin } : {}), settingSources: config.settingSources ?? ['user', 'project', 'local'] },
      })
      try {
        const models = await q.supportedModels()
        return {
          models: models.map((model: any, index: number) => ({
            provider: 'claude',
            id: model.value,
            label: model.displayName ?? model.value,
            description: model.description,
            isDefault: model.value === 'default' || index === 0,
            thinkingOptions: (model.supportedEffortLevels ?? []).map((level: string) => ({ id: level, label: level })),
            supportsFastMode: model.supportsFastMode === true,
            contextWindowMaxTokens: knownContextWindow(model.value),
            ...(model.supportsFastMode ? { fastModeDescription: 'Faster output, higher cost' } : {}),
          })),
          modes: CLAUDE_MODES,
          defaultModeId: DEFAULT_CLAUDE_MODE,
        }
      } finally {
        q.close()
      }
    },

    async createSession(session: SessionConfig) {
      return track(new ClaudeSession(session, await runtime()))
    },

    async resumeSession(handle: PersistenceHandle, overrides: Partial<SessionConfig> = {}) {
      const meta = (handle.metadata ?? {}) as { modeId?: string; model?: string; effort?: string; fast?: boolean }
      const session: SessionConfig = {
        cwd: handle.cwd,
        modeId: meta.modeId,
        model: meta.model ?? undefined,
        thinkingOptionId: meta.effort ?? undefined,
        fast: meta.fast,
        ...overrides,
      }
      return track(new ClaudeSession(session, await runtime(), { sessionId: handle.sessionId }))
    },

    async listSessions(options = {}): Promise<SessionSummary[]> {
      const found = await listSessions({ dir: options.cwd, limit: options.limit ?? 50 })
      const needle = options.query?.toLowerCase()
      return found
        .filter((info) => !needle || `${info.customTitle ?? ''} ${info.summary} ${info.firstPrompt ?? ''}`.toLowerCase().includes(needle))
        .map((info) => ({
          provider: 'claude',
          sessionId: info.sessionId,
          cwd: info.cwd ?? options.cwd ?? '',
          title: info.customTitle ?? info.summary ?? info.firstPrompt ?? null,
          updatedAt: new Date(info.lastModified),
        }))
    },

    async shutdown() {
      await Promise.all([...sessions].map((session) => session.close()))
    },
  }
}
