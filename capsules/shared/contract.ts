/**
 * The provider contract every capsule implements.
 *
 * Shape is adapted from paseo's `AgentClient` / `AgentSession` (Apache-2.0,
 * packages/server/src/server/agent/agent-sdk-types.ts), trimmed of paseo-only
 * concerns (plugins, voice, paseo tool catalog, daemon prompts).
 *
 * Rule: a capsule may only depend on this folder plus its own SDK. AgentKit
 * (src/) is the only thing that knows about more than one capsule.
 */

export type ProviderId = 'claude' | 'codex' | 'opencode' | 'mock' | (string & {})

export type Metadata = Record<string, unknown>

// ---------------------------------------------------------------- MCP

/** `alwaysLoad`: keep the server's tools in context instead of behind tool search (Claude; others always load). */
export type McpServerConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; alwaysLoad?: boolean }
  | { type: 'http'; url: string; headers?: Record<string, string>; alwaysLoad?: boolean }
  | { type: 'sse'; url: string; headers?: Record<string, string>; alwaysLoad?: boolean }

// ---------------------------------------------------------------- catalog

export interface AgentMode {
  id: string
  label: string
  description?: string
  /** True when the mode runs without asking for permission (bypass / full access). */
  unattended?: boolean
}

export interface ThinkingOption {
  id: string
  label: string
  description?: string
  isDefault?: boolean
}

export interface AgentModel {
  provider: ProviderId
  id: string
  label: string
  description?: string
  isDefault?: boolean
  contextWindowMaxTokens?: number
  /**
   * Where the model comes from inside a multi-backend provider. OpenCode: the
   * connection's provider id, e.g. 'opencode-go' (Go subscription), 'opencode' (Zen), 'vercel'.
   */
  source?: string
  thinkingOptions?: ThinkingOption[]
  defaultThinkingOptionId?: string
  /** Model has a faster (usually pricier) serving tier: Claude fast mode, Codex priority tier. */
  supportsFastMode?: boolean
  /** Provider's own wording, e.g. "1.5x speed, increased usage". */
  fastModeDescription?: string
  metadata?: Metadata
}

export interface ProviderCatalog {
  models: AgentModel[]
  modes: AgentMode[]
  defaultModeId?: string | null
}

// ---------------------------------------------------------------- capabilities

/** Every primitive AgentKit knows about. A provider sets true for what it truly supports. */
export interface Capabilities {
  streaming: boolean
  reasoningStream: boolean
  /** Tool calls arrive as typed `ToolDetail` (shell/read/edit/...). */
  toolDetail: boolean
  permissions: boolean
  /** Agent can ask the user structured questions (kind: 'question'). */
  questions: boolean
  persistence: boolean
  sessionListing: boolean
  history: boolean
  modeSwitch: boolean
  modelSwitch: boolean
  thinkingSwitch: boolean
  /** Toggle a faster serving tier per session (see AgentModel.supportsFastMode). */
  fastMode: boolean
  mcpServers: boolean
  /** Inject input into a turn that is still running. */
  steer: boolean
  slashCommands: boolean
  images: boolean
  structuredOutput: boolean
  rewindConversation: boolean
  rewindFiles: boolean
  archive: boolean
  systemPrompt: boolean
  /** Branch the conversation into a new native session; the original is untouched. */
  fork: boolean
  /** Summarize older context to free the window (native compaction). */
  compact: boolean
  /** Subscription / plan rate-limit windows (`ProviderClient.planUsage`). */
  planUsage: boolean
  /** Tool-less one-shot completion that leaves no session behind (`ProviderClient.complete`). */
  complete: boolean
}

export type CapabilityName = keyof Capabilities

// ---------------------------------------------------------------- prompts

export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  /** Native skill attachment. AgentKit only sends this to capsules that load skills natively (Codex). */
  | { type: 'skill'; name: string; path: string }

/** A skill as a provider's own API reports it (Codex `skills/list`). */
export interface NativeSkill {
  name: string
  description: string
  path: string
  scope: 'user' | 'project' | 'system' | 'plugin'
  enabled?: boolean
}

export type PromptInput = string | PromptBlock[]

// ---------------------------------------------------------------- tool calls

export type ToolDetail =
  | { type: 'shell'; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: 'read'; filePath: string; content?: string; offset?: number; limit?: number }
  | { type: 'edit'; filePath: string; oldString?: string; newString?: string; unifiedDiff?: string }
  | { type: 'write'; filePath: string; content?: string }
  | { type: 'search'; query: string; kind?: 'grep' | 'glob' | 'web'; output?: string; filePaths?: string[] }
  | { type: 'fetch'; url: string; prompt?: string; output?: string }
  | { type: 'mcp'; server: string; tool: string; input: unknown; output?: unknown }
  | { type: 'sub_agent'; description?: string; subAgentType?: string; childSessionId?: string; output?: string }
  | { type: 'plan'; text: string }
  | { type: 'todo'; items: TodoItem[] }
  | { type: 'unknown'; input: unknown; output?: unknown }

export type ToolStatus = 'running' | 'completed' | 'failed' | 'canceled'

export interface ToolCallItem {
  type: 'tool_call'
  callId: string
  /** Provider-native tool name (Bash, commandExecution, shell, ...). */
  name: string
  status: ToolStatus
  detail: ToolDetail
  error?: string
  metadata?: Metadata
}

export interface TodoItem {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

// ---------------------------------------------------------------- timeline + events

export type TimelineItem =
  /** `attachments`: files sent with the message (AgentKit parses them out of `text`, see attachment-tags). */
  | { type: 'user_message'; text: string; messageId?: string; clientMessageId?: string; attachments?: AttachmentRef[] }
  /** Assistant text. Live events carry deltas; history replays carry full text. */
  | { type: 'assistant_message'; text: string; messageId?: string }
  | { type: 'reasoning'; text: string }
  | ToolCallItem
  | { type: 'todo'; items: TodoItem[] }
  | { type: 'compaction'; status: 'running' | 'completed' }
  | { type: 'error'; message: string }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string }

export interface Usage {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  totalCostUsd?: number
  contextWindowMaxTokens?: number
  contextWindowUsedTokens?: number
}

export type AgentEvent =
  | { type: 'session_started'; provider: ProviderId; sessionId: string }
  | { type: 'turn_started'; provider: ProviderId; turnId: string }
  | { type: 'turn_completed'; provider: ProviderId; turnId: string; usage?: Usage }
  | { type: 'turn_failed'; provider: ProviderId; turnId: string; error: string }
  | { type: 'turn_canceled'; provider: ProviderId; turnId: string; reason: string }
  | { type: 'timeline'; provider: ProviderId; item: TimelineItem; turnId?: string; timestamp: string }
  | { type: 'usage'; provider: ProviderId; usage: Usage; turnId?: string }
  | { type: 'permission_requested'; provider: ProviderId; request: PermissionRequest; turnId?: string }
  | { type: 'permission_resolved'; provider: ProviderId; requestId: string; response: PermissionResponse }
  | { type: 'mode_changed'; provider: ProviderId; modeId: string | null }
  | { type: 'model_changed'; provider: ProviderId; model: string | null }
  | { type: 'thinking_changed'; provider: ProviderId; thinkingOptionId: string | null }
  | { type: 'fast_changed'; provider: ProviderId; enabled: boolean }
  /** The provider pushed fresh plan rate-limit numbers (Codex does after turns). */
  | { type: 'plan_usage'; provider: ProviderId; usage: PlanUsage }
  // Emitted by AgentKit itself, never by capsules:
  /** Prompts waiting for the current turn, in order. Visible + withdrawable. */
  | { type: 'inbox_changed'; provider: ProviderId; inbox: InboxEntry[] }
  /** A turn that was running when the process died. Never auto-resent. */
  | { type: 'turn_interrupted'; provider: ProviderId; turnId: string | null; submissionId: string | null; reason: string }

/** A file sent with a prompt, as saved by AgentKit. */
export interface AttachmentRef {
  name: string
  /** Absolute path the agent reads. */
  path: string
  mimeType: string
  size: number
}

/** One rate-limit window, normalized across providers. */
export interface UsageWindow {
  /** Provider's id, e.g. 'five_hour', 'seven_day', 'primary'. */
  id: string
  label: string
  /** 0–100, null when the provider didn't say. */
  usedPercent: number | null
  /** ISO timestamp. */
  resetsAt: string | null
  windowMinutes?: number | null
}

export interface PlanUsage {
  provider: ProviderId
  /** e.g. 'pro', 'max', 'plus'. Null when unknown or not a subscription (API key). */
  plan: string | null
  /** False when plan limits don't apply (API key, 3P cloud); `windows` is then empty. */
  available: boolean
  windows: UsageWindow[]
  /** Provider payload as received. Shapes change; don't build UI on it. */
  raw?: unknown
}

export interface CompleteOptions {
  model?: string
  thinkingOptionId?: string
  systemPrompt?: string
  cwd?: string
  signal?: AbortSignal
}

export interface CompleteResult {
  text: string
  usage?: Usage
  model?: string
}

/** How full the model's context is. Either side can be null when the provider hasn't said yet. */
export interface ContextWindow {
  usedTokens: number | null
  maxTokens: number | null
}

export interface InboxEntry {
  /** Submission id (your requestId if you passed one). */
  id: string
  text: string
  whenBusy: 'queue' | 'steer'
  at: string
}

export type TerminalEvent = Extract<AgentEvent, { type: 'turn_completed' | 'turn_failed' | 'turn_canceled' }>

export function isTerminalEvent(event: AgentEvent): event is TerminalEvent {
  return event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_canceled'
}

// ---------------------------------------------------------------- permissions

export type PermissionKind = 'tool' | 'question' | 'plan' | 'other'

export interface PermissionAction {
  id: string
  label: string
  behavior: 'allow' | 'deny'
}

export interface Question {
  id: string
  header?: string
  question: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  allowOther?: boolean
}

export interface PermissionRequest {
  id: string
  provider: ProviderId
  kind: PermissionKind
  /** Provider-native tool name. */
  name: string
  title?: string
  description?: string
  input?: unknown
  detail?: ToolDetail
  questions?: Question[]
  actions?: PermissionAction[]
  metadata?: Metadata
}

export type PermissionResponse =
  | {
      behavior: 'allow'
      /** Matches `PermissionAction.id`, e.g. 'always' to remember for the session. */
      actionId?: string
      updatedInput?: unknown
      /** For kind 'question': answers keyed by question id. */
      answers?: Record<string, string | string[]>
    }
  | { behavior: 'deny'; actionId?: string; message?: string; interrupt?: boolean }

// ---------------------------------------------------------------- sessions

export interface SessionConfig {
  cwd: string
  model?: string
  modeId?: string
  thinkingOptionId?: string
  /** Start in fast mode when the model supports it. */
  fast?: boolean
  /** Appended to the provider's own system prompt. */
  systemPrompt?: string
  mcpServers?: Record<string, McpServerConfig>
  /**
   * `exclusive`: use only `mcpServers`, ignore the CLI's own MCP config (no duplicates).
   * `shared`: the URLs are stable across sessions (AgentKit's hub), so a capsule may register
   * them once instead of isolating per session.
   */
  mcp?: { exclusive?: boolean; shared?: boolean }
  /** Extra folders the agent may read without asking (AgentKit passes its attachments folder). Claude: additionalDirectories. */
  readableDirs?: string[]
  title?: string
  env?: Record<string, string>
  /** Raw provider-native options merged last. The escape hatch. */
  providerOptions?: Metadata
  /** false = do not leave a durable native session behind. */
  persist?: boolean
}

export interface PersistenceHandle {
  provider: ProviderId
  /** Native id: Claude session id, Codex thread id, OpenCode session id. */
  sessionId: string
  cwd: string
  metadata?: Metadata
}

export interface RuntimeInfo {
  provider: ProviderId
  sessionId: string | null
  model: string | null
  modeId: string | null
  thinkingOptionId: string | null
  fast: boolean
  extra?: Metadata
}

export interface SlashCommand {
  name: string
  description: string
  argumentHint?: string
  kind?: 'command' | 'skill'
}

export interface TurnOptions {
  /** JSON schema the final answer must satisfy. */
  outputSchema?: unknown
  clientMessageId?: string
  signal?: AbortSignal
}

export interface RunResult {
  sessionId: string | null
  turnId: string
  status: 'completed' | 'failed' | 'canceled'
  finalText: string
  error?: string
  usage?: Usage
  timeline: TimelineItem[]
}

export interface SessionSummary {
  provider: ProviderId
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: Date
}

export interface ProviderSession {
  readonly provider: ProviderId
  readonly id: string | null
  readonly capabilities: Capabilities

  subscribe(listener: (event: AgentEvent) => void): () => void
  startTurn(prompt: PromptInput, options?: TurnOptions): Promise<{ turnId: string }>
  run(prompt: PromptInput, options?: TurnOptions): Promise<RunResult>
  /** Resolves once the active turn is no longer running. Idle = no-op. */
  interrupt(): Promise<void>
  close(): Promise<void>

  getPendingPermissions(): PermissionRequest[]
  respondToPermission(requestId: string, response: PermissionResponse): Promise<void>

  getRuntimeInfo(): Promise<RuntimeInfo>
  getModes(): Promise<AgentMode[]>
  setMode(modeId: string): Promise<void>
  describePersistence(): PersistenceHandle | null

  setModel?(model: string | null): Promise<void>
  setThinking?(thinkingOptionId: string | null): Promise<void>
  setFast?(enabled: boolean): Promise<void>
  steer?(prompt: PromptInput, options: { expectedTurnId: string }): Promise<{ accepted: boolean }>
  listCommands?(): Promise<SlashCommand[]>
  /** Replay the persisted conversation as timeline items. */
  history?(): AsyncIterable<TimelineItem>
  rewind?(input: { messageId: string; scope: 'conversation' | 'files' | 'both' }): Promise<void>
  /**
   * New native session with this conversation up to (not including) `beforeMessageId`,
   * or all of it when omitted. Must not change this session. Returns a resumable handle.
   */
  fork?(input: { beforeMessageId?: string }): Promise<PersistenceHandle>
  /** Native compaction. Resolves when the provider reports it done. */
  compact?(input: { instructions?: string }): Promise<void>
  /** Exact window for the session's current model, as reported by the provider (not a lookup table). */
  contextWindow?(): Promise<ContextWindow>
}

export interface ProviderClient {
  readonly provider: ProviderId
  readonly label: string
  readonly capabilities: Capabilities

  /** Skills exactly as this CLI would load them for `cwd`, when it has an API for that. */
  listSkills?(options: { cwd: string }): Promise<NativeSkill[]>

  /** Binary present + runnable. Does not prove the user is signed in. */
  isAvailable(signal?: AbortSignal): Promise<boolean>
  fetchCatalog(options?: { cwd?: string; signal?: AbortSignal }): Promise<ProviderCatalog>
  createSession(config: SessionConfig): Promise<ProviderSession>
  resumeSession(handle: PersistenceHandle, overrides?: Partial<SessionConfig>): Promise<ProviderSession>
  listSessions?(options?: { cwd?: string; limit?: number; query?: string }): Promise<SessionSummary[]>
  archiveSession?(handle: PersistenceHandle): Promise<void>
  /** Plan / subscription rate-limit windows for the signed-in account. Gated by `capabilities.planUsage`. */
  planUsage?(): Promise<PlanUsage>
  /** One-shot, tool-less completion; nothing is persisted. Gated by `capabilities.complete`. */
  complete?(prompt: string, options?: CompleteOptions): Promise<CompleteResult>
  /** Release background processes. Idempotent. */
  shutdown(): Promise<void>
}

export const NO_CAPABILITIES: Capabilities = {
  streaming: false,
  reasoningStream: false,
  toolDetail: false,
  permissions: false,
  questions: false,
  persistence: false,
  sessionListing: false,
  history: false,
  modeSwitch: false,
  modelSwitch: false,
  thinkingSwitch: false,
  fastMode: false,
  mcpServers: false,
  steer: false,
  slashCommands: false,
  images: false,
  structuredOutput: false,
  rewindConversation: false,
  rewindFiles: false,
  archive: false,
  systemPrompt: false,
  fork: false,
  compact: false,
  planUsage: false,
  complete: false,
}
