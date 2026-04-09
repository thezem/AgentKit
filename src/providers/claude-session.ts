import {
  NoActiveRunError,
  RunInProgressError,
  SessionClosedError,
} from '../errors.ts'
import {
  query,
  type ElicitationRequest,
  type ElicitationResult,
  type Options as ClaudeOptions,
  type PermissionMode as ClaudePermissionMode,
  type PermissionResult,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue, Deferred } from '../utils.ts'
import { mergeAgentRunOptions } from '../agent-session.ts'
import { createAgentRun } from '../agent-run.ts'
import { normalizeSessionHandle } from '../handle.ts'
import type {
  AgentEvent,
  AgentHandlers,
  AgentInput,
  AgentSessionHandle,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionSummary,
  CreateClaudeOptions,
} from '../agent-types.ts'
import { ClaudePromptQueue } from './claude-prompt-queue.ts'

type ClaudeResumeState = {
  sessionId?: string
  resume?: string
  resumeSessionAt?: string
}

type ClaudeTurnContext = {
  turnId: string
  handlers?: AgentHandlers
  events: AsyncQueue<AgentEvent>
  done: Deferred<AgentRunResult>
  items: unknown[]
  text: string
  interrupted: boolean
  forcedFailureReason: string | null
}

export class ClaudeSession implements AgentSession {
  private static runtimeFactory = (input: Parameters<typeof query>[0]): Query => query(input)

  readonly provider = 'claude' as const
  readonly name: string

  private readonly promptQueue = new ClaudePromptQueue()
  private readonly runtime: Query
  private readonly runtimeConsumer: Promise<void>
  private readonly turns: ClaudeTurnContext[] = []
  private readonly baseOptions?: AgentRunOptions
  private readonly createClaude?: CreateClaudeOptions
  private readonly onClosed?: (name: string, session: ClaudeSession) => void

  private turnSeq = 0
  private closed = false
  private closeReason: Error | null = null

  private sessionId: string | null = null
  private resumeState: ClaudeResumeState | null = null
  private readonly sessionCwd: string
  private currentModel: string | undefined
  private currentPermissionMode: string | undefined

  constructor(
    name: string,
    createClaude?: CreateClaudeOptions,
    baseOptions?: AgentRunOptions,
    onClosed?: (name: string, session: ClaudeSession) => void,
  ) {
    this.name = name
    this.baseOptions = baseOptions
    this.createClaude = createClaude
    this.onClosed = onClosed
    this.currentModel = baseOptions?.model ?? createClaude?.model
    this.currentPermissionMode = baseOptions?.permissionMode ?? createClaude?.permissionMode
    this.resumeState =
      createClaude?.resume || createClaude?.resumeSessionAt
        ? {
            ...(createClaude.resume ? { resume: createClaude.resume } : {}),
            ...(createClaude.resumeSessionAt ? { resumeSessionAt: createClaude.resumeSessionAt } : {}),
          }
        : null

    const runtimeOptions = this.buildRuntimeOptions()
    this.sessionCwd = runtimeOptions.cwd ?? process.cwd()

    this.runtime = ClaudeSession.runtimeFactory({
      prompt: this.promptQueue,
      options: runtimeOptions,
    })

    this.runtimeConsumer = this.consumeRuntime()
  }

  get id(): string | null {
    return this.sessionId
  }

  getHandle(): AgentSessionHandle | null {
    const resumeKey = this.resumeState?.resume ?? this.sessionId ?? undefined
    const sessionId = this.sessionId ?? this.resumeState?.sessionId ?? null
    if (!resumeKey && !sessionId) return null
    return normalizeSessionHandle({
      provider: 'claude',
      sessionId,
      ...(this.name ? { name: this.name } : {}),
      ...(resumeKey ? { resumeKey } : {}),
      ...(this.resumeState?.resumeSessionAt ? { resumeAt: this.resumeState.resumeSessionAt } : {}),
      raw: this.resumeState,
    })
  }

  getSessionInfo(): AgentSessionSummary {
    return {
      provider: 'claude',
      name: this.name,
      sessionId: this.sessionId ?? this.resumeState?.sessionId ?? null,
      handle: this.getHandle() ?? normalizeSessionHandle({ provider: 'claude', sessionId: this.sessionId, name: this.name }),
      status: this.closed ? 'closed' : this.turns.length > 0 ? 'active' : 'idle',
      ...(this.currentModel ? { model: this.currentModel } : {}),
      ...(this.sessionCwd ? { cwd: this.sessionCwd } : {}),
      raw: {
        runtime: this.getRuntimeMetadata(),
        resumeState: this.resumeState,
      },
    }
  }

  async run(input: AgentInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return (await this.start(input, options)).result
  }

  async stream(input: AgentInput, options?: AgentRunOptions): Promise<AsyncIterable<AgentEvent>> {
    return (await this.start(input, options)).events
  }

  async start(input: AgentInput, options?: AgentRunOptions) {
    const context = await this.startTurn(input, options)
    return createAgentRun({
      runId: context.turnId,
      source: context.events,
      interrupt: () => this.interrupt(),
    })
  }

  async interrupt(): Promise<void> {
    if (this.closed) {
      throw this.closeReason ?? new SessionClosedError('claude', this.name)
    }
    const current = this.turns[0]
    if (!current) {
      throw new NoActiveRunError('claude', this.name)
    }
    current.interrupted = true
    await this.runtime.interrupt()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.closeReason = new SessionClosedError('claude', this.name)
    this.promptQueue.close()
    this.runtime.close()
    this.failPendingTurns(this.closeReason)
    this.onClosed?.(this.name, this)
    await this.runtimeConsumer
  }

  isClosed(): boolean {
    return this.closed
  }

  getRuntimeMetadata(): { sessionId: string | null; currentModel?: string; currentPermissionMode?: string } {
    return {
      sessionId: this.sessionId,
      ...(this.currentModel ? { currentModel: this.currentModel } : {}),
      ...(this.currentPermissionMode ? { currentPermissionMode: this.currentPermissionMode } : {}),
    }
  }

  getLastResumeState(): ClaudeResumeState | null {
    return this.resumeState
  }

  private async startTurn(input: AgentInput, options?: AgentRunOptions): Promise<ClaudeTurnContext> {
    if (this.closed) {
      throw this.closeReason ?? new SessionClosedError('claude', this.name)
    }

    if (this.turns.length > 0) {
      throw new RunInProgressError('claude', this.name)
    }

    const merged = mergeAgentRunOptions(this.baseOptions, options)
    await this.applyMutableRuntimeOptions(merged)

    const context: ClaudeTurnContext = {
      turnId: String(++this.turnSeq),
      handlers: merged?.handlers,
      events: new AsyncQueue<AgentEvent>(),
      done: new Deferred<AgentRunResult>(),
      items: [],
      text: '',
      interrupted: false,
      forcedFailureReason: null,
    }

    this.turns.push(context)
    this.promptQueue.push(toClaudeUserMessage(input))
    return context
  }

  private buildRuntimeOptions(): ClaudeOptions {
    const includePartialMessages =
      this.baseOptions?.includePartialMessages ??
      this.createClaude?.includePartialMessages ??
      true

    const options: ClaudeOptions = {
      ...(this.createClaude?.options ?? {}),
      ...(this.baseOptions?.cwd ? { cwd: this.baseOptions.cwd } : {}),
      ...(this.baseOptions?.model ? { model: this.baseOptions.model } : {}),
      ...(this.baseOptions?.env ? { env: this.baseOptions.env } : {}),
      ...(this.baseOptions?.additionalDirectories ? { additionalDirectories: this.baseOptions.additionalDirectories } : {}),
      ...(this.baseOptions?.permissionMode ? { permissionMode: toClaudePermissionMode(this.baseOptions.permissionMode) } : {}),
      ...(this.createClaude?.cwd ? { cwd: this.createClaude.cwd } : {}),
      ...(this.createClaude?.model ? { model: this.createClaude.model } : {}),
      ...(this.createClaude?.env ? { env: this.createClaude.env } : {}),
      ...(this.createClaude?.additionalDirectories ? { additionalDirectories: this.createClaude.additionalDirectories } : {}),
      ...(this.createClaude?.permissionMode ? { permissionMode: this.createClaude.permissionMode } : {}),
      ...(this.createClaude?.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: this.createClaude.pathToClaudeCodeExecutable }
        : {}),
      ...(this.createClaude?.allowDangerouslySkipPermissions !== undefined
        ? { allowDangerouslySkipPermissions: this.createClaude.allowDangerouslySkipPermissions }
        : {}),
      ...(this.createClaude?.resume ? { resume: this.createClaude.resume } : {}),
      ...(this.createClaude?.resumeSessionAt ? { resumeSessionAt: this.createClaude.resumeSessionAt } : {}),
      includePartialMessages,
      canUseTool: (toolName, toolInput, sdkOptions) => this.handleToolApproval(toolName, toolInput, sdkOptions),
      onElicitation: (request) => this.handleElicitation(request),
    }

    if (options.permissionMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true
    }

    return options
  }

  private async applyMutableRuntimeOptions(options?: AgentRunOptions): Promise<void> {
    if (!options) return
    if (options.cwd && options.cwd !== this.sessionCwd) {
      throw new Error(
        `Claude sessions in Codexkit are long-lived and keep a fixed cwd for their lifetime. Session cwd is "${this.sessionCwd}", but turn requested "${options.cwd}".`,
      )
    }
    if (options.additionalDirectories && this.baseOptions?.additionalDirectories) {
      const current = this.baseOptions.additionalDirectories.join('|')
      const next = options.additionalDirectories.join('|')
      if (current !== next) {
        throw new Error('Claude session runtime is long-lived; changing additionalDirectories per-turn is not supported')
      }
    }

    if (options.model && options.model !== this.currentModel) {
      await this.runtime.setModel(options.model)
      this.currentModel = options.model
    }

    if (options.permissionMode && options.permissionMode !== this.currentPermissionMode) {
      const mode = toClaudePermissionMode(options.permissionMode)
      await this.runtime.setPermissionMode(mode)
      this.currentPermissionMode = options.permissionMode
    }
  }

  private async consumeRuntime(): Promise<void> {
    try {
      for await (const message of this.runtime) {
        this.captureSessionMetadata(message)
        this.routeRuntimeMessage(message)
      }
      if (!this.closed) {
        const error = new Error('Claude runtime ended unexpectedly')
        this.closed = true
        this.closeReason = error
        this.failPendingTurns(error)
      }
    } catch (error) {
      const wrapped = new Error(`Claude runtime failed: ${errorToString(error)}`)
      this.closed = true
      this.closeReason = wrapped
      this.failPendingTurns(wrapped)
    }
  }

  private captureSessionMetadata(message: SDKMessage): void {
    if ('session_id' in message && typeof message.session_id === 'string') {
      this.sessionId = message.session_id
      this.resumeState = {
        ...(this.resumeState ?? {}),
        sessionId: message.session_id,
        resume: message.session_id,
      }
    }
  }

  private routeRuntimeMessage(message: SDKMessage): void {
    const current = this.turns[0]
    if (!current) return

    current.items.push(message)

    if (message.type === 'stream_event') {
      const delta = extractDeltaText(message)
      if (delta) {
        current.text += delta
        current.events.push({ provider: 'claude', type: 'message.delta', text: delta, raw: message })
      } else {
        current.events.push({
          provider: 'claude',
          type: 'provider.notification',
          method: 'stream_event',
          raw: message,
        })
      }
      return
    }

    if (message.type === 'assistant') {
      const text = extractAssistantText(message)
      if (text) {
        current.text = text
        current.events.push({ provider: 'claude', type: 'message.completed', text, raw: message })
      } else {
        current.events.push({
          provider: 'claude',
          type: 'provider.notification',
          method: 'assistant',
          raw: message,
        })
      }

      this.resumeState = {
        ...(this.resumeState ?? {}),
        ...(this.sessionId ? { sessionId: this.sessionId, resume: this.sessionId } : {}),
        resumeSessionAt: String(message.uuid),
      }
      return
    }

    if (message.type === 'system') {
      if (message.subtype === 'status') {
        const status = message.status ?? 'idle'
        current.events.push({ provider: 'claude', type: 'status', status, raw: message })
        if (message.permissionMode) {
          this.currentPermissionMode = message.permissionMode
        }
        return
      }
      if (message.subtype === 'session_state_changed') {
        current.events.push({ provider: 'claude', type: 'status', status: message.state, raw: message })
        return
      }
      current.events.push({
        provider: 'claude',
        type: 'provider.notification',
        method: `system.${message.subtype}`,
        raw: message,
      })
      return
    }

    if (message.type === 'result') {
      const result = mapClaudeResultToRunResult(
        message,
        current,
        this.sessionId,
        this.name,
        this.resumeState,
        current.forcedFailureReason,
      )
      current.events.push({ provider: 'claude', type: 'turn.completed', result, raw: message })
      current.done.resolve(result)
      current.events.end()
      this.turns.shift()
      return
    }

    if (message.type === 'auth_status') {
      current.events.push({
        provider: 'claude',
        type: 'status',
        status: message.isAuthenticating ? 'authenticating' : 'authenticated',
        raw: message,
      })
      return
    }

    current.events.push({
      provider: 'claude',
      type: 'provider.notification',
      method: message.type,
      raw: message,
    })
  }

  private async handleToolApproval(
    toolName: string,
    toolInput: Record<string, unknown>,
    sdkOptions: {
      blockedPath?: string
      decisionReason?: string
      title?: string
      description?: string
      displayName?: string
      suggestions?: unknown
      toolUseID: string
      agentID?: string
      signal: AbortSignal
    },
  ): Promise<PermissionResult> {
    const current = this.turns[0]
    const request = {
      provider: 'claude' as const,
      kind: toolName,
      payload: {
        toolName,
        input: toolInput,
        toolUseId: sdkOptions.toolUseID,
        blockedPath: sdkOptions.blockedPath,
        decisionReason: sdkOptions.decisionReason,
        title: sdkOptions.title,
        description: sdkOptions.description,
        displayName: sdkOptions.displayName,
        suggestions: sdkOptions.suggestions as unknown,
      },
    }

    current?.events.push({
      provider: 'claude',
      type: 'approval.tool',
      request,
      raw: { toolName, toolInput, sdkOptions },
    })

    const decision = current?.handlers?.onToolApproval
      ? await current.handlers.onToolApproval(request)
      : this.currentPermissionMode === 'bypassPermissions'
        ? 'allow'
        : 'deny'

    if (decision === 'allow') {
      return { behavior: 'allow' }
    }

    return {
      behavior: 'deny',
      message: 'Denied by host approval policy',
      interrupt: false,
    }
  }

  private async handleElicitation(request: ElicitationRequest): Promise<ElicitationResult> {
    const current = this.turns[0]
    const userRequest = {
      provider: 'claude' as const,
      question: request.message,
      options: toUserInputOptions(request.requestedSchema),
      raw: request,
    }

    current?.events.push({
      provider: 'claude',
      type: 'user.input',
      request: userRequest,
      raw: request,
    })

    if (!current?.handlers?.onUserInput) {
      const message = 'Claude requested user input, but no onUserInput handler is configured'
      if (current) {
        current.forcedFailureReason = message
        current.events.push({ provider: 'claude', type: 'error', error: message, raw: request })
      }
      return { action: 'decline' } as ElicitationResult
    }

    const response = await current.handlers.onUserInput(userRequest)
    const content = toElicitationContent(response, request.requestedSchema)
    return {
      action: 'accept',
      content,
    } as ElicitationResult
  }

  private failPendingTurns(error: Error): void {
    while (this.turns.length > 0) {
      const turn = this.turns.shift() as ClaudeTurnContext
      turn.events.push({
        provider: 'claude',
        type: 'error',
        error: error.message,
        raw: error,
      })
      turn.done.reject(error)
      turn.events.end()
    }
  }
}

function toClaudeUserMessage(input: AgentInput): SDKUserMessage {
  const text = normalizeAgentInput(input)
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: text,
    },
  }
}

function normalizeAgentInput(input: AgentInput): string {
  if (typeof input === 'string') {
    return input
  }

  const chunks: string[] = []
  for (const item of input) {
    if (item.type === 'text') {
      chunks.push(item.text)
      continue
    }

    throw new Error(
      `Unsupported Claude input item type "${item.type}". Claude adapter currently supports text-only input in Codexkit.`,
    )
  }

  return chunks.join('\n')
}

function toClaudePermissionMode(mode?: string): ClaudePermissionMode {
  if (
    mode === 'default' ||
    mode === 'acceptEdits' ||
    mode === 'bypassPermissions' ||
    mode === 'plan' ||
    mode === 'dontAsk' ||
    mode === 'auto'
  ) {
    return mode
  }
  return 'default'
}

function mapClaudeResultToRunResult(
  message: SDKResultMessage,
  context: ClaudeTurnContext,
  sessionId: string | null,
  sessionName: string,
  resumeState: ClaudeResumeState | null,
  forcedFailureReason: string | null,
): AgentRunResult {
  const interrupted =
    context.interrupted ||
    message.terminal_reason === 'aborted_streaming' ||
    message.terminal_reason === 'aborted_tools' ||
    message.stop_reason === 'interrupted'

  const status: AgentRunResult['status'] =
    forcedFailureReason !== null ? 'failed' : interrupted ? 'interrupted' : message.subtype === 'success' ? 'completed' : 'failed'

  const text =
    forcedFailureReason ??
    (message.subtype === 'success'
      ? message.result
      : message.errors.join('\n') || context.text || `Claude turn failed with subtype=${message.subtype}`)

  return {
    provider: 'claude',
    sessionId,
    turnId: context.turnId,
    status,
    text,
    items: context.items,
    raw: message,
    ...(resumeState || sessionId
      ? {
          handle: {
            ...normalizeSessionHandle({
              provider: 'claude',
              sessionId: sessionId ?? resumeState?.sessionId ?? null,
              ...(sessionName ? { name: sessionName } : {}),
              ...(resumeState?.resume || sessionId ? { resumeKey: resumeState?.resume ?? sessionId ?? undefined } : {}),
              ...(resumeState?.resumeSessionAt ? { resumeAt: resumeState.resumeSessionAt } : {}),
              raw: resumeState,
            }),
          } as AgentSessionHandle,
        }
      : {}),
    ...(resumeState ? { resumeState } : {}),
  }
}

function extractDeltaText(message: SDKPartialAssistantMessage): string {
  const event = message.event as unknown
  if (!event || typeof event !== 'object') return ''
  const candidate = event as Record<string, unknown>
  const delta = candidate.delta
  if (!delta || typeof delta !== 'object') return ''
  const text = (delta as Record<string, unknown>).text
  return typeof text === 'string' ? text : ''
}

function extractAssistantText(message: SDKAssistantMessage): string {
  const payload = message.message as unknown
  if (!payload || typeof payload !== 'object') return ''
  const content = (payload as Record<string, unknown>).content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const value = block as Record<string, unknown>
    if (typeof value.text === 'string') {
      text += value.text
    }
  }
  return text
}

function toUserInputOptions(schema: Record<string, unknown> | undefined): Array<{ label: string; description?: string }> {
  if (!schema) return []
  const properties = schema.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return []
  return Object.entries(properties).map(([key, value]) => {
    if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).description === 'string') {
      return {
        label: key,
        description: String((value as Record<string, unknown>).description),
      }
    }
    return { label: key }
  })
}

function toElicitationContent(response: string | string[], schema?: Record<string, unknown>): Record<string, unknown> {
  const value = Array.isArray(response) ? response : [response]
  const properties =
    schema && typeof schema === 'object' && !Array.isArray(schema) && schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : null

  if (!properties) {
    return { response: value.length === 1 ? value[0] : value }
  }

  const keys = Object.keys(properties)
  if (keys.length === 1) {
    return { [keys[0]]: value[0] ?? '' }
  }

  const content: Record<string, unknown> = {}
  for (let index = 0; index < keys.length; index += 1) {
    content[keys[index]] = value[index] ?? ''
  }
  return content
}

function errorToString(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
