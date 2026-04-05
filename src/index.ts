import { CodexClient } from './codex-client.ts'
import type { CreateCodexOptions } from './types.ts'

export { CodexAuth } from './auth.ts'
export { CodexClient } from './codex-client.ts'
export { CodexSession } from './session.ts'
export { CodexThread } from './thread.ts'
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

export async function createCodex(options: CreateCodexOptions = {}): Promise<CodexClient> {
  return CodexClient.create(options)
}
