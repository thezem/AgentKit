Integrate the OpenCode capsule from AgentKit into this repo.

1. Inspect the repo and confirm `opencode --version` is 2.x.
2. Read `capsules/opencode/docs/CAPSULE.md` and `capsules/shared/contract.ts`.
3. Copy `capsules/shared/` + `capsules/opencode/`; install `@opencode/client` at the same version as the CLI.
4. Import only `capsules/opencode/index.ts`; call `shutdown()` on exit so `opencode serve` children die.
5. Use `providerOptions` for native permission rules instead of editing internals.
6. Verify a turn, a permission round-trip and resume; report anything unverified.
