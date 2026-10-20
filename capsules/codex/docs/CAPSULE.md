# Codex capsule

Drives your locally signed-in `codex` CLI through `codex app-server` (JSON-RPC 2.0 over stdio). No API key, no SDK dependency: it speaks the protocol directly.

```ts
import { createCodexClient } from './capsules/codex/index.ts'

const codex = createCodexClient()                       // finds `codex` on PATH
const session = await codex.createSession({ cwd: process.cwd(), modeId: 'auto', thinkingOptionId: 'low' })
session.subscribe((event) => console.log(event.type))
const result = await session.run('Summarize this repo in 3 bullets')
await session.close()
await codex.shutdown()
```

## Public API

| Export | What |
| --- | --- |
| `createCodexClient(config?)` | Returns a `ProviderClient` (see `../shared/contract.ts`) |
| `CODEX_MODES` | `plan` (read-only + Codex plan collaboration mode; the only mode with structured questions), `read-only`, `auto` (default), `full-access` |
| `CODEX_CAPABILITIES` | What this capsule supports |

Config: `binary`, `args` (inserted before `app-server`, e.g. `['-c','model_reasoning_summary=detailed']`), `env` (e.g. `CODEX_HOME`), `requestTimeoutMs`.

## How primitives map

| Primitive | Codex wire |
| --- | --- |
| create / resume | `thread/start`, `thread/resume` |
| turn / steer / interrupt | `turn/start`, `turn/steer`, `turn/interrupt` |
| modes | per-turn `approvalPolicy` + `sandboxPolicy` presets |
| model / thinking | per-turn `model`, `effort` |
| permissions | server requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` |
| questions | `item/tool/requestUserInput` |
| MCP | `config.mcp_servers` on thread start |
| structured output | per-turn `outputSchema` |
| history | `thread/read { includeTurns }` |
| rewind (conversation) | `thread/fork { lastTurnId }` before the target turn; session id changes |
| list / archive | `thread/list`, `thread/archive` |

Not supported: file rewind, slash commands (Codex app-server exposes skills differently; not wired yet).

## Host responsibilities
- Install `codex` and run `codex login`.
- Call `shutdown()` on exit (kills app-server children).

## Capsule-owned internals
`internals/rpc.ts` (transport), `internals/items.ts` (item → timeline), `internals/session.ts`. Treat as private.
