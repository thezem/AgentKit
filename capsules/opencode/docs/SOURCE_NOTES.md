# Source notes (OpenCode)

- Inspected: paseo `providers/opencode/v2/*` (the OpenCode 2.x path, ~2k lines) and `@opencode/client@2.0.26` generated types. Paseo's v1 adapter (`opencode-agent.ts`, 5.5k lines, @opencode-ai/sdk) was skipped because the installed CLI is v2.
- Preserved: loopback + `OPENCODE_PASSWORD` basic auth; "server listening on" readiness; event stream plus snapshot reconciliation; per-part suffix diffing for text; execution-event turn lifecycle with durable-log recovery; dedicated server for MCP.
- Rewritten: runtime is a simple ref-counted lease; turns, permissions and usage are merged into one session class.
- Excluded: paseo bridge plugin (paseo tools inside OpenCode), structured-output plugin, child-session (subagent) presentation, managed-process registry.
- Open: structured output needs a plugin (not shipped). Subagent child sessions are not surfaced.
