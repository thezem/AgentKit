# AGENTS.md

AgentKit = one TypeScript layer over locally signed-in Claude Code, Codex and OpenCode.

## Layout
- `capsules/shared/contract.ts`: **the contract**. `ProviderClient`, `ProviderSession`, `AgentEvent`, `TimelineItem`, `Capabilities`. Change it deliberately; every capsule implements it.
- `capsules/shared/runtime.ts`: helpers capsules may use (`Emitter`, `collectRun`, `deriveToolDetail`, `findBinary`, `killTree`).
- `capsules/<provider>/index.ts`: the only public entry per capsule. `internals/` is private.
  - `claude-code`: `@anthropic-ai/claude-agent-sdk`, one long-lived `query()` per session fed by an input queue.
  - `codex`: raw JSON-RPC to `codex app-server` (one child per session). Wire types: `codex app-server generate-ts --out <dir>`.
  - `opencode`: `opencode serve` (shared, ref-counted; dedicated when MCP) + `@opencode/client` v2. Events + snapshot diffing.
  - `mock`: deterministic, all capabilities; prompt directives `[tool] [ask] [fail] [slow]`.
- `src/`: AgentKit proper. `kit.ts` (registry, access→mode mapping, catalog cache, resume/list), `session.ts` (guards, queue, steer fallback, policies, transcript), `transcript.ts` (pure reducer), `policy.ts`, `errors.ts`.

## Rules
- Capsules import only `../shared/*` and their own SDK. Only `src/` knows about several providers.
- Run with Node ≥ 22.6 type stripping: no enums, no parameter properties, no namespaces (`erasableSyntaxOnly` is on). Relative imports use `.ts`.
- A capability flag must be true only if the live E2E proves it.
- New primitive? Add it to `Capabilities`, implement it in every capsule (or set false), guard it in `AgentSession`, add an E2E step.

## Verify
```bash
npm run verify                         # typecheck + mock conformance (free)
node test/e2e/conformance.ts claude    # real, uses your sign-in; artifact in test/e2e/artifacts/
node test/e2e/extras.ts codex          # steer, structured output, system prompt, queue, commands
npm run doctor                         # install/sign-in status per provider
```

## Gotchas
- Claude loads your user MCP servers per session (settingSources includes 'user'); pass `settingSources: ['project']` to `createClaudeCodeClient` for faster, isolated sessions.
- Claude rewind / Codex rewind change the native session id (fork). Always re-read `session.handle` after rewind.
- OpenCode allows edits by default; ask-rules go through `providerOptions.permissions`.
- Codex `read-only` mode still asks for escalation; that is how the permission path is exercised.
