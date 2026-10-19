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
  Question,
  RunResult,
  RuntimeInfo,
  SessionConfig,
  SlashCommand,
  TimelineItem,
  TurnOptions,
} from '../../shared/contract.ts'
import { collectRun, deferred, Emitter, nowIso } from '../../shared/runtime.ts'
import { isTerminalEvent } from '../../shared/contract.ts'
import { describeError, mapCodexItem, usageFromCodex, type CodexItem } from './items.ts'
import type { CodexRpc } from './rpc.ts'

export const CODEX_MODES: AgentMode[] = [
  { id: 'read-only', label: 'Read only', description: 'Can read files; asks before any write or command.' },
  { id: 'auto', label: 'Default', description: 'Edits inside the workspace, asks before leaving the sandbox.' },
  { id: 'full-access', label: 'Full access', description: 'No sandbox, no approval prompts.', unattended: true },
]
export const DEFAULT_CODEX_MODE = 'auto'

const PRESETS: Record<string, { approvalPolicy: string; sandbox: string; sandboxPolicy: Record<string, unknown> }> = {
  'read-only': { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
  auto: {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  },
  'full-access': { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } },
}

export const CODEX_CAPABILITIES: Capabilities = {
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
  slashCommands: false,
  images: true,
  structuredOutput: true,
  rewindConversation: true,
  rewindFiles: false,
  archive: true,
  fork: true,
  compact: true,
  systemPrompt: true,
}

type PendingPermission = { request: PermissionRequest; reply: (response: PermissionResponse) => unknown }

export function threadParams(config: SessionConfig, modeId: string): Record<string, unknown> {
  const preset = PRESETS[modeId] ?? PRESETS[DEFAULT_CODEX_MODE]
  const inner: Record<string, unknown> = { ...(config.providerOptions ?? {}) }
  if (config.mcpServers) {
    inner.mcp_servers = Object.fromEntries(
      Object.entries(config.mcpServers).map(([name, server]) => [
        name,
        server.type === 'stdio' ? { command: server.command, args: server.args, env: server.env } : { url: server.url, http_headers: server.headers },
      ]),
    )
  }
  return {
    cwd: config.cwd,
    approvalPolicy: preset.approvalPolicy,
    sandbox: preset.sandbox,
    ...(config.model ? { model: config.model } : {}),
    ...(config.systemPrompt ? { developerInstructions: config.systemPrompt } : {}),
    ...(Object.keys(inner).length ? { config: inner } : {}),
    ...(config.persist === false ? { ephemeral: true } : {}),
  }
}

/** Codex reports `modelContextWindow` only with token usage, so remember it per model for the catalog. */
const knownWindows = new Map<string, number>()
export function knownContextWindow(model: string): number | undefined {
  return knownWindows.get(model)
}

export class CodexSession implements ProviderSession {
  readonly provider = 'codex'
  readonly capabilities = CODEX_CAPABILITIES
  private readonly events = new Emitter<AgentEvent>()
  private readonly permissions = new Map<string, PendingPermission>()
  private readonly streamed = new Set<string>()
  private readonly items = new Map<string, CodexItem>()
  private activeTurnId: string | null = null
  private starting: Promise<unknown> | null = null
  private announced = new Set<string>()
  private turnDone = new Map<string, ReturnType<typeof deferred<void>>>()
  private closed = false
  private modeId: string
  private model: string | null
  private effort: string | null
  private fast: boolean
  private models: Promise<any[]> | null = null

  private readonly rpc: CodexRpc
  /** Opens a throwaway app-server. Set by the client; used so a fork doesn't hold the new thread's writer lock. */
  sideChannel: (() => Promise<CodexRpc>) | null = null
  private threadId: string
  private readonly config: SessionConfig

  constructor(rpc: CodexRpc, threadId: string, config: SessionConfig, init: { modeId: string; model: string | null; effort: string | null; fast?: boolean }) {
    this.rpc = rpc
    this.threadId = threadId
    this.config = config
    this.modeId = init.modeId
    this.model = init.model
    this.effort = init.effort
    this.fast = init.fast ?? false
    rpc.onNotification = (method, params) => this.onNotification(method, params)
    rpc.onServerRequest = (method, params) => this.onServerRequest(method, params)
    void rpc.exited.then(() => {
      if (this.closed || !this.activeTurnId) return
      this.finishTurn(this.activeTurnId, { type: 'turn_failed', provider: 'codex', turnId: this.activeTurnId, error: `codex app-server exited: ${rpc.stderr.slice(-300)}` })
    })
  }

  get id(): string {
    return this.threadId
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    return this.events.on(listener)
  }

  // ------------------------------------------------------------ turns

  async startTurn(prompt: PromptInput, options?: TurnOptions): Promise<{ turnId: string }> {
    if (this.closed) throw new Error('codex session is closed')
    if (this.activeTurnId || this.starting) throw new Error('codex session already has an active turn')
    const preset = PRESETS[this.modeId] ?? PRESETS[DEFAULT_CODEX_MODE]
    const serviceTier = await this.serviceTier()
    const request = this.rpc.request('turn/start', {
      threadId: this.threadId,
      input: toCodexInput(prompt),
      cwd: this.config.cwd,
      approvalPolicy: preset.approvalPolicy,
      sandboxPolicy: preset.sandboxPolicy,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      serviceTier,
      ...(options?.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
      ...(options?.clientMessageId ? { clientUserMessageId: options.clientMessageId } : {}),
    })
    this.starting = request
    try {
      const response = await request
      const turnId: string = response.turn.id
      this.beginTurn(turnId)
      return { turnId }
    } finally {
      this.starting = null
    }
  }

  run(prompt: PromptInput, options?: TurnOptions): Promise<RunResult> {
    return collectRun({
      provider: 'codex',
      prompt,
      options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (l) => this.subscribe(l),
      interrupt: () => this.interrupt(),
      sessionId: () => this.threadId,
    })
  }

  async steer(prompt: PromptInput, options: { expectedTurnId: string }): Promise<{ accepted: boolean }> {
    if (this.activeTurnId !== options.expectedTurnId) return { accepted: false }
    try {
      await this.rpc.request('turn/steer', { threadId: this.threadId, input: toCodexInput(prompt), expectedTurnId: options.expectedTurnId })
      return { accepted: true }
    } catch {
      return { accepted: false }
    }
  }

  async interrupt(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined)
    const turnId = this.activeTurnId
    if (!turnId) return
    const done = this.turnDone.get(turnId)
    for (const id of [...this.permissions.keys()]) await this.respondToPermission(id, { behavior: 'deny', interrupt: true }).catch(() => undefined)
    await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => undefined)
    await Promise.race([done?.promise, new Promise((r) => setTimeout(r, 15_000))])
    if (this.activeTurnId === turnId) this.finishTurn(turnId, { type: 'turn_canceled', provider: 'codex', turnId, reason: 'interrupted' })
  }

  private beginTurn(turnId: string): void {
    if (this.announced.has(turnId)) return
    this.announced.add(turnId)
    this.activeTurnId = turnId
    this.turnDone.set(turnId, deferred<void>())
    this.events.emit({ type: 'turn_started', provider: 'codex', turnId })
  }

  private finishTurn(turnId: string, event: AgentEvent): void {
    if (this.activeTurnId !== turnId) return
    this.activeTurnId = null
    for (const [id, entry] of this.permissions) {
      this.permissions.delete(id)
      this.events.emit({ type: 'permission_resolved', provider: 'codex', requestId: entry.request.id, response: { behavior: 'deny' } })
    }
    this.events.emit(event)
    this.turnDone.get(turnId)?.resolve()
    this.turnDone.delete(turnId)
  }

  // ------------------------------------------------------------ protocol events

  private timeline(item: TimelineItem, turnId?: string): void {
    this.events.emit({ type: 'timeline', provider: 'codex', item, turnId, timestamp: nowIso() })
  }

  private onNotification(method: string, params: any): void {
    if (params?.threadId && params.threadId !== this.threadId) return
    const turnId: string | undefined = params?.turnId ?? params?.turn?.id
    switch (method) {
      case 'turn/started':
        this.beginTurn(params.turn.id)
        return
      case 'turn/completed': {
        const turn = params.turn
        if (turn.status === 'completed') this.finishTurn(turn.id, { type: 'turn_completed', provider: 'codex', turnId: turn.id, usage: this.lastUsage })
        else if (turn.status === 'interrupted') this.finishTurn(turn.id, { type: 'turn_canceled', provider: 'codex', turnId: turn.id, reason: 'interrupted' })
        else this.finishTurn(turn.id, { type: 'turn_failed', provider: 'codex', turnId: turn.id, error: describeError(turn.error ?? 'turn failed') })
        return
      }
      case 'item/agentMessage/delta':
        this.streamed.add(params.itemId)
        this.timeline({ type: 'assistant_message', text: params.delta, messageId: params.itemId }, turnId)
        return
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.streamed.add(params.itemId)
        this.timeline({ type: 'reasoning', text: params.delta }, turnId)
        return
      case 'item/started':
      case 'item/completed': {
        const item: CodexItem = params.item
        this.items.set(item.id, item)
        if ((item.type === 'agentMessage' || item.type === 'reasoning') && (method === 'item/started' || this.streamed.has(item.id))) return
        if (item.type === 'userMessage' && method === 'item/started') return
        const mapped = mapCodexItem(item)
        if (mapped) this.timeline(mapped, turnId)
        return
      }
      case 'turn/plan/updated':
        this.timeline(
          {
            type: 'todo',
            items: (params.plan ?? []).map((step: any) => ({
              text: step.step,
              status: step.status === 'completed' ? 'completed' : step.status === 'inProgress' ? 'in_progress' : 'pending',
            })),
          },
          turnId,
        )
        return
      case 'thread/tokenUsage/updated':
        this.lastUsage = usageFromCodex(params.tokenUsage)
        if (this.model && this.lastUsage.contextWindowMaxTokens) knownWindows.set(this.model, this.lastUsage.contextWindowMaxTokens)
        this.events.emit({ type: 'usage', provider: 'codex', usage: this.lastUsage, turnId })
        return
      case 'thread/compacted':
        this.timeline({ type: 'compaction', status: 'completed' }, turnId)
        return
      case 'error':
        if (params?.willRetry) return
        this.timeline({ type: 'error', message: describeError(params?.error ?? params) }, turnId)
        return
    }
  }
  private lastUsage: ReturnType<typeof usageFromCodex> | undefined

  private onServerRequest(method: string, params: any): Promise<unknown> {
    if (params?.threadId && params.threadId !== this.threadId) return Promise.reject(new Error('unknown thread'))
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return this.ask(
          {
            id: params.approvalId ?? params.itemId,
            provider: 'codex',
            kind: 'tool',
            name: 'shell',
            title: params.command ? `Run: ${params.command}` : 'Run command',
            description: params.reason ?? undefined,
            input: params,
            detail: { type: 'shell', command: params.command ?? '', cwd: params.cwd ?? undefined },
            actions: [
              { id: 'once', label: 'Allow once', behavior: 'allow' },
              { id: 'always', label: 'Allow for session', behavior: 'allow' },
              { id: 'deny', label: 'Deny', behavior: 'deny' },
            ],
          },
          params.turnId,
          (response) => ({ decision: decision(response) }),
        )
      case 'item/fileChange/requestApproval': {
        const item = this.items.get(params.itemId)
        const mapped = item ? mapCodexItem(item) : null
        return this.ask(
          {
            id: params.itemId,
            provider: 'codex',
            kind: 'tool',
            name: 'apply_patch',
            title: 'Apply file changes',
            description: params.reason ?? undefined,
            input: params,
            detail: mapped?.type === 'tool_call' ? mapped.detail : undefined,
            actions: [
              { id: 'once', label: 'Allow once', behavior: 'allow' },
              { id: 'always', label: 'Allow for session', behavior: 'allow' },
              { id: 'deny', label: 'Deny', behavior: 'deny' },
            ],
          },
          params.turnId,
          (response) => ({ decision: decision(response) }),
        )
      }
      case 'item/tool/requestUserInput': {
        const questions: Question[] = (params.questions ?? []).map((q: any) => ({
          id: q.id,
          header: q.header,
          question: q.question,
          options: q.options ?? undefined,
          allowOther: q.isOther,
        }))
        return this.ask(
          { id: params.itemId, provider: 'codex', kind: 'question', name: 'request_user_input', questions, input: params },
          params.turnId,
          (response) => {
            if (response.behavior === 'deny') return { answers: {} }
            const answers: Record<string, { answers: string[] }> = {}
            for (const [key, value] of Object.entries(response.answers ?? {})) answers[key] = { answers: Array.isArray(value) ? value : [value] }
            return { answers }
          },
        )
      }
      case 'mcpServer/elicitation/request':
        return Promise.resolve({ action: 'decline', content: null, _meta: null })
      default:
        return Promise.reject(new Error(`agentkit codex capsule does not handle ${method}`))
    }
  }

  private ask(request: PermissionRequest, turnId: string | undefined, toWire: (response: PermissionResponse) => unknown): Promise<unknown> {
    const { promise, resolve } = deferred<unknown>()
    this.permissions.set(request.id, { request, reply: (response) => resolve(toWire(response)) })
    this.events.emit({ type: 'permission_requested', provider: 'codex', request, turnId })
    return promise
  }

  getPendingPermissions(): PermissionRequest[] {
    return [...this.permissions.values()].map((entry) => entry.request)
  }

  async respondToPermission(requestId: string, response: PermissionResponse): Promise<void> {
    const entry = this.permissions.get(requestId)
    if (!entry) throw new Error(`no pending codex permission ${requestId}`)
    this.permissions.delete(requestId)
    entry.reply(response)
    this.events.emit({ type: 'permission_resolved', provider: 'codex', requestId, response })
    if (response.behavior === 'deny' && response.interrupt && this.activeTurnId) void this.interrupt()
  }

  // ------------------------------------------------------------ settings

  async getRuntimeInfo(): Promise<RuntimeInfo> {
    return { provider: 'codex', sessionId: this.threadId, model: this.model, modeId: this.modeId, thinkingOptionId: this.effort, fast: this.fast }
  }
  async getModes(): Promise<AgentMode[]> {
    return CODEX_MODES
  }
  async setMode(modeId: string): Promise<void> {
    if (!PRESETS[modeId]) throw new Error(`unknown codex mode ${modeId}; expected ${Object.keys(PRESETS).join(', ')}`)
    this.modeId = modeId
    this.events.emit({ type: 'mode_changed', provider: 'codex', modeId })
  }
  async setModel(model: string | null): Promise<void> {
    this.model = model
    this.events.emit({ type: 'model_changed', provider: 'codex', model })
  }
  async setThinking(effort: string | null): Promise<void> {
    this.effort = effort
    this.events.emit({ type: 'thinking_changed', provider: 'codex', thinkingOptionId: effort })
  }
  async setFast(enabled: boolean): Promise<void> {
    if (enabled && !(await this.fastTierId())) throw new Error(`codex model ${this.model ?? 'default'} has no fast service tier`)
    this.fast = enabled
    this.events.emit({ type: 'fast_changed', provider: 'codex', enabled })
  }

  /** The current model's "Fast" tier id (Codex calls it e.g. `priority`), read from model/list. */
  private async fastTierId(): Promise<string | null> {
    this.models ??= this.rpc.request('model/list', {}).then((r) => r.data ?? [], () => [])
    const models = await this.models
    const model = models.find((m) => m.model === this.model || m.id === this.model) ?? models.find((m) => m.isDefault) ?? models[0]
    const tiers: Array<{ id: string; name: string }> = model?.serviceTiers ?? []
    return (tiers.find((tier) => tier.name.toLowerCase() === 'fast') ?? tiers.find((tier) => tier.id === 'fast'))?.id ?? null
  }

  private async serviceTier(): Promise<string> {
    if (!this.fast) return 'default'
    return (await this.fastTierId()) ?? 'default'
  }

  async listCommands(): Promise<SlashCommand[]> {
    return []
  }

  describePersistence(): PersistenceHandle {
    return { provider: 'codex', sessionId: this.threadId, cwd: this.config.cwd, metadata: { modeId: this.modeId, model: this.model, effort: this.effort, fast: this.fast } }
  }

  async *history(): AsyncIterable<TimelineItem> {
    const { thread } = await this.rpc.request('thread/read', { threadId: this.threadId, includeTurns: true })
    for (const turn of thread.turns ?? []) {
      for (const item of turn.items ?? []) {
        const mapped = mapCodexItem(item)
        if (mapped) yield mapped
      }
    }
  }

  /** Conversation rewind: fork the thread right before the turn that holds `messageId`. */
  async rewind(input: { messageId: string; scope: 'conversation' | 'files' | 'both' }): Promise<void> {
    if (input.scope !== 'conversation') throw new Error('codex can only rewind the conversation, not files')
    await this.interrupt()
    const { thread } = await this.rpc.request('thread/read', { threadId: this.threadId, includeTurns: true })
    const turns: any[] = thread.turns ?? []
    const index = turns.findIndex((turn) => (turn.items ?? []).some((item: any) => item.type === 'userMessage' && item.id === input.messageId))
    if (index < 0) throw new Error(`codex message ${input.messageId} not found in thread`)
    const preset = PRESETS[this.modeId] ?? PRESETS[DEFAULT_CODEX_MODE]
    if (index === 0) {
      const started = await this.rpc.request('thread/start', threadParams({ ...this.config, model: this.model ?? undefined }, this.modeId))
      this.threadId = started.thread.id
    } else {
      const forked = await this.rpc.request('thread/fork', {
        threadId: this.threadId,
        lastTurnId: turns[index - 1].id,
        cwd: this.config.cwd,
        approvalPolicy: preset.approvalPolicy,
        sandbox: preset.sandbox,
        excludeTurns: true,
      })
      this.threadId = forked.thread.id
    }
    this.events.emit({ type: 'session_started', provider: 'codex', sessionId: this.threadId })
  }

  async fork(input: { beforeMessageId?: string }): Promise<PersistenceHandle> {
    let lastTurnId: string | undefined
    if (input.beforeMessageId) {
      const { thread } = await this.rpc.request('thread/read', { threadId: this.threadId, includeTurns: true })
      const turns: any[] = thread.turns ?? []
      const index = turns.findIndex((turn) => (turn.items ?? []).some((item: any) => item.type === 'userMessage' && item.id === input.beforeMessageId))
      if (index < 0) throw new Error(`codex message ${input.beforeMessageId} not found in thread`)
      if (index === 0) throw new Error('nothing before the first message to fork; open a new session instead')
      lastTurnId = turns[index - 1].id
    }
    const preset = PRESETS[this.modeId] ?? PRESETS[DEFAULT_CODEX_MODE]
    // The app-server that forks becomes the new thread's writer until it exits,
    // so fork on a throwaway one; resumeSession() can then take the thread.
    const rpc = this.sideChannel ? await this.sideChannel() : this.rpc
    try {
      const forked = await rpc.request('thread/fork', {
        threadId: this.threadId,
        ...(lastTurnId ? { lastTurnId } : {}),
        cwd: this.config.cwd,
        approvalPolicy: preset.approvalPolicy,
        sandbox: preset.sandbox,
        excludeTurns: true,
      })
      return { ...this.describePersistence(), sessionId: forked.thread.id }
    } finally {
      if (rpc !== this.rpc) await rpc.dispose()
    }
  }

  /** `thread/compact/start` runs as a turn on the thread; resolve when that turn ends. Codex takes no instructions. */
  async compact(_input: { instructions?: string }): Promise<void> {
    if (this.activeTurnId) throw new Error('codex cannot compact while a turn is running')
    const ended = new Promise<AgentEvent>((resolve) => {
      const off = this.subscribe((event) => {
        if (isTerminalEvent(event)) {
          off()
          resolve(event)
        }
      })
    })
    await this.rpc.request('thread/compact/start', { threadId: this.threadId })
    const event = await Promise.race([ended, new Promise<null>((r) => setTimeout(() => r(null), 300_000))])
    if (!event) throw new Error('codex compaction did not finish within 5 minutes')
    if (event.type !== 'turn_completed') throw new Error(`codex compact ${event.type}`)
  }

  /** Exact once a turn has reported usage; before that, whatever an earlier session learned for this model. */
  async contextWindow(): Promise<ContextWindow> {
    return {
      usedTokens: this.lastUsage?.contextWindowUsedTokens ?? null,
      maxTokens: this.lastUsage?.contextWindowMaxTokens ?? (this.model ? (knownWindows.get(this.model) ?? null) : null),
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.interrupt().catch(() => undefined)
    this.closed = true
    await this.rpc.dispose()
    this.events.clear()
  }
}

function decision(response: PermissionResponse): string {
  if (response.behavior === 'deny') return response.interrupt ? 'cancel' : 'decline'
  return response.actionId === 'always' ? 'acceptForSession' : 'accept'
}

export function toCodexInput(prompt: PromptInput): unknown[] {
  if (typeof prompt === 'string') return [{ type: 'text', text: prompt, text_elements: [] }]
  return prompt.map((block) =>
    block.type === 'text' ? { type: 'text', text: block.text, text_elements: [] } : { type: 'image', url: `data:${block.mimeType};base64,${block.data}` },
  )
}
