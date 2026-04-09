import { CodexClient } from './codex-client.ts'
import {
  createAgent,
  getAvailableProviders,
  listModels,
  listSkills,
  getProviderAvailability,
  getProviderInventory,
  getProviderInventoryEntry,
} from './agent-client.ts'
import type { CreateCodexOptions } from './types.ts'
import { writeCodexSkillConfig } from './providers/codex-adapter.ts'
export type { WriteCodexSkillConfigOptions } from './providers/codex-adapter.ts'

export { CodexAuth } from './auth.ts'
export { CodexClient } from './codex-client.ts'
export { CodexSession } from './session.ts'
export { CodexThread } from './thread.ts'
export {
  AgentError,
  ConcurrentTurnError,
  InputValidationError,
  ProviderProbeTimeoutError,
  QueueOverflowError,
  TransportRequestTimeoutError,
} from './errors.ts'
export {
  isAgentErrorEvent,
  isAgentMessageCompletedEvent,
  isAgentMessageDeltaEvent,
  isAgentProviderNotificationEvent,
  isAgentReasoningDeltaEvent,
  isAgentRunCompletedEvent,
  isAgentRunStartedEvent,
  isAgentStatusUpdatedEvent,
  isAgentToolApprovalEvent,
  isAgentUserInputEvent,
  isCodexApprovalCommandEvent,
  isCodexApprovalFileEvent,
  isCodexApprovalPermissionsEvent,
  isCodexItemCompletedEvent,
  isCodexItemStartedEvent,
  isCodexMcpProgressEvent,
  isCodexMessageDeltaEvent,
  isCodexNotificationEvent,
  isCodexPlanDeltaEvent,
  isCodexReasoningDeltaEvent,
  isCodexToolCallEvent,
  isCodexToolInputEvent,
  isCodexTurnCompletedEvent,
  isCodexTurnStartedEvent,
  isTurnItemFileChange,
  isTurnItemFunctionCall,
  isTurnItemFunctionCallOutput,
  isTurnItemMessage,
  isTurnItemPlan,
  isTurnItemReasoning,
} from './type-guards.ts'
export {
  createAgent,
  getAvailableProviders,
  getProviderAvailability,
  getProviderInventory,
  getProviderInventoryEntry,
  listModels,
  listSkills,
  writeCodexSkillConfig,
}
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
  TurnItemFileChange,
  TurnItemFunctionCall,
  TurnItemFunctionCallOutput,
  TurnItemMessage,
  TurnItemPlan,
  TurnItemReasoning,
  TurnItemUnknown,
  UserInput,
} from './types.ts'
export type {
  AgentAccountState,
  AgentCapabilities,
  AgentClient,
  AgentEvent,
  AgentHandlers,
  AgentModelInfo,
  AgentModelListOptions,
  AgentOpenSessionOptions,
  AgentProviderInventory,
  AgentProviderAvailability,
  AgentProviderId,
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
  AgentToolApprovalRequest,
  AgentUserInputRequest,
  ClaudeProviderHandle,
  CreateAgentOptions,
  CreateClaudeOptions,
  ProviderInventoryOptions,
} from './agent-types.ts'

/**
 * Create a Codex compatibility client.
 *
 * Prefer `createAgent({ provider: 'codex' })` for provider-neutral usage.
 */
export async function createCodex(options: CreateCodexOptions = {}): Promise<CodexClient> {
  return CodexClient.create(options)
}
