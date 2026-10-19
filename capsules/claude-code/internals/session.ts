import { randomUUID } from 'node:crypto'
import {
  forkSession,
  getSessionMessages,
  query,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentEvent,
  AgentMode,
  ContextWindow,
  Capabilities,
  PermissionRequest,
  PermissionResponse,
  PersistenceHandle,
  PromptInput,
  ProviderSession,
  RunResult,
  RuntimeInfo,
  SessionConfig,
  SlashCommand,
  TimelineItem,
  ToolCallItem,
  TurnOptions,
} from '../../shared/contract.ts'
import { collectRun, deferred, deriveToolDetail, Emitter, nowIso, safeJson } from '../../shared/runtime.ts'
import { contentBlocks, replayMessages, toolFinished, toolStarted, usageFromResult } from './mapping.ts'

export const CLAUDE_MODES: AgentMode[] = [
  { id: 'default', label: 'Always ask', description: 'Asks the first time each tool is used.' },
  { id: 'acceptEdits', label: 'Accept edits', description: 'Auto-approves file edits, asks for commands.' },
  { id: 'plan', label: 'Plan', description: 'Read-only analysis; proposes a plan before acting.' },
  { id: 'auto', label: 'Auto', description: 'A classifier reviews permission prompts.' },
  { id: 'bypassPermissions', label: 'Bypass', description: 'Never asks. Use with care.', unattended: true },
]
export const DEFAULT_CLAUDE_MODE = 'default'

export const CLAUDE_CAPABILITIES: Capabilities = {
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
  mcpServers: true,
  steer: true,
  slashCommands: true,
  images: true,
  structuredOutput: true,
  rewindConversation: true,
  rewindFiles: true,
  archive: false,
  fork: true,
  compact: true,
  systemPrompt: true,
}

export interface ClaudeRuntimeOptions {
  binary?: string | null
  settingSources?: Options['settingSources']
  extraOptions?: Partial<Options>
}

/** `lastMessageId`: the newest user message pushed into this turn (initial or steer). Only its `result` ends the turn. */
type Turn = { id: string; done: ReturnType<typeof deferred<void>>; interrupted: boolean; schemaKey: string | null; lastMessageId: string }
type PendingPermission = { request: PermissionRequest; resolve: (result: PermissionResult) => void; input: Record<string, unknown> }

/** Push-based async iterable that feeds user messages into one long-lived `query()`. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiter: ((result: IteratorResult<SDKUserMessage>) => void) | null = null
  private ended = false
  push(message: SDKUserMessage): void {
    if (this.waiter) {
      const wake = this.waiter
      this.waiter = null
      wake({ value: message, done: false })
    } else this.items.push(message)
  }
  end(): void {
    this.ended = true
    this.waiter?.({ value: undefined, done: true })
    this.waiter = null
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => (this.waiter = resolve))
      },
    }
  }
}

export class ClaudeSession implements ProviderSession {
  readonly provider = 'claude'
  readonly capabilities = CLAUDE_CAPABILITIES
  private readonly events = new Emitter<AgentEvent>()
  private readonly permissions = new Map<string, PendingPermission>()
  private readonly tools = new Map<string, { item: ToolCallItem; input: unknown }>()
  private readonly config: SessionConfig
  private readonly runtime: ClaudeRuntimeOptions
  private sessionId: string
  /** True once the native transcript exists on disk (resume instead of sessionId). */
  private materialized: boolean
  private q: Query | null = null
  private input: InputQueue | null = null
  private pump: Promise<void> | null = null
  private turn: Turn | null = null
  private streamedText = false
  private modeId: string
  private model: string | null
  private effort: string | null
  private fast: boolean
  private querySchemaKey: string | null = null
  private closed = false

  constructor(config: SessionConfig, runtime: ClaudeRuntimeOptions, resume?: { sessionId: string }) {
    this.config = config
    this.runtime = runtime
    this.sessionId = resume?.sessionId ?? randomUUID()
    this.materialized = Boolean(resume)
    this.modeId = config.modeId ?? DEFAULT_CLAUDE_MODE
    this.model = config.model ?? null
    this.effort = config.thinkingOptionId ?? null
    this.fast = config.fast ?? false
  }

  get id(): string {
    return this.sessionId
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    return this.events.on(listener)
  }

  // ------------------------------------------------------------ query lifecycle

  private buildOptions(outputSchema: unknown): Options {
    const options: Options = {
      cwd: this.config.cwd,
      includePartialMessages: true,
      permissionMode: this.modeId as Options['permissionMode'],
      allowDangerouslySkipPermissions: true,
      canUseTool: (toolName, input, ctx) => this.canUseTool(toolName, input, ctx),
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(this.config.systemPrompt ? { append: this.config.systemPrompt } : {}) },
      settingSources: this.runtime.settingSources ?? ['user', 'project', 'local'],
      enableFileCheckpointing: true,
      env: { ...process.env, ...this.config.env } as Record<string, string>,
      ...(this.runtime.binary ? { pathToClaudeCodeExecutable: this.runtime.binary } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort as Options['effort'] } : {}),
      // Fast mode is a flag-tier setting; also applied live via applyFlagSettings in setFast().
      ...(this.fast ? { settings: { fastMode: true } as Options['settings'] } : {}),
      ...(this.config.mcpServers ? { mcpServers: this.config.mcpServers as Options['mcpServers'] } : {}),
      ...(this.config.persist === false ? { persistSession: false } : {}),
      ...(outputSchema !== undefined ? { outputFormat: { type: 'json_schema', schema: outputSchema as Record<string, unknown> } } : {}),
      ...(this.materialized ? { resume: this.sessionId } : { sessionId: this.sessionId }),
      ...this.runtime.extraOptions,
      ...(this.config.providerOptions as Partial<Options> | undefined),
    }
    return options
  }

  /** Start (or restart) the long-lived query. Restart is needed for structured output and after rewind. */
  private async ensureQuery(outputSchema?: unknown): Promise<void> {
    const schemaKey = outputSchema === undefined ? null : safeJson(outputSchema)
    if (this.q && this.querySchemaKey === schemaKey) return
    if (this.q) await this.stopQuery()
    this.input = new InputQueue()
    this.querySchemaKey = schemaKey
    this.q = query({ prompt: this.input, options: this.buildOptions(outputSchema) })
    const q = this.q
    this.pump = this.consume(q)
  }

  private async stopQuery(): Promise<void> {
    const q = this.q
    this.q = null
    this.input?.end()
    this.input = null
    if (q) {
      q.close()
      await this.pump?.catch(() => undefined)
    }
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const message of q) this.onMessage(message)
    } catch (error) {
      if (this.turn && !this.closed) this.endTurn({ type: 'turn_failed', provider: 'claude', turnId: this.turn.id, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (this.q === q) {
        this.q = null
        this.input = null
        if (this.turn && !this.closed) this.endTurn({ type: 'turn_failed', provider: 'claude', turnId: this.turn.id, error: 'claude process exited' })
      }
    }
  }

  // ------------------------------------------------------------ turns

  async startTurn(prompt: PromptInput, options?: TurnOptions): Promise<{ turnId: string }> {
    if (this.closed) throw new Error('claude session is closed')
    if (this.turn) throw new Error('claude session already has an active turn')
    await this.ensureQuery(options?.outputSchema)
    const turnId = randomUUID()
    const messageId = options?.clientMessageId && isUuid(options.clientMessageId) ? options.clientMessageId : randomUUID()
    this.turn = { id: turnId, done: deferred<void>(), interrupted: false, schemaKey: this.querySchemaKey, lastMessageId: messageId }
    this.streamedText = false
    this.events.emit({ type: 'turn_started', provider: 'claude', turnId })
    this.timeline({ type: 'user_message', text: promptText(prompt), messageId, clientMessageId: options?.clientMessageId }, turnId)
    this.input!.push(toSdkMessage(prompt, messageId))
    this.materialized = true
    return { turnId }
  }

  run(prompt: PromptInput, options?: TurnOptions): Promise<RunResult> {
    return collectRun({
      provider: 'claude',
      prompt,
      options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (l) => this.subscribe(l),
      interrupt: () => this.interrupt(),
      sessionId: () => this.sessionId,
    })
  }

  /** Steer: queue a user message with priority 'now' into the running turn. */
  async steer(prompt: PromptInput, options: { expectedTurnId: string }): Promise<{ accepted: boolean }> {
    if (!this.turn || this.turn.id !== options.expectedTurnId || !this.input) return { accepted: false }
    const messageId = randomUUID()
    // 'now' cuts the running step short: Claude emits a result for the earlier message, then a new
    // run whose result carries this uuid. Track it so the turn spans both.
    this.turn.lastMessageId = messageId
    this.timeline({ type: 'user_message', text: promptText(prompt), messageId }, this.turn.id)
    this.input.push({ ...toSdkMessage(prompt, messageId), priority: 'now' })
    return { accepted: true }
  }

  async interrupt(): Promise<void> {
    const turn = this.turn
    if (!turn) return
    turn.interrupted = true
    for (const id of [...this.permissions.keys()]) await this.respondToPermission(id, { behavior: 'deny', message: 'interrupted' }).catch(() => undefined)
    await this.q?.interrupt().catch(() => undefined)
    await Promise.race([turn.done.promise, new Promise((r) => setTimeout(r, 10_000))])
    if (this.turn === turn) this.endTurn({ type: 'turn_canceled', provider: 'claude', turnId: turn.id, reason: 'interrupted' })
  }

  private endTurn(event: Extract<AgentEvent, { type: 'turn_completed' | 'turn_failed' | 'turn_canceled' }>): void {
    const turn = this.turn
    if (!turn || turn.id !== event.turnId) return
    this.turn = null
    for (const [id, entry] of this.permissions) {
      this.permissions.delete(id)
      entry.resolve({ behavior: 'deny', message: 'turn ended' })
      this.events.emit({ type: 'permission_resolved', provider: 'claude', requestId: id, response: { behavior: 'deny' } })
    }
    this.events.emit(event)
    turn.done.resolve()
  }

  private timeline(item: TimelineItem, turnId = this.turn?.id): void {
    this.events.emit({ type: 'timeline', provider: 'claude', item, turnId, timestamp: nowIso() })
  }

  // ------------------------------------------------------------ SDK messages

  private onMessage(message: SDKMessage): void {
    const m = message as any
    if (m.session_id && m.session_id !== this.sessionId && !m.parent_tool_use_id) {
      this.sessionId = m.session_id
      this.events.emit({ type: 'session_started', provider: 'claude', sessionId: this.sessionId })
    }
    if (m.fast_mode_state !== undefined && !m.parent_tool_use_id) this.observeFastState(m.fast_mode_state, m.fast_mode_disabled_reason)
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          if (m.model) this.model = this.model ?? m.model
        } else if (m.subtype === 'compact_boundary') this.timeline({ type: 'compaction', status: 'completed' })
        return
      case 'stream_event': {
        if (m.parent_tool_use_id) return
        const event = m.event
        if (event?.type === 'message_start') this.streamedText = false
        if (event?.type !== 'content_block_delta') return
        if (event.delta?.type === 'text_delta') {
          this.streamedText = true
          this.timeline({ type: 'assistant_message', text: event.delta.text, messageId: event.message_id })
        } else if (event.delta?.type === 'thinking_delta') {
          this.timeline({ type: 'reasoning', text: event.delta.thinking })
        }
        return
      }
      case 'assistant': {
        if (m.parent_tool_use_id) return
        for (const block of contentBlocks(m.message)) {
          if (block.type === 'text' && !this.streamedText && block.text) this.timeline({ type: 'assistant_message', text: block.text, messageId: m.uuid })
          if (block.type === 'tool_use') {
            const item = toolStarted(block)
            this.tools.set(block.id, { item, input: block.input })
            this.timeline(item)
            if (item.detail.type === 'todo') this.timeline({ type: 'todo', items: item.detail.items })
          }
        }
        this.streamedText = false
        return
      }
      case 'user': {
        if (m.parent_tool_use_id) return
        for (const block of contentBlocks(m.message)) {
          if (block.type !== 'tool_result') continue
          const started = this.tools.get(block.tool_use_id)
          this.timeline(toolFinished(started?.item, block, started?.input))
        }
        return
      }
      case 'result': {
        const turn = this.turn
        if (!turn) return
        const covered: string[] = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : [])
        // A result for an earlier message of a steered turn is intermediate; keep the turn open.
        if (!turn.interrupted && covered.length && !covered.includes(turn.lastMessageId)) return
        if (m.subtype === 'success' && m.structured_output !== undefined) {
          this.timeline({ type: 'assistant_message', text: safeJson(m.structured_output), messageId: `${turn.id}:structured` })
        }
        const usage = { ...usageFromResult(m), ...windowFromModelUsage(m.modelUsage, this.model) }
        this.events.emit({ type: 'usage', provider: 'claude', usage, turnId: turn.id })
        // Exact fill level after this turn (cheap: 'summary' reuses the last response's usage).
        void this.contextWindow().then(
          (w) => w.maxTokens && this.events.emit({ type: 'usage', provider: 'claude', usage: { contextWindowUsedTokens: w.usedTokens ?? undefined, contextWindowMaxTokens: w.maxTokens }, turnId: turn.id }),
          () => undefined,
        )
        if (turn.interrupted) this.endTurn({ type: 'turn_canceled', provider: 'claude', turnId: turn.id, reason: 'interrupted' })
        else if (m.subtype === 'success' && !m.is_error) this.endTurn({ type: 'turn_completed', provider: 'claude', turnId: turn.id, usage })
        else this.endTurn({ type: 'turn_failed', provider: 'claude', turnId: turn.id, error: (m.errors ?? []).join('; ') || m.result || m.subtype })
        return
      }
    }
  }

  // ------------------------------------------------------------ permissions

  private canUseTool(toolName: string, input: Record<string, unknown>, ctx: { signal: AbortSignal; toolUseID?: string; decisionReason?: string; blockedPath?: string }): Promise<PermissionResult> {
    const id = ctx.toolUseID ?? randomUUID()
    const request: PermissionRequest =
      toolName === 'AskUserQuestion'
        ? {
            id,
            provider: 'claude',
            kind: 'question',
            name: toolName,
            input,
            questions: ((input.questions as any[]) ?? []).map((q, index) => ({
              id: q.question ?? String(index),
              header: q.header,
              question: q.question,
              options: q.options,
              multiSelect: q.multiSelect,
              allowOther: true,
            })),
          }
        : {
            id,
            provider: 'claude',
            kind: toolName === 'ExitPlanMode' ? 'plan' : 'tool',
            name: toolName,
            title: toolName,
            description: ctx.decisionReason ?? ctx.blockedPath,
            input,
            detail: deriveToolDetail(toolName, input),
            actions: [
              { id: 'once', label: 'Allow once', behavior: 'allow' },
              { id: 'always', label: 'Always allow', behavior: 'allow' },
              { id: 'deny', label: 'Deny', behavior: 'deny' },
            ],
          }
    return new Promise<PermissionResult>((resolve) => {
      this.permissions.set(id, { request, resolve, input })
      ctx.signal.addEventListener('abort', () => {
        if (!this.permissions.delete(id)) return
        resolve({ behavior: 'deny', message: 'aborted' })
        this.events.emit({ type: 'permission_resolved', provider: 'claude', requestId: id, response: { behavior: 'deny' } })
      })
      this.events.emit({ type: 'permission_requested', provider: 'claude', request, turnId: this.turn?.id })
    })
  }

  getPendingPermissions(): PermissionRequest[] {
    return [...this.permissions.values()].map((entry) => entry.request)
  }

  async respondToPermission(requestId: string, response: PermissionResponse): Promise<void> {
    const entry = this.permissions.get(requestId)
    if (!entry) throw new Error(`no pending claude permission ${requestId}`)
    this.permissions.delete(requestId)
    if (response.behavior === 'deny') {
      entry.resolve({ behavior: 'deny', message: response.message ?? 'User denied this action', interrupt: response.interrupt })
    } else if (entry.request.kind === 'question') {
      const answers: Record<string, string> = {}
      for (const [key, value] of Object.entries(response.answers ?? {})) answers[key] = Array.isArray(value) ? value.join(', ') : value
      entry.resolve({ behavior: 'allow', updatedInput: { ...entry.input, answers } })
    } else {
      entry.resolve({
        behavior: 'allow',
        updatedInput: (response.updatedInput as Record<string, unknown>) ?? entry.input,
        ...(response.actionId === 'always'
          ? { updatedPermissions: [{ type: 'addRules', rules: [{ toolName: entry.request.name }], behavior: 'allow', destination: 'session' }] }
          : {}),
      })
    }
    this.events.emit({ type: 'permission_resolved', provider: 'claude', requestId, response })
  }

  // ------------------------------------------------------------ settings

  async getRuntimeInfo(): Promise<RuntimeInfo> {
    return { provider: 'claude', sessionId: this.sessionId, model: this.model, modeId: this.modeId, thinkingOptionId: this.effort, fast: this.fast }
  }
  async getModes(): Promise<AgentMode[]> {
    return CLAUDE_MODES
  }
  async setMode(modeId: string): Promise<void> {
    if (!CLAUDE_MODES.some((mode) => mode.id === modeId)) throw new Error(`unknown claude mode ${modeId}`)
    this.modeId = modeId
    await this.q?.setPermissionMode(modeId as Options['permissionMode'] & string)
    this.events.emit({ type: 'mode_changed', provider: 'claude', modeId })
  }
  async setModel(model: string | null): Promise<void> {
    this.model = model
    await this.q?.setModel(model ?? undefined)
    this.events.emit({ type: 'model_changed', provider: 'claude', model })
  }
  async setThinking(effort: string | null): Promise<void> {
    this.effort = effort
    await this.q?.applyFlagSettings({ effortLevel: effort as any })
    this.events.emit({ type: 'thinking_changed', provider: 'claude', thinkingOptionId: effort })
  }
  private lastFastState: string | null = null
  /** Claude reports what it is actually serving: 'on' | 'off' | 'cooldown' (+ why it can't). */
  private observeFastState(state: string, reason?: unknown): void {
    if (state === this.lastFastState) return
    this.lastFastState = state
    if (this.fast && state !== 'on') {
      const why = reason ? `: ${typeof reason === 'string' ? reason : safeJson(reason)}` : ''
      this.timeline({ type: 'notice', level: 'warning', message: state === 'cooldown' ? `Fast mode cooling down after a rate limit; using standard speed${why}` : `Fast mode is not active${why}` })
    }
  }

  async setFast(enabled: boolean): Promise<void> {
    this.fast = enabled
    await this.q?.applyFlagSettings({ fastMode: enabled })
    this.events.emit({ type: 'fast_changed', provider: 'claude', enabled })
  }
  async listCommands(): Promise<SlashCommand[]> {
    await this.ensureQuery(undefined)
    const commands = await this.q!.supportedCommands()
    return commands.map((command) => ({ name: command.name, description: command.description, argumentHint: command.argumentHint }))
  }

  describePersistence(): PersistenceHandle {
    return { provider: 'claude', sessionId: this.sessionId, cwd: this.config.cwd, metadata: { modeId: this.modeId, model: this.model, effort: this.effort, fast: this.fast } }
  }

  async *history(): AsyncIterable<TimelineItem> {
    if (!this.materialized) return
    const messages = await getSessionMessages(this.sessionId, { dir: this.config.cwd })
    yield* replayMessages(messages as any)
  }

  async rewind(input: { messageId: string; scope: 'conversation' | 'files' | 'both' }): Promise<void> {
    await this.interrupt()
    if (input.scope !== 'conversation') {
      await this.ensureQuery(undefined)
      const result: any = await this.q!.rewindFiles(input.messageId)
      if (result && result.canRewind === false) throw new Error(`claude cannot rewind files: ${result.error ?? 'no checkpoint'}`)
    }
    if (input.scope === 'files') return
    const messages = await getSessionMessages(this.sessionId, { dir: this.config.cwd })
    const index = messages.findIndex((message) => message.uuid === input.messageId)
    if (index < 0) throw new Error(`claude message ${input.messageId} not found in transcript`)
    await this.stopQuery()
    if (index === 0) {
      this.sessionId = randomUUID()
      this.materialized = false
    } else {
      const forked = await forkSession(this.sessionId, { dir: this.config.cwd, upToMessageId: messages[index - 1].uuid })
      this.sessionId = forked.sessionId
      this.materialized = true
    }
    this.events.emit({ type: 'session_started', provider: 'claude', sessionId: this.sessionId })
  }

  async fork(input: { beforeMessageId?: string }): Promise<PersistenceHandle> {
    if (!this.materialized) throw new Error('claude session has no messages to fork yet')
    let upToMessageId: string | undefined
    if (input.beforeMessageId) {
      const messages = await getSessionMessages(this.sessionId, { dir: this.config.cwd })
      const index = messages.findIndex((message) => message.uuid === input.beforeMessageId)
      if (index < 0) throw new Error(`claude message ${input.beforeMessageId} not found in transcript`)
      if (index === 0) throw new Error('nothing before the first message to fork; open a new session instead')
      upToMessageId = messages[index - 1].uuid
    }
    const forked = await forkSession(this.sessionId, { dir: this.config.cwd, ...(upToMessageId ? { upToMessageId } : {}) })
    return { ...this.describePersistence(), sessionId: forked.sessionId }
  }

  /** Claude compacts through its built-in `/compact [instructions]` command. */
  async compact(input: { instructions?: string }): Promise<void> {
    const result = await this.run(`/compact${input.instructions ? ` ${input.instructions}` : ''}`)
    if (result.status !== 'completed') throw new Error(`claude compact ${result.status}: ${result.error ?? ''}`)
  }

  /** Claude's own accounting (same numbers as `/context`), so 1M-context variants report 1M. */
  async contextWindow(): Promise<ContextWindow> {
    await this.ensureQuery(undefined)
    const usage: any = await this.q!.getContextUsage({ detail: 'summary' })
    if (this.model && usage?.maxTokens) knownWindows.set(this.model, usage.maxTokens)
    return { usedTokens: usage?.totalTokens ?? null, maxTokens: usage?.maxTokens ?? null }
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.interrupt().catch(() => undefined)
    this.closed = true
    await this.stopQuery()
    this.events.clear()
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function promptText(prompt: PromptInput): string {
  return typeof prompt === 'string' ? prompt : prompt.map((b) => (b.type === 'text' ? b.text : '[image]')).join('\n')
}

function toSdkMessage(prompt: PromptInput, uuid: string): SDKUserMessage {
  const content =
    typeof prompt === 'string'
      ? prompt
      : prompt.flatMap((block): any[] =>
          block.type === 'text'
            ? [{ type: 'text' as const, text: block.text }]
            : block.type === 'image'
              ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: block.mimeType as any, data: block.data } }]
              : [],
        )
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: uuid as any }
}

/** Result messages carry `modelUsage[model].contextWindow`. Prefer the session's model, else the largest entry. */
function windowFromModelUsage(modelUsage: Record<string, any> | undefined, model: string | null): { contextWindowMaxTokens?: number } {
  const entries = Object.entries(modelUsage ?? {}).filter(([, u]) => typeof u?.contextWindow === 'number')
  if (!entries.length) return {}
  const own = model ? entries.find(([id]) => id === model || id.includes(model)) : undefined
  const pick = own ?? entries.sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0]
  return { contextWindowMaxTokens: pick[1].contextWindow }
}

/** Learned per model from live sessions so the catalog can show it (Claude's model list has no window field). */
const knownWindows = new Map<string, number>()
export function knownContextWindow(model: string): number | undefined {
  return knownWindows.get(model)
}
