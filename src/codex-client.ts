import { EventEmitter } from 'node:events'
import { CodexAuth } from './auth.ts'
import { CodexSession, CodexThread } from './thread.ts'
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
import { AsyncQueue, Deferred, assertObject, asArray } from './utils.ts'

type TurnController = {
  threadId: string
  turnId: string | null
  handlers: RequestHandlers
  events: AsyncQueue<CodexStreamEvent>
  done: Deferred<RunResult>
  items: TurnItem[]
  messageBuffer: Map<string, string>
  completed: boolean
}

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

export class CodexClient {
  readonly options: CreateCodexOptions
  readonly raw: { request: <T = unknown>(method: string, params?: unknown) => Promise<T> }
  readonly auth: CodexAuth
  readonly threads: CodexThreadsApi

  private readonly transport: AppServerTransport
  private readonly events = new EventEmitter()
  private readonly sessions = new Map<string, CodexSession>()
  private readonly pendingLogins = new Map<string, Deferred<CodexAccount>>()
  private readonly pendingTurnStarts = new Map<string, TurnController[]>()
  private readonly activeTurns = new Map<string, TurnController>()

  private constructor(transport: AppServerTransport, options: CreateCodexOptions) {
    this.transport = transport
    this.options = options
    this.raw = {
      request: <T = unknown>(method: string, params?: unknown) => this.transport.request<T>(method, params),
    }
    this.auth = new CodexAuth(this)
    this.threads = new CodexThreadsApi(this)

    this.transport.onNotification((message) => {
      void this.handleNotification(message)
    })

    this.transport.onServerRequest((message) => {
      void this.handleServerRequest(message)
    })

    this.transport.onClosed((error) => {
      for (const login of this.pendingLogins.values()) {
        login.reject(error)
      }
      for (const turn of this.activeTurns.values()) {
        turn.done.reject(error)
        turn.events.end()
      }
    })
  }

  static async create(options: CreateCodexOptions = {}): Promise<CodexClient> {
    const transport = await AppServerTransport.start({
      codexPath: options.codexPath,
      clientInfo: options.clientInfo,
      env: options.env,
    })
    const client = new CodexClient(transport, options)
    if (options.auth?.autoLogin) {
      await client.auth.ensureLoggedIn(options.auth.strategy)
    }
    return client
  }

  session(name: string, options?: RunOptions): CodexSession {
    const existing = this.sessions.get(name)
    if (existing) return existing
    const session = new CodexSession(this, name, { ...this.options.defaults, ...options })
    this.sessions.set(name, session)
    return session
  }

  clearSession(name: string): void {
    this.sessions.delete(name)
  }

  clearSessions(): void {
    this.sessions.clear()
  }

  async close(): Promise<void> {
    this.transport.close()
  }

  async runThread(thread: CodexThread, input: UserInput, options?: RunOptions): Promise<RunResult> {
    const controller = await this.startTurn(thread, input, options)
    for await (const _event of controller.events) {
      // drain
    }
    return controller.done.promise
  }

  async streamThread(thread: CodexThread, input: UserInput, options?: RunOptions): Promise<AsyncIterable<CodexStreamEvent>> {
    const controller = await this.startTurn(thread, input, options)
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
    const controller: TurnController = {
      threadId: thread.id,
      turnId: null,
      handlers: {
        ...(this.options.handlers ?? {}),
        ...(options?.handlers ?? {}),
      },
      events: new AsyncQueue<CodexStreamEvent>(),
      done: new Deferred<RunResult>(),
      items: [],
      messageBuffer: new Map<string, string>(),
      completed: false,
    }

    const pending = this.pendingTurnStarts.get(thread.id) ?? []
    pending.push(controller)
    this.pendingTurnStarts.set(thread.id, pending)

    const merged = this.mergeOptions(options)
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

    this.bindTurnController(thread, controller, response.turn.id)
    return controller
  }

  private bindTurnController(thread: CodexThread, controller: TurnController, turnId: string): void {
    if (controller.turnId) return
    controller.turnId = turnId
    this.activeTurns.set(`${thread.id}:${turnId}`, controller)
    thread.setActiveTurnId(turnId)
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
      const queue = this.pendingTurnStarts.get(threadId) ?? []
      const controller = queue.shift()
      if (queue.length === 0) {
        this.pendingTurnStarts.delete(threadId)
      } else {
        this.pendingTurnStarts.set(threadId, queue)
      }

      if (!controller) return

      controller.turnId = String(turn.id)
      this.activeTurns.set(`${threadId}:${turn.id}`, controller)
      controller.events.push({
        type: 'turn.started',
        threadId,
        turnId: String(turn.id),
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
      if (!controller) return

      const result: RunResult = {
        threadId,
        turnId,
        status: turn.status,
        text: finalText(controller),
        items: controller.items,
        turn,
      }

      controller.events.push({
        type: 'turn.completed',
        threadId,
        turnId,
        turn,
      })
      controller.completed = true
      controller.done.resolve(result)
      controller.events.end()
      this.activeTurns.delete(`${threadId}:${turnId}`)
      return
    }

    const threadId = getString(message.params, 'threadId')
    const turnId = getString(message.params, 'turnId')
    if (!threadId || !turnId) return

    const controller = this.activeTurns.get(`${threadId}:${turnId}`)
    if (!controller) return

    switch (message.method) {
      case 'item/agentMessage/delta': {
        const data = assertObject(message.params ?? {}, 'item/agentMessage/delta')
        const itemId = String(data.itemId)
        const delta = String(data.delta ?? '')
        controller.messageBuffer.set(itemId, (controller.messageBuffer.get(itemId) ?? '') + delta)
        controller.events.push({
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
        controller.events.push({
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
        controller.events.push({
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
        controller.events.push({
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
        controller.events.push({
          type: message.method === 'item/started' ? 'item.started' : 'item.completed',
          threadId,
          turnId,
          item,
        })
        return
      }

      default:
        controller.events.push({
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
        controller?.events.push({ type: 'approval.command', ...request })
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
        controller?.events.push({ type: 'approval.file', ...request })
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
        controller?.events.push({ type: 'approval.permissions', ...request })
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
        controller?.events.push({ type: 'tool.input', ...request })
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
        controller?.events.push({ type: 'tool.call', ...request })
        const handler = controller?.handlers.onDynamicToolCall ?? this.options.handlers?.onDynamicToolCall
        if (!handler) {
          this.transport.respondError(message.id, 'No dynamic tool handler configured')
          return
        }
        await request.respond(await handler(request))
        return
      }

      default:
        this.transport.respondError(message.id, `Unsupported server request: ${message.method}`)
    }
  }

  private mergeOptions(options?: ThreadOptions): ThreadOptions {
    return {
      ...(this.options.defaults ?? {}),
      ...(options ?? {}),
    }
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
