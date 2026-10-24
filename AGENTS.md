# AGENTS.md

AgentKit = one TypeScript layer over locally signed-in Claude Code, Codex and OpenCode.

## Layout
- `capsules/shared/contract.ts`: **the contract**. `ProviderClient`, `ProviderSession`, `AgentEvent`, `TimelineItem`, `Capabilities`. Change it deliberately; every capsule implements it.
- `capsules/shared/runtime.ts`: helpers capsules may use (`Emitter`, `collectRun`, `deriveToolDetail`, `findBinary`, `killTree`).
- `capsules/<provider>/index.ts`: the only public entry per capsule. `internals/` is private.
  - `claude-code`: `@anthropic-ai/claude-agent-sdk`, one long-lived `query()` per session fed by an input queue. `internals/session.ts` (turns, interrupt, steer, drafts), `mapping.ts` (SDK messages → timeline/usage), `voice.ts` (dictation websocket).
  - `codex`: raw JSON-RPC to `codex app-server` (one child per session). Wire types: `codex app-server generate-ts --out <dir>`. `internals/`: `rpc.ts`, `session.ts`, `items.ts`.
  - `opencode`: `opencode serve` (shared, ref-counted; dedicated when MCP) + `@opencode/client` v2. Events + snapshot diffing (`internals/server.ts`, `session.ts`, `timeline.ts`).
  - `mock`: deterministic, all capabilities; prompt directives `[tool] [ask] [fail] [slow]`.
- `src/`: AgentKit proper. `kit.ts` (registry, access→mode mapping, catalog cache, resume/list), `session.ts` (guards, `submit` + inbox + steer fallback, fork/compact, policies, transcript), `skills.ts` + `skill-tags.ts` (discovery, search, `$skill` expansion; tags are browser-safe), `store.ts` (node:sqlite durable store: commit-before-show, submission intent/outcome, crash recovery), `hub.ts` (MCP hub: one loopback server per provider session, upstream connections with backoff, native tools, `readCliServers`/TOML import), `transcript.ts` (pure reducer), `attachment-tags.ts`, `policy.ts`, `errors.ts`. `src/index.ts` is the public surface; `package.json` `exports` also ships `/capsules/*`, `/contract`, `/transcript`, `/attachment-tags`, `/skill-tags`.
- `examples/`: `quickstart.ts`, `doctor.ts` (`npm run doctor`), `harness-server.ts`, and a web UI (`npm run ui:api` + `npm run ui`). `test/e2e/FAILURE_MODES.md` lists every failure mode and the check that covers it (numbered #1–#84; add rows before the code).

## Rules
- Capsules import only `../shared/*` and their own SDK. Only `src/` knows about several providers.
- Run with Node ≥ 22.6 type stripping: no enums, no parameter properties, no namespaces (`erasableSyntaxOnly` is on). Relative imports use `.ts`.
- A capability flag must be true only if the live E2E proves it.
- New primitive? Add it to `Capabilities`, implement it in every capsule (or set false), guard it in `AgentSession`, add an E2E step.
- **Every user-facing change updates [`docs/BUILD_YOUR_CONSUMER_APP.md`](docs/BUILD_YOUR_CONSUMER_APP.md) in the same commit**: its section (real snippet + the UX rule), the checklist if relevant, and the changelog.
- Browser-safe modules (`src/transcript.ts`, `src/skill-tags.ts`, `capsules/shared/timeline.ts`) must never import `node:*`; they ship as `@ouim/agentkit/transcript` and `/skill-tags`.

## Verify
```bash
npm test                               # = npm run verify; what CI and publish run
npm run verify                         # typecheck + mock conformance/durable/host + hub-retry + inbox-reorder + lifecycle (free, no models)
node test/e2e/conformance.ts claude    # real, uses your sign-in; artifact in test/e2e/artifacts/
node test/e2e/extras.ts codex          # steer, structured output, system prompt, queue, commands
node test/e2e/durable.ts codex         # kill -9 mid-turn, requestId idempotency, inbox, fork, compact
node test/e2e/skills.ts                # skill discovery/visibility vs each CLI, search, expansion, invocation
node test/e2e/hub.ts                   # MCP hub: each CLI sees only hub servers, status, toggles, persist, import
node test/e2e/inbox-reorder.ts         # reorderInbox: queued prompts run in the host's order (mock; runs in verify)
node test/e2e/hub-retry.ts             # HTTP upstreams: honest errors, SSE fallback only on 4xx, reconnect with backoff, close while connecting (no models; runs in verify)
node test/e2e/lifecycle.ts             # stream() ends on close, stored submissions stop polling, TOML ` #` in strings (mock; runs in verify)
node test/e2e/claude-interrupt.ts      # a Claude CLI that ignores Stop is closed after 10s; next turn resumes (haiku)
node test/e2e/claude-tool-drafts.ts    # Claude tool calls show while their arguments stream (haiku)
node test/e2e/tool-images.ts claude codex  # tool-result images become files under attachmentsDir, no base64 stored
node test/e2e/transcribe.ts            # dictation on the Claude sign-in: batch, streaming, pauses, typed failures (needs `phonon` for test speech)
node test/e2e/orphans.ts               # opencode serve dies with its host (kill -9, graceful, server-only death); no model calls
node test/e2e/host.ts claude codex opencode  # attachments, plan usage, complete, paged snapshots (mock version runs in verify)
node test/e2e/proof.ts                 # settings merge, steer replay after resume, structured questions, file rewind
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
- MCP hub (`src/hub.ts`): exclusivity is per capsule (Claude `strictMcpConfig`, Codex disables only `config.toml` names — built-ins reject overrides, OpenCode `installMcp`). Re-run `test/e2e/hub.ts` after a CLI upgrade.
- `opencode serve` runs under a POSIX `sh` watchdog that holds the host's stdin pipe (`LIFETIME_WATCHDOG` in `capsules/opencode/internals/server.ts`); host death closes the pipe and the group is TERMed. Background jobs in non-interactive sh get /dev/null stdin, hence the fd 3 dance.
- Live E2E suites pin the cheapest models (Claude haiku, Codex gpt-5.6-luna low, OpenCode `opencode-go/minimax-m3.1-flash-free`). Keep them cheap, and never depend on a custom provider in someone's own config. **The OpenCode pin is stale**: that model is gone from the catalog (`opencode models`), so the live OpenCode suites fail with "Model unavailable" until it is re-pinned (a stock free one, e.g. `opencode/deepseek-v4.1-flash-free`, replied fine).
- A thread never changes provider. Don't add a provider swap; a new provider means a new thread.
- `src/attachment-tags.ts` is browser-safe like `transcript.ts` (ships as `@ouim/agentkit/attachment-tags`).
- Codex offers `request_user_input` only in its plan collaboration mode (experimental `collaborationMode` on turn/start); the capsule's `plan` mode sends it. Regenerate wire types with `--experimental` to see those fields.
- Claude file checkpointing tracks Write/Edit only; shell edits aren't rewound.
- Dictation (`capsules/claude-code/internals/voice.ts`) is Claude Code's own voice websocket, not a public API. With `forward_interims` every `TranscriptText` is the whole text so far; an endpoint commits it. Re-run `test/e2e/transcribe.ts` after a CLI upgrade. Never refresh/rotate the Claude OAuth token in AgentKit (a second writer can sign the CLI out); expired → `claude auth status`, then `SIGNED_OUT`.
- `npm run verify` rewrites tracked mock artifacts (`test/e2e/artifacts/*-mock.json`); `git checkout -- test/e2e/artifacts` before committing unless you meant to update them.
- OpenCode capsule: an assistant text/reasoning part holds its stream events until one snapshot `sync()` has emitted the durable user message, so a fast model's answer can't land above the question. Keep that hold when touching `observe()`.
- Hub `Upstream`: `close()` bumps an epoch; a connect that started earlier must check it after every await and close its own client instead of marking the server connected.
- `session.stream()` ends on `close()` (readers are woken); `kit.submission(id).wait()` for another process's turn polls only while awaited and settles `canceled` if the row is deleted.
- Env that matters: `AGENTKIT_INHERIT_ENV` (comma list of host vars MCP servers may see), `CLAUDE_CONFIG_DIR` (Claude sign-in location for dictation), `CODEX_HOME` (where `config.toml` is read for hub import and exclusivity), `VOICE_STREAM_BASE_URL` (dictation endpoint override, used by tests).
- Claude prompt-cache TTL (5m vs 1h) is chosen by the CLI, not AgentKit; the kit only reads `cache_read_input_tokens`. `claude.env` reaches the CLI, but a TTL override through it has not been verified.
