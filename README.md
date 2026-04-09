# @ouim/agentkit

One TypeScript API for local coding-agent runtimes.

`@ouim/agentkit` is a host-side SDK for builders creating apps on top of local agent CLIs and runtimes like Codex and Claude.

If you're building an agent UI, review bot, desktop app, internal tool, or automation runner, this package is the layer that should sit between your app and the provider runtime. It gives you one API for sessions, streaming, approvals, user input, discovery, and resume handles so you can spend your time building product behavior instead of provider glue.

## Why People Pick It

- one API across Codex and Claude
- proper session lifecycle: open, resume, stream, close
- resumable handles for cross-process recovery
- normalized agent events, approvals, and user-input prompts
- discovery APIs for installed providers, models, and skills
- Codex compatibility entrypoint for existing integrations

## Build UIs, Not Glue

This library is for the kind of app that needs controls like:

- model pickers
- reasoning / thinking-level selectors
- access-mode toggles such as supervised vs fuller autonomy
- approval prompts for tool calls and dangerous actions
- streaming turns with tool activity, reasoning, and completion state
- resumable sessions that survive process boundaries

Those apps are usually built today by stitching directly against vendor CLIs and SDKs. That means re-implementing session lifecycle, approval flows, provider discovery, model catalogs, runtime probing, and every provider quirk by hand.

`@ouim/agentkit` exists to be that control layer.

## Product Boundary

`@ouim/agentkit` is intentionally a runtime substrate, not the orchestration engine.

It should help you build:

- your own chat or plan-style agent UI
- your own approval and supervision flows
- your own persistence, replay, and websocket layers
- your own canonical event model if your product needs one

It is not trying to replace your app architecture. It is trying to replace the low-level Codex/Claude runtime glue that usually sits underneath it.

Sessions still belong to their provider runtime. Resume handles are structured and durable across process restarts, but they are not portable across providers.

## Install

```bash
npm install @ouim/agentkit
```

Requirements:

- Node.js `>=22.6`
- at least one local provider runtime:
  - Codex: `codex` CLI
  - Claude: runtime requirements for `@anthropic-ai/claude-agent-sdk`

## Quick Start

```ts
import { createSession } from '@ouim/agentkit'

const session = await createSession({
  provider: 'codex',
  defaults: {
    cwd: process.cwd(),
    interactionMode: 'chat',
    accessMode: 'supervised',
  },
  name: 'demo',
})

const result = await session.run('Summarize this repository in 3 bullets')

console.log(result.status)
console.log(result.handle)

await session.close()
```

`createSession(...)` is the ergonomic path: it creates a private agent client, opens one session, and automatically closes that private client when you call `session.close()`.

## What You Can Control Today

- choose a provider and create or resume a session
- switch shared `interactionMode` between `chat` and `plan`
- switch shared `accessMode` between `supervised`, `auto-edit`, and `full-access`
- set `reasoningEffort` when the provider/runtime supports it
- switch models through one API
- stream turns and inspect final run results
- handle approvals and user-input prompts
- interrupt active work
- inspect provider capabilities before rendering UI controls
- query provider inventory, models, and skills

The shared API is provider-neutral first. When a builder needs richer provider-native behavior, the library keeps explicit escape hatches available.

## Builder Controls

The shared API is now explicit about the control bar most apps want:

```ts
const agent = await createAgent({
  provider: 'codex',
  defaults: { cwd: process.cwd() },
})

const session = await agent.openSession({
  name: 'repo-ui',
  model: 'gpt-5.4',
  interactionMode: 'plan',
  accessMode: 'auto-edit',
})

const result = await session.run('Plan the next refactor and make the first safe edit.', {
  reasoningEffort: 'high',
})
```

Shared builder controls:

- `interactionMode?: 'chat' | 'plan'`
- `accessMode?: 'supervised' | 'auto-edit' | 'full-access'`
- `reasoningEffort?: string`

Legacy `permissionMode` still exists as a low-level escape hatch, but shared APIs reject mixed `accessMode + permissionMode` input instead of silently guessing.

## Capability Matrix

Use `agent.getCapabilities()` plus `listModels()` to decide which controls to render:

| Capability | Codex | Claude |
| --- | --- | --- |
| `modelSwitch` | `turn` | `session` |
| `interactionModeSwitch` | `turn` | `session` |
| `accessModeSwitch` | `turn` | `session` |
| Shared runtime `reasoningEffort` | Yes | Not yet |
| Normalized `plan.delta` / `item.*` activity | Yes | Partial |

`listModels()` is the source of truth for model-level `reasoningEfforts`. Claude discovery can advertise reasoning metadata before the shared runtime setter is enabled.

## Who It Is For

- maintainers building review bots and internal automation on local agent CLIs
- app builders who need resumable sessions and event streams without provider-specific glue
- teams migrating from Codex-only integrations toward a provider-neutral SDK

## Why This Exists

Local agent tooling is fragmented:

- provider-specific session identifiers and resume rules
- different auth/runtime checks per CLI
- non-portable event streams
- inconsistent approval and user-prompt wiring

This package normalizes those concerns into one API while preserving provider-native escape hatches.

## Safe Hello World

```ts
import { createSession, safety } from '@ouim/agentkit'

const session = await createSession({
  provider: 'codex',
  defaults: { cwd: process.cwd() },
  name: 'safe-hello',
})

const result = await session.run('Read this repo and suggest a small cleanup.', {
  handlers: safety.confirmDangerous({
    allowReadOnly: true,
    allowFileEdits: true,
    allowCommands: false,
  }),
})

console.log(result.text)
await session.close()
```

`safety` presets are provider-neutral, best-effort handler factories. They classify approval requests by normalized `request.kind` only, default unknown kinds to deny, and leave provider-specific details available in `request.payload`.

## Shared API

### Lifecycle

- `createSession(options)`
- `createAgent(options)`
- `agent.openSession(options?)`
- `agent.resumeSession(handle, options?)`
- `agent.session(name, options?)` local cached convenience handle
- `agent.clearSession(name)` and `agent.clearSessions()` clear only local cache entries
- `session.close()` always closes the local session object; remote/runtime impact is provider-specific today
- `agent.close()` closes client-owned runtime resources in the current process

### Resume Handle

`run()` returns an `AgentRunResult` with optional `handle`:

```ts
type AgentSessionHandle = {
  version: 1
  provider: 'codex' | 'claude'
  sessionId: string | null
  name?: string
  state?: {
    resumeKey?: string
    resumeAt?: string
    raw?: unknown
  }
}
```

`sessionId`, `state.resumeKey`, and `state.resumeAt` are resumable provider data. Local `session(name)` cache state is not remote state and is not enough by itself for cross-process resume.

### Discovery

- `getAvailableProviders(options?)`
- `getProviderAvailability(provider, options?)`
- `getProviderInventory(options?)`
- `getProviderInventoryEntry(provider, options?)`
- `listModels(provider?, options?)`
- `listSkills(provider, options?)`

## Normalized Events

`session.stream(...)` emits provider-neutral `AgentEvent` values:

- `run.started`: canonical lifecycle start event keyed by `runId`
- `message.delta`: incremental assistant text delta
- `message.completed`: completed assistant message payload
- `reasoning.delta`: incremental reasoning summary delta where available
- `plan.delta`: normalized plan activity item for UI plan panes
- `item.started`: normalized tool/file/other activity start event
- `item.completed`: normalized tool/file/message/other activity completion event
- `status.updated`: canonical lifecycle status update keyed by `runId`
- `approval.tool`: request that needs allow/deny approval
- `user.input`: request for structured user answers
- `run.completed`: normalized final run result for the streamed turn
- `provider.notification`: passthrough provider notification for advanced use
- `error`: normalized stream error event

Current event boundary:

- event order is the live adapter/runtime emission order for the current stream attachment
- `run.completed` carries the normalized final `AgentRunResult` for that turn
- there are no stable event IDs, replay cursors, or live-vs-replay markers yet

For `plan.delta`, `item.started`, and `item.completed`, the normalized item payload includes:

- `id`
- `kind`
- optional `text`
- optional `toolName`
- optional `path`
- optional `status`
- `raw`

## Safety Presets

Use the shared `safety` helper when you want simple approval defaults without introducing a policy engine:

- `safety.readOnly()` denies all approval requests.
- `safety.acceptEditsOnly()` allows file-edit-like kinds and denies the rest.
- `safety.confirmDangerous({ allowReadOnly, allowFileEdits, allowCommands })` allows only the explicitly enabled categories and denies unknown kinds conservatively.

These presets are intentionally thin convenience helpers over `AgentHandlers`. They do not normalize provider-specific payloads beyond the shared `request.kind` string.

## Handlers (Approvals and User Input)

Handlers are passed through `createAgent(...).openSession(...).stream(...)` (or `run(...)`) via `options.handlers`.

```ts
import { createAgent } from '@ouim/agentkit'

const agent = await createAgent({ provider: 'codex', defaults: { cwd: process.cwd() } })
const session = await agent.openSession({ name: 'handlers-demo' })

const stream = await session.stream('Inspect package.json and summarize scripts.', {
  handlers: {
    onToolApproval: async request => {
      console.log('Approval request:', request.kind)
      return 'allow'
    },
    onUserInput: async request => {
      console.log('User input request:', request.question)
      return ['example answer']
    },
  },
})

for await (const event of stream) {
  if (event.type === 'message.delta') process.stdout.write(event.text)
}
```

See runnable example: `npm run example:handlers`.

## Lower-Level Lifecycle

If you want explicit client ownership, local named-session caching, or multiple sessions on one runtime client, use `createAgent(...)` directly:

```ts
import { createAgent } from '@ouim/agentkit'

const agent = await createAgent({
  provider: 'codex',
  defaults: { cwd: process.cwd() },
})

const session = await agent.openSession({ name: 'demo' })
const result = await session.run('Summarize this repository in 3 bullets')

console.log(result.status)
console.log(result.handle)

await session.close()
await agent.close()
```

## Provider Escape Hatches

Use shared API first. Drop down only when you need provider-specific functionality:

- `agent.asCodex()` returns `CodexClient | null`
- `agent.asClaude()` returns `ClaudeProviderHandle | null`

Use escape hatches when your UI needs provider-specific controls or richer runtime detail than the normalized surface exposes today.

## Codex Compatibility Layer

Codex compatibility exports now live under an explicit entrypoint:

```ts
import { createCodex, CodexClient } from '@ouim/agentkit/compat/codex'
```

Compatibility entrypoint exports include:

- `createCodex(options?)`
- `CodexClient`
- `CodexAuth`
- `CodexSession`
- `CodexThread`
- `writeCodexSkillConfig(options)`

Use this for direct Codex runtime control. Prefer shared `createAgent` for new multi-provider code.

## Examples

All README-listed examples exist and map to npm scripts:

- `npm run example` -> `examples/basic.ts` (provider-neutral Codex smoke)
- `npm run smoke` -> `examples/basic.ts`
- `npm run example:agent:codex` -> `examples/agent-codex.ts`
- `npm run example:agent:claude` -> `examples/agent-claude.ts`
- `npm run example:lifecycle` -> `examples/agent-lifecycle.ts`
- `npm run example:handlers` -> `examples/handlers.ts`
- `npm run example:safe-session` -> `examples/safe-session.ts`
- `npm run example:inventory` -> `examples/provider-inventory.ts`
- `npm run example:models` -> `examples/models.ts`
- `npm run example:skills` -> `examples/skills.ts`
- `npm run example:ci` -> `examples/ci.ts`

## Troubleshooting

For precise lifecycle, stream-ordering, interrupt, and close semantics, use [docs/RUNTIME_CONTRACT.md](docs/RUNTIME_CONTRACT.md) as the source of truth.

### Provider binary missing

- Use `npm run example:inventory` and check each provider `status`, `installed`, `runnable`, and `executablePath`.
- If Codex is missing, install `codex` and ensure it is on PATH or pass `codexPath` in options.
- If Claude is missing, ensure Claude runtime dependencies are installed and `pathToClaudeCodeExecutable` is set if needed.

### Account/auth state not available

- Call `agent.getAccountState()` or inspect `authenticated` in provider inventory.
- For Codex browser login, use the login URL printed by examples and wait for completion.
- For Codex device auth, run with `CODEXKIT_LOGIN=device-code` (or PowerShell `$env:CODEXKIT_LOGIN='device-code'`) in examples that support it.
- If device auth completes but account still appears null, restart process/session and re-check inventory/account state.

### Inventory deep probe failures

- Use cheap probe first: `getProviderInventory({ probeMode: 'cheap' })`.
- Deep probes can fail due to startup/auth/runtime issues; inspect `diagnostics.failureReason` and `diagnostics.probeStrategy`.
- Bound probe time using `probeTimeoutMs` and treat `degraded` as a recoverable state.

## Development

```bash
npm install
npm run typecheck
npm test
```

## Runtime Contract

The shared API is intentionally a runtime substrate, not an orchestration framework.

- Current normative behavior and boundaries are documented in [docs/RUNTIME_CONTRACT.md](https://github.com/thezem/AgentKit/blob/main/docs/RUNTIME_CONTRACT.md).
- Persist `AgentSessionHandle` if you need cross-process resume.
- Treat `agent.session(name)` as local cache convenience only.
- Treat `raw`, `resumeState`, and provider escape hatches as provider-specific data.

Non-goals today:

- no event replay or cursor model
- no durable pending-request recovery
- no orchestration, websocket, or UI-state abstraction layer
