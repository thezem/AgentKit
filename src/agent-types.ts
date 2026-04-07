import type { Options as ClaudeOptions, PermissionMode as ClaudePermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { CodexClient } from './codex-client.ts'
import type { CreateCodexOptions, UserInput } from './types.ts'

export type AgentProviderId = 'codex' | 'claude'

export type AgentSessionHandle = {
  provider: AgentProviderId
  sessionId: string | null
  name?: string
  resumeKey?: string
  resumeAt?: string
  raw?: unknown
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

export type AgentToolApprovalRequest = {
  provider: AgentProviderId
  kind: string
  payload: Record<string, unknown>
}

export type AgentUserInputRequest = {
  provider: AgentProviderId
  question: string
  options?: Array<{ label: string; description?: string }>
  raw?: unknown
}

export type AgentHandlers = {
  onToolApproval?: (request: AgentToolApprovalRequest) => Promise<'allow' | 'deny'> | 'allow' | 'deny'
  onUserInput?: (request: AgentUserInputRequest) => Promise<string[] | string> | string[] | string
}

export type AgentEvent =
  | { provider: AgentProviderId; type: 'message.delta'; text: string; raw?: unknown }
  | { provider: AgentProviderId; type: 'message.completed'; text: string; raw?: unknown }
  | { provider: AgentProviderId; type: 'reasoning.delta'; text: string; raw?: unknown }
  | { provider: AgentProviderId; type: 'status'; status: string; raw?: unknown }
  | { provider: AgentProviderId; type: 'approval.tool'; request: AgentToolApprovalRequest; raw?: unknown }
  | { provider: AgentProviderId; type: 'user.input'; request: AgentUserInputRequest; raw?: unknown }
  | { provider: AgentProviderId; type: 'turn.completed'; result: AgentRunResult; raw?: unknown }
  | { provider: AgentProviderId; type: 'provider.notification'; method: string; raw?: unknown }
  | { provider: AgentProviderId; type: 'error'; error: string; raw?: unknown }

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
}

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
  getHandle(): AgentSessionHandle | null
  getSessionInfo(): AgentSessionSummary
  run(input: AgentInput, options?: AgentRunOptions): Promise<AgentRunResult>
  stream(input: AgentInput, options?: AgentRunOptions): Promise<AsyncIterable<AgentEvent>>
  interrupt(): Promise<void>
  close(): Promise<void>
}

export interface AgentClient {
  readonly provider: AgentProviderId
  session(name: string, options?: AgentSessionOptions): AgentSession
  openSession(options?: AgentOpenSessionOptions): Promise<AgentSession>
  resumeSession(handle: AgentSessionHandle, options?: AgentResumeSessionOptions): Promise<AgentSession>
  listSessions?(): Promise<AgentSessionSummary[]>
  clearSession(name: string): void
  clearSessions(): void
  getAccountState(): Promise<AgentAccountState>
  getCapabilities(): Promise<AgentCapabilities>
  close(): Promise<void>
  asCodex(): CodexClient | null
  asClaude(): ClaudeProviderHandle | null
}
