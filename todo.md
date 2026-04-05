# @ouim/codexkit — Development Roadmap

> Last updated: 2026-04-05
> Version: 0.1.0 (early-stage)

This file tracks all known gaps, bugs, improvements, and feature work — broken into prioritized phases. Each phase targets a specific reliability/maturity threshold. Complete phases in order; later phases build on earlier foundations.

---

## Priority Legend
- 🔴 **P0 — Critical** (breaks correctness / production safety)
- 🟠 **P1 — High** (reliability and robustness issues)
- 🟡 **P2 — Medium** (completeness and DX issues)
- 🟢 **P3 — Low** (polish and future scaling)

---

## Phase 1 — Foundation Hardening 🔴 P0
> **Goal:** Make the core JSON-RPC transport and turn lifecycle correct and safe under real-world conditions. Nothing else matters until these are solid — these are the bugs that cause silent data loss, infinite hangs, and race conditions.

- [ ] **1.1 — Request timeouts on JSON-RPC transport**
  > `transport.request()` currently returns a Promise that can hang forever if the app-server stalls or crashes mid-request. Every call in the codebase is vulnerable to silent deadlock.
  - [ ] Add configurable `requestTimeoutMs` option (default: 30 000 ms)
  - [ ] On timeout, reject the pending promise with a typed `TimeoutError`
  - [ ] Reject all inflight pending requests when transport closes
  - [ ] Expose `requestTimeoutMs` in `CreateCodexOptions`

- [ ] **1.2 — AsyncQueue unbounded growth & orphan streams**
  > If the app-server crashes mid-turn, `controller.events` (AsyncQueue) never ends. The async `for await` loop in `runThread()` / `streamThread()` hangs forever.
  - [ ] Call `controller.events.end()` in all turn-error paths
  - [ ] Call `controller.events.end()` when transport closes while a turn is active
  - [ ] Add optional `maxQueueSize` guard; throw if exceeded
  - [ ] Test: simulate mid-turn process death and assert iterator terminates

- [ ] **1.3 — Silent event drops in notification routing**
  > `handleNotification()` silently returns when it can't find a `TurnController` for `${threadId}:${turnId}`. Events are lost with no trace.
  - [ ] Log a warning with full context when a notification is dropped
  - [ ] Emit a generic `'notification'` event so callers can observe unknowns
  - [ ] Add a `droppedNotifications` counter on the client for observability

- [ ] **1.4 — Race condition in concurrent turn starts on same thread**
  > `pendingTurnStarts` is a queue but there is no serialization guard. If two `thread.run()` calls race before either `turn/started` notification arrives, `turnId` matching could go wrong.
  - [ ] Enforce single-turn-at-a-time per thread via a mutex or sequential queue
  - [ ] If a second `run()` is called while a turn is active, either queue it or throw a clear error
  - [ ] Add a `thread.isRunning` boolean for caller introspection

- [ ] **1.5 — Validate `codex` binary exists before starting**
  > The client silently fails with a cryptic spawn error if `codex` is not on `PATH`. There is zero validation or user-friendly error message.
  - [ ] At `createCodex()` time, check `which codex` / `where codex` (cross-platform)
  - [ ] Throw a `CodexNotFoundError` with installation instructions if missing
  - [ ] Expose detected codex path in a `client.diagnostics` object

---

## Phase 2 — Error Recovery & Resilience 🟠 P1
> **Goal:** Handle the cases where things go wrong at runtime — crashes, auth failures, network blips. The client should never leave the caller stuck with an unresolvable promise.

- [ ] **2.1 — Reconnection logic after app-server crash**
  > If the app-server process dies unexpectedly, there is no automatic recovery. All in-flight turns fail with an opaque error and the client becomes permanently broken.
  - [ ] Detect unexpected transport closure (process exit code != 0)
  - [ ] Emit a `'disconnect'` event on the client
  - [ ] Implement auto-reconnect with exponential backoff (max 3 retries by default)
  - [ ] Expose `autoReconnect` boolean in `CreateCodexOptions`
  - [ ] After reconnect, re-register event listeners; in-flight turns are abandoned with `status: 'error'`

- [ ] **2.2 — Device auth polling is fragile (fixed 15 × 1s)**
  > Polling after device-code login is hardcoded to 15 attempts at 1-second intervals. Slow systems or network latency will fail authentication silently, returning `null`.
  - [ ] Make polling configurable: `deviceAuthPollIntervalMs` and `deviceAuthPollMaxAttempts`
  - [ ] Provide sensible defaults: 20 attempts × 2 s = 40 s total
  - [ ] Emit progress events during polling (attempt N / max)
  - [ ] Return a typed `AuthError` (not `null`) when polling exhausts retries

- [ ] **2.3 — Browser auth login timeout**
  > `waitForLogin()` in `auth.ts` polls `account/read` but has no overall deadline. If the user never completes the browser flow, the client waits indefinitely.
  - [ ] Add `loginTimeoutMs` option (default: 5 min)
  - [ ] Reject `ensureLoggedIn()` with `LoginTimeoutError` when deadline passes
  - [ ] Cancel the pending login deferred on timeout

- [ ] **2.4 — Transport restart drops pending requests**
  > `restartTransport()` (called after device-code auth) closes the old transport, which rejects all pending requests. No queuing or replay mechanism exists.
  - [ ] Before closing old transport, snapshot and log any pending request IDs
  - [ ] After restart, re-initialize event routing
  - [ ] Document that `restartTransport()` is only safe when no turns are active

- [ ] **2.5 — Approval handler default behavior clarification**
  > Command/file approval defaults to silent `'decline'` — this can cause Codex to make no progress at all with no user feedback. Tool input handler returns an error (inconsistent).
  - [ ] Make default approval behavior configurable: `'decline' | 'prompt' | 'auto-approve'`
  - [ ] For `item/tool/requestUserInput`, add a sensible no-handler default (e.g., empty string + warning)
  - [ ] Emit a `'approval.defaulted'` event when falling back to default
  - [ ] Document the security implications of `'auto-approve'` clearly

---

## Phase 3 — Type Safety & API Correctness 🟡 P2
> **Goal:** Harden the TypeScript API surface so callers get real type-checking, IDE autocomplete, and compile-time safety across all event types, item variants, and approval decisions.

- [ ] **3.1 — Narrow `TurnItem` type**
  > `TurnItem` is essentially `{ type: string; id: string; [key: string]: unknown }` — effectively `any` after the ID. No type narrowing possible.
  - [ ] Define discriminated union: `AgentMessageItem | CommandExecutionItem | FileChangeItem | McpToolCallItem | ReasoningItem | ...`
  - [ ] Replace `TurnItem` with the union
  - [ ] Add type guards: `isAgentMessageItem(item)`, `isCommandItem(item)`, etc.
  - [ ] Update `RunResult.items` to use the narrowed type

- [ ] **3.2 — Fix suspected typo in `CommandApprovalDecision`**
  > `acceptWithExecpolicyAmendment` uses lowercase `p` — may be a typo vs. the actual server protocol field name. Should be verified and either documented or corrected.
  - [ ] Cross-check against live app-server JSON-RPC schema
  - [ ] If wrong: fix and add a migration note
  - [ ] If intentional: add a comment explaining the naming

- [ ] **3.3 — Typed stream event narrowing**
  > `CodexStreamEvent` is a union but discriminating on `.type` doesn't give full property access without manual casting in practice.
  - [ ] Verify all union members have unique, literal `type` discriminants
  - [ ] Add comprehensive type guard helpers: `isMessageDeltaEvent(e)`, `isApprovalEvent(e)`, etc.
  - [ ] Export type guards from `index.ts`

- [ ] **3.4 — Validate `UserInput` shape at runtime**
  > `UserInput` accepts `string | UserInputElement[]`. The `assertObject` helper exists but isn't used at user-facing boundaries. Malformed input reaches JSON-RPC with cryptic errors.
  - [ ] Add runtime validation in `toUserInput()`: check element types, required fields
  - [ ] Throw `InputValidationError` with a descriptive message on bad shape
  - [ ] Add `image_url` element support validation (non-empty URL check)

- [ ] **3.5 — Export all error types**
  > `CodexNotFoundError`, `TimeoutError`, `AuthError`, `LoginTimeoutError`, `InputValidationError` (from P1/P2 work above) must be exported from `index.ts` so callers can `instanceof` check them.
  - [ ] Create `src/errors.ts` with all typed error classes
  - [ ] Re-export from `index.ts`
  - [ ] Document error hierarchy in README

---

## Phase 4 — Testing 🟡 P2
> **Goal:** Add a test suite. Right now there are zero tests — no unit, no integration, no smoke. This is the biggest maturity gap for any library claiming production readiness.

- [ ] **4.1 — Set up testing infrastructure**
  > No test runner, no test files, no mocking strategy exists.
  - [ ] Add `vitest` (or `node:test` for zero-dep) as a dev dependency
  - [ ] Configure test script in `package.json`
  - [ ] Create `tests/` directory structure: `unit/`, `integration/`
  - [ ] Add a mock `AppServerTransport` that simulates JSON-RPC responses

- [ ] **4.2 — Unit tests: transport layer**
  > Core JSON-RPC transport has no tests. Line parsing, request/response matching, and event routing are untested.
  - [ ] Test: request/response ID matching
  - [ ] Test: notification routing via EventEmitter
  - [ ] Test: server request routing and respond/respondError
  - [ ] Test: timeout behavior (fake timers)
  - [ ] Test: process crash → pending request rejection
  - [ ] Test: Windows vs. Unix process cleanup paths

- [ ] **4.3 — Unit tests: auth module**
  > Auth flows are complex and untested.
  - [ ] Test: `loginWithChatGPT()` happy path with mocked transport
  - [ ] Test: `loginWithChatGPT()` timeout (mock timer expiry)
  - [ ] Test: `loginWithDeviceCode()` success path
  - [ ] Test: `loginWithDeviceCode()` poll exhaustion returns typed error
  - [ ] Test: `ensureLoggedIn()` when already logged in (no re-login)

- [ ] **4.4 — Unit tests: turn lifecycle**
  > The turn start → event routing → completion lifecycle is the most complex logic in the codebase.
  - [ ] Test: single turn happy path (mock server sends turn/started, deltas, turn/completed)
  - [ ] Test: `runThread()` returns correct `RunResult.text`
  - [ ] Test: `streamThread()` yields events in order
  - [ ] Test: concurrent turns on same thread (queuing/mutex behavior)
  - [ ] Test: turn/completed when messageBuffer has content → text in RunResult
  - [ ] Test: approval request emits event and calls handler

- [ ] **4.5 — Unit tests: session and thread wrappers**
  - [ ] Test: `session.run()` reuses same `threadId` across calls
  - [ ] Test: `session.run()` with fork creates new thread
  - [ ] Test: `thread.interrupt()` sends correct JSON-RPC notification

- [ ] **4.6 — Integration smoke tests**
  > End-to-end tests against a real or stub `codex app-server`.
  - [ ] Create a minimal stub `codex` binary for CI (Node script, responds to known protocol)
  - [ ] Smoke test: full login → create thread → run → get text result
  - [ ] Smoke test: streaming turn → collect all delta events
  - [ ] Add to CI via GitHub Actions

---

## Phase 5 — Documentation & Examples 🟡 P2
> **Goal:** Make the SDK usable without reading source code. Right now, no JSDoc exists and the only example has a commented-out section.

- [ ] **5.1 — JSDoc on all public APIs**
  > Zero JSDoc comments in the entire codebase. IDE hover gives no context.
  - [ ] Document `CodexClient`: all public methods with params, return types, throws
  - [ ] Document `CodexThread` and `CodexSession`: lifecycle semantics
  - [ ] Document all `CodexStreamEvent` union members
  - [ ] Document all `RunOptions`: what each field does, valid values, defaults
  - [ ] Document `UserInput` element types with examples

- [ ] **5.2 — Fix and complete examples**
  > `examples/basic.ts` has the `session.run()` call commented out. `examples/ci.ts` is functional but minimal.
  - [ ] Uncomment and fix `session.run()` in `basic.ts`
  - [ ] Add an approval-handling example
  - [ ] Add a tool-input-handler example
  - [ ] Add a fork/branch-thread example
  - [ ] Add a dynamic tool call example
  - [ ] Verify all examples run end-to-end

- [ ] **5.3 — Expand README**
  > README documents basic usage but omits most of the API surface.
  - [ ] Document all stream event types with code examples
  - [ ] Document approval flows and decision types
  - [ ] Document tool input request pattern
  - [ ] Document error handling with typed errors (from Phase 3)
  - [ ] Add troubleshooting section (codex not on PATH, auth failures, timeouts)
  - [ ] Add badge: Node version requirement

- [ ] **5.4 — CHANGELOG**
  > No changelog exists. For a library, this is required for downstream consumers.
  - [ ] Create `CHANGELOG.md` with 0.1.0 entry listing initial capabilities
  - [ ] Document known limitations at 0.1.0

---

## Phase 6 — Build, Package & Distribution 🟢 P3
> **Goal:** Make the package publishable to npm and usable without requiring `--experimental-strip-types`.

- [ ] **6.1 — Add proper build step**
  > Currently `"main": "./src/index.ts"` — the package cannot be consumed by standard Node.js without `--experimental-strip-types`. This prevents use in most environments.
  - [ ] Add `tsc` build script outputting to `dist/`
  - [ ] Set `"main": "./dist/index.js"` and `"types": "./dist/index.d.ts"`
  - [ ] Add `"exports"` field in `package.json` for modern ESM/CJS dual output
  - [ ] Add `dist/` to `.gitignore` and a `prepublishOnly` script

- [ ] **6.2 — Add `.npmignore` / `"files"` field**
  > Without this, `npm publish` would include `src/`, `examples/`, `docs/`, and test files.
  - [ ] Add `"files": ["dist/", "README.md", "CHANGELOG.md"]` to `package.json`

- [ ] **6.3 — CI/CD pipeline**
  > No CI configuration exists.
  - [ ] Add GitHub Actions workflow: lint → typecheck → test → build
  - [ ] Add matrix: Node 22, Node 23
  - [ ] Add publish workflow triggered on version tag

- [ ] **6.4 — Versioning strategy**
  > Still at 0.1.0 with no semver policy.
  - [ ] Document semver policy in CONTRIBUTING or README
  - [ ] Decide pre-1.0 vs. quick stable release path

---

## Phase 7 — Advanced Features 🟢 P3
> **Goal:** Fill capability gaps for advanced use cases and production deployments.

- [ ] **7.1 — Connection pooling / shared app-server**
  > Each `createCodex()` spawns a new `codex app-server` process. Multiple clients cannot share a server. This is inefficient at scale.
  - [ ] Design a `CodexServerPool` singleton that manages one server process
  - [ ] Allow multiple `CodexClient` instances to multiplex over the same transport
  - [ ] Add reference counting for clean shutdown

- [ ] **7.2 — Codex CLI version detection**
  > No validation that the installed `codex` CLI version is compatible with this SDK.
  - [ ] At startup, run `codex --version` and parse output
  - [ ] Define minimum supported codex version in `package.json`
  - [ ] Warn (or error) if CLI version is below minimum

- [ ] **7.3 — Structured logging / telemetry**
  > No internal logging. Debugging requires adding `console.log` manually.
  - [ ] Adopt a lightweight logger interface (injectable, defaults to no-op)
  - [ ] Log: transport lifecycle, auth steps, turn start/complete, approval decisions
  - [ ] Expose `debug: boolean | Logger` in `CreateCodexOptions`

- [ ] **7.4 — Conversation history / message coalescing**
  > Message deltas are buffered but never assembled into a full conversation object.
  - [ ] Add `thread.getMessages()` returning assembled agent messages from last turn
  - [ ] Expose `RunResult.conversation: Message[]` with role + content
  - [ ] Handle multi-item turns correctly (multiple agentMessage items)

- [ ] **7.5 — Retry on rate-limit**
  > `getRateLimits()` exists but nothing uses it. If a turn fails due to rate limiting, the error is passed raw to the caller.
  - [ ] Detect `429` / rate-limit error codes in turn completion
  - [ ] Implement configurable retry with backoff for rate-limited turns
  - [ ] Expose `rateLimitRetry` option in `RunOptions`
