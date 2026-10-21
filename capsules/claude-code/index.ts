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
import type { CompleteOptions, CompleteResult, PersistenceHandle, PlanUsage, ProviderCatalog, ProviderClient, SessionConfig, SessionSummary, TranscribeAudio, TranscribeOptions, TranscribeResult, TranscribeStreamOptions, TranscriptionStream, UsageWindow } from '../shared/contract.ts'
import { usageFromResult } from './internals/mapping.ts'
import { findBinary, runCapture } from '../shared/runtime.ts'
import { openVoiceStream, transcribeOnce, type VoiceConfig } from './internals/voice.ts'
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
  /**
   * Claude Code flag settings, read each time a query starts (this run only; its settings files are never written).
   * E.g. `{ modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 400000 } } }`.
   */
  flagSettings?: () => Record<string, unknown> | undefined
  /** Dictation (`transcribe` / `transcribeStream`): endpoint and sign-in location overrides. Defaults match Claude Code. */
  voice?: VoiceConfig
}

export { CLAUDE_CAPABILITIES, CLAUDE_MODES }
export type { ClaudeSession }

export function createClaudeCodeClient(config: ClaudeCodeCapsuleConfig = {}): ProviderClient {
  let binaryPromise: Promise<string | null> | null = null
  const binary = () => (binaryPromise ??= config.binary === false ? Promise.resolve(null) : findBinary('claude', config.binary || undefined))
  const sessions = new Set<ClaudeSession>()

  const runtime = async () => ({ binary: await binary(), settingSources: config.settingSources, extraOptions: config.sdkOptions, steerPriority: config.steerPriority, flagSettings: config.flagSettings })

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
            ...(model.resolvedModel ? { metadata: { resolvedModel: model.resolvedModel } } : {}),
            ...(model.supportsFastMode ? { fastModeDescription: 'Faster output, higher cost' } : {}),
          })),
          modes: CLAUDE_MODES,
          defaultModeId: DEFAULT_CLAUDE_MODE,
        }
      } finally {
        q.close()
      }
    },

    /** Plan windows from the SDK's usage call (the one behind `/usage`). Marked experimental upstream, so normalized here. */
    async planUsage(): Promise<PlanUsage> {
      const bin = await binary()
      const idle: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
      const q = query({ prompt: idle, options: { cwd: process.cwd(), ...(bin ? { pathToClaudeCodeExecutable: bin } : {}), settingSources: [] } })
      try {
        const raw: any = await (q as any).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
        return claudePlanUsage(raw)
      } finally {
        q.close()
      }
    },

    /** Tool-less one-shot: no built-in tools, no MCP, no settings files, nothing written to disk. */
    async transcribe(audio: TranscribeAudio, options?: TranscribeOptions): Promise<TranscribeResult> {
      return transcribeOnce(config.voice ?? {}, binary, audio, options)
    },

    transcribeStream(options?: TranscribeStreamOptions): TranscriptionStream {
      return openVoiceStream(config.voice ?? {}, binary, options)
    },

    async complete(prompt: string, options: CompleteOptions = {}): Promise<CompleteResult> {
      const bin = await binary()
      const abort = new AbortController()
      options.signal?.addEventListener('abort', () => abort.abort(options.signal!.reason), { once: true })
      const q = query({
        prompt,
        options: {
          cwd: options.cwd ?? process.cwd(),
          abortController: abort,
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          persistSession: false,
          maxTurns: 1,
          ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.thinkingOptionId ? { effort: options.thinkingOptionId as Options['effort'] } : {}),
          ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        },
      })
      try {
        for await (const message of q) {
          if (message.type !== 'result') continue
          const m: any = message
          if (m.subtype !== 'success') throw new Error(`claude complete failed: ${m.subtype}${m.errors ? ` ${JSON.stringify(m.errors).slice(0, 300)}` : ''}`)
          return { text: m.result ?? '', usage: usageFromResult(m), model: Object.keys(m.modelUsage ?? {})[0] }
        }
        throw new Error('claude complete ended without a result')
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

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_oauth_apps: 'Weekly (apps)',
}
const WINDOW_MINUTES: Record<string, number> = { five_hour: 300 }

export function claudePlanUsage(raw: any): PlanUsage {
  const limits = (raw?.rate_limits ?? {}) as Record<string, any>
  // Only real windows: plain objects carrying utilization + resets_at. The payload also has spend,
  // credits, breakdowns and opaque keys; those stay in `raw`.
  const windows: UsageWindow[] = Object.entries(limits)
    .filter(([, w]) => w && typeof w === 'object' && !Array.isArray(w) && 'utilization' in w && 'resets_at' in w)
    .map(([id, w]) => ({
      id,
      label: WINDOW_LABELS[id] ?? id,
      usedPercent: typeof w.utilization === 'number' ? w.utilization : null,
      resetsAt: w.resets_at ?? null,
      windowMinutes: WINDOW_MINUTES[id] ?? (id.startsWith('seven_day') ? 7 * 24 * 60 : null),
    }))
  for (const m of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    if (!m?.display_name) continue
    windows.push({ id: `model:${m.display_name}`, label: `Weekly (${m.display_name})`, usedPercent: typeof m.utilization === 'number' ? m.utilization : null, resetsAt: m.resets_at ?? null, windowMinutes: 7 * 24 * 60 })
  }
  return { provider: 'claude', plan: raw?.subscription_type ?? null, available: raw?.rate_limits_available === true, windows, raw }
}
