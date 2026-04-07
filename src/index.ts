import { CodexClient } from './codex-client.ts'
import {
  createAgent,
  getAvailableProviders,
  getProviderAvailability,
  getProviderInventory,
  getProviderInventoryEntry,
} from './agent-client.ts'
import type { CreateCodexOptions } from './types.ts'

export { CodexAuth } from './auth.ts'
export { CodexClient } from './codex-client.ts'
export { CodexSession } from './session.ts'
export { CodexThread } from './thread.ts'
export { createAgent, getAvailableProviders, getProviderAvailability, getProviderInventory, getProviderInventoryEntry }
export type {
  AccountState,
  ApprovalPolicy,
  AuthMode,
  CodexAccount,
  CodexStreamEvent,
  CodexThreadData,
  CodexTurn,
  CommandApprovalDecision,
  CommandApprovalRequest,
  CreateCodexOptions,
  DynamicToolRequest,
  DynamicToolResponse,
  FileApprovalDecision,
  FileApprovalRequest,
  LoginInfo,
  LoginStrategy,
  Personality,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ReasoningEffort,
  ReasoningSummary,
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
export type {
  AgentAccountState,
  AgentCapabilities,
  AgentClient,
  AgentEvent,
  AgentHandlers,
  AgentOpenSessionOptions,
  AgentProviderInventory,
  AgentProviderAvailability,
  AgentProviderId,
  AgentResumeSessionOptions,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionHandle,
  AgentSessionOptions,
  AgentSessionSummary,
  AgentToolApprovalRequest,
  AgentUserInputRequest,
  ClaudeProviderHandle,
  CreateAgentOptions,
  CreateClaudeOptions,
  ProviderInventoryOptions,
} from './agent-types.ts'

export async function createCodex(options: CreateCodexOptions = {}): Promise<CodexClient> {
  return CodexClient.create(options)
}
