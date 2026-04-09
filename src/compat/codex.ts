import { CodexClient } from '../codex-client.ts'
import type { CreateCodexOptions } from '../types.ts'
import { writeCodexSkillConfig } from '../providers/codex-adapter.ts'

export { CodexAuth } from '../auth.ts'
export { CodexClient } from '../codex-client.ts'
export { CodexSession } from '../session.ts'
export { CodexThread } from '../thread.ts'
export { writeCodexSkillConfig }
export type { WriteCodexSkillConfigOptions } from '../providers/codex-adapter.ts'
export {
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
} from '../type-guards.ts'
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
} from '../types.ts'

export async function createCodex(options: CreateCodexOptions = {}): Promise<CodexClient> {
  return CodexClient.create(options)
}
