# @ouim/agentkit

One layer over the coding agents you're **already signed in to**: Claude Code, Codex and OpenCode. No API keys. Same sessions, events, permissions, modes, interrupt, resume and rewind for all three.

Build a paseo / t3code-style harness by writing UI, not provider glue.

```bash
npm install @ouim/agentkit
npm run doctor            # what's installed + signed in
```

```ts
import { createAgentKit } from '@ouim/agentkit'

const kit = createAgentKit()
const session = await kit.session({ provider: 'codex', cwd: process.cwd(), access: 'auto-edit' })

session.on((event) => {
  if (event.type === 'timeline' && event.item.type === 'assistant_message') process.stdout.write(event.item.text)
  if (event.type === 'permission_requested') session.respond(event.request.id, 'allow')
})

const result = await session.run('Add a --verbose flag to the CLI')
console.log(result.status, session.handle)   // handle = JSON you can resume from anywhere
await kit.shutdown()
```

Swap `'codex'` for `'claude'` or `'opencode'`. Nothing else changes.

## A whole harness backend in one file

[`examples/harness-server.ts`](examples/harness-server.ts) is ~100 lines: REST + SSE for sessions, streaming, approvals, steer, interrupt, mode/model/thinking switches, rewind and resume across every provider.

```bash
npm run harness
curl -s -XPOST localhost:4317/sessions -d '{"provider":"claude","cwd":"/tmp","access":"supervised"}'
curl -N localhost:4317/sessions/<id>/events
```

## Layout

| Path | What |
| --- | --- |
| [`src/`](src) | **AgentKit**: `createAgentKit`, `AgentSession`, access levels, permission policies, transcript reducer, errors |
| [`capsules/shared/contract.ts`](capsules/shared/contract.ts) | The provider contract every capsule implements |
| [`capsules/claude-code/`](capsules/claude-code) | Claude Code via `@anthropic-ai/claude-agent-sdk` |
| [`capsules/codex/`](capsules/codex) | Codex via `codex app-server` JSON-RPC (zero deps) |
| [`capsules/opencode/`](capsules/opencode) | OpenCode v2 via `opencode serve` + `@opencode/client` |
| [`capsules/mock/`](capsules/mock) | Deterministic fake provider for UI work and CI |
| [`test/e2e/conformance.ts`](test/e2e/conformance.ts) | Same 11-step scenario against every provider |
| [`examples/`](examples) | quickstart, doctor, harness server |

Each capsule works without AgentKit (`import { createCodexClient } from '@ouim/agentkit/capsules/codex'`) and ships `docs/CAPSULE.md`, `SOURCE_NOTES.md`, `VERIFY.md`, `APPLY_PROMPT.md`.

## Primitives

| | Claude Code | Codex | OpenCode | Mock |
| --- | :-: | :-: | :-: | :-: |
| streaming text + reasoning | ✓ | ✓ | ✓ | ✓ |
| typed tool calls (shell/read/edit/write/search/fetch/mcp/sub_agent/todo) | ✓ | ✓ | ✓ | ✓ |
| permissions (allow once / always / deny) | ✓ | ✓ | ✓ | ✓ |
| structured questions to the user | ✓ | ✓ | ✓ | ✓ |
| interrupt | ✓ | ✓ | ✓ | ✓ |
| steer a running turn | ✓ | ✓ | ✓ | ✓ |
| prompt queue (`send`) | ✓ | ✓ | ✓ | ✓ |
| mode / model / thinking switch | ✓ | ✓ | ✓ | ✓ |
| provider-neutral `access` levels | ✓ | ✓ | ✓ (via policy) | ✓ |
| MCP servers | ✓ | ✓ | ✓ | – |
| system prompt append | ✓ | ✓ | ✓ | ✓ |
| images in prompts | ✓ | ✓ | ✓ | ✓ |
| structured output (`outputSchema`) | ✓ | ✓ | – | ✓ |
| resume from handle (cross-process) | ✓ | ✓ | ✓ | ✓ |
| history replay | ✓ | ✓ | ✓ | ✓ |
| list native sessions | ✓ | ✓ | ✓ | ✓ |
| rewind conversation | ✓ | ✓ | ✓ | ✓ |
| rewind files | ✓ | – | ✓ (with conversation) | – |
| slash commands / skills | ✓ | – | ✓ | ✓ |
| archive | – | ✓ | – | ✓ |

**Live-verified** on Claude Code 2.1.302, codex-cli 0.162.1 and OpenCode 2.0.26: everything in the conformance and extras E2Es: streaming, typed tools, permissions, interrupt, steer, queue, mode switch, system prompt, structured output, resume, history, listing, conversation rewind, slash commands ([artifacts](test/e2e/artifacts)). **Implemented, not yet E2E-proven:** images, MCP injection, structured questions, file rewind, archive.

Unsupported calls throw `UnsupportedCapabilityError` before touching the provider. Check `session.capabilities` to hide the control.

## The pieces you build a UI from

- **`session.transcript`**: live projection (items, status, pending permissions, usage). Or run `reduceTranscript(state, event)` yourself in any store.
- **`session.on(fn)` / `for await (const e of session.stream())`**: one event union for every provider.
- **`access: 'plan' | 'supervised' | 'auto-edit' | 'full-access'`**: mapped to each provider's native mode. Use `mode` for the native id.
- **`onPermission` + `policies`**: `readOnly()`, `acceptEdits()`, `allow('read','edit')`, `firstOf(...)`. Return `undefined` to leave a request for your UI.
- **`send()`** queues, **`steer()`** injects mid-turn (falls back to queue), **`run()`** is one turn.
- **`session.handle`** → `kit.resume(handle)`; **`kit.listSessions()`** merges all providers' native sessions.
- **`session.native`**: the raw capsule session when you need something provider-specific.

## Checks

```bash
npm run verify            # typecheck + mock conformance (free, no CLIs)
npm run e2e -- claude     # real conformance against your signed-in CLI
npm run e2e               # claude + codex + opencode
```

Artifacts land in `test/e2e/artifacts/<provider>.json`. Failure modes covered: [`test/e2e/FAILURE_MODES.md`](test/e2e/FAILURE_MODES.md).

Requirements: Node ≥ 22.6, plus whichever CLIs you use: `claude`, `codex` (≥ 0.156), `opencode` (v2).

Credits: the capsule contract and protocol handling follow [Paseo](https://github.com/getpaseo/paseo) (Apache-2.0). See [NOTICE](NOTICE).
