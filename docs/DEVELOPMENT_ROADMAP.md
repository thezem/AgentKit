# @ouim/agentkit — Development Roadmap

> Last updated: 2026-04-08
> Version: 0.1.0

This roadmap has been realigned to the current product shape.

`@ouim/agentkit` is no longer just a thin Codex transport wrapper. It already has:

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
- [x] Legacy runtime account flows kept for compatibility (transitional)
- [x] Windows-specific Codex command handling and best-effort process cleanup
- [x] Main examples for Codex compatibility, generic Codex, and generic Claude

### Not shipped yet

- [x] Explicit provider-agnostic session resume/open API
- [x] Rich machine inventory API for installed providers and resolved executable paths
- [x] Unified model listing across providers
- [x] Unified skills listing/configuration across providers
- [x] Test suite
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
  - [x] Distinguish installed, runnable, account-state-present, and degraded states

- [x] **1.3 — Add provider capability reporting that is useful to callers**
  > `getCapabilities()` exists, but it is still coarse and mostly hardcoded.
  - [x] Define a normalized capability schema for session resume, approvals, model switching, tools, skills, partials, and inventory support
  - [x] Split static adapter claims from runtime-probed capabilities where relevant
