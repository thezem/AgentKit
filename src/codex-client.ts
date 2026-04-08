import { EventEmitter } from 'node:events'
import { CodexAuth } from './auth.ts'
import { CodexSession, CodexThread } from './thread.ts'
import { ConcurrentTurnError, QueueOverflowError } from './errors.ts'
import { AppServerTransport } from './transport.ts'
import type {
  CodexAccount,
  CodexStreamEvent,
  CodexThreadData,
  CommandApprovalDecision,
  CommandApprovalRequest,
  CreateCodexOptions,
  DynamicToolRequest,
  DynamicToolResponse,
  FileApprovalDecision,
  FileApprovalRequest,
  JsonRpcNotification,
  JsonRpcRequest,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  RequestHandlers,
  RunOptions,
  RunResult,
  SandboxMode,
  ThreadOptions,
  ToolInputAnswerMap,
  ToolInputRequest,
  TurnItem,
  UserInput,
} from './types.ts'
import { AsyncQueue, Deferred, assertObject, asArray, validateUserInput } from './utils.ts'

type TurnController = {
  thread: CodexThread
  threadId: string
  turnId: string | null
  handlers: RequestHandlers
  events: AsyncQueue<CodexStreamEvent>
  done: Deferred<RunResult>
  items: TurnItem[]
  messageBuffer: Map<string, string>
  completed: boolean
  queueMaxSize?: number
}

type ClientLogger = NonNullable<NonNullable<CreateCodexOptions['diagnostics']>['logger']>

type TurnState = 'starting' | 'active'

class CodexThreadsApi {
  private readonly client: CodexClient

  constructor(client: CodexClient) {
    this.client = client
  }

  async create(options?: ThreadOptions): Promise<CodexThread> {
    const response = await this.client.raw.request<{ thread: CodexThreadData }>(
      'thread/start',
      this.client.toThreadStartParams(options),
    )
    return new CodexThread(this.client, response.thread)
  }

  async resume(threadId: string, options?: ThreadOptions): Promise<CodexThread> {
    const response = await this.client.raw.request<{ thread: CodexThreadData }>('thread/resume', {
      threadId,
      ...this.client.toThreadResumeParams(options),
    })
    return new CodexThread(this.client, response.thread)
  }

  async fork(threadId: string, options?: ThreadOptions): Promise<CodexThread> {
    const response = await this.client.raw.request<{ thread: CodexThreadData }>('thread/fork', {
      threadId,
      ...this.client.toThreadResumeParams(options),
    })
    return new CodexThread(this.client, response.thread)
  }

  async list(): Promise<CodexThreadData[]> {
    const response = await this.client.raw.request<{ threads: CodexThreadData[] }>('thread/list', {})
    return response.threads
  }
}

/**
 * Codex compatibility client backed by `codex app-server`.
 *
 * This surface is provider-specific and mirrors Codex thread/turn semantics.
 */
export class CodexClient {
  readonly options: CreateCodexOptions
  readonly raw: { request: <T = unknown>(method: string, params?: unknown) => Promise<T> }
  readonly auth: CodexAuth
  readonly threads: CodexThreadsApi

  private transport: AppServerTransport
  private readonly events = new EventEmitter()
  private readonly sessions = new Map<string, CodexSession>()
  private readonly pendingLogins = new Map<string, Deferred<CodexAccount>>()
  private readonly startingTurns = new Map<string, TurnController>()
  private readonly activeTurns = new Map<string, TurnController>()
  private readonly threadTurnState = new Map<string, TurnState>()
  private droppedNotificationCount = 0
  private orphanCompletionCount = 0
  private unmatchedNotificationCount = 0
  private unmatchedServerRequestCount = 0

  private constructor(transport: AppServerTransport, options: CreateCodexOptions) {
    this.transport = transport
    this.options = options
    this.raw = {
      request: <T = unknown>(method: string, params?: unknown) => this.transport.request<T>(method, params),
    }
    this.auth = new CodexAuth(this)
    this.threads = new CodexThreadsApi(this)
    this.attachTransportListeners()
  }

  private attachTransportListeners(): void {
    this.transport.onNotification((message) => {
      void this.handleNotification(message).catch((error) => {
        this.droppedNotificationCount += 1
        this.log('error', 'codex.notification.malformed', 'Failed to process notification payload', {
          method: message.method,
          droppedNotificationCount: this.droppedNotificationCount,
          error: errorToString(error),
        })
      })
    })

    this.transport.onServerRequest((message) => {
      void this.handleServerRequest(message).catch((error) => {
        this.log('error', 'codex.server_request.handler_failed', 'Failed handling server request', {
          method: message.method,
          requestId: message.id,
          error: errorToString(error),
        })
        this.transport.respondError(message.id, errorToString(error))
      })
    })

    this.transport.onClosed((error) => {
      for (const login of this.pendingLogins.values()) {
        login.reject(error)
      }
      this.pendingLogins.clear()

      for (const controller of this.startingTurns.values()) {
        this.failTurn(controller, error, 'codex.turn.transport_closed')
      }
      this.startingTurns.clear()

      for (const controller of this.activeTurns.values()) {
        this.failTurn(controller, error, 'codex.turn.transport_closed')
      }
      this.activeTurns.clear()
      this.threadTurnState.clear()
    })
  }

  /**
   * Create and initialize a Codex client transport.
   */
  static async create(options: CreateCodexOptions = {}): Promise<CodexClient> {
    const transport = await AppServerTransport.start({
      codexPath: options.codexPath,
      clientInfo: options.clientInfo,
      env: options.env,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      logger: options.diagnostics?.logger,
    })
    const client = new CodexClient(transport, options)
    if (options.auth?.autoLogin) {
      await client.auth.ensureLoggedIn(options.auth.strategy)
    }
    return client
  }

  /**
   * Return a locally cached `CodexSession` by name.
   *
   * This cache exists only in the current process. Persist thread ids if you
   * need resumability across process restarts.
   */
  session(name: string, options?: RunOptions): CodexSession {
    const existing = this.sessions.get(name)
    if (existing) return existing
    const session = new CodexSession(this, name, { ...this.options.defaults, ...options })
    this.sessions.set(name, session)
    return session
  }

  /**
   * Evict one locally cached session wrapper.
   */
  clearSession(name: string): void {
    this.sessions.delete(name)
  }

  /**
   * Evict all locally cached session wrappers.
   */
  clearSessions(): void {
    this.sessions.clear()
  }

  /**
   * Return current in-process turn state for a thread.
   */
  getThreadTurnState(threadId: string): 'idle' | TurnState {
    return this.threadTurnState.get(threadId) ?? 'idle'
  }

  /**
   * Close transport and fail any inflight work.
   */
  async close(): Promise<void> {
    this.transport.close()
  }

  /**
   * Restart the underlying transport, typically after external auth changes.
   */
  async restartTransport(): Promise<void> {
    this.transport.close()
    this.transport = await AppServerTransport.start({
      codexPath: this.options.codexPath,
      clientInfo: this.options.clientInfo,
      env: this.options.env,
      requestTimeoutMs: this.options.requestTimeoutMs ?? 30_000,
      logger: this.options.diagnostics?.logger,
    })
    this.attachTransportListeners()
  }

  /**
   * Run one turn to completion and return the final turn result.
   * @throws {import('./errors.ts').InputValidationError} If input is malformed.
   * @throws {import('./errors.ts').ConcurrentTurnError} If another turn is already starting or active for the thread.
   * @throws {import('./errors.ts').QueueOverflowError} If the per-turn event queue exceeds `maxQueueSize`.
   * @throws {import('./errors.ts').TransportRequestTimeoutError} If `turn/start` times out.
   */
  async runThread(thread: CodexThread, input: UserInput, options?: RunOptions): Promise<RunResult> {
    const controller = await this.startTurn(thread, input, options)
    void controller.done.promise.catch(() => {
      // Avoid unhandled rejection if event stream fails before result await path.
    })
    for await (const _event of controller.events) {
      // drain
    }
    return controller.done.promise
  }

  /**
   * Start one turn and stream events until completion/failure.
   * @throws {import('./errors.ts').InputValidationError} If input is malformed.
   * @throws {import('./errors.ts').ConcurrentTurnError} If another turn is already starting or active for the thread.
   * @throws {import('./errors.ts').QueueOverflowError} If the per-turn event queue exceeds `maxQueueSize`.
   * @throws {import('./errors.ts').TransportRequestTimeoutError} If `turn/start` times out.
   */
  async streamThread(thread: CodexThread, input: UserInput, options?: RunOptions): Promise<AsyncIterable<CodexStreamEvent>> {
    const controller = await this.startTurn(thread, input, options)
    void controller.done.promise.catch(() => {
      // Avoid unhandled rejection when callers only consume the stream path.
    })
    return controller.events
  }

  toUserInput(input: UserInput): Array<Record<string, unknown>> {
    if (typeof input === 'string') {
      return [{ type: 'text', text: input, text_elements: [] }]
    }

    return input.map((item) => {
      if (item.type === 'text') {
        return { type: 'text', text: item.text, text_elements: [] }
      }
      return item
    })
  }

  toThreadStartParams(options?: ThreadOptions): Record<string, unknown> {
    const merged = this.mergeOptions(options)
    return {
      ...(merged.model ? { model: merged.model } : {}),
      ...(merged.cwd ? { cwd: merged.cwd } : {}),
      ...(merged.approvalPolicy ? { approvalPolicy: merged.approvalPolicy } : {}),
      ...(merged.sandboxMode ? { sandbox: merged.sandboxMode } : {}),
      ...(merged.config ? { config: merged.config } : {}),
      ...(merged.baseInstructions ? { baseInstructions: merged.baseInstructions } : {}),
      ...(merged.developerInstructions ? { developerInstructions: merged.developerInstructions } : {}),
      ...(merged.personality ? { personality: merged.personality } : {}),
      ...(merged.ephemeral !== undefined ? { ephemeral: merged.ephemeral } : {}),
      experimentalRawEvents: false,
      persistExtendedHistory: merged.persistExtendedHistory ?? false,
    }
  }

  toThreadResumeParams(options?: ThreadOptions): Record<string, unknown> {
    const merged = this.mergeOptions(options)
    return {
      ...(merged.model ? { model: merged.model } : {}),
      ...(merged.cwd ? { cwd: merged.cwd } : {}),
      ...(merged.approvalPolicy ? { approvalPolicy: merged.approvalPolicy } : {}),
      ...(merged.sandboxMode ? { sandbox: merged.sandboxMode } : {}),
      ...(merged.config ? { config: merged.config } : {}),
      ...(merged.baseInstructions ? { baseInstructions: merged.baseInstructions } : {}),
      ...(merged.developerInstructions ? { developerInstructions: merged.developerInstructions } : {}),
      ...(merged.personality ? { personality: merged.personality } : {}),
      persistExtendedHistory: merged.persistExtendedHistory ?? false,
    }
  }

  async waitForLogin(loginId: string, timeoutMs: number): Promise<CodexAccount> {
    const deferred = new Deferred<CodexAccount>()
    this.pendingLogins.set(loginId, deferred)

    const timer = setTimeout(() => {
      deferred.reject(new Error(`Timed out waiting for login ${loginId}`))
      this.pendingLogins.delete(loginId)
    }, timeoutMs)

    try {
      return await deferred.promise
    } finally {
      clearTimeout(timer)
      this.pendingLogins.delete(loginId)
    }
  }

  private async startTurn(thread: CodexThread, input: UserInput, options?: RunOptions): Promise<TurnController> {
    validateUserInput(input)

    const existingState = this.threadTurnState.get(thread.id)
    if (existingState) {
      throw new ConcurrentTurnError(thread.id)
    }

    const queueMaxSize = normalizeMaxQueueSize(this.options.maxQueueSize)
    const controller: TurnController = {
      thread,
      threadId: thread.id,
      turnId: null,
      handlers: {
        ...(this.options.handlers ?? {}),
        ...(options?.handlers ?? {}),
      },
      queueMaxSize,
      events: new AsyncQueue<CodexStreamEvent>({ maxSize: queueMaxSize }),
      done: new Deferred<RunResult>(),
      items: [],
      messageBuffer: new Map<string, string>(),
      completed: false,
    }

    this.startingTurns.set(thread.id, controller)
    this.threadTurnState.set(thread.id, 'starting')

    const merged = this.mergeOptions(options)

    try {
      const response = await this.raw.request<{ turn: { id: string } }>('turn/start', {
        threadId: thread.id,
        input: this.toUserInput(input),
        ...(merged.cwd ? { cwd: merged.cwd } : {}),
        ...(merged.approvalPolicy ? { approvalPolicy: merged.approvalPolicy } : {}),
        ...(merged.model ? { model: merged.model } : {}),
        ...(merged.reasoningEffort ? { effort: merged.reasoningEffort } : {}),
        ...(merged.reasoningSummary ? { summary: merged.reasoningSummary } : {}),
        ...(merged.personality ? { personality: merged.personality } : {}),
        ...(merged.outputSchema ? { outputSchema: merged.outputSchema } : {}),
        ...(merged.sandboxMode ? { sandboxPolicy: toSandboxPolicy(merged.sandboxMode, merged.cwd ?? thread.data.cwd) } : {}),
      })

      this.bindTurnController(controller, response.turn.id)
      return controller
    } catch (error) {
      this.startingTurns.delete(thread.id)
      this.threadTurnState.delete(thread.id)
      thread.setActiveTurnId(null)
      controller.events.fail(error)
      controller.done.reject(error)
      throw error
    }
  }

  private bindTurnController(controller: TurnController, turnId: string): void {
    if (controller.turnId) return
    controller.turnId = turnId
    this.startingTurns.delete(controller.threadId)
    this.activeTurns.set(`${controller.threadId}:${turnId}`, controller)
    this.threadTurnState.set(controller.threadId, 'active')
    controller.thread.setActiveTurnId(turnId)
  }

  private async handleNotification(message: JsonRpcNotification): Promise<void> {
    this.events.emit('notification', message)

    if (message.method === 'account/login/completed') {
      const data = assertObject(message.params ?? {}, 'account/login/completed')
      const loginId = typeof data.loginId === 'string' ? data.loginId : null
      if (!loginId) return

      const pending = this.pendingLogins.get(loginId)
      if (!pending) return

      if (data.success !== true) {
        pending.reject(new Error(typeof data.error === 'string' ? data.error : 'ChatGPT login failed'))
        return
      }

      const refreshed = await this.auth.getAccount(true)
      if (!refreshed.account) {
        pending.reject(new Error('Login completed but no account was returned'))
        return
      }

      pending.resolve(refreshed.account)
      return
    }

    if (message.method === 'turn/started') {
      const data = assertObject(message.params ?? {}, 'turn/started')
      const threadId = String(data.threadId)
      const turn = assertObject(data.turn, 'turn/started.turn')
      const turnId = String(turn.id)

      const active = this.activeTurns.get(`${threadId}:${turnId}`)
      if (active) {
        this.pushTurnEvent(active, {
          type: 'turn.started',
          threadId,
          turnId,
          turn: turn as unknown as RunResult['turn'],
        })
        return
      }

      const starting = this.startingTurns.get(threadId)
      if (!starting) {
        this.unmatchedNotificationCount += 1
        this.log('warn', 'codex.notification.unmatched', 'Received unmatched turn/started notification', {
          method: message.method,
          threadId,
          turnId,
          unmatchedNotificationCount: this.unmatchedNotificationCount,
        })
        return
      }

      this.bindTurnController(starting, turnId)
      this.pushTurnEvent(starting, {
        type: 'turn.started',
        threadId,
        turnId,
        turn: turn as unknown as RunResult['turn'],
      })
      return
    }

    if (message.method === 'turn/completed') {
      const data = assertObject(message.params ?? {}, 'turn/completed')
      const threadId = String(data.threadId)
      const turn = assertObject(data.turn, 'turn/completed.turn') as unknown as RunResult['turn']
      const turnId = String(turn.id)
      const controller = this.activeTurns.get(`${threadId}:${turnId}`)
      if (!controller) {
        this.orphanCompletionCount += 1
        this.log('warn', 'codex.notification.orphan_completion', 'Received turn/completed without active controller', {
          threadId,
          turnId,
          orphanCompletionCount: this.orphanCompletionCount,
        })
        return
      }

      const result: RunResult = {
        threadId,
        turnId,
        status: turn.status,
        text: finalText(controller),
        items: controller.items,
        turn,
      }

      this.pushTurnEvent(controller, {
        type: 'turn.completed',
        threadId,
        turnId,
        turn,
      })
      controller.completed = true
      controller.done.resolve(result)
      controller.events.end()
      this.clearTurn(controller)
      return
    }

    const threadId = getString(message.params, 'threadId')
    const turnId = getString(message.params, 'turnId')
    if (!threadId || !turnId) {
      if (isTurnScopedNotification(message.method)) {
        this.unmatchedNotificationCount += 1
        this.log('warn', 'codex.notification.unmatched', 'Dropping unmatched turn-scoped notification', {
          method: message.method,
          unmatchedNotificationCount: this.unmatchedNotificationCount,
        })
      }
      return
    }

    const controller = this.activeTurns.get(`${threadId}:${turnId}`)
    if (!controller) {
      this.unmatchedNotificationCount += 1
      this.log('warn', 'codex.notification.unmatched', 'Dropping notification for non-active turn', {
        method: message.method,
        threadId,
        turnId,
        unmatchedNotificationCount: this.unmatchedNotificationCount,
      })
      return
    }

    switch (message.method) {
      case 'item/agentMessage/delta': {
        const data = assertObject(message.params ?? {}, 'item/agentMessage/delta')
        const itemId = String(data.itemId)
        const delta = String(data.delta ?? '')
        controller.messageBuffer.set(itemId, (controller.messageBuffer.get(itemId) ?? '') + delta)
        this.pushTurnEvent(controller, {
          type: 'message.delta',
          threadId,
          turnId,
          itemId,
          text: delta,
        })
        return
      }

      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const data = assertObject(message.params ?? {}, message.method)
        this.pushTurnEvent(controller, {
          type: 'reasoning.delta',
          threadId,
          turnId,
          itemId: String(data.itemId),
          text: String(data.delta ?? ''),
          ...(typeof data.contentIndex === 'number' ? { contentIndex: data.contentIndex } : {}),
        })
        return
      }

      case 'item/plan/delta': {
        const data = assertObject(message.params ?? {}, 'item/plan/delta')
        this.pushTurnEvent(controller, {
          type: 'plan.delta',
          threadId,
          turnId,
          itemId: String(data.itemId),
          text: String(data.delta ?? ''),
        })
        return
      }

      case 'item/mcpToolCall/progress': {
        const data = assertObject(message.params ?? {}, 'item/mcpToolCall/progress')
        this.pushTurnEvent(controller, {
          type: 'mcp.progress',
          threadId,
          turnId,
          itemId: String(data.itemId),
          message: String(data.message ?? ''),
        })
        return
      }

      case 'item/started':
      case 'item/completed': {
        const data = assertObject(message.params ?? {}, message.method)
        const item = assertObject(data.item, `${message.method}.item`) as unknown as TurnItem
        if (message.method === 'item/completed') {
          controller.items.push(item)
          if (item.type === 'agentMessage' && typeof item.text === 'string') {
            controller.messageBuffer.set(item.id, item.text)
          }
        }
        this.pushTurnEvent(controller, {
          type: message.method === 'item/started' ? 'item.started' : 'item.completed',
          threadId,
          turnId,
          item,
        })
        return
      }

      default:
        this.pushTurnEvent(controller, {
          type: 'notification',
          method: message.method,
          params: message.params,
        })
    }
  }

  private async handleServerRequest(message: JsonRpcRequest): Promise<void> {
    const params = assertObject(message.params ?? {}, message.method)
    const threadId = getString(params, 'threadId') ?? ''
    const turnId = getString(params, 'turnId') ?? ''
    const controller = turnId ? this.activeTurns.get(`${threadId}:${turnId}`) : undefined
    if (!controller) {
      this.unmatchedServerRequestCount += 1
      this.log('warn', 'codex.server_request.unmatched', 'Received server request without active turn match', {
        method: message.method,
        threadId,
        turnId,
        unmatchedServerRequestCount: this.unmatchedServerRequestCount,
      })
    }

    switch (message.method) {
      case 'item/commandExecution/requestApproval': {
        const request: CommandApprovalRequest = {
          requestId: message.id,
          threadId,
          turnId,
          itemId: String(params.itemId),
          params,
          respond: async (decision: CommandApprovalDecision) => {
            this.transport.respond(message.id, { decision })
          },
        }
        this.pushOptionalTurnEvent(controller, { type: 'approval.command', ...request })
        const handler = controller?.handlers.onCommandApproval ?? this.options.handlers?.onCommandApproval
        await request.respond(handler ? await handler(request) : 'decline')
        return
      }

      case 'item/fileChange/requestApproval': {
        const request: FileApprovalRequest = {
          requestId: message.id,
          threadId,
          turnId,
          itemId: String(params.itemId),
          params,
          respond: async (decision: FileApprovalDecision) => {
            this.transport.respond(message.id, { decision })
          },
        }
        this.pushOptionalTurnEvent(controller, { type: 'approval.file', ...request })
        const handler = controller?.handlers.onFileApproval ?? this.options.handlers?.onFileApproval
        await request.respond(handler ? await handler(request) : 'decline')
        return
      }

      case 'item/permissions/requestApproval':
      case 'applyPatchApproval':
      case 'execCommandApproval': {
        const request: PermissionApprovalRequest = {
          requestId: message.id,
          threadId,
          turnId,
          itemId: String(params.itemId ?? 'permission-request'),
          params,
          respond: async (decision: PermissionApprovalDecision) => {
            this.transport.respond(message.id, { decision })
          },
        }
        this.pushOptionalTurnEvent(controller, { type: 'approval.permissions', ...request })
        const handler = controller?.handlers.onPermissionApproval ?? this.options.handlers?.onPermissionApproval
        await request.respond(handler ? await handler(request) : 'decline')
        return
      }

      case 'item/tool/requestUserInput': {
        const request: ToolInputRequest = {
          requestId: message.id,
          threadId,
          turnId,
          itemId: String(params.itemId),
          questions: asArray(params.questions).map((question) => {
            const data = assertObject(question, 'tool question')
            return {
              id: String(data.id),
              header: String(data.header ?? ''),
              question: String(data.question ?? ''),
              isOther: data.isOther === true,
              isSecret: data.isSecret === true,
              options: Array.isArray(data.options)
                ? data.options.map((option) => {
                    const item = assertObject(option, 'tool option')
                    return {
                      label: String(item.label ?? ''),
                      ...(typeof item.description === 'string' ? { description: item.description } : {}),
                      ...(item.isOther === true ? { isOther: true } : {}),
                    }
                  })
                : null,
            }
          }),
          respond: async (answers: ToolInputAnswerMap) => {
            this.transport.respond(message.id, { answers })
          },
        }
        this.pushOptionalTurnEvent(controller, { type: 'tool.input', ...request })
        const handler = controller?.handlers.onToolInput ?? this.options.handlers?.onToolInput
        if (!handler) {
          this.transport.respondError(message.id, 'No tool input handler configured')
          return
        }
        await request.respond(await handler(request))
        return
      }

      case 'item/tool/call': {
        const request: DynamicToolRequest = {
          requestId: message.id,
          threadId,
          turnId,
          callId: String(params.callId),
          tool: String(params.tool),
          arguments: params.arguments,
          respond: async (result: DynamicToolResponse) => {
            this.transport.respond(message.id, result)
          },
        }
        this.pushOptionalTurnEvent(controller, { type: 'tool.call', ...request })
        const handler = controller?.handlers.onDynamicToolCall ?? this.options.handlers?.onDynamicToolCall
        if (!handler) {
          this.transport.respondError(message.id, 'No dynamic tool handler configured')
          return
        }
        await request.respond(await handler(request))
        return
      }

      default:
        this.log('warn', 'codex.server_request.unmatched_method', 'Unsupported server request method', {
          method: message.method,
          requestId: message.id,
        })
        this.transport.respondError(message.id, `Unsupported server request: ${message.method}`)
    }
  }

  private pushOptionalTurnEvent(controller: TurnController | undefined, event: CodexStreamEvent): void {
    if (!controller) return
    this.pushTurnEvent(controller, event)
  }

  private pushTurnEvent(controller: TurnController, event: CodexStreamEvent): void {
    if (controller.completed) return
    const accepted = controller.events.push(event)
    if (accepted) return

    const maxQueueSize = controller.queueMaxSize ?? 0
    const overflowError = new QueueOverflowError(controller.threadId, controller.turnId ?? 'starting', maxQueueSize)
    this.failTurn(controller, overflowError, 'codex.turn.queue_overflow')
  }

  private failTurn(controller: TurnController, error: unknown, code: string): void {
    if (!controller.completed) {
      controller.completed = true
      controller.done.reject(error)
      controller.events.fail(error)
    }

    this.log('error', code, 'Turn failed', {
      threadId: controller.threadId,
      turnId: controller.turnId ?? 'starting',
      error: errorToString(error),
    })
    this.clearTurn(controller)
  }

  private clearTurn(controller: TurnController): void {
    this.startingTurns.delete(controller.threadId)
    if (controller.turnId) {
      this.activeTurns.delete(`${controller.threadId}:${controller.turnId}`)
    }
    this.threadTurnState.delete(controller.threadId)
    controller.thread.setActiveTurnId(null)
  }

  private mergeOptions(options?: ThreadOptions): ThreadOptions {
    return {
      ...(this.options.defaults ?? {}),
      ...(options ?? {}),
    }
  }

  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    code: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const logger: ClientLogger | undefined = this.options.diagnostics?.logger
    logger?.({ level, code, message, ...(data ? { data } : {}) })
  }
}

function getString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' ? candidate : undefined
}

function finalText(controller: TurnController): string {
  let text = ''
  for (const item of controller.items) {
    if (item.type === 'agentMessage' && typeof item.text === 'string') {
      text = item.text
    }
  }
  if (text) return text
  for (const fragment of controller.messageBuffer.values()) {
    text = fragment
  }
  return text
}

function isTurnScopedNotification(method: string): boolean {
  return method.startsWith('item/') || method.startsWith('turn/')
}

function toSandboxPolicy(mode: SandboxMode, cwd: string): Record<string, unknown> {
  if (mode === 'danger-full-access') {
    return { type: 'dangerFullAccess' }
  }

  if (mode === 'read-only') {
    return {
      type: 'readOnly',
      access: { type: 'fullAccess' },
      networkAccess: false,
    }
  }

  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    readOnlyAccess: { type: 'fullAccess' },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

function errorToString(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function normalizeMaxQueueSize(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value)) return undefined
  const normalized = Math.trunc(value)
  return normalized > 0 ? normalized : undefined
}
