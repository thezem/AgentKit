import type { Options as ClaudeOptions, PermissionMode as ClaudePermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { CodexClient } from './codex-client.ts'
import type { CreateCodexOptions, UserInput } from './types.ts'

export type AgentProviderId = 'codex' | 'claude'

/**
 * Provider-neutral resume payload.
 *
 * Stable fields:
 * - `version`, `provider`, `sessionId`, and `name`
 * - `state.resumeKey` and `state.resumeAt` as cross-provider slots
 *
 * Escape hatches:
 * - `state.resumeKey` and `state.resumeAt` values remain provider-specific
 * - `state.raw` contains provider-native resume metadata and should be treated as opaque
 *
 * Persist this handle if you need to resume a session across process restarts.
 * Local `agent.session(name)` cache entries are not sufficient for cross-process
 * resume without this handle.
 */
export type AgentSessionHandle = {
  version: 1
  provider: AgentProviderId
  sessionId: string | null
  name?: string
  state?: {
    resumeKey?: string
    resumeAt?: string
    raw?: unknown
  }
}

export type AgentSessionSummary = {
  provider: AgentProviderId
  name?: string
  sessionId: string | null
  handle: AgentSessionHandle
  status?: 'active' | 'idle' | 'closed' | 'unknown'
  model?: string
  cwd?: string
  raw?: unknown
}

export type AgentAccountState = {
  provider: AgentProviderId
  available: boolean
  authenticated: boolean
  account: unknown | null
  raw?: unknown
}

/**
 * Normalized provider capability metadata used for feature gating.
 *
 * The enum/boolean fields are the stable cross-provider contract.
 * `raw` is reserved for provider-native supplemental data.
 */
export type AgentCapabilities = {
  provider: AgentProviderId
  sessionLifecycle: {
    open: boolean
    resume: boolean
    list: boolean
    clearLocalCache: boolean
    deleteRemote: false
  }
  controls: {
    interrupt: boolean
    modelSwitch: 'none' | 'session' | 'turn'
    permissionModeSwitch: 'none' | 'session' | 'turn'
  }
  interactions: {
    partialMessages: boolean
    toolApproval: boolean
    userInputRequests: boolean
    dynamicToolCalls: boolean
  }
  discovery: {
    inventory: boolean
    modelListing: boolean
    skillsListing: boolean
    skillConfiguration: boolean
  }
  semantics: {
    sessionIdentity: 'thread-id' | 'runtime-session' | 'opaque'
    resumeHandle: 'structured'
    longLivedRuntime: boolean
  }
  // Compatibility booleans kept for one phase.
  supportsResume: boolean
  supportsInterrupt: boolean
  supportsModelSwitch: boolean
  supportsPermissionModeSwitch: boolean
  supportsPartialMessages: boolean
  supportsToolApproval: boolean
  supportsUserInputRequests: boolean
  raw?: unknown
}

/**
 * Normalized approval request surfaced through the shared API.
 *
 * Stable fields:
 * - `provider`
 * - `kind`
 *
 * Escape hatches:
 * - `payload` is intentionally provider-shaped because approval request payloads
 *   are not yet fully normalized across providers
 */
export type AgentToolApprovalRequest = {
  provider: AgentProviderId
  kind: string
  payload: Record<string, unknown>
}

/**
 * Normalized user-input request surfaced through the shared API.
 *
 * Stable fields:
 * - `provider`
 * - `question`
 * - `options`
 *
 * Escape hatches:
 * - `raw` contains the provider-native request object
 */
export type AgentUserInputRequest = {
  provider: AgentProviderId
  question: string
  options?: Array<{ label: string; description?: string }>
  raw?: unknown
}

/**
 * Optional interactive handlers used during `run()` and `stream()`.
 */
export type AgentHandlers = {
  onToolApproval?: (request: AgentToolApprovalRequest) => Promise<'allow' | 'deny'> | 'allow' | 'deny'
  onUserInput?: (request: AgentUserInputRequest) => Promise<string[] | string> | string[] | string
}

/**
 * Provider-neutral streamed events emitted by `AgentSession.stream(...)`.
 *
 * Stream ordering is the live emission order for the current attachment only.
 * The current contract does not include stable event ids, replay cursors, or
 * live-vs-replay markers.
 */
export type AgentEvent =
  | { provider: AgentProviderId; type: 'run.started'; runId: string; sessionId: string | null; raw?: unknown }
  | { provider: AgentProviderId; type: 'message.delta'; text: string; raw?: unknown }
  | { provider: AgentProviderId; type: 'message.completed'; text: string; raw?: unknown }
  | { provider: AgentProviderId; type: 'reasoning.delta'; text: string; raw?: unknown }
  | { provider: AgentProviderId; type: 'status.updated'; runId: string; status: string; raw?: unknown }
  | { provider: AgentProviderId; type: 'approval.tool'; request: AgentToolApprovalRequest; raw?: unknown }
  | { provider: AgentProviderId; type: 'user.input'; request: AgentUserInputRequest; raw?: unknown }
  | { provider: AgentProviderId; type: 'run.completed'; runId: string; result: AgentRunResult; raw?: unknown }
  | { provider: AgentProviderId; type: 'provider.notification'; method: string; raw?: unknown }
  | { provider: AgentProviderId; type: 'error'; error: string; raw?: unknown }

/**
 * Normalized final turn result returned by `run()` and attached to
 * `run.completed` stream events.
 *
 * Stable fields:
 * - `provider`, `sessionId`, `turnId`, `status`, `text`, `items`
 * - optional `handle`
 *
 * Escape hatches:
 * - `items` are provider-native terminal items
 * - `raw` and `resumeState` are provider-specific metadata
 */
export type AgentRunResult = {
  provider: AgentProviderId
  sessionId: string | null
  turnId: string | null
  status: 'completed' | 'interrupted' | 'failed'
  text: string
  items: unknown[]
  raw?: unknown
  handle?: AgentSessionHandle
  resumeState?: unknown
}

export type AgentRun = {
  runId: string
  events: AsyncIterable<AgentEvent>
  result: Promise<AgentRunResult>
  interrupt(): Promise<void>
}

export type AgentSessionOptions = {
  cwd?: string
  model?: string
  env?: Record<string, string>
  permissionMode?: string
  additionalDirectories?: string[]
  includePartialMessages?: boolean
}

export type AgentOpenSessionOptions = AgentSessionOptions & {
  name?: string
}

export type AgentResumeSessionOptions = AgentSessionOptions & {
  name?: string
}

export type AgentRunOptions = AgentSessionOptions & {
  handlers?: AgentHandlers
}

export type CreateClaudeOptions = {
  pathToClaudeCodeExecutable?: string
  executable?: ClaudeOptions['executable']
  executableArgs?: ClaudeOptions['executableArgs']
  model?: string
  cwd?: string
  env?: Record<string, string>
  permissionMode?: ClaudePermissionMode
  includePartialMessages?: boolean
  additionalDirectories?: string[]
  allowDangerouslySkipPermissions?: boolean
  resume?: string
  resumeSessionAt?: string
  options?: Omit<
    ClaudeOptions,
    | 'cwd'
    | 'model'
    | 'env'
    | 'permissionMode'
    | 'includePartialMessages'
    | 'additionalDirectories'
    | 'pathToClaudeCodeExecutable'
    | 'allowDangerouslySkipPermissions'
    | 'resume'
    | 'resumeSessionAt'
    | 'canUseTool'
    | 'onElicitation'
  >
}

export type CreateAgentOptions =
  | {
      provider: 'codex'
      codex?: CreateCodexOptions
      defaults?: AgentSessionOptions
    }
  | {
      provider: 'claude'
      claude?: CreateClaudeOptions
      defaults?: AgentSessionOptions
    }

export type AgentProviderAvailability = AgentAccountState

/**
 * Normalized model discovery entry.
 */
export type AgentModelInfo = {
  provider: AgentProviderId
  id: string
  label: string
  family?: string
  description?: string
  available: boolean
  hidden?: boolean
  recommended?: boolean
  default?: boolean
  reasoningEfforts?: string[]
  defaultReasoningEffort?: string
  inputModalities?: Array<'text' | 'image' | string>
  supportsPersonality?: boolean
  upgradeModelId?: string
  discovery: {
    mode: 'runtime' | 'static'
    source: string
    stale?: boolean
  }
  raw?: unknown
}

/**
 * Normalized skill discovery entry.
 */
export type AgentSkillInfo = {
  provider: AgentProviderId
  name: string
  path?: string
  description?: string
  enabled?: boolean
  interface?: string
  dependencies?: string[]
  configurable: boolean
  discovery: {
    mode: 'runtime'
    source: string
  }
  raw?: unknown
}

export type AgentSkillConfigResult = {
  provider: AgentProviderId
  supported: boolean
  changed: boolean
  raw?: unknown
}

export type AgentModelListOptions = {
  includeHidden?: boolean
  limit?: number
  codexPath?: string
  pathToClaudeCodeExecutable?: string
  cwd?: string
  env?: Record<string, string>
}

export type AgentSkillListOptions = {
  cwd?: string
  env?: Record<string, string>
  forceReload?: boolean
  extraUserRoots?: string[]
  codexPath?: string
}

export type ProviderInventoryOptions = {
  codexPath?: string
  pathToClaudeCodeExecutable?: string
  cwd?: string
  env?: Record<string, string>
  probeMode?: 'cheap' | 'deep'
  probeTimeoutMs?: number
}

/**
 * Canonical provider discovery record.
 *
 * `status` + `degraded` summarize runtime health. `diagnostics` contains probe
 * strategy/failure details and is intended for troubleshooting UI/logging.
 * The `diagnostics` object is normalized and stable. `raw` remains the
 * provider-native escape hatch.
 */
export type AgentProviderInventory = {
  provider: AgentProviderId
  installed: boolean
  runnable: boolean
  authenticated: boolean
  degraded: boolean
  status: 'missing' | 'installed' | 'runnable' | 'authenticated' | 'degraded'
  executablePath?: string
  executableSource?: 'path' | 'configured' | 'sdk' | 'runtime-probe'
  version?: string
  capabilitySupport?: AgentCapabilities
  diagnostics?: {
    probeMode: 'cheap' | 'deep'
    probeStrategy?: 'path-check' | 'version-check' | 'sdk-import' | 'runtime-init'
    failureReason?: string
    notes?: string[]
  }
  versionDetails?: {
    raw?: string
    source: 'cli' | 'sdk' | 'runtime'
  }
  account: unknown | null
  raw?: unknown
}

export type AgentInput = UserInput

export interface ClaudeProviderHandle {
  getSessionRuntimeMetadata(): {
    sessionId: string | null
    currentModel?: string
    currentPermissionMode?: string
  } | null
  getLastResumeState(): unknown | null
  getSessionInfo(): { sessionId: string | null; name: string } | null
}

export interface AgentSession {
  readonly provider: AgentProviderId
  readonly name: string
  readonly id: string | null
  /**
   * Return the current resumable handle, or `null` if no remote session exists yet.
   */
  getHandle(): AgentSessionHandle | null
  /**
   * Return session metadata known locally by this SDK process.
   */
  getSessionInfo(): AgentSessionSummary
  /**
   * Execute one live turn and return the shared run object.
   */
  start(input: AgentInput, options?: AgentRunOptions): Promise<AgentRun>
  /**
   * Execute one live turn and wait for completion.
   */
  run(input: AgentInput, options?: AgentRunOptions): Promise<AgentRunResult>
  /**
   * Execute one live turn and stream normalized events in adapter emission order.
   */
  stream(input: AgentInput, options?: AgentRunOptions): Promise<AsyncIterable<AgentEvent>>
  /**
   * Interrupt the active turn, if the provider supports interruption.
   * Rejects when no turn is currently active.
   */
  interrupt(): Promise<void>
  /**
   * Close local session resources owned by this session object.
   * Remote/runtime impact remains provider-specific.
   */
  close(): Promise<void>
}

/**
 * Shared provider-neutral client interface.
 *
 * `session(name)` is local cache convenience. `openSession` and `resumeSession`
 * are explicit lifecycle operations. Cache clearing does not delete remote
 * provider state.
 */
export interface AgentClient {
  readonly provider: AgentProviderId
  /**
   * Return a locally cached session wrapper by name, creating one if needed.
   */
  session(name: string, options?: AgentSessionOptions): AgentSession
  /**
   * Open a new provider session explicitly.
   * This returns a new wrapper and does not consult the local named-session cache.
   */
  openSession(options?: AgentOpenSessionOptions): Promise<AgentSession>
  /**
   * Resume a provider session from a persisted handle.
   * Use this for cross-process/session recovery rather than `session(name)`.
   */
  resumeSession(handle: AgentSessionHandle, options?: AgentResumeSessionOptions): Promise<AgentSession>
  listSessions?(): Promise<AgentSessionSummary[]>
  /**
   * Evict one locally cached session wrapper by name.
   */
  clearSession(name: string): void
  /**
   * Evict all locally cached session wrappers.
   */
  clearSessions(): void
  getAccountState(): Promise<AgentAccountState>
  getCapabilities(): Promise<AgentCapabilities>
  /**
   * Close provider client resources in this process.
   */
  close(): Promise<void>
  /**
   * Escape hatch for provider-specific Codex APIs.
   * Outside the normalized contract once non-null.
   */
  asCodex(): CodexClient | null
  /**
   * Escape hatch for provider-specific Claude APIs.
   * Outside the normalized contract once non-null.
   */
  asClaude(): ClaudeProviderHandle | null
}
