# `@ouim/agentkit` Gap Analysis For Orchestration Apps

## Purpose

This document evaluates the current `@ouim/agentkit` API against the needs of orchestration-heavy applications such as `t3code`, where provider runtimes already sit inside a larger system with:

- provider adapters
- canonical event projection
- persistence and replay
- browser/server protocols
- approvals and user-input round-trips
- reconnect/recovery semantics

The goal is not to ask whether `agentkit` should replace those systems. It should not.

The real question is narrower and more useful:

> Can `@ouim/agentkit` become a strong provider-runtime substrate that lives under app-owned adapters, so teams stop rewriting session glue, runtime detection, and provider transport code for every provider?

This document says:

- where `agentkit` fits
- what the current API already does well
- what is too weak or underspecified today
- what must be added before apps like `t3code` would trust it as an implementation detail

## Executive Summary

`@ouim/agentkit` is already pointed in the right direction for orchestration-heavy apps, but it is still too thin and too ambiguous at the runtime boundary.

Today it is best understood as:

- a host-side SDK for local agent runtimes
- a shared lifecycle wrapper over Codex and Claude
- a discovery API for providers/models/skills
- a compatibility layer for Codex-specific integrations

That is useful, but not yet enough for products that need exact runtime semantics.

For a codebase like `t3code`, the correct placement of `agentkit` is:

- **good fit now:** under `apps/server/src/provider/*`, behind app-owned provider adapters
- **bad fit:** orchestration, persistence, UI state, websocket protocol, checkpointing, recovery policy

The adoption blocker is not that `agentkit` is provider-neutral. The blocker is that the current API does not yet provide the level of determinism, fidelity, and replayability that an orchestration system expects from its runtime layer.

## The Current `agentkit` Surface

Based on the current public types and adapters, `agentkit` exposes:

- `createAgent({ provider, defaults })`
- `agent.openSession(options?)`
- `agent.resumeSession(handle, options?)`
- `agent.session(name)` as a local cache convenience
- `session.run(input, options?)`
- `session.stream(input, options?)`
- `session.interrupt()`
- `session.close()`
- `agent.getAccountState()`
- `agent.getCapabilities()`
- `getAvailableProviders()`
- `getProviderAvailability()`
- `getProviderInventory()`
- `getProviderInventoryEntry()`
- `listModels()`
- `listSkills()`
- provider escape hatches via `asCodex()` / `asClaude()`

The normalized streaming model currently includes:

- `message.delta`
- `message.completed`
- `reasoning.delta`
- `status`
- `approval.tool`
- `user.input`
- `turn.completed`
- `provider.notification`
- `error`

The current session model also has:

- structured resume handles
- lightweight provider capability metadata
- session-local defaults for `cwd`, `model`, `permissionMode`, `additionalDirectories`, and partial message behavior

## Where `agentkit` Fits In Apps Like `t3code`

### Good Fit Now

`agentkit` is a reasonable fit as the implementation behind an app-owned provider adapter boundary.

In a `t3code`-shaped system, that means:

- provider runtime process launch/resume logic
- provider availability/authentication checks
- model and skill discovery
- session wrapper logic
- provider-edge streaming transport
- approval and user-input callback plumbing

This is the layer where teams currently write a large amount of repetitive and fragile glue:

- how to detect installed runtimes
- how to start and resume provider sessions
- how to map provider lifecycle quirks into a stable local API
- how to keep Codex and Claude integrations from diverging too far

This is the strongest current use case for `agentkit`.

### Maybe Later

`agentkit` could eventually own a stronger canonical provider-runtime event layer if it becomes:

- lossless enough for product read models
- replayable
- deterministically ordered
- explicit about terminal states and request/response correlation

That would let apps keep their own orchestration logic while trusting `agentkit` more deeply at the event boundary.

### Wrong Layer

`agentkit` should not try to replace:

- orchestration engines
- event stores and projections
- app-specific websocket or RPC protocols
- app UI state models
- checkpointing policy
- git, terminal, workspace, and project domain services

Those are product concerns. `agentkit` should feed them, not subsume them.

## What The Current API Already Does Well

### 1. Shared Session Lifecycle Exists

The current API already exposes the right basic nouns:

- create/open/resume/close
- run vs stream
- interrupt
- structured resume handles

This is important because orchestration apps do not want to hand-roll a different lifecycle surface per provider.

### 2. Discovery Is Already On The Right Track

`getProviderInventory()`, model listing, and skills discovery are exactly the kind of host-side runtime checks apps need before session startup.

The richer discovery metadata is also useful:

- executable path
- executable source
- probe mode and diagnostics
- authenticated vs runnable vs degraded state

This is credible value for applications that need to manage local runtimes reliably.

### 3. Provider Escape Hatches Are The Right Design

`asCodex()` and `asClaude()` are important because orchestration apps rarely stay purely provider-neutral.

The right abstraction is not “hide the providers completely.”
The right abstraction is:

- normalize the common layer
- expose explicit provider escape hatches when the product needs them

That matches real application architecture better than a purity-first shared API.

### 4. Approvals And User Input Are Already Recognized As First-Class

The presence of:

- `approval.tool`
- `user.input`
- handler plumbing in `run()` / `stream()`

is a strong sign that this package is aimed at actual agent runtimes rather than shallow text-generation wrappers.

### 5. Codex Compatibility Is Pragmatic

Keeping direct Codex exports and a compatibility path lowers migration risk for existing users.

For adoption in real apps, this matters.

## Where The Current API Is Too Weak Or Underspecified

This is the critical section.

The following gaps are what keep `agentkit` from being trusted under provider adapters in applications like `t3code`.

### 1. Event Model Is Normalized, But Not Yet Operationally Strong

Current `AgentEvent` values are useful for simple consumers, but orchestration apps need more than event names and payloads.

Missing strength today:

- no explicit event sequence number
- no replay cursor or offset
- no distinction between live stream and replay stream
- no explicit event timestamp contract
- no causal/correlation metadata for linking requests, responses, and turn transitions
- no explicit provider event identity separate from app-level identity

Why this matters:

- read models need deterministic ordering
- reconnect logic needs replay-from-last-seen semantics
- audit trails need stable event identity
- UI and persistence layers need to recover from disconnects without duplicating or losing effects

Current implication:

`session.stream()` is usable for immediate streaming UX, but not yet strong enough to be the canonical runtime event backbone for a durable orchestration system.

### 2. Session Resume Exists, But Reconnect Semantics Are Too Thin

The current API has `resumeSession(handle)`, which is necessary.

But orchestration apps need a stronger contract around:

- attach vs resume
- reconnect after process restart
- whether the stream resumes from “now” or from a known point
- whether in-flight requests survive reconnect
- whether the same underlying provider session can be safely attached twice
- how to detect stale handles vs live handles
- what “session closed” means locally vs remotely

Why this matters:

- apps like `t3code` survive restarts and reconnects
- provider session identity is part of product correctness
- accidental duplicate sessions are unacceptable

Current implication:

the API is resumable, but not yet explicit enough for durable multi-process or reconnect-heavy environments.

### 3. Approval And User-Input Flows Need Correlation Guarantees

The package already supports approval and user-input interaction, which is good.

But the current normalized request shapes are too generic:

- `kind: string`
- `payload: Record<string, unknown>`
- user-input requests expose only a question, optional options, and raw data

What is missing:

- stable request IDs in the shared API
- request lifecycle states
- timeout behavior
- cancellation behavior
- explicit “continue turn with this response” semantics
- correlation between the request and the eventual effect on the turn timeline

Why this matters:

- orchestration apps need to park UI state on a pending request
- reconnecting clients need to rehydrate pending approvals/input requests
- app logic must know whether a turn is blocked, failed, or resumed after a response

Current implication:

the interaction surface is good enough for callback-style examples, but not strong enough for apps with durable read models.

### 4. Final Turn Results Are Too Coarse

Current `AgentRunResult` includes:

- `status`
- `text`
- `items`
- `handle`
- optional `resumeState`

This is enough for lightweight consumers, but not enough for orchestration systems that care about exact runtime outcomes.

What is missing:

- explicit terminal reason categories
- normalized failure taxonomy
- machine-readable interruption/cancellation reason
- provider exit/source diagnostics
- relationship between final result and preceding event sequence
- guarantees about whether `text` is complete, canonical, or best-effort

Why this matters:

- UIs distinguish interrupted, failed, stopped, timed-out, denied, and transport-broken states
- product telemetry and retry logic need exact failure categories

Current implication:

`completed` / `interrupted` / `failed` is directionally right, but not enough for a product runtime contract.

### 5. Capabilities Exist, But Behavior Guarantees Do Not

`AgentCapabilities` helps feature-gating, but it mostly describes support, not guarantees.

Applications like `t3code` need to know:

- event ordering guarantees
- whether partial messages are lossless or best-effort
- whether interruption has strong or weak semantics
- whether resume is same-session resume or emulated local resume
- whether requests survive reconnect
- whether discovery is runtime-backed or static and how stale it can be

Current implication:

capabilities are useful for branching, but not sufficient for building reliability-sensitive adapter logic.

### 6. Provider-Neutral Shapes Are Sometimes Too Opaque

Several key types rely on `raw?: unknown` and generic payloads.

That is appropriate as an escape hatch, but too much of the operational surface is still effectively:

- provider-neutral on paper
- provider-specific in practice
- opaque in the middle

Why this matters:

app authors cannot confidently build app-level state machines against opaque normalized payloads

Current implication:

the package needs stronger typed shared structures for runtime-critical flows, with `raw` remaining supplemental rather than foundational.

## Gap Matrix

| Area | Current `agentkit` status | Good enough for simple host apps | Good enough for `t3code`-class apps | Main gap |
|---|---|---:|---:|---|
| Provider discovery | Strong | Yes | Mostly | Could use freshness/guarantee semantics |
| Session open/resume/close | Present | Yes | Partially | Reconnect/attach semantics are too thin |
| Run vs stream | Present | Yes | Partially | Stream contract lacks replay/ordering identity |
| Approval/user-input handling | Present | Yes | No | Missing correlation and lifecycle guarantees |
| Interrupt support | Present | Partially | No | Terminal semantics and guarantees are too weak |
| Model/skill discovery | Good | Yes | Yes | Mostly sufficient for adapter layer |
| Provider escape hatches | Good | Yes | Yes | Keep and expand carefully |
| Event normalization | Present | Yes | No | Too coarse for durable orchestration |
| Failure model | Weak | Partially | No | Needs structured taxonomy |
| Session summaries/listing | Minimal | Partially | No | Needs stronger remote/runtime semantics |

## What `agentkit` Must Improve To Be Used In Apps Like `t3code`

This section is intentionally prescriptive.

### Priority 1: Introduce A Durable Runtime Event Contract

Add a stronger event envelope, for example:

```ts
type AgentEventEnvelope<TEvent extends AgentEvent = AgentEvent> = {
  provider: AgentProviderId
  sessionId: string | null
  turnId: string | null
  eventId: string
  sequence: number
  emittedAt: string
  source: 'live' | 'replay'
  replayCursor?: string
  correlationId?: string
  event: TEvent
  raw?: unknown
}
```

Minimum behaviors needed:

- monotonic sequence within a session stream
- stable event IDs
- replay cursor support
- explicit live vs replay distinction

Why this unlocks adoption:

apps can build projections and reconnect logic without inventing a second runtime event contract on top of `agentkit`.

### Priority 2: Strengthen Session Identity And Reconnect Semantics

The API needs to separate:

- `open`
- `resume`
- `attach`
- `detach`
- `interrupt`
- `stop`

Suggested direction:

```ts
type AgentAttachOptions = {
  from?: 'latest' | { cursor: string }
}

interface AgentClient {
  openSession(options?: AgentOpenSessionOptions): Promise<AgentSession>
  resumeSession(handle: AgentSessionHandle, options?: AgentResumeSessionOptions): Promise<AgentSession>
  attachSession(handle: AgentSessionHandle, options?: AgentAttachOptions): Promise<AgentSession>
}
```

Minimum behaviors needed:

- explicit definition of local vs remote session closure
- stale-handle detection
- attach/reconnect without accidental duplicate runtime creation
- clear rules for resuming event streams after restart

### Priority 3: Make Approval And User-Input Requests Durable

Upgrade the shared request types from generic payload containers to typed runtime interaction records.

Suggested direction:

```ts
type AgentPendingRequest =
  | {
      id: string
      provider: AgentProviderId
      kind: 'approval.tool'
      sessionId: string | null
      turnId: string | null
      createdAt: string
      status: 'pending' | 'resolved' | 'expired' | 'cancelled'
      request: AgentToolApprovalRequest
    }
  | {
      id: string
      provider: AgentProviderId
      kind: 'user.input'
      sessionId: string | null
      turnId: string | null
      createdAt: string
      status: 'pending' | 'resolved' | 'expired' | 'cancelled'
      request: AgentUserInputRequest
    }
```

Minimum behaviors needed:

- stable request ID
- response APIs that target request ID directly
- clear timeout/cancel semantics
- ability to rehydrate pending requests on reconnect

Why this matters:

this is the difference between a callback demo and a runtime component that an app can safely project into UI state.

### Priority 4: Add A Structured Failure And Terminal-State Taxonomy

Suggested direction:

```ts
type AgentTerminalState =
  | { status: 'completed' }
  | { status: 'interrupted'; reason: 'user' | 'system' | 'provider' }
  | { status: 'failed'; code: string; retryable?: boolean; message: string }
  | { status: 'cancelled'; reason: 'user' | 'shutdown' | 'superseded' }
  | { status: 'timed_out'; phase: 'startup' | 'turn' | 'approval' | 'input' }
```

Minimum behaviors needed:

- no ambiguity between transport failure and model failure
- final event guarantee after stream termination where possible
- structured reason codes for retries and UI messaging

### Priority 5: Expose Operational Guarantees In Capabilities

Extend capability reporting to include behavior guarantees, not just support flags.

Examples:

- `eventOrdering: 'best-effort' | 'strict-session'`
- `replaySupport: boolean`
- `pendingRequestRecovery: boolean`
- `interruptSemantics: 'best-effort' | 'guaranteed-terminal-event'`
- `resumeSemantics: 'reattach-runtime' | 'provider-resume' | 'local-only'`

Why this matters:

adapter authors need to know whether they can trust a behavior, not just whether an API exists.

### Priority 6: Add A More Explicit Adapter-Oriented API Tier

Right now the public API is optimized for application consumers.

Apps like `t3code` would benefit from an additional lower-level but still shared provider-runtime tier, for example:

- stream envelopes instead of only simple events
- pending request enumeration
- attach/replay support
- structured provider runtime metadata
- explicit transport state notifications

This should not replace the simple API.
It should sit underneath it.

## Recommended Product Positioning Change

Current framing is close, but for adoption in serious apps it should sharpen from:

> One clean TypeScript API for Codex + Claude local agents.

to:

> A provider-runtime substrate for local agent applications. Use the simple API for host apps, or build your own adapters on top of a stronger runtime contract.

This matters because orchestration-heavy apps do not primarily buy “cleaner syntax.”
They buy:

- less provider churn
- fewer custom subprocess wrappers
- more reliable runtime behavior
- a smaller adapter surface to maintain

## Proposed Roadmap

### Phase 1: Make Current Runtime Semantics Explicit

Ship without major API breakage:

- document current guarantees and non-guarantees
- define terminal-state semantics
- define what resume means per provider
- clarify `approval.tool` and `user.input` lifecycle expectations

### Phase 2: Add Strong Event Envelopes

Introduce an advanced streaming API:

- event IDs
- sequence numbers
- timestamps
- replay cursor support
- source=`live|replay`

Keep the current `AgentEvent` API as the simplified projection.

### Phase 3: Add Durable Request/Response Semantics

Introduce:

- typed pending requests
- explicit response APIs
- request recovery after reconnect

### Phase 4: Add Attach/Reconnect Operations

Introduce:

- `attachSession()`
- stronger remote-vs-local closure semantics
- reconnect-safe streaming

### Phase 5: Publish Adapter-Focused Guidance

Document:

- how to embed `agentkit` under app-owned provider adapters
- how to keep orchestration/app state product-owned
- how to use escape hatches without collapsing back into provider-specific glue everywhere

## Acceptance Criteria For “Ready For `t3code`-Class Adoption”

`agentkit` should be considered ready for serious adapter-layer adoption when all of the following are true:

- provider stream events have stable ordering and event identity
- reconnect/replay is supported with an explicit cursor model
- approvals and user-input prompts have stable request IDs and recovery semantics
- terminal states are structured and unambiguous
- session attach/resume semantics are explicit and documented
- capability reporting includes behavioral guarantees, not just support booleans
- the simple consumer API still exists, but a stronger adapter-tier API is available

## Bottom Line

`@ouim/agentkit` is not blocked by the wrong idea.
It is blocked by incomplete runtime contracts.

The current API is already useful for:

- smaller host-side apps
- scripts
- simpler multi-provider tooling
- provider discovery and session wrappers

To be used inside apps like `t3code`, `agentkit` does **not** need to become an orchestration framework.
It needs to become a more trustworthy provider-runtime substrate.

That means investing in:

- durable event semantics
- reconnect and replay
- durable interaction requests
- explicit terminal-state guarantees
- adapter-oriented runtime APIs

If those are done well, `agentkit` becomes genuinely valuable to serious apps that currently integrate provider SDKs directly.
If those are not done, it remains a convenient shared wrapper, but not a dependency that core runtime adapters will trust.
