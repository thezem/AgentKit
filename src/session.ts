import type {
  AgentEvent,
  AgentMode,
  Capabilities,
  CapabilityName,
  PermissionRequest,
  PermissionResponse,
  PersistenceHandle,
  PromptInput,
  ProviderId,
  ProviderSession,
  RunResult,
  RuntimeInfo,
  SlashCommand,
  TimelineItem,
  TurnOptions,
} from '../capsules/shared/contract.ts'
import { Emitter } from '../capsules/shared/runtime.ts'
import { AgentKitError, UnsupportedCapabilityError } from './errors.ts'
import { modeForAccess, normalizeDecision, type AccessLevel, type PermissionHandler } from './policy.ts'
import { emptyTranscript, reduceTranscript, type Transcript } from './transcript.ts'

export interface SessionHandlers {
  /** Auto-answer permission requests. Return undefined to leave one pending for your UI. */
  onPermission?: PermissionHandler
  onEvent?: (event: AgentEvent) => void
}

/**
 * The one session type harness builders use. Wraps a capsule session with:
 * capability guards, permission policies, a prompt queue, a live transcript,
 * and an async event iterator. Same API for every provider.
 */
export class AgentSession {
  readonly provider: ProviderId
  readonly capabilities: Capabilities
  private readonly inner: ProviderSession
  private readonly events = new Emitter<AgentEvent>()
  private readonly queue: Array<{ prompt: PromptInput; options?: TurnOptions; resolve: (r: RunResult) => void; reject: (e: unknown) => void }> = []
  private state: Transcript = emptyTranscript()
  private draining = false
  private closed = false
  private handlers: SessionHandlers
  private readonly onClose: () => void

  constructor(inner: ProviderSession, handlers: SessionHandlers, onClose: () => void) {
    this.inner = inner
    this.provider = inner.provider
    this.capabilities = inner.capabilities
    this.handlers = handlers
    this.onClose = onClose
    this.state = { ...this.state, sessionId: inner.id }
    inner.subscribe((event) => this.onInnerEvent(event))
  }

  /** Native session id (Claude session, Codex thread, OpenCode session). Can change after rewind. */
  get id(): string | null {
    return this.inner.id
  }
  /** Live UI projection: items, status, pending permissions, usage. */
  get transcript(): Transcript {
    return this.state
  }
  get isRunning(): boolean {
    return this.state.activeTurnId !== null
  }
  get activeTurnId(): string | null {
    return this.state.activeTurnId
  }
  /** Raw capsule session. The escape hatch for provider-native extras. */
  get native(): ProviderSession {
    return this.inner
  }

  private onInnerEvent(event: AgentEvent): void {
    this.state = reduceTranscript(this.state, event)
    if (event.type === 'permission_requested' && this.handlers.onPermission) void this.autoAnswer(event.request)
    this.handlers.onEvent?.(event)
    this.events.emit(event)
  }

  private async autoAnswer(request: PermissionRequest): Promise<void> {
    try {
      const response = normalizeDecision(await this.handlers.onPermission!(request))
      if (response && this.inner.getPendingPermissions().some((p) => p.id === request.id)) await this.inner.respondToPermission(request.id, response)
    } catch {}
  }

  setHandlers(handlers: SessionHandlers): void {
    this.handlers = handlers
  }

  // ---------------------------------------------------------- events

  /** Subscribe to every event. Returns an unsubscribe function. */
  on(listener: (event: AgentEvent) => void): () => void {
    return this.events.on(listener)
  }

  /** Async-iterate events until `signal` aborts or the session closes. */
  async *stream(signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const buffer: AgentEvent[] = []
    let wake: (() => void) | null = null
    const off = this.on((event) => {
      buffer.push(event)
      wake?.()
    })
    const onAbort = () => wake?.()
    signal?.addEventListener('abort', onAbort)
    try {
      while (!signal?.aborted && !this.closed) {
        if (buffer.length) {
          yield buffer.shift()!
          continue
        }
        await new Promise<void>((resolve) => (wake = resolve))
        wake = null
      }
    } finally {
      off()
      signal?.removeEventListener('abort', onAbort)
    }
  }

  // ---------------------------------------------------------- turns

  private guard(capability: CapabilityName, detail?: string): void {
    if (this.closed) throw new AgentKitError('SESSION_CLOSED', 'session is closed', { provider: this.provider })
    if (!this.capabilities[capability]) throw new UnsupportedCapabilityError(this.provider, capability, detail)
  }

  private checkTurnOptions(prompt: PromptInput, options?: TurnOptions): void {
    if (this.closed) throw new AgentKitError('SESSION_CLOSED', 'session is closed', { provider: this.provider })
    if (options?.outputSchema !== undefined) this.guard('structuredOutput')
    if (typeof prompt !== 'string' && prompt.some((block) => block.type === 'image')) this.guard('images')
  }

  /** Run one turn to completion. Throws SESSION_BUSY if a turn is active; use `send` to queue. */
  async run(prompt: PromptInput, options?: TurnOptions): Promise<RunResult> {
    this.checkTurnOptions(prompt, options)
    if (this.isRunning || this.draining) throw new AgentKitError('SESSION_BUSY', 'a turn is already running; use send() to queue or steer() to inject', { provider: this.provider })
    return this.inner.run(prompt, options)
  }

  /** Start a turn and return immediately. Follow progress through `on()` / `stream()` / `transcript`. */
  async start(prompt: PromptInput, options?: TurnOptions): Promise<{ turnId: string }> {
    this.checkTurnOptions(prompt, options)
    if (this.isRunning) throw new AgentKitError('SESSION_BUSY', 'a turn is already running', { provider: this.provider })
    return this.inner.startTurn(prompt, options)
  }

  /** Queue a prompt: runs now if idle, otherwise after the current/queued turns finish. */
  send(prompt: PromptInput, options?: TurnOptions): Promise<RunResult> {
    this.checkTurnOptions(prompt, options)
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, options, resolve, reject })
      void this.drain()
    })
  }

  get queued(): number {
    return this.queue.length
  }

  clearQueue(): void {
    for (const entry of this.queue.splice(0)) entry.reject(new AgentKitError('SESSION_CLOSED', 'queue cleared', { provider: this.provider }))
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length && !this.closed) {
        if (this.isRunning) await new Promise<void>((resolve) => {
          const off = this.on((event) => {
            if (event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_canceled') {
              off()
              resolve()
            }
          })
        })
        const next = this.queue.shift()!
        try {
          next.resolve(await this.inner.run(next.prompt, next.options))
        } catch (error) {
          next.reject(error)
        }
      }
    } finally {
      this.draining = false
    }
  }

  /**
   * Inject input into the running turn. Falls back to queueing when the
   * provider cannot steer or no turn is active.
   */
  async steer(prompt: PromptInput): Promise<{ steered: boolean }> {
    const turnId = this.activeTurnId
    if (turnId && this.capabilities.steer && this.inner.steer) {
      const { accepted } = await this.inner.steer(prompt, { expectedTurnId: turnId })
      if (accepted) return { steered: true }
    }
    void this.send(prompt).catch(() => undefined)
    return { steered: false }
  }

  async interrupt(): Promise<void> {
    await this.inner.interrupt()
  }

  // ---------------------------------------------------------- permissions

  get pendingPermissions(): PermissionRequest[] {
    return this.inner.getPendingPermissions()
  }

  async respond(requestId: string, response: PermissionResponse | 'allow' | 'deny'): Promise<void> {
    await this.inner.respondToPermission(requestId, normalizeDecision(response)!)
  }

  // ---------------------------------------------------------- controls

  info(): Promise<RuntimeInfo> {
    return this.inner.getRuntimeInfo()
  }
  modes(): Promise<AgentMode[]> {
    return this.inner.getModes()
  }
  async setMode(modeId: string): Promise<void> {
    this.guard('modeSwitch')
    await this.inner.setMode(modeId)
  }
  /** Switch by provider-neutral access level instead of native mode id. */
  async setAccess(level: AccessLevel): Promise<void> {
    const mode = modeForAccess(this.provider, level)
    if (!mode) throw new UnsupportedCapabilityError(this.provider, 'modeSwitch', `no mode for access level ${level}`)
    await this.setMode(mode)
  }
  async setModel(model: string | null): Promise<void> {
    this.guard('modelSwitch')
    await this.inner.setModel!(model)
  }
  async setThinking(optionId: string | null): Promise<void> {
    this.guard('thinkingSwitch')
    await this.inner.setThinking!(optionId)
  }
  async commands(): Promise<SlashCommand[]> {
    if (!this.capabilities.slashCommands || !this.inner.listCommands) return []
    return this.inner.listCommands()
  }
  async history(): Promise<TimelineItem[]> {
    this.guard('history')
    const items: TimelineItem[] = []
    for await (const item of this.inner.history!()) items.push(item)
    return items
  }
  /** Rewind to just before `messageId` (a user_message id). */
  async rewind(messageId: string, scope: 'conversation' | 'files' | 'both' = 'conversation'): Promise<void> {
    if (scope !== 'files') this.guard('rewindConversation')
    if (scope !== 'conversation') this.guard('rewindFiles')
    await this.inner.rewind!({ messageId, scope })
    const index = this.state.items.findIndex((item) => item.type === 'user_message' && item.messageId === messageId)
    if (index >= 0 && scope !== 'files') this.state = { ...this.state, items: this.state.items.slice(0, index), sessionId: this.inner.id }
  }

  /** Durable, JSON-serializable handle. Pass to `kit.resume()` in another process. */
  get handle(): PersistenceHandle | null {
    return this.inner.describePersistence()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.clearQueue()
    this.closed = true
    await this.inner.close()
    this.events.clear()
    this.onClose()
  }
}
