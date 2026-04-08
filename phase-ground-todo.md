# @ouim/agentkit — Phase Ground Roadmap

> Last updated: 2026-04-08 Focus: orchestration-grade runtime contracts for adapter-layer adoption

This roadmap translates [docs/agentkit-gap-analysis-for-orchestration-apps.md](/G:/PI/codex-sdk-node/docs/agentkit-gap-analysis-for-orchestration-apps.md) into concrete work.

The goal of Phase Ground is not to turn `@ouim/agentkit` into an orchestration framework. It is to make the package trustworthy as the provider-runtime substrate that sits under app-owned adapters in systems like `t3code`.

That means closing the contract gaps around:

- durable event semantics
- attach/resume/reconnect behavior
- durable approval and user-input request handling
- terminal-state and failure taxonomy
- capability guarantees
- adapter-oriented runtime APIs and guidance

---

## Priority Legend

- 🔴 **P0 — Critical**: runtime contract correctness required for serious adapter adoption
- 🟠 **P1 — High**: core completeness for reconnect-heavy and persistence-heavy apps
- 🟡 **P2 — Medium**: docs, ergonomics, migration, and guardrails
- 🟢 **P3 — Low**: future expansion after the runtime contract is stable

---

## Current Snapshot

### Strong enough already

- [x] Shared provider/session lifecycle exists: `createAgent()`, `openSession()`, `resumeSession()`, `run()`, `stream()`, `interrupt()`, `close()`
- [x] Provider discovery/inventory exists and is already useful for host-side runtime detection
- [x] Normalized cross-provider event stream exists for immediate streaming UX
- [x] Approval and user-input flows are recognized as first-class runtime concerns
- [x] Provider escape hatches exist via `asCodex()` and `asClaude()`
- [x] Current product boundary is mostly correct: runtime substrate, not orchestration engine

### Not strong enough yet for `t3code`-class adapter usage

- [ ] Event streams do not yet expose stable event identity, ordering, replay cursors, or live-vs-replay source
- [ ] Session resume semantics are still too thin for reconnect-heavy multi-process environments
- [ ] Approval and user-input requests do not yet have durable request IDs and recovery semantics
- [ ] Terminal states and failure outcomes are still too coarse for product-grade retry and UI logic
- [ ] Capabilities report support flags, but not enough behavioral guarantees
- [ ] The shared API is still optimized for app consumers more than adapter authors

---

## Phase 1 — Contract Baseline 🔴 P0

> Goal: make the current runtime semantics explicit before expanding the API surface.

- [x] **1.1 — Document the current runtime contract**

  > Before adding new abstractions, lock down what the package does today and where guarantees stop.
  - [x] Define the current ordering guarantees for normalized stream events
  - [x] Define what `resumeSession()` means per provider today
  - [x] Define current interruption semantics and known ambiguities
  - [x] Define current `approval.tool` and `user.input` lifecycle behavior
  - [x] Define the difference between local session closure and provider/runtime closure

- [x] **1.2 — Publish explicit non-goals for orchestration apps**

  > Adoption gets easier if the boundary is crisp.
  - [x] State that `agentkit` is not the orchestration engine, event store, websocket protocol, or UI state model
  - [x] State that `agentkit` is intended to sit under app-owned provider adapters
  - [x] Add guidance on when to stay in the simple consumer API vs when to use adapter-tier APIs

- [x] **1.3 — Audit the existing public types against the documented contract**
  > The current types expose a mix of strong shapes and opaque escape hatches.
  - [x] Identify runtime-critical fields that still rely on `raw?: unknown` or generic payload records
  - [x] Mark which existing public types can be hardened without breaking the simple API
  - [x] Identify where provider-specific escape hatches should remain intentionally opaque

---

## Phase 2 — Durable Event Envelope 🔴 P0

> Goal: introduce an orchestration-grade event contract without breaking the current simple stream API.

- [ ] **2.1 — Define an event envelope type**

  > The simple `AgentEvent` projection is useful, but adapter consumers need a stable outer contract.
  - [ ] Add a shared `AgentEventEnvelope<TEvent>` shape
  - [ ] Include `provider`, `sessionId`, `turnId`, `eventId`, `sequence`, `emittedAt`, and `event`
  - [ ] Include `source: 'live' | 'replay'`
  - [ ] Include `replayCursor` when replay support is available
  - [ ] Include `correlationId` for request/response and turn-transition linking
  - [ ] Keep `raw` supplemental rather than central

- [ ] **2.2 — Define event identity and ordering guarantees**

  > The envelope is only useful if the sequencing rules are explicit.
  - [ ] Guarantee monotonic sequence ordering within a session stream
  - [ ] Define whether ordering is per-session, per-turn, or stronger
  - [ ] Define event ID stability across reconnect and replay
  - [ ] Define timestamp format and source-of-truth semantics

- [ ] **2.3 — Add an advanced streaming surface**

  > Keep the current event API as the simplified projection; add a stronger adapter-facing stream.
  - [ ] Add an advanced stream API that yields `AgentEventEnvelope`
  - [ ] Preserve `session.stream()` for existing consumers
  - [ ] Document how the advanced stream relates to the simplified normalized events
  - [ ] Decide whether the advanced stream lives on `session.streamEvents()` or a similar explicit method

- [ ] **2.4 — Add replay cursor support**
  > Reconnect-heavy apps need replay-from-last-seen semantics.
  - [ ] Define a cursor model that survives process restart where supported
  - [ ] Add stream attach options for `latest` vs `from cursor`
  - [ ] Define behavior when replay is unsupported by a provider
  - [ ] Expose replay support in capabilities

---

## Phase 3 — Session Identity, Attach, and Reconnect 🔴 P0

> Goal: make session ownership and reconnect behavior explicit enough for durable adapter-layer use.

- [ ] **3.1 — Separate open, resume, and attach semantics**

  > `resumeSession()` alone is too overloaded.
  - [ ] Define `openSession()` as new runtime/session creation
  - [ ] Narrow `resumeSession()` semantics and document when it creates vs rebinds
  - [ ] Add `attachSession()` for reconnecting to an existing underlying session without accidental duplication
  - [ ] Decide whether `detach()` should be explicit in the public API

- [ ] **3.2 — Define stale handle and duplicate attach behavior**

  > Products need exact behavior when state drifts.
  - [ ] Add stale-handle detection semantics
  - [ ] Define duplicate attach behavior for the same underlying session
  - [ ] Define behavior when the remote/provider session has already ended
  - [ ] Define whether multiple local attachments can coexist safely

- [ ] **3.3 — Clarify local-vs-remote lifecycle transitions**

  > Correctness depends on precise lifecycle meanings.
  - [ ] Define local close vs remote close vs transport death
  - [ ] Define what `interrupt()` guarantees about terminal events
  - [ ] Add explicit stop/cancel semantics if interruption is not sufficient
  - [ ] Define whether in-flight turns and pending requests survive reconnect

- [ ] **3.4 — Expose reconnect-safe stream attach options**
  - [ ] Add attach options for `latest` and `from cursor`
  - [ ] Define replay-after-restart behavior per provider
  - [ ] Define what happens when the requested cursor is expired or unavailable
  - [ ] Surface provider limitations through capabilities and typed errors

---

## Phase 4 — Durable Pending Requests 🔴 P0

> Goal: upgrade approvals and user prompts from callback conveniences into durable runtime interaction records.

- [ ] **4.1 — Introduce typed pending request records**

  > Runtime interactions need their own durable identity.
  - [ ] Add a shared `AgentPendingRequest` union for `approval.tool` and `user.input`
  - [ ] Include `id`, `provider`, `sessionId`, `turnId`, `createdAt`, `status`, and typed request payload
  - [ ] Replace generic `kind: string` / `payload: Record<string, unknown>` usage in the adapter-facing API
  - [ ] Preserve raw provider payloads as supplemental debug context only

- [ ] **4.2 — Add explicit request response APIs**

  > Apps need to target a specific pending request directly.
  - [ ] Add response methods keyed by request ID
  - [ ] Define explicit accept/deny/cancel behavior for approvals
  - [ ] Define submit/cancel behavior for user-input prompts
  - [ ] Ensure responses correlate to subsequent turn/runtime events

- [ ] **4.3 — Define pending request lifecycle states**

  > Durable UI state depends on lifecycle guarantees.
  - [ ] Define `pending`, `resolved`, `expired`, and `cancelled`
  - [ ] Define timeout behavior
  - [ ] Define cancellation behavior
  - [ ] Define whether request resolution is guaranteed to emit a correlated runtime event

- [ ] **4.4 — Add pending request recovery on reconnect**
  > Rehydrating blocked turns is a core orchestration requirement.
  - [ ] Add enumeration or snapshot APIs for outstanding requests
  - [ ] Guarantee pending request IDs remain stable across reconnect
  - [ ] Define recovery behavior when a provider cannot rehydrate pending interactions
  - [ ] Reflect support in capabilities

---

## Phase 5 — Terminal States and Failure Taxonomy 🟠 P1

> Goal: make final outcomes precise enough for product UI, telemetry, and retry logic.

- [ ] **5.1 — Define a structured terminal-state model**

  > `completed` / `interrupted` / `failed` is directionally right but too coarse.
  - [ ] Add a normalized `AgentTerminalState` union
  - [ ] Distinguish `completed`, `interrupted`, `failed`, `cancelled`, and `timed_out`
  - [ ] Add structured reasons for interruption and cancellation
  - [ ] Add phase-aware timeout categories where meaningful

- [ ] **5.2 — Add a normalized failure taxonomy**

  > Adapter logic needs machine-readable failure reasons.
  - [ ] Separate transport failure from model/runtime failure
  - [ ] Add typed failure codes
  - [ ] Mark retryable vs non-retryable failures where the provider semantics allow it
  - [ ] Include provider diagnostics without forcing consumers into opaque `raw` parsing

- [ ] **5.3 — Strengthen final-result guarantees**
  > Final result objects need a clearer relationship to the event timeline.
  - [ ] Define whether the final result is canonical or best-effort
  - [ ] Define whether `text` is complete, truncated, or provider-dependent
  - [ ] Link final results to the terminal event identity/sequence where possible
  - [ ] Guarantee a terminal event after stream termination where the provider allows it

---

## Phase 6 — Capability Guarantees 🟠 P1

> Goal: expose what behaviors can be trusted, not only what methods exist.

- [ ] **6.1 — Extend capability reporting with behavioral guarantees**
  - [ ] Add `eventOrdering` guarantee metadata
  - [ ] Add `replaySupport`
  - [ ] Add `pendingRequestRecovery`
  - [ ] Add `interruptSemantics`
  - [ ] Add `resumeSemantics`
  - [ ] Add freshness/staleness semantics for discovery and inventory

- [ ] **6.2 — Split static support claims from runtime-probed guarantees**
  > Adapter authors need to know what is always true vs what depends on the current runtime.
  - [ ] Identify which capability fields are static adapter claims
  - [ ] Identify which capability fields require runtime probing
  - [ ] Document probe cost and staleness tradeoffs
  - [ ] Preserve a cheap default path for simple host apps

---

## Phase 7 — Adapter-Tier API Surface 🟠 P1

> Goal: add a lower-level shared API for provider adapters without degrading the simple host-app API.

- [ ] **7.1 — Introduce an explicit adapter-oriented API tier**

  > Serious apps need more than the current consumer-oriented surface.
  - [ ] Expose event envelopes directly
  - [ ] Expose pending request enumeration and response APIs
  - [ ] Expose attach/replay support
  - [ ] Expose structured transport/runtime state notifications where useful
  - [ ] Keep the simple `run()` / `stream()` API intact

- [ ] **7.2 — Define the boundary between normalized and provider-specific surfaces**
  - [ ] Identify the minimum shared contract required for adapters
  - [ ] Keep provider escape hatches explicit rather than leaking provider quirks into shared types
  - [ ] Document when adapter authors should drop down to `asCodex()` / `asClaude()`

- [ ] **7.3 — Avoid reintroducing orchestration concerns**
  > The adapter tier should help products own their orchestration logic, not compete with it.
  - [ ] Do not add event-store, checkpoint, websocket, or UI-state abstractions
  - [ ] Keep persistence, projection, and recovery policy product-owned
  - [ ] Review every new API addition against this boundary before release

---

## Phase 8 — Tests for Runtime Contracts 🟡 P2

> Goal: verify behavior and outcomes, not implementation details, before hardening the new contract.

- [ ] **8.1 — Event envelope contract tests**
  - [ ] Verify stable ordering semantics within a session stream
  - [ ] Verify event IDs remain stable across replay where supported
  - [ ] Verify live vs replay source tagging
  - [ ] Verify cursor-based replay resumes from the correct point

- [ ] **8.2 — Attach/resume/reconnect tests**
  - [ ] Verify attach does not create duplicate provider sessions
  - [ ] Verify stale handles fail with typed errors
  - [ ] Verify reconnect after transport restart behaves as documented
  - [ ] Verify local close vs remote close semantics

- [ ] **8.3 — Pending request durability tests**
  - [ ] Verify pending approvals survive reconnect where supported
  - [ ] Verify user-input prompts retain stable request IDs
  - [ ] Verify resolution/cancellation/timeout transitions
  - [ ] Verify request responses correlate to subsequent runtime events

- [ ] **8.4 — Terminal-state and failure tests**
  - [ ] Verify transport failure and model failure are distinguishable
  - [ ] Verify interruption and cancellation reasons are preserved
  - [ ] Verify timed-out phases map to the correct terminal categories
  - [ ] Verify final result and terminal event alignment

---

## Phase 9 — Docs, Positioning, and Adoption Guidance 🟡 P2

> Goal: make the package legible to orchestration-heavy adopters without confusing simple host-app users.

- [ ] **9.1 — Reposition the product language**

  > The value proposition is reliable runtime substrate, not just cleaner syntax.
  - [ ] Update README language to describe `agentkit` as a provider-runtime substrate for local agent applications
  - [ ] Keep the simple host-app story, but add explicit adapter-layer positioning
  - [ ] Clarify that the orchestration layer remains app-owned

- [ ] **9.2 — Publish adapter embedding guidance**
  - [ ] Document how to place `agentkit` behind `apps/server/src/provider/*`-style adapters
  - [ ] Document how to project runtime events into app-owned read models
  - [ ] Document when to rely on normalized contracts vs provider escape hatches
  - [ ] Document reconnect, replay, and pending request handling patterns

- [ ] **9.3 — Publish migration and compatibility notes**
  - [ ] Document how existing simple consumers can ignore the adapter-tier APIs
  - [ ] Document how Codex compatibility consumers map to the new runtime contract
  - [ ] Document any provider-specific limitations that remain after the contract hardening work

---

## Phase 10 — Future Reliability Expansion 🟢 P3

> Goal: leave room for deeper runtime guarantees after the core contract is solid.

- [ ] **10.1 — Provider-specific replay depth and retention policies**
  - [ ] Evaluate how long replay cursors remain valid per provider
  - [ ] Expose retention/expiry limits where known

- [ ] **10.2 — Cross-process diagnostics and telemetry**
  - [ ] Add structured diagnostics for reconnect, replay gaps, and stale-handle failures
  - [ ] Keep telemetry optional and separate from the shared runtime contract

- [ ] **10.3 — Additional providers**
  - [ ] Define the contract a new provider must satisfy to claim adapter-tier support
  - [ ] Distinguish first-class adapter-tier support from simple host-app support

---

## Acceptance Criteria For Phase Ground

Phase Ground should be considered complete when all of the following are true:

- [ ] Provider stream events have stable identity, ordering, timestamps, and live-vs-replay source semantics
- [ ] Reconnect and replay are supported through an explicit cursor model where providers allow it
- [ ] Session open, resume, attach, detach, interrupt, and closure semantics are explicit and documented
- [ ] Approvals and user-input prompts have stable request IDs and durable recovery behavior where supported
- [ ] Terminal states and failures are structured, typed, and unambiguous
- [ ] Capability reporting includes behavioral guarantees, not only support booleans
- [ ] A stronger adapter-tier API exists without breaking the current simple consumer API
- [ ] Tests cover the new runtime contract behavior end-to-end
- [ ] Docs clearly position `agentkit` as a runtime substrate under app-owned adapters, not as an orchestration framework

---

## Bottom Line

If this roadmap lands, `@ouim/agentkit` stops being only a convenient shared wrapper and becomes a credible dependency for serious adapter-layer integrations.

That is the bar for `t3code`-class adoption:

- fewer custom subprocess wrappers
- less provider churn
- stronger reconnect behavior
- durable interaction handling
- a runtime contract that app-owned orchestration systems can trust
