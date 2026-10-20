# Build your consumer app

How to build a good agent harness (a chat UI, an IDE panel, an orchestrator, a bot) on top of AgentKit. One API drives Claude Code, Codex and OpenCode through the user's own local sign-ins.

Every snippet here is real API. The working reference is the example UI: [`examples/web/server.ts`](../examples/web/server.ts) (~300 lines of HTTP + SSE) and [`examples/web/src`](../examples/web/src) (React).

> **Maintained doc.** Every new primitive gets a section here in the same change that ships it. See [Keeping this doc current](#keeping-this-doc-current).

---

## 0. The shape of a harness

```
your UI  ──HTTP/WS/IPC──►  your backend  ──►  AgentKit  ──►  capsules  ──►  claude / codex / opencode CLIs
   ▲                            │                │
   └──── events (SSE) ◄─────────┘   store (sqlite): events, sessions, submissions
```

- **AgentKit lives in your backend** (Node ≥ 22.6). It spawns CLIs, so it can't run in a browser.
- **Your UI is a projection of events.** Fold them with `reduceTranscript` (pure, browser-safe) and render the result.
- **The store makes it durable.** Give it a file and you get crash-safe history, idempotent sends and reattach for free.

---

## 1. Setup

```bash
npm i @ouim/agentkit              # or point at this repo
npm run doctor                    # (in this repo) which CLIs are installed + signed in
```

The user needs whichever CLIs they want, signed in: `claude`, `codex` (≥ 0.156), `opencode` (v2). No API keys.

```ts
import { createAgentKit } from '@ouim/agentkit'

const kit = createAgentKit({
  store: `${os.homedir()}/.myapp/agentkit.db`,   // durable layer (node:sqlite, no deps)
  // claude: false,                               // disable a provider
  // mock: true,                                  // free fake provider for tests/demos
})

if (kit.recovered.length) log('turns cut off by the last crash:', kit.recovered)
process.on('SIGTERM', async () => { await kit.shutdown(); process.exit(0) })
```

**Rules:** one kit per process. One process writes a given store file (the store records the owner pid; a second live writer is not supported). Always `shutdown()` on exit so CLI children die with you.

---

## 2. The "new conversation" screen

Everything a picker needs comes from two calls. Never hardcode model lists.

```ts
const providers = await kit.providers()               // availability cached 60s; { force: true } re-probes
// [{ provider: 'codex', label: 'Codex', available: true, capabilities: {...} }, ...]
kit.capabilities('codex')                              // sync, no CLI probe: use this when you only need capabilities

const catalog = await kit.catalog('codex', { cwd })   // cached 5 min
// catalog.models[i]: { id, label, isDefault, thinkingOptions, supportsFastMode, contextWindowMaxTokens? }
// catalog.modes:     native modes; catalog.defaultModeId
```

| Control | Source | Hide/disable when |
| --- | --- | --- |
| Provider | `kit.providers()` | `!available` |
| Model | `catalog.models` | `!capabilities.modelSwitch` (mid-conversation) |
| Effort / thinking | `model.thinkingOptions` | the model has none |
| Fast | `model.supportsFastMode` | `!capabilities.fastMode` or model lacks it |
| Access | `'plan' \| 'supervised' \| 'auto-edit' \| 'full-access'` | – (mapped per provider) |
| Folder | your input; pass as `cwd` | – |

**OpenCode lists every model of every connected backend** (hundreds with a gateway like Vercel). Each OpenCode model has `source` = its connection (`'opencode-go'` = the Go subscription, `'opencode'` = Zen, `'vercel'`, …). Narrow the picker with:

```ts
await kit.catalog('opencode', { cwd, sources: ['opencode-go'] })   // only the Go plan's models
```

OpenCode exposes no plan entitlements, so this filters by connection, not by what the account may call. If nothing matches it returns the full list. If you filter, also pass the filtered default as `model` when opening the session; otherwise OpenCode uses its own default, which may be outside your filter.

**Prefer `access` over native modes** in your UI. AgentKit maps it per provider (`ACCESS_MODE_MAP`); where a provider has no native unattended mode (OpenCode), full-access is enforced with an allow-all policy. Offer native `mode` only as an advanced option.

---

## 3. Open a session

```ts
const session = await kit.session({
  provider: 'codex',
  cwd: '/path/to/project',
  key: conversationId,          // YOUR stable id; survives rewinds/restarts (native ids change)
  meta: { title: 'New chat' },  // your app data, saved in the store next to the session
  model, thinking, fast,        // from the pickers
  access: 'supervised',
  systemPrompt: '…',            // appended to the provider's own
  onPermission: undefined,      // see §6
})
```

- `session.key` is your id. `session.id` is the native id (Claude session / Codex thread / OpenCode session) and **can change** after rewind.
- Open lazily: create the conversation row in your app first, open the AgentKit session on the first message. The example does exactly this (`sessionFor()` in [`server.ts`](../examples/web/server.ts)).
- After a restart: `await kit.restore(key)` gives you a live session with its saved transcript. Use it whenever there's no live session for a stored key.
- **A thread stays on the provider it started with.** There is no "switch this conversation to Codex": each provider owns its own history, tools and context, and AgentKit doesn't fake a handoff. Model, effort, fast and access can change mid-thread (§7); the provider can't. Want another provider? Start a new thread (seed it with `kit.complete()`'s summary of the old one if you like). Hide the provider picker once a thread has messages.

---

## 4. Sending messages

There is one way in: `submit`.

```ts
const sub = await session.submit(text, {
  requestId: clientMessageId,   // generate on the CLIENT; makes retries/double-clicks run once
  whenBusy: 'queue',            // 'queue' | 'steer' | 'reject'
})
sub.id; sub.status              // 'queued' | 'running' | 'steered' | 'completed' | 'failed' | 'canceled' | 'withdrawn' | 'interrupted'
await sub.result                // RunResult { status, finalText, usage, error? }
await sub.wait()                // the final SubmissionRecord
```

| `whenBusy` | Idle | Busy |
| --- | --- | --- |
| `'queue'` (default) | runs now | goes to the visible inbox, runs after |
| `'steer'` | runs now | injected into the running turn; falls back to the inbox if the provider can't |
| `'reject'` | runs now | throws `AgentKitError` `SESSION_BUSY` |

**Good harness behaviour**
- Let the user keep typing while a turn runs. Composer while running: steer if `capabilities.steer`, otherwise queue.
- **Render the inbox.** `transcript.inbox` lists waiting prompts; give each an ✕ that calls `session.withdraw(id)`. Never queue silently.
- Always send a `requestId` from the client. If the HTTP call times out and the client retries, the turn still runs once.
- Reattach from anywhere: `kit.submission(requestId)?.wait()` works across restarts and across processes sharing the store.

Steer is non-disruptive on every provider: the running step (e.g. a shell command) finishes, and the message lands at the next safe point in the same turn. Claude does this via `priority: 'next'` (AgentKit's default); pass `createAgentKit({ claude: { steerPriority: 'now' } })` to cut the current step short instead. Codex (`turn/steer`) and OpenCode (`delivery: 'steer'`) behave this way natively and have no knob.

Shorthands: `run()` (= submit + reject when busy + await result), `send()` (= queue + await result), `steer()`.

### Attachments

```ts
await session.submit('Summarise this and fix the layout in the screenshot', {
  attachments: [
    { name: 'spec.pdf', data: base64 },                     // or bytes (Uint8Array)
    { name: 'screen.png', path: '/tmp/upload-123.png' },    // or copy from a path
  ],
})
```

- AgentKit saves each file to `kit.attachmentsDir/<session key>/<submission id>/<name>` (default `attachments/` next to the store) and appends one `<attachments>` tag to the text the model receives. **What the user typed is not changed.**
- Images (png/jpeg/gif/webp ≤ 5 MB) also go as real image blocks where `capabilities.images`; the model sees them directly.
- Every session may read the attachments folder **without a permission prompt** (Claude gets it as `additionalDirectories`; Codex and OpenCode read outside the project freely, proven in `test/e2e/host.ts`).
- In the transcript, `user_message.text` is the typed text and `user_message.attachments` is `[{ name, path, mimeType, size }]`: render file chips from it. It survives restore and forks (the tag lives in the provider's own history too). Browser: `splitAttachments(text)` from `@ouim/agentkit/attachment-tags`.
- Names are sanitized (no `..`, no absolute paths); duplicates get `-2`, `-3`.

---

## 5. Rendering: events → transcript

Subscribe once per session and stream every event to the client. Fold them with the same reducer on both sides.

```ts
// backend
session.on((event) => sse.write(`data: ${JSON.stringify({ type: 'event', event })}\n\n`))
// on connect, send a snapshot first:
sse.write(`data: ${JSON.stringify({ type: 'snapshot', transcript: session.transcript })}\n\n`)

// browser
import { reduceTranscript, emptyTranscript } from '@ouim/agentkit/transcript'  // browser-safe subpath
let state = emptyTranscript()
onMessage((m) => (state = m.type === 'snapshot' ? m.transcript : reduceTranscript(state, m.event)))
```

(The example's [`use-conversation.ts`](../examples/web/src/lib/use-conversation.ts) does exactly this.)

**Long threads: page the snapshot.** A long Codex thread can be ~700 KB. Send the latest items first and fetch older ones on scroll:

```ts
// backend: snapshot = latest 100 items + all current state
const page = kit.transcriptPage(key, { limit: 100 })             // live session or the store
const older = kit.transcriptPage(key, { limit: 100, before: page.itemsOffset })

// browser
import { prependPage, reduceTranscript } from '@ouim/agentkit/transcript'
state = prependPage(state, older)          // when the user scrolls up; stop when itemsOffset === 0
state = reduceTranscript(state, event)     // live events keep working on a partial transcript
```

`transcript.itemsOffset` is the absolute index of `items[0]` (0 = complete). Live events only touch the newest items, so a partial transcript keeps reducing correctly.

`Transcript` gives you everything a chat view needs:

| Field | Use it for |
| --- | --- |
| `items` | the timeline (below) |
| `status` | `idle` · `running` · `waiting_permission` · `failed` — spinner, stop button, amber "needs you" state |
| `pendingPermissions` | approval cards (§6) |
| `inbox` | queued prompts with withdraw (§4) |
| `usage` | tokens, cost, `contextWindowUsedTokens` / `contextWindowMaxTokens` |
| `modeId`, `model`, `thinkingOptionId`, `fast` | keep pickers in sync with reality |
| `lastError` | error banner |
| `planUsage` | latest plan rate-limit numbers the provider pushed (Codex); see §7 |
| `itemsOffset` | > 0 when you hold a page, not the whole thread |

Timeline items (`items[i].type`):

| Type | Render as |
| --- | --- |
| `user_message` | user bubble; skill tags → chips (§9); `attachments` → file chips (§4) |
| `assistant_message` | markdown; streams in (deltas are already merged) |
| `reasoning` | collapsed "Thought" |
| `tool_call` | by `detail.type`: `shell` (command + output), `edit`/`write` (diff), `read`, `search`, `fetch`, `mcp`, `sub_agent`, `plan`, `todo`, `unknown` |
| `todo` | live plan/checklist |
| `compaction` | divider "context compacted" |
| `notice` | quiet line; `level: 'warning'` for interrupted turns |
| `error` | inline error |

Tool calls with the same `callId` are one call updating (`running` → `completed`/`failed`); the reducer already replaces them in place. Group consecutive tool calls into one quiet block so prose stays readable ([`thread.tsx`](../examples/web/src/components/thread.tsx)).

---

## 6. Permissions and questions

Two ways, combinable:

```ts
// 1) Policy: answer automatically. Return undefined to leave it for the UI.
import { policies } from '@ouim/agentkit'
kit.session({ ..., onPermission: policies.firstOf(policies.readOnly(), myHandler) })
// allowAll · denyAll · readOnly · acceptEdits · allow('read', 'edit') · firstOf(...)

// 2) UI: render transcript.pendingPermissions, then
await session.respond(request.id, { behavior: 'allow', actionId: 'once' })   // or 'always'
await session.respond(request.id, 'deny')
// questions (request.kind === 'question'):
await session.respond(request.id, { behavior: 'allow', answers: { [questionId]: 'option' } })
```

A request has `kind` (`tool` · `question` · `plan` · `other`), `title`, `detail` (typed like tool calls: show the diff/command), `actions` (the buttons the provider offers) and `questions`. Show the actual command or diff, not just the tool name. This is the one place that deserves an accent colour: it's the only time the agent is waiting on the user.

---

## 7. Controls during a conversation

```ts
await session.interrupt()                 // stop button; resolves when the turn is really over
await session.setAccess('auto-edit')      // or setMode(nativeId)
await session.setModel('gpt-6.1-sol')
await session.setThinking('high')
await session.setFast(true)
await session.info()                      // { model, modeId, thinkingOptionId, fast, ... } — read back, don't assume
await session.contextWindow()             // { usedTokens, maxTokens } — exact, from the provider
await session.commands()                  // provider slash commands (native)
```

**Capability guards.** Every optional primitive throws `UnsupportedCapabilityError` *before* touching the provider. Don't rely on the throw for UX: read `session.capabilities` (or `kit.providers()`) and hide/disable the control.

Context meter: `transcript.usage.contextWindowUsedTokens / contextWindowMaxTokens` updates every turn. Codex only reports the max after the first turn; Claude and OpenCode know it up front via `contextWindow()`.

**Plan usage meter** (how much of the subscription is left):

```ts
const usage = await kit.planUsage('claude')   // cached 60s; { force: true } re-reads
// { plan: 'pro', available: true, windows: [{ id: 'five_hour', label: '5-hour', usedPercent: 6, resetsAt: '2026-…Z' }, { id: 'seven_day', label: 'Weekly', … }] }
```

| Provider | Source | Notes |
| --- | --- | --- |
| Claude | the SDK's usage call (same as `/usage`) | marked experimental upstream; AgentKit normalizes it. `available: false` on API keys / cloud providers |
| Codex | `account/rateLimits/read` | also **pushes** updates during turns → `plan_usage` event / `transcript.planUsage` |
| OpenCode | – | `capabilities.planUsage` false → `UNSUPPORTED_CAPABILITY` |

**One-shot completions** (titles, summaries, commit messages):

```ts
const { text } = await kit.complete('claude', `Title this chat in 5 words:\n${firstMessage}`, { model: 'haiku' })
```

No session is left behind (nothing in `listSessions()` or the store). Claude runs with no tools at all; Codex runs an ephemeral read-only thread and OpenCode a throwaway `plan` session that is deleted after, with every permission ask denied (they can't switch tools off entirely, so a model may still read).

---

## 8. Persistence, restarts and crashes

With `store` set, you mostly don't write persistence code:

| You want | Call |
| --- | --- |
| list conversations | `kit.storedSessions()` → `{ key, provider, handle, meta, updatedAt }` |
| update your app data | `kit.store.updateSession(key, { meta: { title } })` |
| reopen after restart | `kit.restore(key)` (native resume + saved transcript) |
| transcript without opening | `kit.store.loadTranscript(key)` |
| delete | `await session.close(); kit.store.deleteSession(key)` |
| find a submission | `kit.submission(requestId)` |

What the store guarantees:
- **Commit before show.** Every event is written before any listener sees it. If the process dies mid-reply, the restored transcript has at least everything the user saw.
- **Never re-sends.** A turn cut off by a crash comes back with status `interrupted`, a warning notice in the transcript, and an entry in `kit.recovered`. Re-running it is the user's decision (it may have edited files). Show a "retry" button that submits the prompt again with a new `requestId`.

Without a store you still have `session.handle` (JSON) → `kit.resume(handle)` for native resume, and `kit.listSessions()` for the CLIs' own session lists.

---

## 9. Skills (`/` menu)

```ts
const skills = await kit.skills({ cwd })            // all installed, deduped (~1.5 s first call, cached 30 s)
const hits = await kit.searchSkills(query, { cwd }) // for the menu, as the user types
// Skill: { name, description, path, scope, sources, visibleTo, variants? }
```

**The contract:** when the user *picks* a skill from your menu, write `$name` into the message text. That's all.

```ts
await session.submit('Look at $repo-capsule and pull out the auth flow')
```

- AgentKit replaces each `$name` that is a real skill **in place**: Claude/OpenCode get a `<skill-invoked name path>` tag, Codex keeps `$name` plus its native skill item. Every other character is left as typed (`$PATH`, `$5`, `a$b`, unknown names).
- A `/name` the user typed by hand is just text. Only picking makes `$name`.
- Render sent messages with `splitSkillTags(text)` (and `findSkillTokens` for Codex's `$name`) to show chips. Import them from `@ouim/agentkit/skill-tags` in the browser.
- In the composer, keep the text plain and paint chips behind it (an overlay copying the textarea's computed font metrics — see [`composer.tsx`](../examples/web/src/components/composer.tsx); a rich-text editor works too).
- `{ skills: false }` on submit disables expansion; `{ skills: 'inline' }` puts the SKILL.md body in the tag (automatic in plan mode).

---

## 10. History operations

```ts
const items = await session.history()                          // replay from the provider (whole items)
await session.rewind(messageId, 'conversation' | 'files' | 'both')   // drop that message and after
const branch = await session.fork({ beforeMessageId, key })    // NEW session; original untouched
await session.compact('keep the API decisions')                // native compaction
```

- `messageId` comes from `user_message.messageId` in the transcript.
- Fork is the safe alternative to rewind: offer it on every user message ("branch from here"). It returns a live session with the hydrated transcript; give it its own `key`.
- After rewind the native id may change; `session.key` doesn't. Re-read `session.handle` if you keep handles yourself.
- Compact counts as busy (submits queue behind it). Show progress; it can take 10+ s on Codex.

---

## 10b. MCP servers (one hub for every provider)

Don't add MCP servers to each CLI. Turn on the hub and give the user one list:

```ts
const kit = createAgentKit({ store, hub: true })   // saved to mcp-servers.json next to the store
await kit.hub.add({ name: 'github', transport: { type: 'http', url, headers } })
await kit.hub.add({ name: 'files', transport: { type: 'stdio', ...splitCommand('npx -y my-mcp'), env } })
await kit.hub.update('github', { enabled: false })      // or { load: 'always' }
kit.hub.importFrom()                                     // copy servers from Claude/Codex/OpenCode configs
kit.hub.on((e) => /* status | removed | call */)
```

- The hub connects to each upstream once and serves each one on a loopback URL (`127.0.0.1:<port>/<secret>/<name>`). Every new session, on any provider, gets exactly the enabled servers.
- **Exclusive by default**: the CLI's own MCP config is switched off for that thread (Claude `strictMcpConfig`, Codex `config.toml` servers disabled, OpenCode other servers disconnected), so the hub list is the truth. Codex's built-in `codex_apps`/`cua_repl` can't be disabled. `hub: { exclusive: false }` merges instead.
- **Codex name collisions**: a hub server named like a server in `~/.codex/config.toml` is mounted as `<name>-hub` on Codex (the config.toml one is switched off), because Codex merges overrides onto same-named tables. Tool names on Codex then read `<name>-hub.<tool>`.
- **Host env for stdio servers**: they get the MCP SDK's safe default env plus their own `env`. `AGENTKIT_INHERIT_ENV=VAR1,VAR2` copies named host vars in too (e.g. a process-ownership tag your app reaps by).
- `kit.hub` always exists. Without the `hub` option its servers are added next to each CLI's own (not exclusive); an empty hub binds nothing and passes no config. `hub: false` keeps it out of sessions.
- Toggles and adds apply to **new** threads. Say so in the UI.
- `load` is a Claude-only hint today: `'always'` → `alwaysLoad` (schemas up front), `'on-demand'` → Claude's tool search. Codex and OpenCode load every tool up front either way; label the control accordingly.
- Status per server: `connected | starting | failed | needs_auth | off`, with `error` and `tools`. Show a badge + tool count; a failed server never blocks the others.
- Never send env/header values to the browser. Mask them (see [`server.ts`](../examples/web/server.ts) `publicServer`).
- Settings UI reference: [`mcp-settings.tsx`](../examples/web/src/components/mcp-settings.tsx): list with badge, tool count, On demand/Always, delete, enable switch; Add dialog with Command (stdio) / Remote (HTTP) tabs; Import; live updates over SSE.

### Native tools

Your own functions, served by the hub to every provider. No MCP server to write:

```ts
import { toolResult } from '@ouim/agentkit'

kit.hub.addTools('app', [{
  name: 'save_note',
  description: 'Save a note to this conversation',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  run: async ({ text }, ctx) => {
    // ctx: { sessionKey, provider, cwd, signal, server, tool }
    await notes.add(ctx.sessionKey, String(text), { signal: ctx.signal })
    return 'saved'
  },
}])
```

- **Context.** Each session gets its own hub URLs, so `ctx.sessionKey/provider/cwd` is the session that called. Concurrent sessions never see each other's. Called from outside a session (e.g. a raw MCP client on `hub.url()`), those fields are `null`.
- **Cancel.** `ctx.signal` aborts when the user interrupts (`session.interrupt()`, before the provider confirms), the turn is canceled, the session closes, or the CLI drops the call. Pass it to `fetch`/child processes. A tool that ignores it is still answered as `Canceled: …` immediately, so the turn never hangs on it.
- **Results.** Return a string, any JSON value (bigint ok), or nothing (`(no output)`). For more: `toolResult.image(bytesOrBase64, 'image/png', caption?)`, `toolResult.error('message')` (model sees a failure, no throw needed), `toolResult.parts(a, b)`. Throwing also becomes an error result.
- Tool sets live in code: register them at startup, every run. The hub file only remembers their toggles.

---

## 11. Errors

`AgentKitError.code`:

| Code | Meaning | UX |
| --- | --- | --- |
| `UNKNOWN_PROVIDER` | not registered | bug in your app |
| `PROVIDER_UNAVAILABLE` | CLI missing / not signed in | link to setup / doctor |
| `UNSUPPORTED_CAPABILITY` | you called something the provider lacks | hide the control (§7) |
| `SESSION_BUSY` | `reject` while running | offer queue/steer |
| `SESSION_CLOSED` | used after `close()` | reopen with `restore` |
| `INVALID_INPUT` | bad args (e.g. unknown store key) | validation |

Turn failures are not exceptions: they arrive as `turn_failed` (transcript `status: 'failed'`, `lastError`) and `RunResult.status`.

---

## 12. Checklist: a good harness

- [ ] Pickers come from `kit.catalog()`; controls hidden by `capabilities`
- [ ] Every send carries a client-generated `requestId`
- [ ] User can type while the agent works: steer or visible, withdrawable inbox
- [ ] Interrupt is always one click away while `status` is running
- [ ] Permission cards show the real command/diff; questions are answerable
- [ ] Transcript rendered from events via `reduceTranscript`, snapshot on reconnect
- [ ] `store` configured; `restore(key)` on demand; interrupted turns shown with a retry, never auto-resent
- [ ] Fork/rewind/compact offered where `capabilities` allow
- [ ] `/` skill menu writes `$name`; sent messages show chips
- [ ] Context meter from `usage`; plan meter from `kit.planUsage()` where supported
- [ ] Attachments sent with `submit({ attachments })` and shown as chips from `user_message.attachments`
- [ ] Long threads load a `transcriptPage` and fetch older items on scroll
- [ ] Provider picker locked once a thread has messages (a thread never changes provider)
- [ ] Native tools use `ctx.sessionKey` for per-conversation data and pass `ctx.signal` to slow work
- [ ] One MCP settings page backed by `kit.hub`; secrets masked; "applies to new threads" made clear
- [ ] `kit.shutdown()` on exit

---

## 13. Testing your harness

- `createAgentKit({ mock: true })` gives a free, deterministic provider with every capability. Prompt directives: `[tool]` (permission + shell tool), `[ask]` (question), `[fail]`, `[slow]`.
- Run AgentKit's own suites against your machine before blaming your app:
  `npm run verify` (free), `npm run e2e`, `node test/e2e/extras.ts`, `npm run e2e:durable`, `npm run e2e:skills`, `node test/e2e/hub.ts`.

---

## Keeping this doc current

When you add or change a primitive, in the same change:
1. Add/update the section here (real snippet, the UX rule that goes with it, the capability flag).
2. Add a line to the checklist if users would notice its absence.
3. Add a changelog line below.

### Changelog
- **0.2** — sessions, events, transcript, permissions/policies, access levels, modes/model/thinking/fast, steer/queue, resume, history, rewind, slash commands.
- **0.2 + durable** — `store`, `submit({ whenBusy, requestId })`, inbox + withdraw, `kit.restore`, `kit.submission`, crash recovery, `fork`, `compact`.
- **0.2 + context** — `contextWindow()`, `contextWindowMaxTokens` in usage and catalogs.
- **0.2 + catalog sources** — `AgentModel.source`, `kit.catalog(p, { sources })` (OpenCode: filter to `opencode-go`).
- **0.2 + skills** — `kit.skills()`, `kit.searchSkills()`, `$name` expansion, `splitSkillTags`, example `/` menu.
- **0.2 + hub** — `createAgentKit({ hub })`, `kit.hub` (add/update/remove/refresh/importFrom/addTools/on), exclusive MCP per provider, example MCP settings page.
- **0.2 + native tools** — `kit.hub` always present; `run(args, ctx)` with session context + abort signal; `toolResult.text/image/error/parts`.
- **0.2 + safe steer** — Claude steer defaults to `priority: 'next'` (waits for the next safe point); `claude.steerPriority: 'now'` restores the old behaviour.
- **0.2 + host fixes** — `kit.providers()` caches availability (60s, `{ force }`), `kit.capabilities(provider)`; Claude `flagSettings: () => ({...})` per-run flag settings merged with fast mode, catalog `metadata.resolvedModel`; hub `AGENTKIT_INHERIT_ENV`; Codex hub servers colliding with config.toml names mount as `<name>-hub`; `opencode serve` dies with its host even on SIGKILL (POSIX watchdog).
- **0.2 + host primitives** — `submit({ attachments })` (saved, readable without prompts, images inline, `user_message.attachments`, `@ouim/agentkit/attachment-tags`), `kit.planUsage(provider)` + `plan_usage` event, `kit.complete()`, `kit.transcriptPage()` / `pageTranscript` / `prependPage` + `transcript.itemsOffset`; documented that a thread never changes provider.
