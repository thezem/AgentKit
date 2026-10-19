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
- `src/`: AgentKit proper. `kit.ts` (registry, access→mode mapping, catalog cache, resume/list), `session.ts` (guards, `submit` + inbox + steer fallback, fork/compact, policies, transcript), `skills.ts` + `skill-tags.ts` (discovery, search, `$skill` expansion; tags are browser-safe), `store.ts` (node:sqlite durable store: commit-before-show, submission intent/outcome, crash recovery), `transcript.ts` (pure reducer), `policy.ts`, `errors.ts`.

## Rules
- Capsules import only `../shared/*` and their own SDK. Only `src/` knows about several providers.
- Run with Node ≥ 22.6 type stripping: no enums, no parameter properties, no namespaces (`erasableSyntaxOnly` is on). Relative imports use `.ts`.
- A capability flag must be true only if the live E2E proves it.
- New primitive? Add it to `Capabilities`, implement it in every capsule (or set false), guard it in `AgentSession`, add an E2E step.
- **Every user-facing change updates [`docs/BUILD_YOUR_CONSUMER_APP.md`](docs/BUILD_YOUR_CONSUMER_APP.md) in the same commit**: its section (real snippet + the UX rule), the checklist if relevant, and the changelog.
- Browser-safe modules (`src/transcript.ts`, `src/skill-tags.ts`, `capsules/shared/timeline.ts`) must never import `node:*`; they ship as `@ouim/agentkit/transcript` and `/skill-tags`.

## Verify
```bash
npm run verify                         # typecheck + mock conformance + mock durable (free)
node test/e2e/conformance.ts claude    # real, uses your sign-in; artifact in test/e2e/artifacts/
node test/e2e/extras.ts codex          # steer, structured output, system prompt, queue, commands
node test/e2e/durable.ts codex         # kill -9 mid-turn, requestId idempotency, inbox, fork, compact
node test/e2e/skills.ts                # skill discovery/visibility vs each CLI, search, expansion, invocation
npm run doctor                         # install/sign-in status per provider
```

## Gotchas
- Claude loads your user MCP servers per session (settingSources includes 'user'); pass `settingSources: ['project']` to `createClaudeCodeClient` for faster, isolated sessions.
- Claude rewind / Codex rewind change the native session id (fork). Always re-read `session.handle` after rewind.
- OpenCode allows edits by default; ask-rules go through `providerOptions.permissions`.
- Codex `read-only` mode still asks for escalation; that is how the permission path is exercised.
- Codex: the app-server that runs `thread/fork` holds the new thread's writer lock until it exits, so `fork()` uses a throwaway app-server.
- Store recovery never re-sends: interrupted turns are surfaced (`kit.recovered`, a transcript notice), the user decides.
- `node:sqlite` prints an ExperimentalWarning on Node 22–24; harmless.
- Skill visibility rules live in `src/skills.ts` roots: Claude reads only top-level `.claude/skills/<name>`; OpenCode also reads `.agents` + `.codex` (incl. `.system`) and nested skills; Codex is taken from its own `skills/list`. Re-run `test/e2e/skills.ts` after a CLI upgrade.
- OpenCode keys a skill by folder name when it differs from frontmatter `name` (seen: `2d-game-UI`); AgentKit uses the frontmatter name.
