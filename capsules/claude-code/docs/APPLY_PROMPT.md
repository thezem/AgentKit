Integrate the Claude Code capsule from AgentKit into this repo.

1. Inspect the repo: module system, Node version (>= 22.6), process lifecycle.
2. Read `capsules/claude-code/docs/CAPSULE.md` and `capsules/shared/contract.ts`.
3. Copy `capsules/shared/` + `capsules/claude-code/`. Install `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sdk`.
4. Import only `capsules/claude-code/index.ts`. Create one client, open sessions per conversation, render events, answer `permission_requested`.
5. Pass extra SDK options through `sdkOptions`, never by editing `internals/`.
6. Verify one turn, one permission round-trip and one resume against the real CLI; report what you could not verify.
