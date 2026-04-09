# Runtime Contract

This document is the Phase 1 baseline for the current `@ouim/agentkit` runtime semantics.

It is normative for the API that exists today. It does not introduce new abstractions for replay, orchestration, durable pending-request recovery, or adapter-tier envelopes. Where the implementation is intentionally thinner than an orchestration system, that boundary is explicit below.

## Scope

This contract covers the current shared runtime surface:

- `createAgent()`
- `AgentClient.session()`
- `AgentClient.openSession()`
- `AgentClient.resumeSession()`
- `AgentSession.run()`
- `AgentSession.stream()`
- `AgentSession.interrupt()`
- `AgentSession.close()`
- `AgentClient.getCapabilities()`
- `getProviderInventory()` and `getProviderInventoryEntry()`
- normalized `AgentEvent`
- normalized `AgentRunResult`
- provider escape hatches via `asCodex()` and `asClaude()`

## Product Boundary

`@ouim/agentkit` is a runtime substrate for local provider runtimes. It is intended to sit under app-owned adapters.

Current non-goals:

- It is not the orchestration engine.
- It is not an event store or replay service.
- It does not provide stable event IDs, replay cursors, or source markers such as live vs replay.
- It does not provide durable pending-request IDs or recovery APIs for approvals and user prompts.
- It is not a websocket protocol, UI-state model, or persistence layer.
- It does not model app-specific retry, projection, checkpoint, or reconciliation policy.

## Shared Lifecycle Contract

### `createAgent()`

- Validates the selected provider and returns a provider-backed `AgentClient`.
- The returned client owns only the SDK process state it creates.
- Unknown or empty provider IDs fail fast with `InputValidationError`.

### `session(name)`

- `session(name)` is a local cache convenience.
- Reusing the same `name` returns the same in-process wrapper until that wrapper is cleared or closed.
- The local cache is not remote provider state and is not enough for cross-process resume.
- Clearing a cached session name does not imply remote/provider deletion.

### `openSession(options?)`

- Returns a new session wrapper without consulting the local `session(name)` cache.
- Provider runtimes may allocate underlying state eagerly or lazily.
- Today, Codex opens a thread immediately. Claude creates a long-lived local runtime immediately, but provider session identity may remain `null` until the provider emits one during a turn.

### `resumeSession(handle, options?)`

- Requires a persisted `AgentSessionHandle`.
- `resumeSession()` is the cross-process resume path. Local cached wrappers are not a substitute for the handle.
- Resume semantics are provider-backed, not provider-neutral attach/replay semantics.
- Invalid or stale handles currently fail through provider-specific errors; no normalized stale-handle taxonomy exists yet.

### Local State vs Provider State

There are three separate concepts in the current API:

- Local cache state: the wrappers returned by `agent.session(name)` and tracked only inside the current process.
- Local session object state: the live `AgentSession` instance the caller holds.
- Provider/runtime state: the underlying Codex thread or Claude runtime/session state represented by the persisted handle.

Current guarantee: only the persisted handle is intended to survive process restart. The local cache and local wrapper identity are intentionally process-local.

## Stream And Result Contract

### `stream()`

- `stream()` yields normalized `AgentEvent` values for one live turn.
- Events are emitted in the order the current adapter/runtime surfaces them to the session stream.
- There is no stronger guarantee today than live emission order within the current attachment.
- There are no stable event IDs, sequence numbers, replay cursors, or replay markers in the shared API.
- `provider.notification` is the escape hatch for provider activity that is not normalized into a first-class shared event.

### `run()`

- `run()` starts the same turn lifecycle as `stream()`.
- It drains the underlying event stream internally and returns the final normalized `AgentRunResult`.
- Callers should treat the returned result as the terminal summary for that turn, not as a durable event log.

### `run.completed`

- When a provider emits a terminal result normally, the shared stream emits `type: 'run.completed'`.
- That event carries the same normalized result shape used by `run()` for that turn.
- The result contains stable top-level fields such as `provider`, `sessionId`, `turnId`, `status`, `text`, `items`, and optional `handle`.
- `items` is intentionally provider-native terminal content in provider order. Its presence is stable; its inner item schema is provider-specific.
- `raw` and `resumeState` are escape hatches and must be treated as opaque provider data.

### Terminal Ordering Boundary

- The current contract expects `run.completed` to be the normal terminal event when the provider produces a terminal turn result.
- Transport failure or runtime shutdown can terminate a run/stream by rejection instead of a terminal event.
- No stronger guarantee exists yet for terminal event delivery after transport loss.

## Interrupt Contract

- `interrupt()` targets the currently active turn only.
- If no turn is active, the call rejects.
- A successful interrupt request means the SDK forwarded the provider interrupt command; it does not by itself guarantee when a terminal event will arrive.
- If the provider later emits a terminal result with an interrupted status, that status is normalized into the final `AgentRunResult`.
- There is no shared replay, cancellation receipt, or cross-process interruption recovery contract yet.

## Close Contract

### `session.close()`

- Always closes the local session object.
- Codex and Claude do not currently have identical remote-side semantics:
  - Codex: closing the shared `AgentSession` closes the local wrapper and clears the cached named session if that wrapper came from `session(name)`. It does not delete the remote thread.
  - Claude: closing the shared `AgentSession` shuts down the long-lived runtime owned by that session and fails pending turns in that session.
- The shared API does not currently expose remote delete semantics for either provider.

### `agent.clearSession()` and `agent.clearSessions()`

- These are local cache operations only.
- They do not delete provider state.
- A previously persisted handle may still be resumable after local cache eviction.

### `agent.close()`

- Closes client-owned resources in the current process.
- Codex transport close rejects inflight work.
- Claude client close currently closes cached named sessions owned by the client. Callers should still close explicit uncached sessions they hold directly.

## Approval And User Input Contract

- Providers may surface approval and user-input requests during an active turn.
- The shared stream normalizes these to `approval.tool` and `user.input` events.
- Shared handler hooks are synchronous or asynchronous:
  - `onToolApproval` returns `'allow'` or `'deny'`
  - `onUserInput` returns `string` or `string[]`
- The shared API wires these answers back into the provider transport/runtime inline during the current turn.

Current boundary:

- `AgentToolApprovalRequest.kind` is stable.
- `AgentToolApprovalRequest.payload` is intentionally provider-specific.
- `AgentUserInputRequest.question` and `options` are normalized.
- `raw` request payloads are provider-specific escape hatches.
- The shared API does not yet provide durable request IDs, request recovery after reconnect, or a way to enumerate pending requests.

Provider-specific default behavior still matters today:

- Codex without a user-input handler responds to the server request with an error.
- Claude without a user-input handler declines the elicitation and the turn may fail with an error result.
- Claude tool approval defaults to deny unless the runtime is already in a bypass-permissions mode.

## Resume Handle Contract

`AgentSessionHandle` has stable top-level slots but provider-specific values.

Stable fields:

- `provider`
- `sessionId`
- `name`
- `resumeKey`
- `resumeAt`

Interpretation boundary:

- `resumeKey` and `resumeAt` are stable slots, but the values are provider-specific and opaque to app code unless the app knowingly opts into a provider-specific contract.
- `raw` is provider-native resume metadata and is outside the normalized contract.

Current provider meaning:

- Codex: `resumeKey` is the thread ID used for `thread/resume`.
- Claude: `resumeKey` is the current session/resume token, and `resumeAt` is surfaced from the latest assistant message UUID when available.

## Capabilities And Inventory Contract

### `getCapabilities()`

- `AgentCapabilities` is the stable normalized feature-gating surface.
- The normalized booleans/enums are the contract. `raw` is supplemental provider data only.
- Capability fields describe what the adapter exposes today, not future orchestration semantics.

### `getAvailableProviders()`

- This is a compatibility projection.
- It intentionally returns less data than inventory.
- Callers needing diagnostics, executable location, degradation state, or capability metadata should use inventory APIs instead.

### `getProviderInventory()` and `getProviderInventoryEntry()`

- Inventory is the canonical discovery contract.
- Stable normalized fields include installation, runnable/authenticated state, degradation, capability support, executable metadata, and normalized diagnostics.
- `diagnostics.probeMode`, `diagnostics.probeStrategy`, `diagnostics.failureReason`, and `diagnostics.notes` are stable troubleshooting fields.
- `raw` remains provider-native diagnostic data.

## Escape Hatches

- `asCodex()` and `asClaude()` are explicit provider escape hatches.
- They may return `null` when the client was created for the other provider.
- Once the caller drops down to the provider-specific surface, provider-specific semantics take precedence over the normalized contract.

## What Phase 1 Does Not Add

This baseline deliberately does not add:

- event envelopes
- stable event identity
- replay cursors
- attach semantics distinct from resume
- durable pending-request IDs
- recovery of pending approvals or user prompts after reconnect
- adapter-tier orchestration abstractions

Those concerns belong to later phases after the current runtime baseline is explicitly documented and test-pinned.
