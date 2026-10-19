# Source notes (Codex)

- Inspected: getpaseo/paseo @ main (shallow clone, Oct 2026), `packages/server/src/server/agent/providers/codex-app-server-agent.ts` (7.6k lines), `codex/app-server-transport.ts`, `codex/rewind.ts`, `codex/tool-call-mapper.ts`.
- Ground truth for wire types: `codex app-server generate-ts` against codex-cli 0.162.1 (not paseo's hand-written schemas).
- Preserved conceptually: one app-server per session; `initialize` with `experimentalApi`; mode presets as approvalPolicy+sandbox pairs; MCP via `config.mcp_servers`; rewind by forking because `thread/rollback` was removed in 0.156.
- Rewritten: transport (~150 lines vs paseo's), item mapping, permission plumbing. No zod, no pino.
- Excluded: paseo goals (`thread/goal/*`), auto-review reviewer mode, collaboration modes, custom provider import, speed tiers, paseo tool catalog, voice.
- Open: Codex `plan` collaboration mode not exposed; `item/permissions/requestApproval` and MCP elicitations are declined.
