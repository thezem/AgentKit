**Architecture** This is the rewrite I would hand to an implementation agent as the source-of-truth spec.

The new library is a provider-neutral runtime SDK. It does not expose auth, does not expose provider compatibility layers, and does not give Codex any privileged shape in the engine. Codex and Claude are both plugins behind the same adapter contract. Future providers like GitHub Copilot CLI must plug in without changing the core engine API.

Core product goals:

- One stable public API regardless of provider.
- A normalized request model translated into provider-native requests.
- A normalized event/result model translated back from provider-native responses.
- No auth flows, login helpers, or account-state abstractions.
- No compatibility exports for old Codex classes.
- No provider-specific root exports.
- No orchestration, persistence service, replay log, or websocket protocol in v1.
- No session-name cache convenience in core v1. Open and resume are explicit.

Core non-goals:

- Remote session deletion.
- Durable replay cursors.
- Durable pending approval recovery after reconnect.
- Cross-provider skill abstraction.
- Provider-specific escape hatches in the stable root API.

Recommended public API:

```ts
export type ProviderId = string

export interface AgentKitOptions {
  providers: ProviderAdapterFactory[]
  defaults?: Partial<SessionConfig>
  logger?: Logger
}

export interface AgentKit {
  openSession(request: OpenSessionRequest): Promise<AgentSession>
  resumeSession(handle: SessionHandle, request?: ResumeSessionRequest): Promise<AgentSession>
  getProviderInventory(options?: ProbeOptions): Promise<ProviderInventory[]>
  getProviderCapabilities(provider: ProviderId): Promise<ProviderCapabilities>
  listModels(provider: ProviderId, options?: ModelQuery): Promise<ModelInfo[]>
  close(): Promise<void>
}

export interface OpenSessionRequest {
  provider: ProviderId
  label?: string
  config?: Partial<SessionConfig>
}

export interface ResumeSessionRequest {
  label?: string
  config?: Partial<SessionConfig>
}

export interface AgentSession {
  readonly provider: ProviderId
  readonly localSessionId: string
  getSummary(): SessionSummary
  getHandle(): SessionHandle | null
  start(request: RunRequest): Promise<AgentRun>
  run(request: RunRequest): Promise<RunResult>
  stream(request: RunRequest): Promise<AsyncIterable<AgentEvent>>
  interrupt(): Promise<void>
  close(): Promise<void>
}

export interface AgentRun {
  readonly runId: string
  readonly provider: ProviderId
  readonly events: AsyncIterable<AgentEvent>
  readonly result: Promise<RunResult>
  interrupt(): Promise<void>
}

export interface RunRequest {
  input: TurnInput
  config?: Partial<TurnConfig>
  handlers?: InteractionHandlers
  metadata?: Record<string, string>
}

export type TurnInput =
  | string
  | {
      instructions?: string
      messages: InputMessage[]
    }

export interface InputMessage {
  role: 'system' | 'user' | 'assistant'
  content: ContentPart[]
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }
```

Normalized session config:

```ts
export interface SessionConfig {
  cwd?: string
  env?: Record<string, string>
  model?: string
  sandbox?: 'provider-default' | 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalMode?: 'provider-default' | 'manual' | 'auto-approve' | 'auto-deny'
  includeReasoning?: boolean
  additionalDirectories?: string[]
}

export interface TurnConfig extends SessionConfig {
  timeoutMs?: number
}
```

Normalized persisted handle contract:

```ts
export interface SessionHandle {
  version: 1
  provider: ProviderId
  providerSessionId: string | null
  resumeToken: string | null
  resumeCursor: string | null
  state?: Record<string, unknown>
}
```

Rules for `SessionHandle`:

- It must be JSON-serializable.
- It is the only supported cross-process resume artifact.
- `state` is provider-owned opaque data, but must still be serializable JSON.
- Consumers may persist it, but must not branch on `state`.
- `version` is mandatory so handle evolution is possible later.

Normalized event contract:

```ts
export type AgentEvent =
  | {
      type: 'run.started'
      runId: string
      provider: ProviderId
      sessionId: string | null
      timestamp: string
    }
  | {
      type: 'message.delta'
      runId: string
      provider: ProviderId
      messageId: string
      role: 'assistant'
      text: string
      timestamp: string
    }
  | {
      type: 'message.completed'
      runId: string
      provider: ProviderId
      messageId: string
      role: 'assistant'
      text: string
      timestamp: string
    }
  | {
      type: 'reasoning.delta'
      runId: string
      provider: ProviderId
      blockId: string
      text: string
      timestamp: string
    }
  | {
      type: 'status.updated'
      runId: string
      provider: ProviderId
      status: 'queued' | 'running' | 'waiting-input' | 'waiting-approval' | 'completed' | 'interrupted' | 'failed'
      timestamp: string
    }
  | {
      type: 'tool.approval.requested'
      runId: string
      provider: ProviderId
      request: ToolApprovalRequest
      timestamp: string
    }
  | {
      type: 'user.input.requested'
      runId: string
      provider: ProviderId
      request: UserInputRequest
      timestamp: string
    }
  | {
      type: 'artifact.emitted'
      runId: string
      provider: ProviderId
      item: OutputItem
      timestamp: string
    }
  | {
      type: 'run.completed'
      runId: string
      provider: ProviderId
      status: 'completed' | 'interrupted' | 'failed'
      stopReason?: string
      handle?: SessionHandle
      usage?: UsageSummary
      timestamp: string
    }
  | {
      type: 'error'
      runId: string
      provider: ProviderId
      error: AgentErrorPayload
      timestamp: string
    }
```

Normalized interactive request contracts:

```ts
export interface ToolApprovalRequest {
  id: string
  kind: 'command' | 'file' | 'network' | 'tool' | 'permission' | 'unknown'
  title: string
  details?: string
  risk: 'low' | 'medium' | 'high' | 'unknown'
  raw?: Record<string, unknown>
}

export interface UserInputRequest {
  id: string
  prompt: string
  description?: string
  secret?: boolean
  multiSelect?: boolean
  options?: Array<{ value: string; label: string; description?: string }>
  schema?: Record<string, unknown>
  raw?: Record<string, unknown>
}

export interface InteractionHandlers {
  onToolApproval?: (request: ToolApprovalRequest) => Promise<'approve' | 'deny'> | 'approve' | 'deny'
  onUserInput?: (request: UserInputRequest) => Promise<string | string[]> | string | string[]
}
```

Normalized result contract:

```ts
export interface RunResult {
  runId: string
  provider: ProviderId
  sessionId: string | null
  status: 'completed' | 'interrupted' | 'failed'
  stopReason?: string
  outputText: string
  items: OutputItem[]
  usage?: UsageSummary
  handle?: SessionHandle
  startedAt: string
  completedAt: string
}

export type OutputItem =
  | { type: 'message'; id: string; role: 'assistant'; text: string }
  | { type: 'reasoning'; id: string; text: string }
  | { type: 'tool-call'; id: string; name: string; input?: Record<string, unknown>; status?: 'started' | 'completed' | 'failed' }
  | { type: 'tool-result'; id: string; toolCallId?: string; text: string; isError?: boolean }
  | { type: 'plan'; id: string; text: string }
  | { type: 'file-change'; id: string; path: string; changeType?: 'create' | 'update' | 'delete' }
  | { type: 'provider'; id: string; name: string; payload: Record<string, unknown> }

export interface UsageSummary {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}
```

Hard runtime rules:

- One active run per session. A second `start`, `run`, or `stream` call while a run is active must fail with `RUN_IN_PROGRESS`.
- `run()` is sugar over `start()` that drains the event stream and returns `result`.
- `stream()` is sugar over `start()` that returns only `events`.
- `interrupt()` targets the active run only. If no run is active, fail with `NO_ACTIVE_RUN`.
- `close()` is idempotent.
- `resumeSession()` is explicit. There is no local name cache.
- Remote deletion is out of scope.
- Event ordering is live order only for the current run attachment. No stable replay IDs in v1.
- If a provider cannot produce a terminal event because the transport dies, the run fails by rejection and the engine surfaces a terminal `error` followed by a failed `RunResult` if possible. If not possible, `result` rejects.

**Implementation** Recommended package layout:

```text
src/
  index.ts
  public-types.ts
  errors.ts
  core/
    create-agentkit.ts
    agentkit.ts
    session.ts
    run-controller.ts
    result-accumulator.ts
    event-types.ts
    handle.ts
    config.ts
    logger.ts
  contracts/
    provider.ts
    translation.ts
    discovery.ts
    runtime.ts
  providers/
    codex/
      index.ts
      adapter.ts
      runtime.ts
      request-translator.ts
      event-translator.ts
      handle-translator.ts
      error-translator.ts
      discovery.ts
      models.ts
      transport.ts
    claude/
      index.ts
      adapter.ts
      runtime.ts
      request-translator.ts
      event-translator.ts
      handle-translator.ts
      error-translator.ts
      discovery.ts
      models.ts
      prompt-queue.ts
  test/
    contract/
    unit/
    fixtures/
    smoke/
```

Core architectural rule:

- `core/*` knows only normalized contracts.
- `providers/*` know provider specifics.
- No provider imports another provider.
- index.ts exports only provider-neutral types and `createAgentKit`.
- Provider registration happens through factories, not special cases.

Provider registration API:

```ts
export interface ProviderAdapterFactory {
  create(context: ProviderFactoryContext): ProviderAdapter
}

export interface ProviderAdapter {
  readonly id: ProviderId
  readonly displayName: string
  readonly version: string

  probe(options?: ProbeOptions): Promise<ProviderInventory>
  getCapabilities(): ProviderCapabilities
  listModels?(options?: ModelQuery): Promise<ModelInfo[]>

  openSession(input: ProviderOpenSessionInput): Promise<ProviderSessionRuntime>
  resumeSession(handle: SessionHandle, input?: ProviderResumeSessionInput): Promise<ProviderSessionRuntime>
}
```

Provider runtime contract:

```ts
export interface ProviderSessionRuntime {
  readonly provider: ProviderId
  getSnapshot(): Promise<ProviderSessionSnapshot>
  getHandle(): Promise<SessionHandle | null> | SessionHandle | null
  startRun(request: ProviderRunRequest, sink: ProviderEventSink): Promise<ProviderRunCompletion>
  interrupt(): Promise<void>
  close(): Promise<void>
}
```

Translation pipeline is explicit and mandatory:

1. Core receives `RunRequest`.
2. Core validates normalized config against provider capabilities.
3. Provider `request-translator` converts normalized request to provider-native request.
4. Provider `runtime` sends request to provider process or SDK.
5. Provider-native events flow through `event-translator`.
6. `event-translator` emits normalized `AgentEvent` records only.
7. Core `result-accumulator` synthesizes the canonical `RunResult`.
8. Provider `handle-translator` updates or emits the latest `SessionHandle`.

Required internal modules and responsibilities:

- `run-controller.ts`: owns one active run, event sink wiring, handler lifecycle, cancellation, finalization.
- `result-accumulator.ts`: consumes normalized events and builds `RunResult` deterministically.
- `handle.ts`: validates handle versioning and JSON safety.
- `config.ts`: merges defaults and validates unsupported combinations.
- `errors.ts`: owns stable error codes and retryability metadata.

Stable error taxonomy:

```ts
export type AgentErrorCode =
  | 'INVALID_PROVIDER'
  | 'PROVIDER_NOT_INSTALLED'
  | 'PROVIDER_NOT_RUNNABLE'
  | 'UNSUPPORTED_FEATURE'
  | 'INVALID_HANDLE'
  | 'EXPIRED_HANDLE'
  | 'SESSION_CLOSED'
  | 'RUN_IN_PROGRESS'
  | 'NO_ACTIVE_RUN'
  | 'INTERRUPT_NOT_SUPPORTED'
  | 'USER_INPUT_UNHANDLED'
  | 'TOOL_APPROVAL_UNHANDLED'
  | 'TRANSPORT_ERROR'
  | 'PROVIDER_PROTOCOL_ERROR'
  | 'TRANSLATION_ERROR'
  | 'PROBE_TIMEOUT'
  | 'INTERNAL_ERROR'

export interface AgentErrorPayload {
  code: AgentErrorCode
  message: string
  retryable: boolean
  provider?: ProviderId
  details?: Record<string, unknown>
}
```

Discovery contract with no auth:

```ts
export interface ProviderInventory {
  provider: ProviderId
  displayName: string
  installed: boolean
  runnable: boolean
  healthy: boolean
  status: 'missing' | 'installed' | 'runnable' | 'ready' | 'degraded'
  executablePath?: string
  version?: string
  diagnostics?: {
    probeMode: 'cheap' | 'deep'
    failureReason?: string
    notes?: string[]
  }
}

export interface ProviderCapabilities {
  session: {
    open: boolean
    resume: boolean
    interrupt: boolean
    close: boolean
  }
  streaming: {
    messageDeltas: boolean
    reasoningDeltas: boolean
    runStatus: boolean
  }
  interaction: {
    toolApproval: boolean
    userInput: boolean
  }
  config: {
    cwd: boolean
    env: boolean
    model: boolean
    sandbox: boolean
    approvalMode: boolean
    additionalDirectories: boolean
  }
  discovery: {
    models: boolean
  }
}
```

Important product choices that simplify the rewrite:

- Remove all account/auth concepts from core types.
- Remove skill APIs from v1 core. They are provider-specific and currently Codex-biased.
- Remove all root-level provider escape hatches from v1.
- Remove local named session caching from v1.
- Remove provider-native event/item types from public exports.
- Use `ProviderId = string`, not a hardcoded union, so adding Copilot later does not force a core type edit.

Provider-specific implementation notes that must be captured in the spec:

- Codex provider uses its own transport internally, but transport is private to the provider module.
- Claude provider uses its runtime/SDK internally, but long-lived runtime details must remain private to the provider module.
- Both providers must implement the same contract tests.
- Both providers must return normalized `SessionHandle` objects, even if their native session identity is asymmetric.
- Provider-specific close semantics may differ internally, but the public API stays the same: close the local runtime wrapper, do not promise remote deletion.

Contract tests that every provider must pass:

1. Open session, run prompt, receive normalized result.
2. Open session, stream prompt, receive valid event ordering.
3. Persist handle, recreate engine, resume session, run again.
4. Interrupt active run and surface interrupted status.
5. Fail concurrent run on same session.
6. Close session and reject further runs.
7. Reject invalid handle with `INVALID_HANDLE` or `EXPIRED_HANDLE`.
8. Respect capability gating for unsupported config fields.
9. Produce JSON-serializable handles only.
10. Return the same normalized result shape for both Codex and Claude.

**Delivery** Implementation order should be test-first and contract-first.

1. Write all provider-neutral public types and contract tests before implementation.
2. Implement core engine, session, run controller, accumulator, and error system with a fake provider.
3. Implement Codex provider against the contract.
4. Implement Claude provider against the same contract.
5. Add discovery and model listing.
6. Add smoke tests and examples showing provider swap with no code-path changes except provider id.

Acceptance criteria for the rewrite:

1. Changing from Codex to Claude in consumer code means changing only the `provider` value and, optionally, config values like `model`.
2. No root export contains provider-specific class names or auth APIs.
3. No auth module exists anywhere in the core public surface.
4. All stable public types are provider-neutral.
5. Adding a new provider does not require editing core runtime logic, only registration and tests.
6. Both built-in providers pass the identical contract test suite.
7. Session handles survive JSON serialize/deserialize round trips.
8. The public `RunResult` never contains provider-native item shapes except through the normalized `OutputItem` union.
9. The engine does not know whether the provider is Codex, Claude, or something added later.
10. The README examples for both providers share the same API shape.

If I were actually building this, I would name the deliverable `REWRITE_SPEC.md` and use it as the build contract for the agent. The next useful step is one of these:

1. I can turn this into a full spec document format with RFC-style sections, exact TypeScript interfaces, and acceptance tests.
2. I can convert this into an implementation backlog with phases, files, and agent-sized tasks.
3. I can draft the new public API and contract tests in code form without implementing the providers yet.
