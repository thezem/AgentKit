// Codex-specific public types are intentionally kept in this file for compatibility.
export type AuthMode = 'chatgpt' | 'apiKey' | 'chatgptAuthTokens'

export type LoginStrategy = 'browser' | 'device-code'

export type ApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type ReasoningSummary = 'none' | 'auto' | 'concise' | 'detailed'

export type Personality = 'none' | 'friendly' | 'pragmatic'

export type CollaborationMode = {
  mode: 'default' | 'plan'
  settings?: {
    reasoning_effort?: string
    [key: string]: unknown
  }
}

export type UserInput =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; url: string }
      | { type: 'localImage'; path: string }
      | { type: 'skill'; name: string; path: string }
      | { type: 'mention'; name: string; path: string }
    >

export type JsonRpcId = number

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export type JsonRpcNotification = {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type JsonRpcSuccess = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

export type JsonRpcFailure = {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  error: {
    code: number
    message: string
    data?: unknown
  }
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure

export type CodexAccount =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string; planType: string }

export type AccountState = {
  account: CodexAccount | null
  requiresOpenaiAuth: boolean
}

export type LoginStartResult =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; loginId: string; authUrl: string }
  | { type: 'chatgptAuthTokens' }

export type LoginInfo = {
  strategy: LoginStrategy
  url?: string
  loginId?: string
  verificationUri?: string
  userCode?: string
  expiresInMinutes?: number
}

export type CodexModelListParams = {
  includeHidden?: boolean
  limit?: number
}

export type CodexModelDescriptor = {
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
  [key: string]: unknown
}

export type CodexModelListResponse = {
  data?: CodexModelDescriptor[]
  models?: CodexModelDescriptor[]
  nextCursor?: string | null
}

export type CodexSkillListParams = {
  cwds?: string[]
  cwd?: string
  extraUserRoots?: string[] | Record<string, string[]>
  forceReload?: boolean
}

export type CodexSkillDescriptor = {
  name: string
  path?: string
  description?: string
  enabled?: boolean
  interface?: string
  dependencies?: string[]
  [key: string]: unknown
}

export type CodexSkillListResponse = {
  skills?: CodexSkillDescriptor[]
  data?: Array<{
    cwd?: string
    skills?: CodexSkillDescriptor[]
    errors?: Array<{ message?: string } | string>
  }>
}

export type CodexSkillConfigWriteParams = {
  cwd: string
  path: string
  enabled: boolean
}

export type CodexSkillConfigWriteResponse = {
  changed?: boolean
  effectiveEnabled?: boolean
  [key: string]: unknown
}

export type TurnItemMessage = { type: 'agentMessage'; id: string; text: string; [key: string]: unknown }
export type TurnItemReasoning = {
  type: 'reasoning'
  id: string
  text?: string
  contentIndex?: number
  [key: string]: unknown
}
export type TurnItemFunctionCall = {
  type: 'functionCall'
  id: string
  name: string
  arguments: string
  callId?: string
  [key: string]: unknown
}
export type TurnItemFunctionCallOutput = {
  type: 'functionCallOutput'
  id: string
  callId: string
  output: string
  [key: string]: unknown
}
export type TurnItemFileChange = {
  type: 'fileChange'
  id: string
  path: string
  change: unknown
  [key: string]: unknown
}
export type TurnItemPlan = { type: 'plan'; id: string; text: string; [key: string]: unknown }
export type TurnItemUnknown = { type: string; id: string; [key: string]: unknown }

export type TurnItem =
  | TurnItemMessage
  | TurnItemReasoning
  | TurnItemFunctionCall
  | TurnItemFunctionCallOutput
  | TurnItemFileChange
  | TurnItemPlan
  | TurnItemUnknown

export type CodexTurn = {
  id: string
  items: TurnItem[]
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
  error: { message: string } | null
}

export type CodexThreadData = {
  id: string
  preview: string
  ephemeral: boolean
  modelProvider: string
  createdAt: number
  updatedAt: number
  status: string
  path: string | null
  cwd: string
  cliVersion: string
  source: string
  agentNickname: string | null
  agentRole: string | null
  gitInfo: unknown
  name: string | null
  turns: CodexTurn[]
}

export type RunResult = {
  threadId: string
  turnId: string
  status: CodexTurn['status']
  text: string
  items: TurnItem[]
  turn: CodexTurn
}

export type StreamEventBase = {
  threadId: string
  turnId?: string
}

/**
 * The two object variants use the exact field names from the Codex app-server
 * JSON-RPC wire shape (`execpolicy_amendment`, `network_policy_amendment`).
 * Verified on April 7, 2026 against the official App Server docs for
 * `acceptWithExecpolicyAmendment.execpolicy_amendment`. The network-amendment
 * variant is preserved for wire compatibility even though docs are less explicit.
 * The underscore-cased names are intentional; do not rename them.
 */
export type CommandApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: unknown } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: unknown } }

export type FileApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export type PermissionApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export type ToolInputAnswerMap = Record<string, { answers: string[] }>

export type DynamicToolResponse = {
  contentItems: Array<{ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }>
  success: boolean
}

export type CommandApprovalRequest = {
  requestId: JsonRpcId
  threadId: string
  turnId: string
  itemId: string
  params: Record<string, unknown>
  respond: (decision: CommandApprovalDecision) => Promise<void>
}

export type FileApprovalRequest = {
  requestId: JsonRpcId
  threadId: string
  turnId: string
  itemId: string
  params: Record<string, unknown>
  respond: (decision: FileApprovalDecision) => Promise<void>
}

export type PermissionApprovalRequest = {
  requestId: JsonRpcId
  threadId: string
  turnId: string
  itemId: string
  params: Record<string, unknown>
  respond: (decision: PermissionApprovalDecision) => Promise<void>
}

export type ToolInputRequest = {
  requestId: JsonRpcId
  threadId: string
  turnId: string
  itemId: string
  questions: Array<{
    id: string
    header: string
    question: string
    isOther: boolean
    isSecret: boolean
    options: Array<{ label: string; description?: string; isOther?: boolean }> | null
  }>
  respond: (answers: ToolInputAnswerMap) => Promise<void>
}

export type DynamicToolRequest = {
  requestId: JsonRpcId
  threadId: string
  turnId: string
  callId: string
  tool: string
  arguments: unknown
  respond: (result: DynamicToolResponse) => Promise<void>
}

export type RequestEvent =
  | ({
      type: 'approval.command'
    } & CommandApprovalRequest)
  | ({
      type: 'approval.file'
    } & FileApprovalRequest)
  | ({
      type: 'approval.permissions'
    } & PermissionApprovalRequest)
  | ({
      type: 'tool.input'
    } & ToolInputRequest)
  | ({
      type: 'tool.call'
    } & DynamicToolRequest)

export type CodexStreamEvent =
  | (StreamEventBase & { type: 'message.delta'; itemId: string; text: string })
  | (StreamEventBase & { type: 'reasoning.delta'; itemId: string; text: string; contentIndex?: number })
  | (StreamEventBase & { type: 'plan.delta'; itemId: string; text: string })
  | (StreamEventBase & { type: 'mcp.progress'; itemId: string; message: string })
  | (StreamEventBase & { type: 'item.started'; item: TurnItem })
  | (StreamEventBase & { type: 'item.completed'; item: TurnItem })
  | (StreamEventBase & { type: 'turn.started'; turn: CodexTurn })
  | (StreamEventBase & { type: 'turn.completed'; turn: CodexTurn })
  | RequestEvent
  | { type: 'notification'; method: string; params: unknown }

export type RequestHandlers = {
  onCommandApproval?: (request: CommandApprovalRequest) => Promise<CommandApprovalDecision> | CommandApprovalDecision
  onFileApproval?: (request: FileApprovalRequest) => Promise<FileApprovalDecision> | FileApprovalDecision
  onPermissionApproval?: (
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision> | PermissionApprovalDecision
  onToolInput?: (request: ToolInputRequest) => Promise<ToolInputAnswerMap> | ToolInputAnswerMap
  onDynamicToolCall?: (request: DynamicToolRequest) => Promise<DynamicToolResponse> | DynamicToolResponse
}

export type ThreadOptions = {
  model?: string
  cwd?: string
  approvalPolicy?: ApprovalPolicy
  sandboxMode?: SandboxMode
  collaborationMode?: CollaborationMode
  reasoningEffort?: ReasoningEffort
  reasoningSummary?: ReasoningSummary
  personality?: Personality
  outputSchema?: unknown
  config?: Record<string, unknown>
  baseInstructions?: string
  developerInstructions?: string
  ephemeral?: boolean
  persistExtendedHistory?: boolean
}

export type CreateCodexOptions = {
  codexPath?: string
  clientInfo?: {
    name?: string
    title?: string
    version?: string
  }
  auth?: {
    mode?: AuthMode
    strategy?: LoginStrategy
    autoLogin?: boolean
    timeoutMs?: number
    onLoginRequired?: (info: LoginInfo) => void | Promise<void>
    onLoginComplete?: (account: CodexAccount) => void | Promise<void>
  }
  requestTimeoutMs?: number
  maxQueueSize?: number
  diagnostics?: {
    logger?: (event: {
      level: 'debug' | 'info' | 'warn' | 'error'
      code: string
      message: string
      data?: Record<string, unknown>
    }) => void
  }
  defaults?: ThreadOptions
  handlers?: RequestHandlers
  env?: Record<string, string>
}

export type RunOptions = ThreadOptions & {
  handlers?: RequestHandlers
}
