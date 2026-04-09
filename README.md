# @ouim/agentkit

One TypeScript API for local coding agents.

`@ouim/agentkit` gives builders one stable host-side SDK for working with local agent runtimes. Use the same lifecycle and streaming patterns across Codex and Claude, keep provider-specific escape hatches when you need them, and stop rewriting CLI glue every time a runtime shifts.

## Why People Pick It

- one API across Codex and Claude
- proper session lifecycle: open, resume, stream, close
- resumable handles for cross-process recovery
- normalized agent events, approvals, and user-input prompts
- discovery APIs for installed providers, models, and skills
- Codex compatibility entrypoint for existing integrations

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
  defaults: { cwd: process.cwd() },
  name: 'demo',
})

const result = await session.run('Summarize this repository in 3 bullets')

console.log(result.status)
console.log(result.handle)

await session.close()
```

`createSession(...)` is the ergonomic path: it creates a private agent client, opens one session, and automatically closes that private client when you call `session.close()`.

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

- Current normative behavior and boundaries are documented in [docs/RUNTIME_CONTRACT.md](https://github.com/thezem/agentkit/blob/main/docs/RUNTIME_CONTRACT.md).
- Persist `AgentSessionHandle` if you need cross-process resume.
- Treat `agent.session(name)` as local cache convenience only.
- Treat `raw`, `resumeState`, and provider escape hatches as provider-specific data.

Non-goals today:

- no event replay or cursor model
- no durable pending-request recovery
- no orchestration, websocket, or UI-state abstraction layer
