# AGENTS.md

## Project

- Package name: `@ouim/agentkit`
- Purpose: high-level Node wrapper around `codex app-server`
- Primary auth preference: ChatGPT login, not API key first
- Supported auth modes:
  - app-server ChatGPT browser login
  - CLI device auth via `codex login --device-auth`

## Product Vision

- This package is a host-side SDK for local AI agent CLIs installed on user machines.
- Codex is the first provider, but the SDK is intended to support multiple providers and CLIs over time.
- The goal is one stable API for builders to manage agents without dealing with provider-specific CLI quirks.
- The core public surface should support:
  - creating/opening sessions
  - resuming sessions
  - closing sessions
  - streaming agent activity and turn events
  - handling tool requests, approvals, and user input prompts
  - switching models and passing provider-specific configuration
- Keep `getAvailableProviders()` as the discovery API name.
- Discovery should focus on globally installed provider binaries/runtime availability, not full system scanning.
- For each available provider, prefer returning enough metadata to identify the executable/runtime location when possible, especially for CLI-based providers like Claude.
- The SDK should expose provider-neutral primitives first, while still allowing provider-specific escape hatches where needed.

## Important Implementation Notes

- This package was intentionally rebuilt on top of `codex app-server`, not `@openai/codex-sdk`.
- Reason: app-server exposes the real runtime surface, including auth, thread lifecycle, approvals, tool input requests, and richer event streams.
- The old SDK-wrapper approach was discarded because it could not cleanly support the intended API.

## Auth Lessons

- Browser auth works through app-server `account/login/start` with `{ type: "chatgpt" }`.
- The app-server browser flow can be quiet if the app does not print explicit progress, so examples should always print:
  - login URL
  - a waiting message
  - a success confirmation after login completes

- Device auth is supported, but the correct UX is to launch the native CLI flow with inherited stdio:
  - `codex login --device-auth`
- Do not try to scrape the device code from piped stdout in this project.
- On Windows, inherited stdio is the reliable approach because the native Codex login UI should be shown directly in the terminal.

- After `codex login --device-auth` completes, the already-running app-server process may still have stale auth state.
- Fix: restart the app-server transport, then poll `account/read` briefly until the ChatGPT account appears.
- If this is removed later, device auth may appear to succeed but `account/read` can still return `null`.

## Windows Notes

- Use `codex.cmd` on Windows when spawning Codex from Node.
- Process shutdown on Windows may leave child processes behind if not terminated carefully.
- The transport currently uses `taskkill /pid ... /t /f` as a best-effort cleanup path.

## Turn/Event Lessons

- `turn/completed` does not expose a top-level `turnId` in the notification params.
- The turn id must be read from `params.turn.id`.
- A previous bug dropped completion events because the router expected `params.turnId`.
- If `thread.run()` or `thread.stream()` hangs forever, check this first.

## TypeScript Notes

- This repo uses explicit `.ts` import paths.
- `tsconfig.json` must include:
  - `"types": ["node"]`
  - `"allowImportingTsExtensions": true`
- Node ambient types are required because the package directly uses `process`, `node:child_process`, `node:events`, and `node:readline`.

## Example Expectations

- `examples/basic.ts` is the main smoke example.
- It should always show visible progress, especially around login.
- It supports device auth selection with:
  - PowerShell: `$env:CODEXKIT_LOGIN='device-code'`
  - POSIX: `CODEXKIT_LOGIN=device-code`

## Naming

- Chosen package identity: `@ouim/agentkit`
- This was preferred over `codex-client` because it matches the `ouim/*` naming style better and keeps the umbrella name provider-neutral.

--Before writing any implementation, write the test files first. Tests should be written to fail until implementation exists. Tests should verify behavior and outcomes, not implementation details or function signatures. Then proceed with implementation

---

---

**Stop rewriting glue code every time Codex or Claude updates.**

You’re building real stuff on top of local AI agents — multi-step workflows, review bots, internal tools, skill-heavy automations. But every provider ships its own session model, resume semantics, discovery quirks, and breaking CLI changes. Switching between Codex and Claude (or just surviving an update) turns into death by docs and fragile subprocess wrappers.

**@ouim/agentkit** fixes that.

It’s a lightweight **host-side TypeScript SDK** that gives you one clean, stable API over both `codex` CLI and the Claude Agent runtime.

### What you actually get

- **Shared provider API** — `createAgent({ provider: 'codex' | 'claude' })` and you’re done. Same calls, same patterns.
- **Proper session lifecycle** — `openSession`, `resumeSession` (with a clean structured handle), `session(name)` convenience cache, and explicit close. No more guessing thread IDs or raw handles.
- **Discovery that works** — inventory, models, skills (Codex-backed today, Claude coming). Probe cheap or deep, no more manual `which codex` hacks.
- **Codex compatibility layer** — drop-in replacement for existing `createCodex` / `CodexClient` code. Zero migration pain for current users.
- **Escape hatches** when you need raw power — `asCodex()` or `asClaude()` still there.
- Explicit, predictable resource management. No surprise leaks or zombie runtimes.

Install once:

```bash
npm install @ouim/agentkit
```

Then:

```ts
const agent = await createAgent({ provider: 'codex', defaults: { cwd: process.cwd() } })
const session = await agent.session('my-project') // cached convenience
const result = await session.run('Summarize this repo and list open issues')
console.log(result.handle) // resume anywhere, anytime
```

You keep the full power of the underlying runtimes while getting rid of the fragmentation tax.

No more chasing changelogs.  
No more provider-specific if/else hell.  
No more brittle stdout parsers in production scripts.

If you’re tired of maintaining separate adapters for Codex and Claude just to keep your agent tooling alive — this is the thin, opinionated layer you’ve been waiting for.

**@ouim/agentkit** — one API. Two (soon more) agents. Zero drama.

Check the examples folder or just `npm run example:agent:codex` to feel the difference.

Built for people who actually ship on these tools.

---

Short version for tweets / README hero:

> One clean TypeScript API for Codex + Claude local agents.  
> Proper sessions, resume handles, discovery, and a stable compatibility layer.  
> Stop fighting SDK drift. Start building.
