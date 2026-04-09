import type { AgentEvent } from './agent-types.ts'
import type {
  CodexStreamEvent,
  TurnItem,
  TurnItemFileChange,
  TurnItemFunctionCall,
  TurnItemFunctionCallOutput,
  TurnItemMessage,
  TurnItemPlan,
  TurnItemReasoning,
} from './types.ts'

export function isTurnItemMessage(item: TurnItem): item is TurnItemMessage {
  return item.type === 'agentMessage'
}

export function isTurnItemReasoning(item: TurnItem): item is TurnItemReasoning {
  return item.type === 'reasoning'
}

export function isTurnItemFunctionCall(item: TurnItem): item is TurnItemFunctionCall {
  return item.type === 'functionCall'
}

export function isTurnItemFunctionCallOutput(item: TurnItem): item is TurnItemFunctionCallOutput {
  return item.type === 'functionCallOutput'
}

export function isTurnItemFileChange(item: TurnItem): item is TurnItemFileChange {
  return item.type === 'fileChange'
}

export function isTurnItemPlan(item: TurnItem): item is TurnItemPlan {
  return item.type === 'plan'
}

export function isCodexMessageDeltaEvent(
  event: CodexStreamEvent,
): event is Extract<CodexStreamEvent, { type: 'message.delta' }> {
  return event.type === 'message.delta'
}

export function isCodexReasoningDeltaEvent(
  event: CodexStreamEvent,
): event is Extract<CodexStreamEvent, { type: 'reasoning.delta' }> {
  return event.type === 'reasoning.delta'
}

export function isCodexPlanDeltaEvent(
  event: CodexStreamEvent,
): event is Extract<CodexStreamEvent, { type: 'plan.delta' }> {
  return event.type === 'plan.delta'
}

export function isCodexMcpProgressEvent(
  event: CodexStreamEvent,
): event is Extract<CodexStreamEvent, { type: 'mcp.progress' }> {
  return event.type === 'mcp.progress'
}

export function isCodexItemStartedEvent(
  event: CodexStreamEvent,
): event is Extract<CodexStreamEvent, { type: 'item.started' }> {
  return event.type === 'item.started'
}

export function isCodexItemCompletedEvent(
  event: CodexStreamEvent,
): event is Extract<CodexStreamEvent, { type: 'item.completed' }> {
  return event.type === 'item.completed'
}

export function isCodexTurnStartedEvent(
  event: CodexStreamEvent,
): event is Extract<CodexStreamEvent, { type: 'turn.started' }> {
  return event.type === 'turn.started'
}

export function isCodexTurnCompletedEvent(
  event: CodexStreamEvent,
): event is Extract<CodexStreamEvent, { type: 'turn.completed' }> {
  return event.type === 'turn.completed'
}

export function isCodexApprovalCommandEvent(
  event: CodexStreamEvent,
): event is Extract<CodexStreamEvent, { type: 'approval.command' }> {
  return event.type === 'approval.command'
}

export function isCodexApprovalFileEvent(
  event: CodexStreamEvent,
): event is Extract<CodexStreamEvent, { type: 'approval.file' }> {
  return event.type === 'approval.file'
}

export function isCodexApprovalPermissionsEvent(
  event: CodexStreamEvent,
): event is Extract<CodexStreamEvent, { type: 'approval.permissions' }> {
  return event.type === 'approval.permissions'
}

export function isCodexToolInputEvent(
  event: CodexStreamEvent,
): event is Extract<CodexStreamEvent, { type: 'tool.input' }> {
  return event.type === 'tool.input'
}

export function isCodexToolCallEvent(
  event: CodexStreamEvent,
): event is Extract<CodexStreamEvent, { type: 'tool.call' }> {
  return event.type === 'tool.call'
}

export function isCodexNotificationEvent(
  event: CodexStreamEvent,
): event is Extract<CodexStreamEvent, { type: 'notification' }> {
  return event.type === 'notification'
}

export function isAgentMessageDeltaEvent(event: AgentEvent): event is Extract<AgentEvent, { type: 'message.delta' }> {
  return event.type === 'message.delta'
}

export function isAgentMessageCompletedEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'message.completed' }> {
  return event.type === 'message.completed'
}

export function isAgentReasoningDeltaEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'reasoning.delta' }> {
  return event.type === 'reasoning.delta'
}

export function isAgentRunStartedEvent(event: AgentEvent): event is Extract<AgentEvent, { type: 'run.started' }> {
  return event.type === 'run.started'
}

export function isAgentStatusUpdatedEvent(event: AgentEvent): event is Extract<AgentEvent, { type: 'status.updated' }> {
  return event.type === 'status.updated'
}

export function isAgentToolApprovalEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'approval.tool' }> {
  return event.type === 'approval.tool'
}

export function isAgentUserInputEvent(event: AgentEvent): event is Extract<AgentEvent, { type: 'user.input' }> {
  return event.type === 'user.input'
}

export function isAgentRunCompletedEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'run.completed' }> {
  return event.type === 'run.completed'
}

export function isAgentProviderNotificationEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'provider.notification' }> {
  return event.type === 'provider.notification'
}

export function isAgentErrorEvent(event: AgentEvent): event is Extract<AgentEvent, { type: 'error' }> {
  return event.type === 'error'
}
