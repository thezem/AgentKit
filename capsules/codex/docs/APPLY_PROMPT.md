Integrate the Codex capsule from AgentKit into this repo.

1. Inspect this repo first: language, module system, where vendored code lives, how processes are shut down.
2. Read `capsules/codex/docs/CAPSULE.md`, `capsules/shared/contract.ts`, then `capsules/codex/index.ts`.
3. Copy `capsules/shared/` and `capsules/codex/` together (codex imports `../shared`). Keep `index.ts` as the only import.
4. Ensure Node >= 22.6. No npm dependencies are required. Ensure `codex` is installed and signed in.
5. Wire: create one client with `createCodexClient()`, open sessions with `createSession({ cwd })`, subscribe to events, call `shutdown()` on process exit.
6. Do not edit `internals/`; extend via `providerOptions` (passed to Codex `config`) or `args`.
7. Verify with a real turn and a permission round-trip; report anything you could not verify.
