# Changelog

## 0.2.0 — rebuild

Breaking rewrite.

- New architecture: per-provider **capsules** behind one contract (`capsules/shared/contract.ts`), adapted from Paseo's provider design (Apache-2.0).
- New providers: **OpenCode v2** capsule, **mock** capsule.
- Claude Code and Codex capsules rewritten (Claude: long-lived streaming query; Codex: direct app-server JSON-RPC, zero deps).
- Primitives now uniform across providers: steer, prompt queue, rewind (conversation/files), history replay, native session listing, structured output, MCP injection, system prompt append, slash commands, typed tool details, structured questions, provider-neutral access levels, permission policies, transcript reducer.
- `createAgentKit()` replaces `createAgent()` / `createSession()`. 0.1 handles are not compatible.
- Conformance E2E against real signed-in CLIs with JSON artifacts.
