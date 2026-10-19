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

**Building an app on AgentKit?** Start with [Build your consumer app](docs/BUILD_YOUR_CONSUMER_APP.md): pickers, sending, rendering, permissions, persistence, skills, and a checklist for a good harness.

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
| fast mode (per model: `supportsFastMode`) | ✓ | ✓ (priority tier) | – | ✓ |
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
| exact context window (`session.contextWindow()`) | ✓ (`/context` accounting) | ✓ (after first turn) | ✓ (model registry) | ✓ |
| skills: discover + search + `$skill` invoke | ✓ | ✓ (native skill item) | ✓ | – |
| fork (new branch, original untouched) | ✓ | ✓ | ✓ | ✓ |
| compact context | ✓ (`/compact`) | ✓ (`thread/compact`) | ✓ | ✓ |
| durable store, idempotent submit, inbox | ✓ | ✓ | ✓ | ✓ (AgentKit-level, every provider) |

**Live-verified** on Claude Code 2.1.302, codex-cli 0.162.1 and OpenCode 2.0.26: everything in the conformance and extras E2Es: streaming, typed tools, permissions, interrupt, steer, queue, mode switch, fast mode, system prompt, structured output, resume, history, listing, conversation rewind, slash commands ([artifacts](test/e2e/artifacts)). **Implemented, not yet E2E-proven:** images, MCP injection, structured questions, file rewind, archive.

Unsupported calls throw `UnsupportedCapabilityError` before touching the provider. Check `session.capabilities` to hide the control.

## The pieces you build a UI from

- **`session.transcript`**: live projection (items, status, pending permissions, usage). Or run `reduceTranscript(state, event)` yourself in any store.
- **`session.on(fn)` / `for await (const e of session.stream())`**: one event union for every provider.
- **`access: 'plan' | 'supervised' | 'auto-edit' | 'full-access'`**: mapped to each provider's native mode. Use `mode` for the native id.
- **`onPermission` + `policies`**: `readOnly()`, `acceptEdits()`, `allow('read','edit')`, `firstOf(...)`. Return `undefined` to leave a request for your UI.
- **`submit(prompt, { whenBusy, requestId })`** is the one way in: idle runs now; busy does `'queue'` (visible in `transcript.inbox`, `withdraw(id)`-able), `'steer'` (into the live turn, falls back to the inbox) or `'reject'` (`SESSION_BUSY`). `run()` / `send()` / `steer()` are shorthands.
- **`session.fork({ beforeMessageId })`** → a new session; the original is untouched. **`session.compact(instructions?)`** → native compaction.
- **`session.handle`** → `kit.resume(handle)`; **`kit.listSessions()`** merges all providers' native sessions.
- **`session.native`**: the raw capsule session when you need something provider-specific.

## Skills

One list of every installed skill (`.claude`, `.codex`, `.agents`, OpenCode, plugins, project + user), deduped, for your `/` menu:

```ts
const all = await kit.skills({ cwd })                 // [{ name, description, path, scope, sources, visibleTo, variants? }]
const hits = await kit.searchSkills('capsule', { cwd }) // name exact > prefix > word > substring > fuzzy > description
```

When the user **picks** a skill from your menu, write `$name` into the message. That's the whole contract:

```ts
await session.submit('Look at $repo-capsule and pull out the auth flow')
```

AgentKit replaces each `$name` that is a real skill **in place** and leaves every other character as typed (`$PATH`, `$5`, `a$b`, unknown `$foo` untouched):
- Claude / OpenCode get `<skill-invoked name="repo-capsule" path="…/SKILL.md">read it and follow it</skill-invoked>` where the token was. Inlined (SKILL.md body inside the tag) when the session is in plan mode, or with `{ skills: 'inline' }`.
- Codex keeps `$repo-capsule` in the text and gets its native `{ type: 'skill', name, path }` item (or the tag if Codex doesn't load that skill).
- `{ skills: false }` turns it off. `splitSkillTags(text)` turns a sent message back into text + chips for rendering history.

`visibleTo` is checked against each CLI's own list (Claude/OpenCode `commands()`, Codex `skills/list`, disabled ones excluded). `variants` shows copies of the same skill in other folders; `sameContent: false` means they drifted.

## Durable sessions

Inspired by [pi durable](https://github.com/earendil-works/pi/tree/main/packages/durable). One option, no new deps (`node:sqlite`):

```ts
const kit = createAgentKit({ store: '~/.myapp/agentkit.db' })
const session = await kit.session({ provider: 'codex', cwd, key: 'chat-42' })
const sub = await session.submit('fix the failing test', { requestId: clientMsgId })

// after a crash / restart / in another process:
const again = await kit.restore('chat-42')       // native resume + saved transcript
await kit.submission(clientMsgId)?.wait()        // { status: 'completed' | 'interrupted' | ... }
```

- **Commit before show.** Every event is written before any listener sees it. Kill -9 mid-reply and the restored transcript has at least everything the user saw.
- **Intent / outcome.** A submission is saved as `running` before the provider gets the prompt, and its outcome after. Work cut off by a dead process comes back as `interrupted` with a notice in the transcript (`kit.recovered` lists it). **It is never re-sent automatically**: re-running a turn that may have edited files is the user's call.
- **Idempotent.** Same `requestId` → same submission, in this process or after a restart. Retries and double-clicks run once.
- Single writer per session: the store marks rows with the owning pid and only recovers rows whose process is gone.

## Checks

```bash
npm run verify            # typecheck + mock conformance + durable (free, no CLIs)
npm run e2e -- claude     # real conformance against your signed-in CLI
npm run e2e               # claude + codex + opencode
npm run e2e:durable -- mock   # kill -9 mid-turn, idempotency, inbox, fork, compact
npm run e2e:skills        # discovery vs each CLI's own list, search, $skill expansion, real invocation
```

Artifacts land in `test/e2e/artifacts/<provider>.json`. Failure modes covered: [`test/e2e/FAILURE_MODES.md`](test/e2e/FAILURE_MODES.md).

Requirements: Node ≥ 22.6, plus whichever CLIs you use: `claude`, `codex` (≥ 0.156), `opencode` (v2).

Credits: the capsule contract and protocol handling follow [Paseo](https://github.com/getpaseo/paseo) (Apache-2.0). See [NOTICE](NOTICE).
