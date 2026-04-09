# @ouim/agentkit — Phase Ground Roadmap

> Last updated: 2026-04-08
> Focus: orchestration-grade runtime contracts for adapter-layer adoption

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

## Phase 2 — Pre-release Spec Alignment (3–5 SP Slices) 🔴 P0
