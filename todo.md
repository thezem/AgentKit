# @ouim/codexkit — Development Roadmap

> Last updated: 2026-04-07
> Version: 0.1.0

This roadmap has been realigned to the current product shape.

`@ouim/codexkit` is no longer just a thin Codex transport wrapper. It already has:

- a stable Codex compatibility layer
- a shared multi-provider API
- provider adapters for Codex and Claude
- normalized lifecycle and event primitives
- provider availability checks

The roadmap below marks what is already complete and focuses the remaining work on the missing pieces: richer discovery, explicit cross-provider resume/inventory APIs, better reliability, tests, and package readiness.

---

## Priority Legend

- 🔴 **P0 — Critical**: correctness, hangs, production safety
- 🟠 **P1 — High**: core product completeness and reliability
- 🟡 **P2 — Medium**: DX, docs, packaging, maintainability
- 🟢 **P3 — Low**: optimization and broader future expansion

---

## Current Snapshot

### Already shipped

- [x] Codex runtime/client layer on top of `codex app-server`
- [x] Generic `createAgent()` API
- [x] Shared `AgentClient` / `AgentSession` abstraction
- [x] Provider registry with first-class `codex` and `claude`
- [x] Normalized cross-provider event stream
- [x] Cross-provider `run()`, `stream()`, `interrupt()`, `close()`
- [x] Provider availability helpers: `getAvailableProviders()` and `getProviderAvailability()`
- [x] Provider-specific escape hatches: `asCodex()` and `asClaude()`
- [x] Claude long-lived session runtime with interrupt support
- [x] Claude resume state surfaced as opaque `resumeState`
- [x] Device auth via native `codex login --device-auth`
- [x] Windows-specific Codex command handling and best-effort process cleanup
- [x] Main examples for Codex compatibility, generic Codex, and generic Claude

### Not shipped yet

- [x] Explicit provider-agnostic session resume/open API
- [x] Rich machine inventory API for installed providers and resolved executable paths
- [ ] Unified model listing across providers
- [ ] Unified skills listing/configuration across providers
- [ ] Test suite
- [ ] Standard build output for npm consumption without `--experimental-strip-types`

---

## Phase 1 — Product Surface Alignment 🔴 P0

> Goal: finish the transition from "Codex wrapper plus adapter experiments" to a clear local agent control-plane SDK.

- [x] **1.1 — Make session lifecycle fully explicit in the shared API**
  > The shared API has `run()`, `stream()`, `interrupt()`, and `close()`, but generic explicit resume/open semantics are still provider-specific or implicit.
  - [x] Add a provider-agnostic session resume/open API
  - [x] Decide whether session identity is `sessionId`, provider-native resume token, or a structured resume handle
  - [x] Preserve provider-specific resume escape hatches where the generic model is not expressive enough
  - [x] Document lifecycle semantics clearly: create, resume, interrupt, close, clear

- [x] **1.2 — Add richer provider inventory/discovery**
  > Current discovery answers "can I use this provider right now?" It does not answer "what runtimes are installed, where are they, and how were they detected?"
  - [x] Introduce a top-level provider inventory type
  - [x] Surface normalized executable/runtime metadata as first-class fields, not only under `raw`
  - [x] Report detection source: PATH lookup, configured override, SDK importability, runtime probe
  - [x] Include resolved executable path when known
  - [x] Distinguish installed, runnable, authenticated, and degraded states

- [x] **1.3 — Add provider capability reporting that is useful to callers**
  > `getCapabilities()` exists, but it is still coarse and mostly hardcoded.
  - [x] Define a normalized capability schema for session resume, approvals, model switching, tools, skills, partials, and inventory support
  - [x] Split static adapter claims from runtime-probed capabilities where relevant
  - [x] Expose this through discovery so apps can decide what UI/flows to enable before creating a session

- [x] **1.4 — Publish a crisp public product statement**
  > README and docs should consistently describe the package as a host-side SDK for local agent runtimes, with Codex compatibility preserved but no longer the whole story.
  - [x] Update README positioning language
  - [x] Align examples and docs terminology around provider, session, availability, and resume
  - [x] Add an explicit "Codex compatibility layer vs shared provider API" section

---

## Phase 2 — Discovery, Models, and Skills 🟠 P1

> Goal: expose the pieces an app needs to build a real provider picker and runtime management UI.

- [ ] **2.1 — Unified model discovery**
  > Codex protocol docs include model listing, but the SDK does not expose a shared model/catalog API.
  - [ ] Add provider-specific model discovery for Codex
  - [ ] Decide Claude model discovery posture: supported, partial, or unavailable
  - [ ] Define a normalized `AgentModelInfo` shape
  - [ ] Expose `listModels(provider?)`
  - [ ] Include default/recommended model metadata where available

- [ ] **2.2 — Unified skills discovery/configuration**
  > Codex supports skills at the protocol/input level, but the SDK does not expose a first-class management surface.
  - [ ] Add Codex-backed `listSkills()` support
  - [ ] Add Codex-backed skill configuration read/write support if the protocol remains stable enough
  - [ ] Decide whether the shared API exposes only "supported/not supported" for non-Codex providers or a generic extension point
  - [ ] Document which skill operations are cross-provider and which are provider-specific

- [ ] **2.3 — Better provider availability results**
  > Current availability returns provider/auth/account state, but not enough metadata for diagnostics or UX.
  - [ ] Include version metadata when cheaply available
  - [ ] Include executable path metadata when available
  - [ ] Include last probe strategy and failure reason in a normalized field
  - [ ] Preserve raw provider-native payloads for debugging

---

## Phase 3 — Reliability Hardening 🟠 P1

> Goal: remove the remaining hang and recovery risks in the transport/session layers.

- [ ] **3.1 — Request timeouts on JSON-RPC transport**
  > `transport.request()` can still wait forever if the app-server stalls without exiting.
  - [ ] Add configurable `requestTimeoutMs`
  - [ ] Reject timed-out requests with a typed error
  - [x] Reject inflight pending requests when transport exits/closes
  - [ ] Export the timeout option through `CreateCodexOptions`

- [ ] **3.2 — Async queue backpressure / orphan stream protection**
  > Active turn streams are ended on transport close, but there is still no queue size guard or explicit memory protection.
  - [x] End active turn streams when transport closes
  - [ ] Add optional `maxQueueSize` guard
  - [ ] Add explicit tests for mid-turn crash behavior

- [ ] **3.3 — Observability for dropped or unmatched notifications**
  > Notification routing still silently returns in some unmatched cases.
  - [ ] Log or emit diagnostics for dropped notifications
  - [ ] Count dropped notifications for debugging
  - [ ] Decide whether to expose a client-level event emitter or logger hook

- [ ] **3.4 — Concurrency control for turns on the same thread/session**
  > The current turn-start queueing logic is still fragile under concurrent calls on the same thread.
  - [ ] Enforce one active turn per thread/session or queue explicitly
  - [ ] Add a clear error or serialization strategy
  - [ ] Expose running-state introspection where useful
  - [ ] Mirror the policy consistently in the shared provider API

- [ ] **3.5 — Auth robustness**
  > Browser timeout exists, but device auth polling remains fixed and transport restart behavior is still lightly documented.
  - [x] Browser login timeout support exists via `auth.timeoutMs`
  - [x] Device auth restarts the app-server transport after CLI login
  - [ ] Make device-auth polling interval and attempts configurable
  - [ ] Emit device-auth polling progress or diagnostics
  - [ ] Document safe/unsafe timing for `restartTransport()` during active work

- [ ] **3.6 — Provider availability probing safety**
  > Availability probing should be cheap and predictable; runtime checks should not surprise callers or hang.
  - [ ] Define cheap probe vs deep probe modes consistently across providers
  - [ ] Add timeouts around provider runtime probing where appropriate
  - [ ] Document probe cost and side effects

---

## Phase 4 — Type Safety and API Correctness 🟡 P2

> Goal: make the public API pleasant to consume from TypeScript without guesswork.

- [ ] **4.1 — Narrow Codex `TurnItem`**
  - [ ] Replace loose `TurnItem` with a discriminated union
  - [ ] Add type guards for common item kinds
  - [ ] Update `RunResult.items` and related event payloads

- [ ] **4.2 — Tighten runtime validation for user input**
  - [ ] Validate `UserInput` shape before sending JSON-RPC payloads
  - [ ] Throw typed input validation errors
  - [ ] Validate URLs/paths for non-text input elements
  - [ ] Keep Codex skill and mention input validation consistent with documented protocol shape

- [ ] **4.3 — Introduce typed exported errors**
  - [ ] Create shared error classes for timeout, input validation, provider detection, auth, and unsupported capability
  - [ ] Re-export them from `index.ts`
  - [ ] Document which methods throw which errors

- [ ] **4.4 — Stream event helpers**
  - [ ] Add event type guards for normalized `AgentEvent`
  - [ ] Add event type guards for Codex-specific `CodexStreamEvent`
  - [ ] Export helpers from `index.ts`

- [ ] **4.5 — Verify odd protocol naming and compatibility**
  > The Codex approval decision shape includes protocol-looking names that should be verified before the API hardens further.
  - [ ] Re-check `CommandApprovalDecision` naming against current app-server behavior
  - [ ] Add comments or migration notes if the names are intentionally awkward

---

## Phase 5 — Tests 🟡 P2

> Goal: add confidence. The codebase still has no test harness.

- [ ] **5.1 — Test infrastructure**
  - [ ] Add `vitest` or `node:test`
  - [ ] Add `test` script to `package.json`
  - [ ] Create unit/integration test directories
  - [ ] Add transport and provider mocks/stubs

- [ ] **5.2 — Transport/auth tests**
  - [ ] Request/response matching
  - [ ] Transport close rejects inflight requests
  - [ ] Browser login completion and timeout
  - [ ] Device auth restart and post-login polling behavior
  - [ ] Windows cleanup path coverage

- [ ] **5.3 — Codex lifecycle tests**
  - [ ] Thread start/resume/fork behavior
  - [ ] Turn start, delta streaming, completion routing
  - [ ] Concurrent turn behavior
  - [ ] Approval and tool-input handling

- [ ] **5.4 — Shared provider API tests**
  - [ ] `createAgent()` creates the right adapter
  - [ ] Session caching/clearing behavior
  - [ ] Normalized event mapping for Codex
  - [ ] Normalized event mapping for Claude
  - [ ] Capability and availability reporting

- [ ] **5.5 — Smoke/integration tests**
  - [ ] Stub or fixture runtime for Codex protocol tests
  - [ ] Minimal Claude adapter integration strategy
  - [ ] CI smoke test for README/example flows

---

## Phase 6 — Docs and Examples 🟡 P2

> Goal: make the SDK understandable from the package surface, not only by reading source.

- [ ] **6.1 — README expansion**
  - [x] Document the full shared provider API
  - [x] Document provider availability semantics
  - [ ] Document normalized events and handlers
  - [x] Document provider escape hatches and when to use them
  - [ ] Add troubleshooting for missing binaries, missing auth, and probe failures

- [ ] **6.2 — API docs / JSDoc**
  - [ ] Add JSDoc to public shared API types and methods
  - [ ] Add JSDoc to Codex compatibility classes
  - [ ] Clarify lifecycle semantics and caveats on sessions vs threads

- [ ] **6.3 — Example cleanup**
  - [x] Add generic agent examples for Codex and Claude
  - [x] Keep `examples/basic.ts` as the main Codex compatibility smoke example
  - [ ] Decide whether `examples/basic.ts` should prefer `run()` again instead of stream-only output
  - [x] Add example for provider discovery / availability
  - [ ] Add example for approvals and user-input handlers on the shared API
  - [ ] Verify every example listed in README actually exists and runs

- [ ] **6.4 — Changelog**
  - [ ] Add `CHANGELOG.md`
  - [ ] Record the transition from Codex-only wrapper to shared provider SDK
  - [ ] Note current limitations explicitly

---

## Phase 7 — Build, Package, and CI 🟢 P3

> Goal: make the package publishable and consumable in normal Node environments.

- [ ] **7.1 — Build output**
  > The package still points to source `.ts` entrypoints and currently relies on Node strip-types behavior.
  - [ ] Add `tsc` build to `dist/`
  - [ ] Publish JS + declaration files
  - [ ] Update `main`, `types`, and `exports`
  - [ ] Add `prepublishOnly`

- [ ] **7.2 — Publish footprint**
  - [ ] Add `"files"` or `.npmignore`
  - [ ] Exclude docs/examples/tests from publish output unless intentionally shipped

- [ ] **7.3 — Scripts**
  - [ ] Add `typecheck`
  - [ ] Add `build`
  - [ ] Add `test`
  - [ ] Keep example scripts aligned with actual files

- [ ] **7.4 — CI**
  - [ ] Add GitHub Actions for typecheck, test, and build
  - [ ] Add Node version matrix
  - [ ] Add publish workflow when packaging is ready

---

## Phase 8 — Future Expansion 🟢 P3

> Goal: leave room for scale without muddying the immediate product.

- [ ] **8.1 — Additional providers beyond Codex and Claude**
  - [ ] Define adapter checklist for new providers
  - [ ] Clarify minimum feature bar for first-class support

- [ ] **8.2 — Shared runtime pooling / process reuse**
  - [ ] Evaluate whether Codex transports should be pooled or shared
  - [ ] Avoid premature complexity until real usage justifies it

- [ ] **8.3 — Structured logging / telemetry**
  - [ ] Add injectable logger interface
  - [ ] Log transport lifecycle, auth, discovery probes, and approvals

- [ ] **8.4 — Conversation/message history helpers**
  - [ ] Expose higher-level message history APIs where they add value
  - [ ] Keep low-level turn/item access available
