import type { Options as ClaudeOptions, PermissionMode as ClaudePermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { CodexClient } from './codex-client.ts'
import type { CreateCodexOptions, UserInput } from './types.ts'

export type AgentProviderId = 'codex' | 'claude'

export type AgentAccountState = {
  provider: AgentProviderId
  available: boolean
  authenticated: boolean
  account: unknown | null
  raw?: unknown
}

export type AgentCapabilities = {
  provider: AgentProviderId
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
  run(input: AgentInput, options?: AgentRunOptions): Promise<AgentRunResult>
  stream(input: AgentInput, options?: AgentRunOptions): Promise<AsyncIterable<AgentEvent>>
  interrupt(): Promise<void>
  close(): Promise<void>
}

export interface AgentClient {
  readonly provider: AgentProviderId
  session(name: string, options?: AgentSessionOptions): AgentSession
  clearSession(name: string): void
  clearSessions(): void
  getAccountState(): Promise<AgentAccountState>
  getCapabilities(): Promise<AgentCapabilities>
  close(): Promise<void>
  asCodex(): CodexClient | null
  asClaude(): ClaudeProviderHandle | null
}
