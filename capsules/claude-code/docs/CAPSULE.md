# Claude Code capsule

Drives your locally signed-in Claude Code through `@anthropic-ai/claude-agent-sdk`. One long-lived `query()` per session fed by a streaming input queue, so turns, steering, mode/model switches and interrupts all hit the same live process. Loads your `~/.claude` settings, CLAUDE.md, skills, hooks and MCP config exactly like the CLI.

```ts
import { createClaudeCodeClient } from './capsules/claude-code/index.ts'

const claude = createClaudeCodeClient()                 // uses `claude` on PATH
const session = await claude.createSession({ cwd: process.cwd(), model: 'sonnet', modeId: 'acceptEdits' })
session.subscribe((event) => console.log(event.type))
await session.run('Add a test for utils.ts')
await claude.shutdown()
```

## Public API
| Export | What |
| --- | --- |
| `createClaudeCodeClient(config?)` | `ProviderClient` |
| `CLAUDE_MODES` | `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions` |
| `CLAUDE_CAPABILITIES` | Everything except `archive` |

Config: `binary` (path, or `false` to use the SDK-bundled CLI), `settingSources`, `sdkOptions` (raw SDK `Options`, merged into every query).

## How primitives map
| Primitive | Claude SDK |
| --- | --- |
| turn | push `SDKUserMessage` (with our uuid) into the input stream; ends at `result` |
| steer | push with `priority: 'now'` |
| interrupt | `query.interrupt()` |
| modes / model / thinking | `setPermissionMode`, `setModel`, `applyFlagSettings({ effortLevel })` |
| permissions | `canUseTool`; `always` adds a session allow rule |
| questions | `AskUserQuestion` tool surfaced as `kind: 'question'`; answers go back in `updatedInput.answers` |
| plan approval | `ExitPlanMode` surfaced as `kind: 'plan'` |
| structured output | restarts the query with `outputFormat: json_schema` (resumes same session) |
| history / list | `getSessionMessages`, `listSessions` |
| rewind conversation | `forkSession({ upToMessageId })` at the message before the target; id changes |
| rewind files | `query.rewindFiles(messageId)` (file checkpointing is on) |

## Host responsibilities
- `npm i @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk`.
- Be signed in to Claude Code. Call `shutdown()` on exit.
- In `bypassPermissions` the SDK warns that `canUseTool` is shadowed; expected.

## Internals (private)
`internals/session.ts` (query lifecycle, permissions, rewind), `internals/mapping.ts` (SDK messages → timeline).
