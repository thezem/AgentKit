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
  InboxEntry,
  ContextWindow,
} from '../capsules/shared/contract.ts'
import { isTerminalEvent } from '../capsules/shared/contract.ts'
import { deferred, Emitter } from '../capsules/shared/runtime.ts'
import { randomUUID } from 'node:crypto'
import { expandSkillPrompt, type Skill } from './skills.ts'
import { modeForAccess as planModeFor } from './policy.ts'
import { TERMINAL_SUBMISSION, type AgentStore, type SubmissionRecord, type SubmissionStatus } from './store.ts'
import { AgentKitError, UnsupportedCapabilityError } from './errors.ts'
import { modeForAccess, normalizeDecision, type AccessLevel, type PermissionHandler } from './policy.ts'
import { emptyTranscript, reduceTranscript, type Transcript } from './transcript.ts'

export interface SessionHandlers {
  /** Auto-answer permission requests. Return undefined to leave one pending for your UI. */
  onPermission?: PermissionHandler
  onEvent?: (event: AgentEvent) => void
}

export interface SubmitOptions extends TurnOptions {
  /**
   * Idempotency key. Submitting the same id again (same process or after a restart,
   * with a store) returns the original submission instead of running a second turn.
   */
  requestId?: string
  /** What to do when a turn is already running. Default 'queue'. */
  whenBusy?: 'queue' | 'steer' | 'reject'
  /**
   * `$name` tokens that match an installed skill are invoked (your app writes `$name`
   * when the user picks a skill). Default true: path reference, inlined in plan mode.
   * `false` sends the text untouched.
   */
  skills?: boolean | 'reference' | 'inline'
}

/** One prompt's journey: queued → running/steered → outcome. */
export interface Submission {
  readonly id: string
  readonly status: SubmissionStatus
  record(): SubmissionRecord
  /** The turn's result. Withdrawn / interrupted resolve as `canceled`. */
  readonly result: Promise<RunResult>
  /** Resolves with the final record once the submission is terminal. */
  wait(): Promise<SubmissionRecord>
  /** Pull it out of the inbox before it starts. False once running. */
  withdraw(): boolean
}

/** Wiring the kit hands each session. */
export interface SessionContext {
  key: string
  store: AgentStore | null
  registry: Map<string, Submission>
  open: (handle: PersistenceHandle, key?: string) => Promise<AgentSession>
  skills: (cwd: string) => Promise<Skill[]>
  onClose: () => void
  /** Called as soon as the user interrupts (before the provider confirms). */
  onInterrupt?: () => void
}

interface Live {
  record: SubmissionRecord
  /** What actually goes to the provider (skills expanded). `record.prompt` keeps what the user wrote. */
  wire: PromptInput
  options?: TurnOptions
  visible: boolean
  result: ReturnType<typeof deferred<RunResult>>
  settled: ReturnType<typeof deferred<SubmissionRecord>>
  submission: Submission
}

/**
 * The one session type harness builders use. Wraps a capsule session with:
 * capability guards, permission policies, a visible prompt inbox, durable
 * submissions, a live transcript, and an async event iterator. Same API for every provider.
 */
export class AgentSession {
  readonly provider: ProviderId
  readonly capabilities: Capabilities
  /** Stable id across rewinds/restarts (the native id can change). Store key. */
  readonly key: string
  private readonly inner: ProviderSession
  private readonly events = new Emitter<AgentEvent>()
  private readonly queue: Live[] = []
  private running: Live | null = null
  private state: Transcript = emptyTranscript()
  private draining = false
  private compacting = false
  private closed = false
  private lastInbox = '[]'
  private handlers: SessionHandlers
  private readonly ctx: SessionContext

  constructor(inner: ProviderSession, handlers: SessionHandlers, ctx: SessionContext) {
    this.inner = inner
    this.provider = inner.provider
    this.capabilities = inner.capabilities
    this.handlers = handlers
    this.ctx = ctx
    this.key = ctx.key
    this.state = { ...this.state, sessionId: inner.id }
    inner.subscribe((event) => this.publish(event))
  }

  /** Native session id (Claude session, Codex thread, OpenCode session). Can change after rewind. */
  get id(): string | null {
    return this.inner.id
  }
  /** Live UI projection: items, status, inbox, pending permissions, usage. */
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

  /** Every event goes through here: stored first (commit-before-show), then reduced, then shown. */
  private publish(event: AgentEvent): void {
    const store = this.ctx.store
    if (event.type === 'turn_started' && this.running && !this.running.record.turnId) {
      this.running.record = { ...this.running.record, turnId: event.turnId }
      store?.putSubmission(this.running.record)
    }
    store?.appendEvent(this.key, event)
    this.state = reduceTranscript(this.state, event)
    if (event.type === 'session_started') store?.updateSession(this.key, { handle: this.inner.describePersistence() })
    if (isTerminalEvent(event) && !this.running) store?.checkpoint(this.key, this.state)
    if (event.type === 'permission_requested' && this.handlers.onPermission) void this.autoAnswer(event.request)
    this.handlers.onEvent?.(event)
    this.events.emit(event)
  }

  /** Load a saved transcript (restore from a store, or a fork's history). */
  hydrate(transcript: Transcript): void {
    this.state = { ...transcript, sessionId: this.inner.id, status: transcript.status === 'failed' ? 'failed' : 'idle', activeTurnId: null, pendingPermissions: [], inbox: [] }
    this.ctx.store?.checkpoint(this.key, this.state)
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

  /** A turn is running, about to run, or compaction is in progress. */
  get busy(): boolean {
    return this.isRunning || this.running !== null || this.queue.length > 0 || this.compacting
  }

  /**
   * The one way to send a prompt. Idle: starts now. Busy: `whenBusy` decides —
   * 'queue' puts it in the visible inbox, 'steer' injects into the running turn
   * (falls back to the inbox if the provider can't), 'reject' throws SESSION_BUSY.
   */
  async submit(prompt: PromptInput, options: SubmitOptions = {}): Promise<Submission> {
    const { requestId, whenBusy = 'queue', skills = true, ...turnOptions } = options
    if (requestId) {
      const known = this.ctx.registry.get(requestId)
      if (known) return known
      const stored = this.ctx.store?.getSubmission(requestId)
      if (stored) return storedSubmission(stored, this.ctx.store!)
    }
    this.checkTurnOptions(prompt, turnOptions)
    const busy = this.busy
    if (busy && whenBusy === 'reject') throw new AgentKitError('SESSION_BUSY', 'a turn is already running; submit with whenBusy "queue" or "steer"', { provider: this.provider })

    const live = this.createLive(requestId ?? randomUUID(), prompt, whenBusy, turnOptions)
    live.wire = await this.expand(prompt, skills)
    if (busy && whenBusy === 'steer') {
      const turnId = this.activeTurnId
      if (turnId && this.capabilities.steer && this.inner.steer && !this.compacting) {
        const accepted = await this.inner.steer(live.wire, { expectedTurnId: turnId }).then((r) => r.accepted, () => false)
        if (accepted) {
          this.save(live, { status: 'steered', turnId })
          this.joinTurn(live, turnId)
          return live.submission
        }
      }
    }
    live.visible = busy
    this.queue.push(live)
    this.save(live, {})
    this.emitInbox()
    void this.drain()
    return live.submission
  }

  /** Run one turn to completion. Throws SESSION_BUSY if a turn is active; use `submit`/`send` to queue. */
  async run(prompt: PromptInput, options?: TurnOptions & { requestId?: string }): Promise<RunResult> {
    return (await this.submit(prompt, { ...options, whenBusy: 'reject' })).result
  }

  /** Start a raw turn and return immediately (not tracked as a submission). Follow it through `on()` / `transcript`. */
  async start(prompt: PromptInput, options?: TurnOptions): Promise<{ turnId: string }> {
    this.checkTurnOptions(prompt, options)
    if (this.busy) throw new AgentKitError('SESSION_BUSY', 'a turn is already running', { provider: this.provider })
    return this.inner.startTurn(prompt, options)
  }

  /** Queue a prompt: runs now if idle, otherwise after the current/queued turns finish. */
  async send(prompt: PromptInput, options?: TurnOptions & { requestId?: string }): Promise<RunResult> {
    return (await this.submit(prompt, { ...options, whenBusy: 'queue' })).result
  }

  /** Inject input into the running turn; falls back to the inbox when the provider can't steer or nothing is running. */
  async steer(prompt: PromptInput): Promise<{ steered: boolean; submission: Submission }> {
    const submission = await this.submit(prompt, { whenBusy: 'steer' })
    submission.result.catch(() => undefined)
    return { steered: submission.status === 'steered', submission }
  }

  /** Pull a queued prompt out of the inbox. False if it already started or is unknown. */
  withdraw(id: string): boolean {
    const index = this.queue.findIndex((live) => live.record.id === id)
    if (index < 0) return false
    const [live] = this.queue.splice(index, 1)
    this.settle(live, { status: 'withdrawn', error: 'withdrawn before it started' })
    this.emitInbox()
    return true
  }

  get queued(): number {
    return this.queue.length
  }

  clearQueue(): void {
    for (const live of this.queue.splice(0)) this.settle(live, { status: 'withdrawn', error: 'queue cleared' }, new AgentKitError('SESSION_CLOSED', 'queue cleared', { provider: this.provider }))
    this.emitInbox()
  }

  private createLive(id: string, prompt: PromptInput, whenBusy: SubmitOptions['whenBusy'] & string, options?: TurnOptions): Live {
    const result = deferred<RunResult>()
    const settled = deferred<SubmissionRecord>()
    result.promise.catch(() => undefined)
    const record: SubmissionRecord = {
      id,
      sessionKey: this.key,
      provider: this.provider,
      status: 'queued',
      prompt,
      whenBusy,
      turnId: null,
      handle: this.inner.describePersistence(),
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    }
    const live = { record, wire: prompt, options, visible: false, result, settled } as Live
    const session = this
    live.submission = {
      id,
      get status() {
        return live.record.status
      },
      record: () => live.record,
      result: result.promise,
      wait: () => settled.promise,
      withdraw: () => session.withdraw(id),
    }
    this.ctx.registry.set(id, live.submission)
    return live
  }

  private async expand(prompt: PromptInput, mode: SubmitOptions['skills']): Promise<PromptInput> {
    if (mode === false) return prompt
    const hasDollar = typeof prompt === 'string' ? prompt.includes('$') : prompt.some((b) => b.type === 'text' && b.text.includes('$'))
    const cwd = this.inner.describePersistence()?.cwd
    if (!hasDollar || !cwd) return prompt
    const modeId = this.state.modeId ?? (await this.inner.getRuntimeInfo().catch(() => null))?.modeId ?? null
    const inPlan = modeId !== null && modeId === planModeFor(this.provider, 'plan')
    const resolved = mode === 'inline' || mode === 'reference' ? mode : inPlan ? 'inline' : 'reference'
    const skills = await this.ctx.skills(cwd).catch(() => [] as Skill[])
    return expandSkillPrompt(prompt, { provider: this.provider, skills, mode: resolved }).prompt
  }

  private save(live: Live, patch: Partial<SubmissionRecord>): void {
    live.record = { ...live.record, ...patch }
    this.ctx.store?.putSubmission(live.record)
  }

  private settle(live: Live, patch: Partial<SubmissionRecord>, error?: unknown, result?: RunResult): void {
    if (TERMINAL_SUBMISSION.has(live.record.status)) return
    const final: RunResult = result ?? {
      sessionId: this.inner.id,
      turnId: live.record.turnId ?? '',
      status: 'canceled',
      finalText: '',
      error: patch.error ?? undefined,
      timeline: [],
    }
    const { timeline: _timeline, ...outcome } = final
    this.save(live, { result: outcome, finishedAt: new Date().toISOString(), ...patch })
    this.ctx.store?.updateSession(this.key, { handle: this.inner.describePersistence() })
    if (error) live.result.reject(error)
    else live.result.resolve(final)
    live.settled.resolve(live.record)
  }

  private settleFromResult(live: Live, result: RunResult): void {
    this.settle(live, { status: result.status, turnId: result.turnId || live.record.turnId, error: result.error ?? null }, undefined, result)
  }

  /** A steered prompt finishes with the turn it joined. */
  private joinTurn(live: Live, turnId: string): void {
    const host = this.running
    if (host && host.record.turnId === turnId) {
      host.result.promise.then((result) => this.settleFromResult(live, result), (error) => this.settle(live, { status: 'failed', error: String(error) }, error))
      return
    }
    const off = this.on((event) => {
      if (!isTerminalEvent(event) || event.turnId !== turnId) return
      off()
      const status = event.type === 'turn_completed' ? 'completed' : event.type === 'turn_failed' ? 'failed' : 'canceled'
      const error = event.type === 'turn_failed' ? event.error : undefined
      this.settleFromResult(live, { sessionId: this.inner.id, turnId, status, finalText: '', error, timeline: [] })
    })
  }

  private emitInbox(): void {
    const inbox: InboxEntry[] = this.queue
      .filter((live) => live.visible)
      .map((live) => ({
        id: live.record.id,
        text: typeof live.record.prompt === 'string' ? live.record.prompt : live.record.prompt.map((b) => (b.type === 'text' ? b.text : '[image]')).join('\n'),
        whenBusy: live.record.whenBusy === 'steer' ? 'steer' : 'queue',
        at: live.record.createdAt,
      }))
    const json = JSON.stringify(inbox)
    if (json === this.lastInbox) return
    this.lastInbox = json
    this.publish({ type: 'inbox_changed', provider: this.provider, inbox })
  }

  private waitIdle(): Promise<void> {
    if (!this.isRunning && !this.compacting) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const check = () => {
        if (!this.isRunning && !this.compacting) {
          off()
          clearInterval(timer)
          resolve()
        }
      }
      const off = this.on(() => queueMicrotask(check))
      const timer = setInterval(check, 250)
    })
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length && !this.closed) {
        await this.waitIdle()
        const live = this.queue.shift()
        if (!live) break
        this.emitInbox()
        this.running = live
        // Intent: saved before the provider sees the prompt.
        this.save(live, { status: 'running', handle: this.inner.describePersistence() })
        try {
          this.settleFromResult(live, await this.inner.run(live.wire, live.options))
        } catch (error) {
          this.settle(live, { status: 'failed', error: error instanceof Error ? error.message : String(error) }, error)
        } finally {
          this.running = null
          this.ctx.store?.checkpoint(this.key, this.state)
        }
      }
    } finally {
      this.draining = false
    }
  }

  async interrupt(): Promise<void> {
    this.ctx.onInterrupt?.()
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
  /** Faster serving tier for models with `supportsFastMode` (Claude fast mode, Codex priority tier). */
  async setFast(enabled: boolean): Promise<void> {
    this.guard('fastMode')
    await this.inner.setFast!(enabled)
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
    this.ctx.store?.updateSession(this.key, { handle: this.inner.describePersistence() })
    this.ctx.store?.checkpoint(this.key, this.state)
  }

  /**
   * Branch into a new session holding this conversation up to (not including)
   * `beforeMessageId`, or all of it. This session is untouched.
   */
  async fork(options: { beforeMessageId?: string; key?: string } = {}): Promise<AgentSession> {
    this.guard('fork')
    const handle = await this.inner.fork!({ beforeMessageId: options.beforeMessageId })
    const forked = await this.ctx.open(handle, options.key)
    let items: TimelineItem[] = []
    if (forked.capabilities.history) items = await forked.history().catch(() => [])
    if (!items.length) {
      const cut = options.beforeMessageId ? this.state.items.findIndex((item) => item.type === 'user_message' && item.messageId === options.beforeMessageId) : -1
      items = cut >= 0 ? this.state.items.slice(0, cut) : this.state.items.slice()
    }
    forked.hydrate({ ...emptyTranscript(), items, modeId: this.state.modeId, model: this.state.model, thinkingOptionId: this.state.thinkingOptionId, fast: this.state.fast })
    return forked
  }

  /**
   * How full the context is, straight from the provider. Falls back to the last
   * usage event when the capsule has no direct call.
   */
  async contextWindow(): Promise<ContextWindow> {
    if (this.closed) throw new AgentKitError('SESSION_CLOSED', 'session is closed', { provider: this.provider })
    const fromUsage: ContextWindow = { usedTokens: this.state.usage?.contextWindowUsedTokens ?? null, maxTokens: this.state.usage?.contextWindowMaxTokens ?? null }
    if (!this.inner.contextWindow) return fromUsage
    const live = await this.inner.contextWindow()
    return { usedTokens: live.usedTokens ?? fromUsage.usedTokens, maxTokens: live.maxTokens ?? fromUsage.maxTokens }
  }

  /** Native compaction: summarize older context. Waits for any running turn; counts as busy while it runs. */
  async compact(instructions?: string): Promise<void> {
    this.guard('compact')
    if (this.busy) throw new AgentKitError('SESSION_BUSY', 'cannot compact while a turn is running or queued', { provider: this.provider })
    this.compacting = true
    try {
      await this.inner.compact!({ instructions })
    } finally {
      this.compacting = false
      this.ctx.store?.checkpoint(this.key, this.state)
      void this.drain()
    }
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
    this.ctx.onClose()
  }
}

/** A read-only view of a submission from the store (another process, or before a restart). */
export function storedSubmission(record: SubmissionRecord, store: AgentStore): Submission {
  let current = record
  const toResult = (r: SubmissionRecord): RunResult => ({
    sessionId: r.result?.sessionId ?? r.handle?.sessionId ?? null,
    turnId: r.turnId ?? '',
    status: r.status === 'completed' || r.status === 'failed' ? r.status : 'canceled',
    finalText: r.result?.finalText ?? '',
    error: r.error ?? r.result?.error,
    usage: r.result?.usage,
    timeline: [],
  })
  const wait = async (): Promise<SubmissionRecord> => {
    // Another live process may still own it: poll the shared file.
    while (!TERMINAL_SUBMISSION.has(current.status)) {
      await new Promise((r) => setTimeout(r, 500))
      current = store.getSubmission(record.id) ?? current
    }
    return current
  }
  const settled = wait()
  return {
    id: record.id,
    get status() {
      return current.status
    },
    record: () => current,
    result: settled.then(toResult),
    wait: () => settled,
    withdraw: () => false,
  }
}
