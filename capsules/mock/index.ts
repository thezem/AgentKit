/**
 * Mock capsule: a deterministic fake provider with every capability switched on.
 * Build and test harness UIs without spending tokens or needing any CLI.
 *
 * Prompt directives (anywhere in the text):
 *   [tool]      run a fake shell tool that needs permission
 *   [ask]       ask a structured question
 *   [fail]      end the turn with turn_failed
 *   [slow]      stream slowly (good for testing interrupt)
 * Anything else is echoed back word by word.
 */
import { randomUUID } from 'node:crypto'
import { appendTimeline } from '../shared/timeline.ts'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  AgentEvent,
  AgentMode,
  Capabilities,
  PermissionRequest,
  PermissionResponse,
  PersistenceHandle,
  PromptInput,
  ProviderClient,
  ProviderSession,
  RunResult,
  RuntimeInfo,
  SessionConfig,
  TimelineItem,
  TurnOptions,
} from '../shared/contract.ts'
import { collectRun, deferred, Emitter, nowIso, promptToText } from '../shared/runtime.ts'

export const MOCK_CAPABILITIES: Capabilities = {
  streaming: true,
  reasoningStream: true,
  toolDetail: true,
  permissions: true,
  questions: true,
  persistence: true,
  sessionListing: true,
  history: true,
  modeSwitch: true,
  modelSwitch: true,
  thinkingSwitch: true,
  fastMode: true,
  mcpServers: false,
  steer: true,
  slashCommands: true,
  images: true,
  structuredOutput: true,
  rewindConversation: true,
  rewindFiles: false,
  archive: true,
  fork: true,
  compact: true,
  systemPrompt: true,
}

const MODES: AgentMode[] = [
  { id: 'ask', label: 'Ask' },
  { id: 'auto', label: 'Auto', unattended: true },
]

export interface MockCapsuleConfig {
  /** Delay between streamed words. Default 15ms. */
  tokenDelayMs?: number
}

const MOCK_WINDOW = 200_000
const store = new Map<string, { cwd: string; title: string | null; updatedAt: Date; timeline: TimelineItem[] }>()

class MockSession implements ProviderSession {
  readonly provider = 'mock'
  readonly capabilities = MOCK_CAPABILITIES
  readonly id: string
  private readonly events = new Emitter<AgentEvent>()
  private readonly config: SessionConfig
  private readonly delayMs: number
  private turn: { id: string; abort: AbortController; done: ReturnType<typeof deferred<void>> } | null = null
  private pending = new Map<string, { request: PermissionRequest; resolve: (r: PermissionResponse) => void }>()
  private modeId: string
  private model: string | null
  private thinking: string | null
  private fast: boolean

  constructor(id: string, config: SessionConfig, delayMs: number) {
    this.id = id
    this.config = config
    this.delayMs = delayMs
    this.modeId = config.modeId ?? 'ask'
    this.model = config.model ?? 'mock-1'
    this.thinking = config.thinkingOptionId ?? null
    this.fast = config.fast ?? false
    if (!store.has(id)) store.set(id, { cwd: config.cwd, title: config.title ?? null, updatedAt: new Date(), timeline: [] })
  }

  subscribe(listener: (event: AgentEvent) => void) {
    return this.events.on(listener)
  }

  private emitItem(item: TimelineItem, turnId: string) {
    store.get(this.id)!.timeline.push(item)
    this.events.emit({ type: 'timeline', provider: 'mock', item, turnId, timestamp: nowIso() })
  }

  async startTurn(prompt: PromptInput, options?: TurnOptions) {
    if (this.turn) throw new Error('mock session already has an active turn')
    const turn = { id: randomUUID(), abort: new AbortController(), done: deferred<void>() }
    this.turn = turn
    this.events.emit({ type: 'turn_started', provider: 'mock', turnId: turn.id })
    void this.play(promptToText(prompt), turn, options).finally(() => turn.done.resolve())
    return { turnId: turn.id }
  }

  private async play(text: string, turn: NonNullable<MockSession['turn']>, options?: TurnOptions) {
    const signal = turn.abort.signal
    const end = (event: AgentEvent) => {
      if (this.turn !== turn) return
      this.turn = null
      this.events.emit(event)
    }
    try {
      this.emitItem({ type: 'user_message', text, messageId: randomUUID(), clientMessageId: options?.clientMessageId }, turn.id)
      this.emitItem({ type: 'reasoning', text: `Thinking about "${text.slice(0, 40)}"` }, turn.id)
      if (text.includes('[tool]')) {
        const callId = randomUUID()
        const detail = { type: 'shell' as const, command: 'echo hello', cwd: this.config.cwd }
        this.emitItem({ type: 'tool_call', callId, name: 'shell', status: 'running', detail }, turn.id)
        const answer = this.modeId === 'auto' ? { behavior: 'allow' as const } : await this.ask({ id: callId, provider: 'mock', kind: 'tool', name: 'shell', title: 'Run: echo hello', detail, actions: [{ id: 'once', label: 'Allow', behavior: 'allow' }, { id: 'deny', label: 'Deny', behavior: 'deny' }] }, turn.id, signal)
        this.emitItem(
          answer.behavior === 'allow'
            ? { type: 'tool_call', callId, name: 'shell', status: 'completed', detail: { ...detail, output: 'hello\n', exitCode: 0 } }
            : { type: 'tool_call', callId, name: 'shell', status: 'failed', detail, error: 'denied by user' },
          turn.id,
        )
      }
      if (text.includes('[ask]')) {
        const answer = await this.ask({ id: randomUUID(), provider: 'mock', kind: 'question', name: 'question', questions: [{ id: 'color', question: 'Pick a color', options: [{ label: 'red' }, { label: 'blue' }] }] }, turn.id, signal)
        const color = answer.behavior === 'allow' ? String(answer.answers?.color ?? 'none') : 'none'
        this.emitItem({ type: 'assistant_message', text: `You picked ${color}. `, messageId: turn.id }, turn.id)
      }
      if (text.includes('[fail]')) {
        end({ type: 'turn_failed', provider: 'mock', turnId: turn.id, error: 'mock failure requested' })
        return
      }
      const reply = options?.outputSchema !== undefined ? JSON.stringify({ ok: true }) : `echo: ${text.replace(/<skill-invoked name="([^"]*)"[^>]*>[\s\S]*?<\/skill-invoked>/g, '$$$1').replace(/\[(tool|ask|slow)\]/g, '').trim()}`
      const wait = text.includes('[slow]') ? 250 : this.fast ? Math.max(1, this.delayMs / 3) : this.delayMs
      for (const word of reply.split(/(?<= )/)) {
        await delay(wait, undefined, { signal })
        this.emitItem({ type: 'assistant_message', text: word, messageId: turn.id }, turn.id)
      }
      store.get(this.id)!.updatedAt = new Date()
      this.used += text.length + reply.length
      end({ type: 'turn_completed', provider: 'mock', turnId: turn.id, usage: { inputTokens: text.length, outputTokens: reply.length, totalCostUsd: 0, contextWindowUsedTokens: this.used, contextWindowMaxTokens: MOCK_WINDOW } })
    } catch {
      end({ type: 'turn_canceled', provider: 'mock', turnId: turn.id, reason: 'interrupted' })
    }
  }

  private ask(request: PermissionRequest, turnId: string, signal: AbortSignal): Promise<PermissionResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { request, resolve })
      signal.addEventListener('abort', () => {
        this.pending.delete(request.id)
        reject(new Error('aborted'))
      })
      this.events.emit({ type: 'permission_requested', provider: 'mock', request, turnId })
    })
  }

  run(prompt: PromptInput, options?: TurnOptions): Promise<RunResult> {
    return collectRun({ provider: 'mock', prompt, options, startTurn: (p, o) => this.startTurn(p, o), subscribe: (l) => this.subscribe(l), interrupt: () => this.interrupt(), sessionId: () => this.id })
  }

  async steer(prompt: PromptInput, options: { expectedTurnId: string }) {
    if (this.turn?.id !== options.expectedTurnId) return { accepted: false }
    this.emitItem({ type: 'user_message', text: promptToText(prompt), messageId: randomUUID() }, this.turn.id)
    return { accepted: true }
  }

  async interrupt() {
    const turn = this.turn
    if (!turn) return
    turn.abort.abort()
    await turn.done.promise
  }

  getPendingPermissions() {
    return [...this.pending.values()].map((p) => p.request)
  }
  async respondToPermission(requestId: string, response: PermissionResponse) {
    const entry = this.pending.get(requestId)
    if (!entry) throw new Error(`no pending mock permission ${requestId}`)
    this.pending.delete(requestId)
    this.events.emit({ type: 'permission_resolved', provider: 'mock', requestId, response })
    entry.resolve(response)
  }
  async getRuntimeInfo(): Promise<RuntimeInfo> {
    return { provider: 'mock', sessionId: this.id, model: this.model, modeId: this.modeId, thinkingOptionId: this.thinking, fast: this.fast }
  }
  async getModes() {
    return MODES
  }
  async setMode(modeId: string) {
    this.modeId = modeId
    this.events.emit({ type: 'mode_changed', provider: 'mock', modeId })
  }
  async setModel(model: string | null) {
    this.model = model
    this.events.emit({ type: 'model_changed', provider: 'mock', model })
  }
  async setThinking(id: string | null) {
    this.thinking = id
    this.events.emit({ type: 'thinking_changed', provider: 'mock', thinkingOptionId: id })
  }
  async setFast(enabled: boolean) {
    this.fast = enabled
    this.events.emit({ type: 'fast_changed', provider: 'mock', enabled })
  }
  async listCommands() {
    return [{ name: 'compact', description: 'Pretend to compact', kind: 'command' as const }]
  }
  describePersistence(): PersistenceHandle {
    return { provider: 'mock', sessionId: this.id, cwd: this.config.cwd }
  }
  /** Contract: history yields whole items, so merge the stored deltas. */
  async *history() {
    const whole: TimelineItem[] = []
    for (const item of store.get(this.id)?.timeline ?? []) appendTimeline(whole, item)
    yield* whole
  }
  async rewind(input: { messageId: string; scope: 'conversation' | 'files' | 'both' }) {
    const entry = store.get(this.id)!
    const index = entry.timeline.findIndex((item) => item.type === 'user_message' && item.messageId === input.messageId)
    if (index < 0) throw new Error('message not found')
    entry.timeline.splice(index)
  }
  private used = 0
  async contextWindow() {
    return { usedTokens: this.used, maxTokens: MOCK_WINDOW }
  }
  async fork(input: { beforeMessageId?: string }) {
    const entry = store.get(this.id)!
    let timeline = entry.timeline.slice()
    if (input.beforeMessageId) {
      const index = timeline.findIndex((item) => item.type === 'user_message' && item.messageId === input.beforeMessageId)
      if (index < 0) throw new Error('message not found')
      if (index === 0) throw new Error('nothing before the first message to fork; open a new session instead')
      timeline = timeline.slice(0, index)
    }
    const id = randomUUID()
    store.set(id, { ...entry, timeline: structuredClone(timeline), updatedAt: new Date() })
    return { provider: 'mock', sessionId: id, cwd: this.config.cwd }
  }
  async compact(input: { instructions?: string }) {
    const entry = store.get(this.id)!
    // Keep the user's words (that's what a summary must preserve), drop everything else.
    const kept = entry.timeline.filter((item) => item.type === 'user_message')
    entry.timeline = [{ type: 'notice', level: 'info', message: `compacted${input.instructions ? `: ${input.instructions}` : ''}` }, ...kept]
    this.events.emit({ type: 'timeline', provider: 'mock', item: { type: 'compaction', status: 'completed' }, timestamp: new Date().toISOString() })
  }
  async close() {
    await this.interrupt()
    this.events.clear()
  }
}

export function createMockClient(config: MockCapsuleConfig = {}): ProviderClient {
  const delayMs = config.tokenDelayMs ?? 15
  return {
    provider: 'mock',
    label: 'Mock',
    capabilities: MOCK_CAPABILITIES,
    async isAvailable() {
      return true
    },
    async fetchCatalog() {
      return {
        models: [
          { provider: 'mock', id: 'mock-1', label: 'Mock 1', isDefault: true, contextWindowMaxTokens: MOCK_WINDOW, supportsFastMode: true, fastModeDescription: '3x faster streaming', thinkingOptions: [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }] },
          { provider: 'mock', id: 'mock-2', label: 'Mock 2' },
        ],
        modes: MODES,
        defaultModeId: 'ask',
      }
    },
    async createSession(session: SessionConfig) {
      return new MockSession(randomUUID(), session, delayMs)
    },
    async resumeSession(handle: PersistenceHandle, overrides = {}) {
      // Mock memory is per-process: a handle from a dead process resumes as an empty conversation.
      return new MockSession(handle.sessionId, { cwd: handle.cwd, ...overrides }, delayMs)
    },
    async listSessions(options = {}) {
      return [...store.entries()]
        .filter(([, s]) => !options.cwd || s.cwd === options.cwd)
        .map(([sessionId, s]) => ({ provider: 'mock', sessionId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt }))
    },
    async archiveSession(handle: PersistenceHandle) {
      store.delete(handle.sessionId)
    },
    async shutdown() {},
  }
}
