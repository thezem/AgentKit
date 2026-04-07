import { spawnSync } from 'node:child_process'
import { CodexClient } from '../codex-client.ts'
import { mergeAgentRunOptions, mergeAgentSessionOptions } from '../agent-session.ts'
import type {
  AgentAccountState,
  AgentCapabilities,
  AgentClient,
  AgentEvent,
  AgentInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionOptions,
  CreateAgentOptions,
} from '../agent-types.ts'
import type {
  CodexStreamEvent,
  CommandApprovalDecision,
  CommandApprovalRequest,
  CreateCodexOptions,
  DynamicToolRequest,
  FileApprovalDecision,
  FileApprovalRequest,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  RequestHandlers,
  RunOptions,
  RunResult,
  ThreadOptions,
  ToolInputAnswerMap,
  ToolInputRequest,
  UserInput,
} from '../types.ts'
import type { InternalAgentProvider, ProviderAvailabilityOptions } from './provider-types.ts'

type CodexAgentClientOptions = Extract<CreateAgentOptions, { provider: 'codex' }>

class CodexAgentSession implements AgentSession {
  readonly provider = 'codex' as const
  readonly name: string

  private readonly options?: AgentSessionOptions
  private readonly codexClient: CodexClient
  private readonly codexSession
  private readonly onClosed: (name: string, session: CodexAgentSession) => void
  private closed = false

  constructor(
    codexClient: CodexClient,
    name: string,
    options: AgentSessionOptions | undefined,
    onClosed: (name: string, session: CodexAgentSession) => void,
  ) {
    this.codexClient = codexClient
    this.name = name
    this.options = options
    this.onClosed = onClosed
    this.codexSession = this.codexClient.session(this.name)
  }

  get id(): string | null {
    return this.codexSession.id
  }

  async run(input: AgentInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    this.assertOpen()
    const merged = mergeAgentRunOptions(this.options, options)
    const result = await this.codexSession.run(asCodexInput(input), toCodexRunOptions(merged))
    return codexRunResultToAgent(result)
  }

  async stream(input: AgentInput, options?: AgentRunOptions): Promise<AsyncIterable<AgentEvent>> {
    this.assertOpen()
    const merged = mergeAgentRunOptions(this.options, options)
    const stream = await this.codexSession.stream(asCodexInput(input), toCodexRunOptions(merged))

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const event of stream) {
          yield codexStreamEventToAgent(event)
        }
      },
    }
  }

  async interrupt(): Promise<void> {
    this.assertOpen()
    await this.codexSession.interrupt()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.codexClient.clearSession(this.name)
    this.onClosed(this.name, this)
  }

  isClosed(): boolean {
    return this.closed
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`Session "${this.name}" is closed`)
    }
  }
}

class CodexAgentClient implements AgentClient {
  readonly provider = 'codex' as const
  private readonly codexClient: CodexClient
  private readonly defaults?: AgentSessionOptions
  private readonly sessions = new Map<string, CodexAgentSession>()

  constructor(codexClient: CodexClient, defaults?: AgentSessionOptions) {
    this.codexClient = codexClient
    this.defaults = defaults
  }

  session(name: string, options?: AgentSessionOptions): AgentSession {
    const existing = this.sessions.get(name)
    if (existing && !existing.isClosed()) return existing
    const merged = mergeAgentSessionOptions(this.defaults, options)
    const session = new CodexAgentSession(this.codexClient, name, merged, (sessionName, current) => {
      if (this.sessions.get(sessionName) === current) {
        this.sessions.delete(sessionName)
      }
    })
    this.sessions.set(name, session)
    return session
  }

  clearSession(name: string): void {
    this.sessions.delete(name)
    this.codexClient.clearSession(name)
  }

  clearSessions(): void {
    this.sessions.clear()
    this.codexClient.clearSessions()
  }

  async getAccountState(): Promise<AgentAccountState> {
    return getCodexAvailability({ codexPath: this.codexClient.options.codexPath })
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return {
      provider: 'codex',
      supportsResume: true,
      supportsInterrupt: true,
      supportsModelSwitch: true,
      supportsPermissionModeSwitch: false,
      supportsPartialMessages: true,
      supportsToolApproval: true,
      supportsUserInputRequests: true,
      raw: {
        eventModel: 'codex-app-server',
      },
    }
  }

  async close(): Promise<void> {
    await this.codexClient.close()
  }

  asCodex(): CodexClient {
    return this.codexClient
  }

  asClaude() {
    return null
  }
}

export async function createCodexAgentClient(options: CodexAgentClientOptions): Promise<AgentClient> {
  const codexOptions = mergeCodexOptions(options)
  const client = await CodexClient.create(codexOptions)
  return new CodexAgentClient(client, options.defaults)
}

export async function getCodexAvailability(options?: ProviderAvailabilityOptions): Promise<AgentAccountState> {
  const codexPath = options?.codexPath
  const binaryAvailable = isCodexBinaryAvailable(codexPath)
  if (!binaryAvailable) {
    return {
      provider: 'codex',
      available: false,
      authenticated: false,
      account: null,
      raw: { reason: `Codex binary not found: ${codexPath ?? defaultCodexCommand()}` },
    }
  }

  try {
    const client = await CodexClient.create({
      codexPath,
      auth: { autoLogin: false },
      env: options?.env,
    })
    try {
      const state = await client.auth.getAccount(false)
      return {
        provider: 'codex',
        available: true,
        authenticated: state.account !== null,
        account: state.account,
        raw: state,
      }
    } finally {
      await client.close()
    }
  } catch (error) {
    return {
      provider: 'codex',
      available: true,
      authenticated: false,
      account: null,
      raw: {
        error: errorToString(error),
      },
    }
  }
}

export const codexProvider: InternalAgentProvider = {
  id: 'codex',
  async isAvailable(options?: ProviderAvailabilityOptions): Promise<boolean> {
    return isCodexBinaryAvailable(options?.codexPath)
  },
  async getAvailability(options?: ProviderAvailabilityOptions): Promise<AgentAccountState> {
    return getCodexAvailability(options)
  },
  async createClient(options: CreateAgentOptions): Promise<AgentClient> {
    if (options.provider !== 'codex') {
      throw new Error(`codexProvider cannot handle provider=${options.provider}`)
    }
    return createCodexAgentClient(options)
  },
}

function mergeCodexOptions(options: CodexAgentClientOptions): CreateCodexOptions {
  const codex = options.codex ?? {}
  const mergedDefaults = toCodexThreadOptions(mergeAgentSessionOptions(options.defaults, toAgentSessionDefaults(codex.defaults)))
  return {
    ...codex,
    defaults: {
      ...(codex.defaults ?? {}),
      ...(mergedDefaults ?? {}),
    },
  }
}

function toCodexThreadOptions(options?: AgentSessionOptions): ThreadOptions | undefined {
  if (!options) return undefined
  return {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.model ? { model: options.model } : {}),
  }
}

function toAgentSessionDefaults(options?: ThreadOptions): AgentSessionOptions | undefined {
  if (!options) return undefined
  return {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.model ? { model: options.model } : {}),
  }
}

function toCodexRunOptions(options?: AgentRunOptions): RunOptions | undefined {
  if (!options) return undefined
  return {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.handlers ? { handlers: toCodexRequestHandlers(options.handlers) } : {}),
  }
}

function toCodexRequestHandlers(handlers: NonNullable<AgentRunOptions['handlers']>): RequestHandlers {
  const onToolApproval = handlers.onToolApproval
  const onUserInput = handlers.onUserInput

  return {
    onCommandApproval: onToolApproval
      ? async (request) => mapToolApprovalDecision(await onToolApproval(toAgentApprovalRequest('approval.command', request)))
      : undefined,
    onFileApproval: onToolApproval
      ? async (request) => mapFileApprovalDecision(await onToolApproval(toAgentApprovalRequest('approval.file', request)))
      : undefined,
    onPermissionApproval: onToolApproval
      ? async (request) =>
          mapPermissionApprovalDecision(await onToolApproval(toAgentApprovalRequest('approval.permissions', request)))
      : undefined,
    onDynamicToolCall: async (request) => unsupportedDynamicToolResponse(request),
    onToolInput: onUserInput
      ? async (request) => mapToolInputAnswers(await onUserInput(toolInputRequestToAgent(request)), request)
      : undefined,
  }
}

function toAgentApprovalRequest(
  kind: 'approval.command' | 'approval.file' | 'approval.permissions' | 'tool.call',
  request: CommandApprovalRequest | FileApprovalRequest | PermissionApprovalRequest | DynamicToolRequest,
) {
  if (kind === 'tool.call') {
    const toolRequest = request as DynamicToolRequest
    return {
      provider: 'codex' as const,
      kind,
      payload: {
        threadId: toolRequest.threadId,
        turnId: toolRequest.turnId,
        callId: toolRequest.callId,
        tool: toolRequest.tool,
        arguments: toolRequest.arguments,
      },
    }
  }

  const approvalRequest = request as CommandApprovalRequest | FileApprovalRequest | PermissionApprovalRequest
  return {
    provider: 'codex' as const,
    kind,
    payload: {
      threadId: approvalRequest.threadId,
      turnId: approvalRequest.turnId,
      itemId: approvalRequest.itemId,
      params: approvalRequest.params,
    },
  }
}

function mapToolApprovalDecision(decision: 'allow' | 'deny'): CommandApprovalDecision {
  return decision === 'allow' ? 'accept' : 'decline'
}

function mapFileApprovalDecision(decision: 'allow' | 'deny'): FileApprovalDecision {
  return decision === 'allow' ? 'accept' : 'decline'
}

function mapPermissionApprovalDecision(decision: 'allow' | 'deny'): PermissionApprovalDecision {
  return decision === 'allow' ? 'accept' : 'decline'
}

function unsupportedDynamicToolResponse(_request: DynamicToolRequest) {
  return {
    success: false,
    contentItems: [
      {
        type: 'inputText' as const,
        text: 'Generic Codexkit AgentClient does not support executing Codex dynamic tool calls yet. Use the Codex-specific API instead.',
      },
    ],
  }
}

function mapToolInputAnswers(response: string[] | string, request: ToolInputRequest): ToolInputAnswerMap {
  const values = Array.isArray(response) ? response : [response]
  const answers: ToolInputAnswerMap = {}
  request.questions.forEach((question, index) => {
    const candidate = values[index] ?? values[0] ?? ''
    const normalized = Array.isArray(candidate) ? candidate : [String(candidate)]
    answers[question.id] = { answers: normalized }
  })
  return answers
}

function asCodexInput(input: AgentInput): UserInput {
  return input
}

function codexRunResultToAgent(result: RunResult): AgentRunResult {
  return {
    provider: 'codex',
    sessionId: result.threadId,
    turnId: result.turnId,
    status: mapCodexStatus(result.status),
    text: result.text,
    items: result.items,
    raw: result,
  }
}

function codexStreamEventToAgent(event: CodexStreamEvent): AgentEvent {
  switch (event.type) {
    case 'message.delta':
      return { provider: 'codex', type: 'message.delta', text: event.text, raw: event }
    case 'reasoning.delta':
      return { provider: 'codex', type: 'reasoning.delta', text: event.text, raw: event }
    case 'turn.completed':
      return {
        provider: 'codex',
        type: 'turn.completed',
        result: {
          provider: 'codex',
          sessionId: event.threadId,
          turnId: event.turnId ?? event.turn.id,
          status: mapCodexStatus(event.turn.status),
          text: codexTurnText(event.turn.items),
          items: event.turn.items,
          raw: event.turn,
        },
        raw: event,
      }
    case 'approval.command':
    case 'approval.file':
    case 'approval.permissions':
    case 'tool.call':
      return {
        provider: 'codex',
        type: 'approval.tool',
        request: {
          provider: 'codex',
          kind: event.type,
          payload: codexRequestPayload(event),
        },
        raw: event,
      }
    case 'tool.input':
      return {
        provider: 'codex',
        type: 'user.input',
        request: toolInputRequestToAgent(event),
        raw: event,
      }
    default:
      return {
        provider: 'codex',
        type: 'provider.notification',
        method: event.type === 'notification' ? event.method : event.type,
        raw: event,
      }
  }
}

function toolInputRequestToAgent(event: ToolInputRequest) {
  const first = event.questions[0]
  return {
    provider: 'codex' as const,
    question: first?.question ?? 'Tool requested user input.',
    options: first?.options?.map((option) => ({
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    raw: event,
  }
}

function codexRequestPayload(event: CodexStreamEvent): Record<string, unknown> {
  if (event.type === 'approval.command' || event.type === 'approval.file' || event.type === 'approval.permissions') {
    return {
      threadId: event.threadId,
      turnId: event.turnId,
      itemId: event.itemId,
      params: event.params,
    }
  }

  if (event.type === 'tool.call') {
    return {
      threadId: event.threadId,
      turnId: event.turnId,
      callId: event.callId,
      tool: event.tool,
      arguments: event.arguments,
    }
  }

  return {}
}

function codexTurnText(items: Array<{ type: string; text?: unknown }>): string {
  let latest = ''
  for (const item of items) {
    if (item.type === 'agentMessage' && typeof item.text === 'string') {
      latest = item.text
    }
  }
  return latest
}

function mapCodexStatus(status: string): AgentRunResult['status'] {
  if (status === 'completed') return 'completed'
  if (status === 'interrupted') return 'interrupted'
  return 'failed'
}

function defaultCodexCommand(): string {
  return process.platform === 'win32' ? 'codex.cmd' : 'codex'
}

function isCodexBinaryAvailable(codexPath?: string): boolean {
  const command = codexPath ?? defaultCodexCommand()
  const result =
    process.platform === 'win32'
      ? spawnSync(command, ['--version'], { stdio: 'ignore', shell: true })
      : spawnSync('which', [command], { stdio: 'ignore' })
  return result.status === 0
}

function errorToString(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
