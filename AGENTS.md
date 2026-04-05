# AGENTS.md

## Project

- Package name: `@ouim/codexkit`
- Purpose: high-level Node wrapper around `codex app-server`
- Primary auth preference: ChatGPT login, not API key first
- Supported auth modes:
  - app-server ChatGPT browser login
  - CLI device auth via `codex login --device-auth`

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

- Chosen package identity: `@ouim/codexkit`
- This was preferred over `codex-client` because it matches the `ouim/*` naming style better, especially next to `@ouim/logto-authkit`.
