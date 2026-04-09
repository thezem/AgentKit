# Changelog

All notable changes to `@ouim/agentkit` are documented here.

## [0.1.0] - 2026-04-08

### Added

- Shared provider SDK surface centered on `createAgent(...)` with first-class `codex` and `claude` providers.
- Explicit session lifecycle primitives:
  - `openSession(...)`
  - `resumeSession(...)`
  - local cached `session(name)` convenience
  - explicit close/clear APIs
- Provider-neutral event stream model (`AgentEvent`) including message deltas, status, approval prompts, user input prompts, and turn completion.
- Provider inventory/discovery APIs:
  - `getProviderInventory(...)`
  - `getProviderInventoryEntry(...)`
  - compatibility availability helpers
- Unified model discovery (`listModels`) and Codex-backed skills discovery/configuration (`listSkills`, `writeCodexSkillConfig`).
- Dedicated shared handler example for approvals and user input (`examples/handlers.ts`).

### Changed

- Package positioning shifted from Codex-only wrapper to provider-neutral host SDK for local agent runtimes.
- README expanded with normalized events, handler wiring, lifecycle semantics, troubleshooting, and verified script/example mapping.
- Public API JSDoc coverage added for shared API and Codex compatibility surface.

### Compatibility

- Codex compatibility layer remains available:
  - `createCodex`
  - `CodexClient`
  - `CodexSession`
  - `CodexThread`
  - `CodexAuth`
- Existing Codex-first integrations can stay on compatibility APIs while migrating to the shared provider API incrementally.

### Current Limitations

- Skills are Codex-first; Claude skill listing/configuration is not yet implemented.
- Provider behavior is normalized where possible, but some resume/account/runtime details remain provider-specific in `handle.raw`/`result.raw` escape hatches.
