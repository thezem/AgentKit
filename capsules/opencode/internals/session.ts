import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
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
  TurnOptions,
  Usage,
} from '../../shared/contract.ts'
import { collectRun, deferred, Emitter, nowIso } from '../../shared/runtime.ts'
import type { OpenCodeApi } from './server.ts'
import { OpenCodeTimeline } from './timeline.ts'

export const OPENCODE_CAPABILITIES: Capabilities = {
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
  /** No native fast tier; OpenCode's "-fast" entries are separate model ids. */
  fastMode: false,
  mcpServers: true,
  steer: true,
  slashCommands: true,
  images: true,
  structuredOutput: false,
  rewindConversation: true,
  /** Files revert only together with the conversation (scope 'both'). */
  rewindFiles: true,
  archive: false,
  fork: true,
  compact: true,
  systemPrompt: true,
}

type Lease = { client: OpenCodeApi; exited: Promise<Error>; release(): Promise<void> }
type Turn = { id: string; accepted: boolean; done: ReturnType<typeof deferred<void>>; denied: boolean; interrupting: boolean }

const EXECUTION = new Set(['session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'])

export function modelRef(id: string, variant?: string | null): { providerID: string; id: string; variant?: string } {
  const slash = id.indexOf('/')
  if (slash < 1) throw new Error(`opencode model must be "provider/model", got "${id}"`)
  return { providerID: id.slice(0, slash), id: id.slice(slash + 1), ...(variant ? { variant } : {}) }
}

export class OpenCodeSession implements ProviderSession {
  readonly provider = 'opencode'
  readonly capabilities = OPENCODE_CAPABILITIES
  private readonly events = new Emitter<AgentEvent>()
  private readonly timelineState = new OpenCodeTimeline()
  private readonly abort = new AbortController()
  private readonly pending = new Map<string, { request: PermissionRequest; form?: any }>()
  /** Ids already answered. A snapshot fetched before a reply landed must not resurrect them. */
  private readonly resolved = new Set<string>()
  private readonly lease: Lease
  private readonly config: SessionConfig
  private info: any
  private modes: AgentMode[] = []
  private turn: Turn | null = null
  private seq = 0
  private stream: Promise<void> | null = null
  private syncing: Promise<void> = Promise.resolve()
  private dirty = false
  private syncTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(lease: Lease, info: any, config: SessionConfig) {
    this.lease = lease
    this.info = info
    this.config = config
  }

  private get client(): any {
    return this.lease.client
  }
  private get location() {
    return { directory: this.config.cwd }
  }

  get id(): string {
    return this.info.id
  }

  /** Mark existing history as seen, install MCP + instructions, open the event stream. */
  async initialize(): Promise<void> {
    await waitForLocation(this.client, this.location)
    for (const [server, mcp] of Object.entries(this.config.mcpServers ?? {})) {
      await this.client.mcp.add({
        server,
        location: this.location,
        config:
          mcp.type === 'stdio'
            ? { type: 'local', command: [mcp.command, ...(mcp.args ?? [])], environment: mcp.env, codemode: false }
            : { type: 'remote', url: mcp.url, headers: mcp.headers, oauth: false, codemode: false },
      })
    }
    if (this.config.systemPrompt) {
      await this.client.session.instructions.entry.put({ sessionID: this.id, key: 'agentkit', value: this.config.systemPrompt })
    }
    if (this.config.env) await this.client.session.environment({ sessionID: this.id, variables: this.config.env })
    const agents = await this.client.agent.list({ location: this.location })
    this.modes = (agents.data ?? [])
      .filter((agent: any) => !agent.hidden && agent.mode !== 'subagent')
      .map((agent: any) => ({ id: agent.id, label: agent.name ?? agent.id, description: agent.description }))
    this.timelineState.messages(await this.allMessages())
    const ready = deferred<void>()
    this.stream = this.consume(ready)
    await Promise.race([ready.promise, delay(30_000).then(() => Promise.reject(new Error('opencode event stream did not connect')))])
    void this.lease.exited.then((error) => {
      if (!this.closed && this.turn) this.finish({ type: 'turn_failed', provider: 'opencode', turnId: this.turn.id, error: error.message })
    })
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    return this.events.on(listener)
  }

  // ------------------------------------------------------------ turns

  async startTurn(prompt: PromptInput, options?: TurnOptions): Promise<{ turnId: string }> {
    if (this.closed) throw new Error('opencode session is closed')
    if (this.turn) throw new Error('opencode session already has an active turn')
    if (options?.outputSchema !== undefined) throw new Error('opencode capsule does not support outputSchema yet')
    const turn: Turn = { id: randomUUID(), accepted: false, done: deferred<void>(), denied: false, interrupting: false }
    this.turn = turn
    this.events.emit({ type: 'turn_started', provider: 'opencode', turnId: turn.id })
    try {
      await this.dispatch(prompt, options)
      turn.accepted = true
      this.schedulePoll()
    } catch (error) {
      this.finish({ type: 'turn_failed', provider: 'opencode', turnId: turn.id, error: error instanceof Error ? error.message : String(error) })
    }
    return { turnId: turn.id }
  }

  private async dispatch(prompt: PromptInput, options?: TurnOptions): Promise<void> {
    const input = toInput(prompt)
    const command = input.text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
    if (command && (command[1] === 'compact' || command[1] === 'summarize')) {
      await this.client.session.compact({ sessionID: this.id })
      return
    }
    if (command) {
      const known = (await this.listCommands()).find((entry) => entry.name === command[1])
      if (known?.kind === 'command') {
        await this.client.session.command({ sessionID: this.id, name: known.name, text: command[2] ?? '', files: input.files })
        return
      }
      if (known?.kind === 'skill') {
        await this.client.session.prompt({ sessionID: this.id, text: command[2] ?? `Use the ${known.name} skill.`, files: input.files, skills: [{ id: known.name }] })
        return
      }
    }
    await this.client.session.prompt({
      sessionID: this.id,
      ...input,
      metadata: options?.clientMessageId ? { agentkitClientMessageId: options.clientMessageId } : {},
    })
  }

  run(prompt: PromptInput, options?: TurnOptions): Promise<RunResult> {
    return collectRun({
      provider: 'opencode',
      prompt,
      options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (l) => this.subscribe(l),
      interrupt: () => this.interrupt(),
      sessionId: () => this.id,
    })
  }

  async steer(prompt: PromptInput, options: { expectedTurnId: string }): Promise<{ accepted: boolean }> {
    if (this.turn?.id !== options.expectedTurnId) return { accepted: false }
    await this.client.session.prompt({ sessionID: this.id, ...toInput(prompt), delivery: 'steer' })
    return { accepted: true }
  }

  async interrupt(): Promise<void> {
    const turn = this.turn
    if (!turn) return
    turn.interrupting = true
    await this.client.session.interrupt({ sessionID: this.id }).catch(() => undefined)
    this.requestSync()
    await Promise.race([turn.done.promise, delay(10_000)])
    if (this.turn === turn) this.finish({ type: 'turn_canceled', provider: 'opencode', turnId: turn.id, reason: 'interrupted' })
  }

  private finish(event: Extract<AgentEvent, { type: 'turn_completed' | 'turn_failed' | 'turn_canceled' }>): void {
    const turn = this.turn
    if (!turn || turn.id !== event.turnId) return
    this.turn = null
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    this.events.emit(event)
    turn.done.resolve()
  }

  private async onExecution(event: any): Promise<void> {
    if (event.durable?.seq !== undefined) {
      if (event.durable.seq <= this.seq) return
      this.seq = event.durable.seq
    }
    const turn = this.turn
    if (event.type === 'session.execution.started') {
      if (!turn && !this.closed) {
        // Execution started by someone else (TUI, another client). Surface it as a turn.
        const adopted: Turn = { id: randomUUID(), accepted: true, done: deferred<void>(), denied: false, interrupting: false }
        this.turn = adopted
        this.events.emit({ type: 'turn_started', provider: 'opencode', turnId: adopted.id })
      }
      return
    }
    if (!turn || !turn.accepted) return
    if (event.type === 'session.execution.interrupted' && event.data.reason === 'shutdown' && !turn.denied && !turn.interrupting) return
    await this.sync()
    if (event.type === 'session.execution.succeeded') {
      this.finish({ type: 'turn_completed', provider: 'opencode', turnId: turn.id, usage: await this.usage() })
    } else if (event.type === 'session.execution.failed') {
      this.finish({ type: 'turn_failed', provider: 'opencode', turnId: turn.id, error: event.data.error?.message ?? 'opencode execution failed' })
    } else {
      this.finish({ type: 'turn_canceled', provider: 'opencode', turnId: turn.id, reason: event.data.reason ?? 'interrupted' })
    }
  }

  /** Safety net: SSE has no replay, so poll durable state while a turn is open. */
  private schedulePoll(): void {
    if (this.pollTimer || !this.turn || this.closed) return
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null
      const turn = this.turn
      if (!turn || this.closed) return
      try {
        const active = await this.client.session.active({ signal: this.abort.signal })
        if (!active[this.id] && turn.accepted) {
          for await (const event of this.client.session.log({ sessionID: this.id, follow: false, after: this.seq }, { signal: this.abort.signal })) {
            if (EXECUTION.has(event.type)) await this.onExecution(event)
          }
        }
      } catch {}
      this.schedulePoll()
    }, 5_000)
    this.pollTimer.unref()
  }

  // ------------------------------------------------------------ event stream

  private async consume(ready: ReturnType<typeof deferred<void>>): Promise<void> {
    let connected = false
    while (!this.closed) {
      try {
        for await (const event of this.client.event.subscribe({ signal: this.abort.signal }) as AsyncIterable<any>) {
          if (this.closed) return
          if (event.type === 'server.connected') {
            this.timelineState.resetStreams()
            connected = true
            ready.resolve()
            this.requestSync()
            continue
          }
          this.observe(event)
        }
      } catch (error) {
        if (this.closed) return
        if (!connected) {
          ready.reject(error)
          return
        }
      }
      await delay(200).catch(() => undefined)
    }
  }

  private observe(event: any): void {
    const data = event.data ?? {}
    const sessionID = data.sessionID ?? data.form?.sessionID
    if (sessionID !== this.id) return
    switch (event.type) {
      case 'session.text.started':
      case 'session.reasoning.started':
        this.timelineState.startPart(data.assistantMessageID, event.type === 'session.text.started' ? 'text' : 'reasoning', data.ordinal)
        return
      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const item = this.timelineState.delta(data.assistantMessageID, event.type === 'session.text.delta' ? 'text' : 'reasoning', data.ordinal, data.delta)
        if (item) this.timeline(item)
        return
      }
      case 'session.step.ended':
        void this.usage(data.tokens).then((usage) => this.events.emit({ type: 'usage', provider: 'opencode', usage, turnId: this.turn?.id }))
        break
      case 'permission.replied':
        this.resolvePending(data.requestID, { behavior: data.reply === 'reject' ? 'deny' : 'allow' })
        return
      case 'form.replied':
      case 'form.cancelled':
        this.resolvePending(data.id, { behavior: event.type === 'form.cancelled' ? 'deny' : 'allow' })
        return
    }
    if (EXECUTION.has(event.type)) {
      void this.onExecution(event)
      return
    }
    this.requestSync()
  }

  private timeline(item: TimelineItem): void {
    this.events.emit({ type: 'timeline', provider: 'opencode', item, turnId: this.turn?.id, timestamp: nowIso() })
  }

  /** Debounced snapshot reconcile: messages + permissions. */
  private requestSync(): void {
    if (this.syncTimer || this.closed) return
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.sync().catch(() => undefined)
    }, 25)
  }

  private sync(): Promise<void> {
    this.dirty = true
    this.syncing = this.syncing
      .catch(() => undefined)
      .then(async () => {
        while (this.dirty && !this.closed) {
          this.dirty = false
          const [messages, permissions, forms] = await Promise.all([
            this.allMessages(),
            this.client.permission.list({ sessionID: this.id }),
            this.client.session.form.list({ sessionID: this.id }),
          ])
          for (const item of this.timelineState.messages(messages)) this.timeline(item)
          this.syncPermissions(permissions ?? [], forms ?? [])
        }
      })
    return this.syncing
  }

  private async allMessages(): Promise<any[]> {
    const result: any[] = []
    let cursor: string | undefined
    do {
      const page = await this.client.message.list({ sessionID: this.id, ...(cursor ? { cursor } : { order: 'asc' }), limit: 100 })
      result.push(...(page.data ?? []))
      cursor = page.cursor?.next ?? undefined
    } while (cursor)
    return result
  }

  private lastUsed: number | null = null
  private limits: Promise<Map<string, number>> | null = null

  /** The model's `limit.context` from OpenCode's own model registry. */
  private async maxContext(): Promise<number | null> {
    this.limits ??= this.client.model
      .list({ location: this.location })
      .then((r: any) => new Map<string, number>((r.data ?? []).filter((m: any) => m.limit?.context).map((m: any) => [`${m.providerID}/${m.id}`, m.limit.context])))
      .catch(() => {
        this.limits = null
        return new Map<string, number>()
      })
    let model = this.info?.model
    if (!model) model = (await this.client.model.default({ location: this.location }).catch(() => ({ data: null }))).data
    return model ? ((await this.limits!).get(`${model.providerID}/${model.id}`) ?? null) : null
  }

  async contextWindow(): Promise<ContextWindow> {
    return { usedTokens: this.lastUsed, maxTokens: await this.maxContext() }
  }

  private async usage(stepTokens?: any): Promise<Usage> {
    this.info = await this.client.session.get({ sessionID: this.id }).catch(() => this.info)
    const tokens = this.info?.tokens ?? {}
    return {
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cachedInputTokens: tokens.cache?.read,
      totalCostUsd: this.info?.cost,
      ...(await this.maxContext().then((max) => (max ? { contextWindowMaxTokens: max } : {}))),
      ...(stepTokens
        ? { contextWindowUsedTokens: (this.lastUsed = (stepTokens.input ?? 0) + (stepTokens.output ?? 0) + (stepTokens.reasoning ?? 0) + (stepTokens.cache?.read ?? 0) + (stepTokens.cache?.write ?? 0)) }
        : {}),
    }
  }

  // ------------------------------------------------------------ permissions

  private syncPermissions(permissions: any[], forms: any[]): void {
    for (const request of permissions) {
      if (this.pending.has(request.id) || this.resolved.has(request.id)) continue
      const pending: PermissionRequest = {
        id: request.id,
        provider: 'opencode',
        kind: 'tool',
        name: request.action,
        title: request.action,
        description: request.message ?? (request.resources ?? []).join('\n'),
        input: request,
        actions: [
          { id: 'once', label: 'Allow once', behavior: 'allow' },
          { id: 'always', label: 'Always allow', behavior: 'allow' },
          { id: 'deny', label: 'Deny', behavior: 'deny' },
        ],
      }
      this.pending.set(request.id, { request: pending })
      this.events.emit({ type: 'permission_requested', provider: 'opencode', request: pending, turnId: this.turn?.id })
    }
    for (const form of forms) {
      if (this.pending.has(form.id) || this.resolved.has(form.id)) continue
      const pending: PermissionRequest = {
        id: form.id,
        provider: 'opencode',
        kind: 'question',
        name: 'question',
        title: form.title,
        input: form,
        questions: (form.fields ?? []).map((field: any) => ({
          id: field.key,
          header: field.title ?? field.key,
          question: field.description ?? field.title ?? field.key,
          options: 'options' in field ? field.options?.map((o: any) => ({ label: o.label ?? o.value, description: o.description })) : undefined,
          multiSelect: field.type === 'multiselect',
          allowOther: field.custom === true,
        })),
      }
      this.pending.set(form.id, { request: pending, form })
      this.events.emit({ type: 'permission_requested', provider: 'opencode', request: pending, turnId: this.turn?.id })
    }
  }

  private resolvePending(requestId: string, response: PermissionResponse): void {
    this.resolved.add(requestId)
    if (!this.pending.delete(requestId)) return
    this.events.emit({ type: 'permission_resolved', provider: 'opencode', requestId, response })
  }

  getPendingPermissions(): PermissionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  async respondToPermission(requestId: string, response: PermissionResponse): Promise<void> {
    const entry = this.pending.get(requestId)
    if (!entry) throw new Error(`no pending opencode permission ${requestId}`)
    // Mark first so a concurrent snapshot cannot re-emit this request while the reply is in flight.
    this.resolved.add(requestId)
    try {
      await this.reply(entry, requestId, response)
    } catch (error) {
      // 404 = OpenCode already settled it (timeout, another client, turn ended). Not an error for the caller.
      if (!/HTTP 404/.test(String(error instanceof Error ? error.message + String((error as any).cause?.message ?? '') : error))) {
        this.resolved.delete(requestId)
        throw error
      }
    }
    if (response.behavior === 'deny' && this.turn) this.turn.denied = true
    this.resolvePending(requestId, response)
  }

  private async reply(entry: { request: PermissionRequest; form?: any }, requestId: string, response: PermissionResponse): Promise<void> {
    if (entry.form) {
      if (response.behavior === 'deny') await this.client.session.form.cancel({ sessionID: this.id, formID: entry.form.id })
      else {
        const answer: Record<string, unknown> = {}
        for (const field of entry.form.fields ?? []) {
          const value = response.answers?.[field.key]
          if (value === undefined) continue
          answer[field.key] = field.type === 'multiselect' ? (Array.isArray(value) ? value : [value]) : Array.isArray(value) ? value[0] : coerce(field.type, value)
        }
        await this.client.session.form.reply({ sessionID: this.id, formID: entry.form.id, answer })
      }
    } else {
      await this.client.permission.reply({
        sessionID: this.id,
        requestID: requestId,
        decision: response.behavior === 'deny' ? 'reject' : response.actionId === 'always' ? 'always' : 'once',
      })
    }
  }

  // ------------------------------------------------------------ settings

  async getRuntimeInfo(): Promise<RuntimeInfo> {
    this.info = await this.client.session.get({ sessionID: this.id })
    let model = this.info.model
    if (!model) model = (await this.client.model.default({ location: this.location }).catch(() => ({ data: null }))).data
    return {
      provider: 'opencode',
      sessionId: this.id,
      model: model ? `${model.providerID}/${model.id}` : null,
      modeId: this.info.agent ?? null,
      thinkingOptionId: model?.variant ?? null,
      fast: false,
      ...(this.info.model ? {} : { extra: { modelIsDefault: true } }),
    }
  }
  async getModes(): Promise<AgentMode[]> {
    return this.modes
  }
  async setMode(modeId: string): Promise<void> {
    await this.client.session.switchAgent({ sessionID: this.id, agent: modeId })
    this.info.agent = modeId
    this.events.emit({ type: 'mode_changed', provider: 'opencode', modeId })
  }
  async setModel(model: string | null): Promise<void> {
    const ref = model ? modelRef(model) : (await this.client.model.default({ location: this.location })).data
    if (!ref) throw new Error('opencode has no default model')
    await this.client.session.switchModel({ sessionID: this.id, model: { id: ref.id, providerID: ref.providerID } })
    this.info.model = { id: ref.id, providerID: ref.providerID }
    this.events.emit({ type: 'model_changed', provider: 'opencode', model: `${ref.providerID}/${ref.id}` })
  }
  async setThinking(variant: string | null): Promise<void> {
    const model = this.info.model
    if (!model) throw new Error('select an opencode model before choosing a variant')
    await this.client.session.switchModel({ sessionID: this.id, model: { id: model.id, providerID: model.providerID, ...(variant ? { variant } : {}) } })
    this.info.model = { ...model, variant: variant ?? undefined }
    this.events.emit({ type: 'thinking_changed', provider: 'opencode', thinkingOptionId: variant })
  }
  async listCommands(): Promise<SlashCommand[]> {
    const [commands, skills] = await Promise.all([this.client.command.list({ location: this.location }), this.client.skill.list({ location: this.location })])
    const out = new Map<string, SlashCommand>()
    for (const name of ['compact', 'summarize']) out.set(name, { name, description: 'Compact the session', kind: 'command' })
    for (const c of commands.data ?? []) out.set(c.name, { name: c.name, description: c.description ?? '', kind: 'command' })
    for (const s of skills.data ?? []) if (!out.has(s.id)) out.set(s.id, { name: s.id, description: s.description ?? '', kind: 'skill' })
    return [...out.values()]
  }

  describePersistence(): PersistenceHandle {
    return { provider: 'opencode', sessionId: this.id, cwd: this.config.cwd }
  }

  async *history(): AsyncIterable<TimelineItem> {
    yield* new OpenCodeTimeline().messages(await this.allMessages())
  }

  async rewind(input: { messageId: string; scope: 'conversation' | 'files' | 'both' }): Promise<void> {
    if (input.scope === 'files') throw new Error('opencode reverts files together with the conversation; use scope "both"')
    await this.interrupt()
    await this.client.session.revert.stage({ sessionID: this.id, messageID: input.messageId, files: input.scope === 'both' })
    await this.client.session.revert.commit({ sessionID: this.id })
  }

  async fork(input: { beforeMessageId?: string }): Promise<PersistenceHandle> {
    if (input.beforeMessageId) {
      const messages: any[] = await this.allMessages()
      const index = messages.findIndex((message) => (message.info?.id ?? message.id) === input.beforeMessageId)
      if (index < 0) throw new Error(`opencode message ${input.beforeMessageId} not found`)
      if (index === 0) throw new Error('nothing before the first message to fork; open a new session instead')
    }
    const info: any = await this.client.session.fork({ sessionID: this.id, ...(input.beforeMessageId ? { before: input.beforeMessageId } : {}) })
    return { provider: 'opencode', sessionId: info.id ?? info.data?.id, cwd: this.config.cwd }
  }

  async compact(_input: { instructions?: string }): Promise<void> {
    const result = await this.run('/compact')
    if (result.status !== 'completed') throw new Error(`opencode compact ${result.status}: ${result.error ?? ''}`)
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.interrupt().catch(() => undefined)
    this.closed = true
    this.abort.abort()
    if (this.syncTimer) clearTimeout(this.syncTimer)
    if (this.pollTimer) clearTimeout(this.pollTimer)
    await this.stream?.catch(() => undefined)
    await this.syncing.catch(() => undefined)
    try {
      if (this.config.persist === false) await this.client.session.remove({ sessionID: this.id })
    } finally {
      await this.lease.release()
      this.events.clear()
    }
  }
}

function toInput(prompt: PromptInput): { text: string; files: Array<{ uri: string }> } {
  if (typeof prompt === 'string') return { text: prompt, files: [] }
  const text: string[] = []
  const files: Array<{ uri: string }> = []
  for (const block of prompt) {
    if (block.type === 'text') text.push(block.text)
    else files.push({ uri: `data:${block.mimeType};base64,${block.data}` })
  }
  return { text: text.join('\n'), files }
}

function coerce(type: string, value: string): unknown {
  if (type === 'boolean') return value === 'true'
  if (type === 'number' || type === 'integer') return Number(value)
  return value
}

/** A cold location reports zero plugins until config loads; wait briefly so commands/agents are populated. */
export async function waitForLocation(client: any, location: { directory: string }, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const plugins = await client.plugin.list({ location }, { signal: AbortSignal.timeout(5_000) })
      if ((plugins.data ?? []).length > 0) return
    } catch {}
    await delay(100)
  }
}
