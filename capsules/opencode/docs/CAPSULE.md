# OpenCode capsule

Drives your local OpenCode v2 by spawning `opencode serve` on 127.0.0.1 with a random password and talking to it through `@opencode/client`. One shared server per client (ref-counted); sessions with MCP servers get a dedicated server because OpenCode MCP is location-scoped.

```ts
import { createOpenCodeClient } from './capsules/opencode/index.ts'

const opencode = createOpenCodeClient()
const session = await opencode.createSession({ cwd: process.cwd(), model: 'anthropic/claude-sonnet-5' })
await session.run('Explain src/index.ts')
await opencode.shutdown()
```

## Public API
| Export | What |
| --- | --- |
| `createOpenCodeClient(config?)` | `ProviderClient` |
| `OPENCODE_CAPABILITIES` | No structured output, no archive; file rewind only with conversation |

Config: `binary`, `args`, `env` (e.g. `OPENCODE_CONFIG_CONTENT`), `defaultMode` (agent id, default `build`).

Models are `provider/model` ids. Modes are OpenCode agents (`build`, `plan`, custom agents). Thinking options are model variants.

## How primitives map
| Primitive | OpenCode v2 |
| --- | --- |
| turn | `session.prompt`; terminal from `session.execution.*` events, with a 5s durable-log poll as safety net |
| text / reasoning | `session.text.delta` / `session.reasoning.delta` |
| tools | message snapshots, diffed per part |
| steer | `session.prompt { delivery: 'steer' }` |
| interrupt | `session.interrupt` |
| permissions / questions | `permission.list` + `permission.reply`; forms via `session.form.*` |
| modes / model / variant | `switchAgent`, `switchModel` |
| system prompt | `session.instructions.entry.put` |
| MCP | `mcp.add` on a dedicated server |
| rewind | `session.revert.stage` + `commit` (`files: true` for scope `both`) |
| native rules | `providerOptions` spread into `session.create`, e.g. `{ permissions: [{ action: 'edit', resource: '*', effect: 'ask' }] }` |

Note: OpenCode allows edits by default. AgentKit's `access: 'supervised'` maps to `build`, so pass ask-rules via `providerOptions` if you need prompts.
