# Source notes (Claude Code)

- Inspected: paseo `providers/claude/agent.ts` (6.8k lines), `query.ts`, `rewind.ts`, `tool-call-mapper.ts`, and the installed SDK's `sdk.d.ts` (0.3.303) as ground truth.
- Preserved: preset `claude_code` system prompt with `append`; `settingSources` user/project/local; `allowDangerouslySkipPermissions` so bypass can be switched on mid-session; `enableFileCheckpointing` for file rewind; `includePartialMessages` for deltas; the five permission modes.
- Rewritten: a single input queue instead of paseo's query restarts; rewind uses the SDK's native `forkSession` (newer than paseo's approach); much smaller event mapping.
- Excluded: subagent sidechain panes, task notifications, workflow replay, paseo voice/tool catalog, Windows .cmd spawn shims, fast mode / ultracode settings.
- Open: subagent (Task) inner events are dropped (parent_tool_use_id != null); the Task tool call itself is reported.
