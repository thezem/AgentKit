import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { CodexClient } from '../codex-client.ts'
import { ProviderProbeTimeoutError } from '../errors.ts'
import type { CodexThread } from '../thread.ts'
import { mergeAgentRunOptions, mergeAgentSessionOptions } from '../agent-session.ts'
import type {
  AgentAccountState,
  AgentCapabilities,
  AgentClient,
  AgentEvent,
  AgentInput,
  AgentModelInfo,
  AgentModelListOptions,
  AgentOpenSessionOptions,
  AgentProviderInventory,
  AgentResumeSessionOptions,
  AgentRunOptions,
  AgentRunResult,
  AgentSkillConfigResult,
  AgentSkillInfo,
  AgentSkillListOptions,
  AgentSession,
  AgentSessionHandle,
  AgentSessionOptions,
  AgentSessionSummary,
  CreateAgentOptions,
  ProviderInventoryOptions,
} from '../agent-types.ts'
import type {
  CodexStreamEvent,
  CodexModelListParams,
  CodexModelListResponse,
  CodexSkillConfigWriteParams,
  CodexSkillConfigWriteResponse,
  CodexSkillListParams,
  CodexSkillListResponse,
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

type CodexSessionInit = {
  codexSessionName?: string
  thread?: CodexThread
  threadId?: string
}

export type WriteCodexSkillConfigOptions = {
  path: string
  enabled: boolean
  codexPath?: string
  cwd?: string
  env?: Record<string, string>
}

class CodexAgentSession implements AgentSession {
  readonly provider = 'codex' as const
  readonly name: string

  private readonly options?: AgentSessionOptions
  private readonly codexClient: CodexClient
  private readonly onClosed: (name: string, session: CodexAgentSession) => void
  private readonly codexSessionName?: string

  private threadId: string | null = null
  private threadRef: CodexThread | null = null
  private closed = false

  constructor(
    codexClient: CodexClient,
    name: string,
    options: AgentSessionOptions | undefined,
    onClosed: (name: string, session: CodexAgentSession) => void,
    init?: CodexSessionInit,
  ) {
    this.codexClient = codexClient
    this.name = name
    this.options = options
    this.onClosed = onClosed
    this.codexSessionName = init?.codexSessionName
    this.threadRef = init?.thread ?? null
    this.threadId = init?.thread?.id ?? init?.threadId ?? null
  }

  get id(): string | null {
    return this.threadId
  }

  getHandle(): AgentSessionHandle | null {
    if (!this.threadId) return null
    return codexHandle(this.threadId, this.name)
  }

  getSessionInfo(): AgentSessionSummary {
    const runtimeStatus = this.threadId ? this.codexClient.getThreadTurnState(this.threadId) : 'idle'
    return {
      provider: 'codex',
      name: this.name,
      sessionId: this.threadId,
      handle: codexHandle(this.threadId, this.name),
      status: this.closed ? 'closed' : runtimeStatus === 'idle' ? 'idle' : 'active',
      ...(this.options?.model ? { model: this.options.model } : {}),
      ...(this.options?.cwd ? { cwd: this.options.cwd } : {}),
      raw: {
        codexSessionName: this.codexSessionName,
      },
    }
  }

  async run(input: AgentInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    this.assertOpen()
    const merged = mergeAgentRunOptions(this.options, options)

    if (this.codexSessionName) {
      const session = this.codexClient.session(this.codexSessionName)
      const result = await session.run(asCodexInput(input), toCodexRunOptions(merged))
      this.threadId = session.id
      return codexRunResultToAgent(result, this.name)
    }

    const thread = await this.ensureThread()
    const result = await thread.run(asCodexInput(input), toCodexRunOptions(merged))
    this.threadId = thread.id
    return codexRunResultToAgent(result, this.name)
  }

  async stream(input: AgentInput, options?: AgentRunOptions): Promise<AsyncIterable<AgentEvent>> {
    this.assertOpen()
    const merged = mergeAgentRunOptions(this.options, options)

    if (this.codexSessionName) {
      const session = this.codexClient.session(this.codexSessionName)
      const stream = await session.stream(asCodexInput(input), toCodexRunOptions(merged))
      this.threadId = session.id
      return {
        [Symbol.asyncIterator]: async function* () {
          for await (const event of stream) {
            yield codexStreamEventToAgent(event, session.id)
          }
        },
      }
    }

    const thread = await this.ensureThread()
    const stream = await thread.stream(asCodexInput(input), toCodexRunOptions(merged))
    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const event of stream) {
          yield codexStreamEventToAgent(event, thread.id)
        }
      },
    }
  }

  async interrupt(): Promise<void> {
    this.assertOpen()
    if (this.codexSessionName) {
      await this.codexClient.session(this.codexSessionName).interrupt()
      return
    }

    const thread = this.threadRef
    if (!thread) {
      throw new Error(`Session "${this.name}" has no active Codex thread to interrupt`)
    }
    await thread.interrupt()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.codexSessionName) {
      this.codexClient.clearSession(this.codexSessionName)
    }
    this.onClosed(this.name, this)
  }

  isClosed(): boolean {
    return this.closed
  }

  private async ensureThread(): Promise<CodexThread> {
    if (this.threadRef) return this.threadRef

    const thread = this.threadId
      ? await this.codexClient.threads.resume(this.threadId, toCodexThreadOptions(this.options))
      : await this.codexClient.threads.create(toCodexThreadOptions(this.options))

    this.threadRef = thread
    this.threadId = thread.id
    return thread
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
  private unnamedCounter = 0

  constructor(codexClient: CodexClient, defaults?: AgentSessionOptions) {
    this.codexClient = codexClient
    this.defaults = defaults
  }

  session(name: string, options?: AgentSessionOptions): AgentSession {
    const existing = this.sessions.get(name)
    if (existing && !existing.isClosed()) return existing

    const merged = mergeAgentSessionOptions(this.defaults, options)
    const session = new CodexAgentSession(
      this.codexClient,
      name,
      merged,
      (sessionName, current) => {
        if (this.sessions.get(sessionName) === current) {
          this.sessions.delete(sessionName)
        }
      },
      { codexSessionName: name },
    )

    this.sessions.set(name, session)
    return session
  }

  async openSession(options?: AgentOpenSessionOptions): Promise<AgentSession> {
    const name = options?.name ?? this.newSessionName('codex-open')
    const merged = mergeAgentSessionOptions(this.defaults, options)
    const thread = await this.codexClient.threads.create(toCodexThreadOptions(merged))

    const session = new CodexAgentSession(this.codexClient, name, merged, () => {}, { thread })
    return session
  }

  async resumeSession(handle: AgentSessionHandle, options?: AgentResumeSessionOptions): Promise<AgentSession> {
    if (handle.provider !== 'codex') {
      throw new Error(`Cannot resume provider=${handle.provider} with codex client`)
    }

    const resumeKey = handle.resumeKey ?? handle.sessionId
    if (!resumeKey) {
      throw new Error('Codex resume handle requires resumeKey or sessionId')
    }

    const name = options?.name ?? handle.name ?? this.newSessionName('codex-resume')
    const merged = mergeAgentSessionOptions(this.defaults, options)
    const thread = await this.codexClient.threads.resume(resumeKey, toCodexThreadOptions(merged))

    return new CodexAgentSession(this.codexClient, name, merged, () => {}, {
      thread,
      threadId: resumeKey,
    })
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
    const inventory = await getCodexInventory({ codexPath: this.codexClient.options.codexPath, probeMode: 'deep' })
    return inventoryToAvailability(inventory)
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return codexCapabilities()
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

  private newSessionName(prefix: string): string {
    this.unnamedCounter += 1
    return `${prefix}-${this.unnamedCounter}`
  }
}

export async function createCodexAgentClient(options: CodexAgentClientOptions): Promise<AgentClient> {
  const codexOptions = mergeCodexOptions(options)
  const client = await CodexClient.create(codexOptions)
  return new CodexAgentClient(client, options.defaults)
}

export async function listCodexModels(options?: AgentModelListOptions): Promise<AgentModelInfo[]> {
  if (options?.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
    throw new Error('Invalid model list limit: expected a non-negative integer')
  }

  const client = await createCodexDiscoveryClient({
    codexPath: options?.codexPath,
    env: options?.env,
  })

  try {
    const response = await client.raw.request<CodexModelListResponse>(
      'model/list',
      {
        ...(options?.includeHidden !== undefined ? { includeHidden: options.includeHidden } : {}),
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      } satisfies CodexModelListParams,
    )

    const normalized = normalizeCodexModelsResponse(response)
      .filter((model) => options?.includeHidden === true || model.hidden !== true)
      .map((model) => ({
        provider: 'codex' as const,
        id: model.id,
        label: model.label ?? model.displayName ?? model.name ?? model.model ?? model.id,
        ...(model.family ? { family: model.family } : {}),
        ...(model.description ? { description: model.description } : {}),
        available: true,
        ...(model.hidden !== undefined ? { hidden: model.hidden } : {}),
        ...(model.isDefault !== undefined ? { default: model.isDefault } : {}),
        ...(model.isDefault !== undefined ? { recommended: model.isDefault } : {}),
        ...(model.supportedReasoningEfforts
          ? {
              reasoningEfforts: model.supportedReasoningEfforts
                .map((entry) => (typeof entry === 'string' ? entry : entry.reasoningEffort))
                .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0),
            }
          : {}),
        ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
        ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
        ...(model.supportsPersonality !== undefined ? { supportsPersonality: model.supportsPersonality } : {}),
        ...(typeof model.upgrade === 'string' ? { upgradeModelId: model.upgrade } : {}),
        ...(typeof model.upgrade === 'object' && model.upgrade && typeof model.upgrade.id === 'string'
          ? { upgradeModelId: model.upgrade.id }
          : {}),
        discovery: {
          mode: 'runtime' as const,
          source: 'codex:model/list',
        },
        raw: model,
      }))
    if (options?.limit !== undefined) {
      return normalized.slice(0, options.limit)
    }
    return normalized
  } finally {
    await client.close()
  }
}

export async function listCodexSkills(options?: AgentSkillListOptions): Promise<AgentSkillInfo[]> {
  const client = await createCodexDiscoveryClient({
    codexPath: options?.codexPath,
    env: options?.env,
  })

  try {
    const cwd = options?.cwd ?? process.cwd()
    const response = await client.raw.request<CodexSkillListResponse>('skills/list', {
      cwd,
      cwds: [cwd],
      ...(options?.extraUserRoots ? { extraUserRoots: { [cwd]: options.extraUserRoots } } : {}),
      ...(options?.forceReload !== undefined ? { forceReload: options.forceReload } : {}),
    } satisfies CodexSkillListParams)

    const skills = normalizeCodexSkillsResponse(response)
    return skills.map((skill) => ({
      provider: 'codex' as const,
      name: skill.name,
      ...(skill.path ? { path: skill.path } : {}),
      ...(skill.description ? { description: skill.description } : {}),
      ...(skill.enabled !== undefined ? { enabled: skill.enabled } : {}),
      ...(skill.interface ? { interface: skill.interface } : {}),
      ...(skill.dependencies ? { dependencies: skill.dependencies } : {}),
      configurable: true,
      discovery: {
        mode: 'runtime' as const,
        source: 'codex:skills/list',
      },
      raw: skill.raw ?? skill,
    }))
  } finally {
    await client.close()
  }
}

export async function writeCodexSkillConfig(options: WriteCodexSkillConfigOptions): Promise<AgentSkillConfigResult> {
  const before = await listCodexSkills({
    codexPath: options.codexPath,
    cwd: options.cwd ?? process.cwd(),
    env: options.env,
    forceReload: false,
  })
  const previous = before.find((skill) => skill.path === options.path)?.enabled

  const client = await createCodexDiscoveryClient({
    codexPath: options.codexPath,
    env: options.env,
  })

  try {
    const response = await client.raw.request<CodexSkillConfigWriteResponse>('skills/config/write', {
      cwd: options.cwd ?? process.cwd(),
      path: options.path,
      enabled: options.enabled,
    } satisfies CodexSkillConfigWriteParams)

    return {
      provider: 'codex',
      supported: true,
      changed:
        typeof response.changed === 'boolean'
          ? response.changed
          : typeof previous === 'boolean' && typeof response.effectiveEnabled === 'boolean'
            ? previous !== response.effectiveEnabled
            : true,
      raw: response,
    }
  } finally {
    await client.close()
  }
}

export async function getCodexInventory(options?: ProviderInventoryOptions): Promise<AgentProviderInventory> {
  const probeMode = options?.probeMode ?? 'deep'
  const probeTimeoutMs = options?.probeTimeoutMs ?? 5000
  const detection = detectCodexBinary(options?.codexPath, { runVersionCheck: probeMode === 'deep' })

  if (!detection.installed) {
    return {
      provider: 'codex',
      installed: false,
      runnable: false,
      authenticated: false,
      degraded: false,
      status: 'missing',
      ...(detection.executablePath ? { executablePath: detection.executablePath } : {}),
      ...(detection.executableSource ? { executableSource: detection.executableSource } : {}),
      account: null,
      diagnostics: {
        probeMode,
        probeStrategy: 'path-check',
        ...(detection.failureReason ? { failureReason: detection.failureReason } : {}),
      },
      raw: detection.raw,
      capabilitySupport: codexCapabilities(),
    }
  }

  if (probeMode === 'cheap') {
    return {
      provider: 'codex',
      installed: true,
      runnable: detection.runnable,
      authenticated: false,
      degraded: false,
      status: deriveInventoryStatus({
        installed: true,
        runnable: detection.runnable,
        authenticated: false,
        degraded: false,
      }),
      ...(detection.executablePath ? { executablePath: detection.executablePath } : {}),
      ...(detection.executableSource ? { executableSource: detection.executableSource } : {}),
      ...(detection.version ? { version: detection.version } : {}),
      ...(detection.version ? { versionDetails: { raw: detection.version, source: 'cli' as const } } : {}),
      account: null,
      diagnostics: {
        probeMode,
        probeStrategy: 'path-check',
        notes: ['Cheap probe checks command presence only; runtime execution is not verified.'],
      },
      raw: detection.raw,
      capabilitySupport: codexCapabilities(),
    }
  }

  if (!detection.runnable) {
    return {
      provider: 'codex',
      installed: true,
      runnable: false,
      authenticated: false,
      degraded: true,
      status: 'degraded',
      ...(detection.executablePath ? { executablePath: detection.executablePath } : {}),
      ...(detection.executableSource ? { executableSource: detection.executableSource } : {}),
      ...(detection.version ? { version: detection.version } : {}),
      ...(detection.version ? { versionDetails: { raw: detection.version, source: 'cli' as const } } : {}),
      account: null,
      diagnostics: {
        probeMode,
        probeStrategy: 'version-check',
        ...(detection.failureReason ? { failureReason: detection.failureReason } : {}),
      },
      raw: detection.raw,
      capabilitySupport: codexCapabilities(),
    }
  }

  try {
    const createClientPromise = CodexClient.create({
      codexPath: options?.codexPath,
      auth: { autoLogin: false },
      env: options?.env,
    })
    const client = await withTimeout(createClientPromise, probeTimeoutMs, () => {
      void createClientPromise
        .then((lateClient) => lateClient.close())
        .catch(() => {
          // Ignore cleanup failures for late-resolving probe clients.
        })
      return new ProviderProbeTimeoutError('codex', probeTimeoutMs)
    })

    try {
      const state = await withTimeout(
        client.auth.getAccount(false),
        probeTimeoutMs,
        () => new ProviderProbeTimeoutError('codex', probeTimeoutMs),
      )
      const authenticated = state.account !== null
      return {
        provider: 'codex',
        installed: true,
        runnable: true,
        authenticated,
        degraded: false,
        status: deriveInventoryStatus({
          installed: true,
          runnable: true,
          authenticated,
          degraded: false,
        }),
        ...(detection.executablePath ? { executablePath: detection.executablePath } : {}),
        ...(detection.executableSource ? { executableSource: detection.executableSource } : {}),
        ...(detection.version ? { version: detection.version } : {}),
        ...(detection.version ? { versionDetails: { raw: detection.version, source: 'cli' as const } } : {}),
        account: state.account,
        diagnostics: {
          probeMode,
          probeStrategy: 'runtime-init',
        },
        raw: {
          detection: detection.raw,
          accountState: state,
        },
        capabilitySupport: codexCapabilities(),
      }
    } finally {
      await client.close()
    }
  } catch (error) {
    const timeout = error instanceof ProviderProbeTimeoutError
    return {
      provider: 'codex',
      installed: true,
      runnable: timeout ? true : false,
      authenticated: false,
      degraded: true,
      status: 'degraded',
      ...(detection.executablePath ? { executablePath: detection.executablePath } : {}),
      ...(detection.executableSource ? { executableSource: detection.executableSource } : {}),
      ...(detection.version ? { version: detection.version } : {}),
      ...(detection.version ? { versionDetails: { raw: detection.version, source: 'cli' as const } } : {}),
      account: null,
      diagnostics: {
        probeMode,
        probeStrategy: 'runtime-init',
        failureReason: errorToString(error),
        ...(timeout ? { notes: [`Runtime probe exceeded ${probeTimeoutMs}ms and was degraded.`] } : {}),
      },
      raw: {
        detection: detection.raw,
        error: errorToString(error),
      },
      capabilitySupport: codexCapabilities(),
    }
  }
}

export async function getCodexAvailability(options?: ProviderAvailabilityOptions): Promise<AgentAccountState> {
  const inventory = await getCodexInventory({
    codexPath: options?.codexPath,
    cwd: options?.cwd,
    env: options?.env,
    probeMode: options?.probeRuntime === true ? 'deep' : 'cheap',
    probeTimeoutMs: options?.probeTimeoutMs,
  })
  return inventoryToAvailability(inventory)
}

export const codexProvider: InternalAgentProvider = {
  id: 'codex',
  async getInventory(options?: ProviderInventoryOptions): Promise<AgentProviderInventory> {
    return getCodexInventory(options)
  },
  async isAvailable(options?: ProviderInventoryOptions): Promise<boolean> {
    const inventory = await getCodexInventory({ ...options, probeMode: 'cheap' })
    return inventory.runnable
  },
  async getAvailability(options?: ProviderAvailabilityOptions): Promise<AgentAccountState> {
    return getCodexAvailability(options)
  },
  async listModels(options?: AgentModelListOptions): Promise<AgentModelInfo[]> {
    return listCodexModels(options)
  },
  async listSkills(options?: AgentSkillListOptions): Promise<AgentSkillInfo[]> {
    return listCodexSkills(options)
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

async function createCodexDiscoveryClient(options?: {
  codexPath?: string
  env?: Record<string, string>
}): Promise<CodexClient> {
  return CodexClient.create({
    codexPath: options?.codexPath,
    auth: { autoLogin: false },
    env: options?.env,
  })
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

function codexRunResultToAgent(result: RunResult, name?: string): AgentRunResult {
  return {
    provider: 'codex',
    sessionId: result.threadId,
    turnId: result.turnId,
    status: mapCodexStatus(result.status),
    text: result.text,
    items: result.items,
    raw: result,
    handle: codexHandle(result.threadId, name),
  }
}

function codexStreamEventToAgent(event: CodexStreamEvent, sessionIdHint?: string | null): AgentEvent {
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
          handle: codexHandle(event.threadId),
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

function detectCodexBinary(
  codexPath?: string,
  options?: { runVersionCheck?: boolean },
): {
  installed: boolean
  runnable: boolean
  executablePath?: string
  executableSource?: 'path' | 'configured'
  version?: string
  failureReason?: string
  raw: unknown
} {
  const command = codexPath ?? defaultCodexCommand()
  const executableSource = codexPath ? 'configured' : 'path'
  const runVersionCheck = options?.runVersionCheck ?? true

  const resolvedPath = resolveCommandPath(command)
  const installed = codexPath ? existsSync(codexPath) : resolvedPath !== null
  let runnable = installed
  let version: string | undefined
  let failureReason: string | undefined
  let versionStatus: number | null | undefined
  let versionStdout: string | null | undefined
  let versionStderr: string | null | undefined

  if (runVersionCheck && installed) {
    const versionResult = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 4000,
    })
    versionStatus = versionResult.status
    versionStdout = versionResult.stdout
    versionStderr = versionResult.stderr
    runnable = versionResult.status === 0

    const versionText = (versionResult.stdout ?? '').trim()
    version = versionText.length > 0 ? versionText.split(/\r?\n/)[0] : undefined

    if (!runnable) {
      failureReason =
        versionResult.error?.message ||
        (versionResult.stderr ?? '').trim() ||
        `Unable to execute ${command} --version (exit=${String(versionResult.status ?? 'unknown')})`
    }
  }

  return {
    installed,
    runnable,
    ...(resolvedPath ? { executablePath: resolvedPath } : codexPath ? { executablePath: codexPath } : {}),
    executableSource,
    ...(version ? { version } : {}),
    ...(failureReason ? { failureReason } : {}),
    raw: {
      command,
      resolvedPath,
      versionProbe: runVersionCheck,
      versionStatus,
      stdout: versionStdout,
      stderr: versionStderr,
    },
  }
}

function resolveCommandPath(command: string): string | null {
  const result =
    process.platform === 'win32'
      ? spawnSync('where', [command], { encoding: 'utf8', shell: true, timeout: 2000 })
      : spawnSync('which', [command], { encoding: 'utf8', timeout: 2000 })

  if (result.status !== 0) {
    return null
  }

  const line = (result.stdout ?? '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0)

  return line ?? null
}

function codexHandle(sessionId: string | null, name?: string): AgentSessionHandle {
  return {
    provider: 'codex',
    sessionId,
    ...(name ? { name } : {}),
    ...(sessionId ? { resumeKey: sessionId } : {}),
  }
}

function codexCapabilities(): AgentCapabilities {
  return {
    provider: 'codex',
    sessionLifecycle: {
      open: true,
      resume: true,
      list: false,
      clearLocalCache: true,
      deleteRemote: false,
    },
    controls: {
      interrupt: true,
      modelSwitch: 'turn',
      permissionModeSwitch: 'none',
    },
    interactions: {
      partialMessages: true,
      toolApproval: true,
      userInputRequests: true,
      dynamicToolCalls: true,
    },
    discovery: {
      inventory: true,
      modelListing: true,
      skillsListing: true,
      skillConfiguration: true,
    },
    semantics: {
      sessionIdentity: 'thread-id',
      resumeHandle: 'structured',
      longLivedRuntime: false,
    },
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

function deriveInventoryStatus(flags: {
  installed: boolean
  runnable: boolean
  authenticated: boolean
  degraded: boolean
}): AgentProviderInventory['status'] {
  if (!flags.installed) return 'missing'
  if (flags.degraded) return 'degraded'
  if (flags.authenticated) return 'authenticated'
  if (flags.runnable) return 'runnable'
  return 'installed'
}

function inventoryToAvailability(inventory: AgentProviderInventory): AgentAccountState {
  return {
    provider: inventory.provider,
    available: inventory.runnable,
    authenticated: inventory.authenticated,
    account: inventory.account,
    raw: inventory.raw,
  }
}

function normalizeCodexModelsResponse(response: CodexModelListResponse): Array<{
  id: string
  name?: string
  label?: string
  displayName?: string
  model?: string
  family?: string
  description?: string
  hidden?: boolean
  isDefault?: boolean
  supportedReasoningEfforts?: Array<string | { reasoningEffort?: string; description?: string }>
  defaultReasoningEffort?: string
  inputModalities?: Array<'text' | 'image' | string>
  supportsPersonality?: boolean
  upgrade?: string | { id?: string } | null
  raw?: unknown
}> {
  const data = (response.data ?? response.models ?? []) as unknown[]
  if (!Array.isArray(data)) return []
  return data
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const id =
        (typeof item.id === 'string' && item.id) ||
        (typeof item.model === 'string' && item.model) ||
        (typeof item.name === 'string' && item.name) ||
        ''

      const supportedReasoningEfforts = Array.isArray(item.supportedReasoningEfforts)
        ? item.supportedReasoningEfforts.filter(
            (entry): entry is string | { reasoningEffort?: string; description?: string } =>
              typeof entry === 'string' || (typeof entry === 'object' && entry !== null),
          )
        : undefined

      return {
        id,
        ...(typeof item.name === 'string' ? { name: item.name } : {}),
        ...(typeof item.label === 'string' ? { label: item.label } : {}),
        ...(typeof item.displayName === 'string' ? { displayName: item.displayName } : {}),
        ...(typeof item.model === 'string' ? { model: item.model } : {}),
        ...(typeof item.family === 'string' ? { family: item.family } : {}),
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        ...(typeof item.hidden === 'boolean' ? { hidden: item.hidden } : {}),
        ...(typeof item.isDefault === 'boolean' ? { isDefault: item.isDefault } : {}),
        ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
        ...(typeof item.defaultReasoningEffort === 'string'
          ? { defaultReasoningEffort: item.defaultReasoningEffort }
          : {}),
        ...(Array.isArray(item.inputModalities)
          ? { inputModalities: item.inputModalities.filter((entry): entry is string => typeof entry === 'string') }
          : {}),
        ...(typeof item.supportsPersonality === 'boolean' ? { supportsPersonality: item.supportsPersonality } : {}),
        ...(typeof item.upgrade === 'string' || (typeof item.upgrade === 'object' && item.upgrade !== null)
          ? { upgrade: item.upgrade as string | { id?: string } }
          : {}),
        raw: item,
      }
    })
    .filter((item) => item.id.length > 0)
}

function normalizeCodexSkillsResponse(response: CodexSkillListResponse): Array<{
  name: string
  path?: string
  description?: string
  enabled?: boolean
  interface?: string
  dependencies?: string[]
  raw?: unknown
}> {
  const asRecord = response as unknown as Record<string, unknown>
  const flat = asRecord.skills
  if (Array.isArray(flat)) {
    return flat
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        name: String(item.name ?? ''),
        ...(typeof item.path === 'string' ? { path: item.path } : {}),
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        ...(typeof item.enabled === 'boolean' ? { enabled: item.enabled } : {}),
        ...(typeof item.interface === 'string' ? { interface: item.interface } : {}),
        ...(Array.isArray(item.dependencies)
          ? { dependencies: item.dependencies.filter((value): value is string => typeof value === 'string') }
          : {}),
        raw: item,
      }))
      .filter((item) => item.name.length > 0)
  }

  const cwdEntries = asRecord.data
  if (!Array.isArray(cwdEntries)) {
    return []
  }

  const skills: Array<{
    name: string
    path?: string
    description?: string
    enabled?: boolean
    interface?: string
    dependencies?: string[]
    raw?: unknown
  }> = []
  for (const entry of cwdEntries) {
    if (!entry || typeof entry !== 'object') continue
    const nested = (entry as Record<string, unknown>).skills
    if (!Array.isArray(nested)) continue
    for (const item of nested) {
      if (!item || typeof item !== 'object') continue
      const data = item as Record<string, unknown>
      const name = typeof data.name === 'string' ? data.name : ''
      if (!name) continue
      skills.push({
        name,
        ...(typeof data.path === 'string' ? { path: data.path } : {}),
        ...(typeof data.description === 'string' ? { description: data.description } : {}),
        ...(typeof data.enabled === 'boolean' ? { enabled: data.enabled } : {}),
        ...(typeof data.interface === 'string' ? { interface: data.interface } : {}),
        ...(Array.isArray(data.dependencies)
          ? { dependencies: data.dependencies.filter((value): value is string => typeof value === 'string') }
          : {}),
        raw: data,
      })
    }
  }
  return skills
}

function errorToString(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, createError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(createError()), timeoutMs)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}
