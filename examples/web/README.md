# AgentKit example UI

Chat with your locally signed-in Claude Code, Codex and OpenCode through one interface. Everything provider-specific lives in AgentKit; this app is ~900 lines of React plus a ~250-line backend.

```bash
cd AgentKit && npm install
cd examples/web && npm install
npm run api      # terminal 1: http://127.0.0.1:4417/api
npm run dev      # terminal 2: http://127.0.0.1:5317
```

Set `AGENTKIT_CWD=/path/to/project` before `npm run api` to change the default folder.

| File | What |
| --- | --- |
| [`server.ts`](server.ts) | HTTP + SSE over `createAgentKit({ store })`; everything lives in `~/.agentkit-ui/agentkit.db` (an old `conversations.json` is imported once) |
| [`src/components/inbox.tsx`](src/components/inbox.tsx) | Queued prompts above the composer, each withdrawable |
| [`src/components/skill-menu.tsx`](src/components/skill-menu.tsx), [`skill-chip.tsx`](src/components/skill-chip.tsx) | `/` opens the skill picker (`kit.searchSkills`); picking writes `$name`; sent messages show skills as chips (`splitSkillTags`) |
| [`src/lib/use-conversation.ts`](src/lib/use-conversation.ts) | SSE stream folded through AgentKit's own `reduceTranscript` |
| [`src/components/tool-call.tsx`](src/components/tool-call.tsx) | Renders typed tool calls: shell, diff, read/write, search, todo, MCP |
| [`src/components/permission-card.tsx`](src/components/permission-card.tsx) | Permission + question round-trips (the only accented surface) |
| [`src/components/pickers.tsx`](src/components/pickers.tsx) | Provider / model / effort / mode, all from `kit.catalog()` |

Works: streaming, reasoning, typed tools, permissions, questions, interrupt, steer while running, model/effort/mode switches, rewind and fork (hover a message), fork/compact (header), visible queue with withdraw, idempotent sends (`requestId`), crash-safe history (kill -9 the API mid-reply: what you saw stays, the turn shows as interrupted, nothing is re-sent), `/` skill picker with chips, light/dark.
