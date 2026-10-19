# Shared contract

`contract.ts` is the seam between capsules and AgentKit. A capsule is anything that returns a `ProviderClient`.

Lifecycle: `client.createSession(config)` → `session.subscribe(fn)` → `startTurn` / `run` → events → terminal event (`turn_completed | turn_failed | turn_canceled`) → `close()` → `client.shutdown()`.

Invariants every capsule must keep (checked by `test/e2e/conformance.ts`):
1. Every turn emits exactly one `turn_started` and exactly one terminal event with the same `turnId`.
2. Timeline events of a turn carry that `turnId`.
3. `assistant_message` / `reasoning` events are deltas live; `history()` yields whole items.
4. `tool_call` items with the same `callId` are updates of one call (running → completed/failed).
5. Every `permission_requested` is followed by one `permission_resolved` (answered, denied on turn end, or aborted).
6. `interrupt()` resolves only after the active turn is terminal; idle = no-op.
7. `describePersistence()` is JSON-serializable and enough for `resumeSession()` in a new process.
8. Capability flags are true only when implemented end to end.
9. `fork()` never changes the current session and returns a handle `resumeSession()` accepts. `compact()` resolves only after the provider reports it done.
10. Capsules never emit `inbox_changed` / `turn_interrupted`; AgentKit owns those (queueing and crash recovery live above the capsule, so every provider gets them for free).

Write your own capsule: copy `capsules/mock/index.ts`, replace the fake turn with real calls, run the conformance script against it via `createAgentKit({ providers: [yourClient] })`.
