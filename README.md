# @ouim/agentkit

One TypeScript SDK for local agent runtimes.

`@ouim/agentkit` provides a stable host-side API over provider CLIs and runtimes. Codex is first-class today, Claude is supported through the same shared surface, and the API is designed to add more providers without rewriting your app glue.

## Why this exists

Local agent tooling is fragmented:

- provider-specific session identifiers and resume rules
- different auth/runtime checks per CLI
- non-portable event streams
- inconsistent approval and user-prompt wiring

This package normalizes those concerns into one API while preserving provider-native escape hatches.

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

## Shared API

### Lifecycle

- `createAgent(options)`
- `agent.openSession(options?)`
- `agent.resumeSession(handle, options?)`
- `agent.session(name, options?)` local cached convenience handle
- `agent.clearSession(name)` and `agent.clearSessions()` clear only local cache entries
- `session.close()` closes the local session object/runtime resources for that provider
- `agent.close()` closes client-level runtime resources

### Resume Handle

`run()` returns an `AgentRunResult` with optional `handle`:

```ts
type AgentSessionHandle = {
  provider: 'codex' | 'claude'
  sessionId: string | null
  name?: string
  resumeKey?: string
  resumeAt?: string
  raw?: unknown
}
```

`sessionId`, `resumeKey`, and `resumeAt` are resumable provider data. Local `session(name)` cache state is not remote state and is not enough by itself for cross-process resume.

### Discovery

- `getAvailableProviders(options?)`
- `getProviderAvailability(provider, options?)`
- `getProviderInventory(options?)`
- `getProviderInventoryEntry(provider, options?)`
- `listModels(provider?, options?)`
- `listSkills(provider, options?)`
- `writeCodexSkillConfig(options)` (Codex-specific)

## Normalized Events

`session.stream(...)` emits provider-neutral `AgentEvent` values:

- `message.delta`: incremental assistant text delta
- `message.completed`: completed assistant message payload
- `reasoning.delta`: incremental reasoning summary delta where available
- `status`: provider/session status update
- `approval.tool`: request that needs allow/deny approval
- `user.input`: request for structured user answers
- `turn.completed`: normalized final turn result for the streamed turn
- `provider.notification`: passthrough provider notification for advanced use
- `error`: normalized stream error event

## Handlers (Approvals and User Input)

Handlers are passed through `createAgent(...).openSession(...).stream(...)` (or `run(...)`) via `options.handlers`.

```ts
import { createAgent } from '@ouim/agentkit'

const agent = await createAgent({ provider: 'codex', defaults: { cwd: process.cwd() } })
const session = await agent.openSession({ name: 'handlers-demo' })

const stream = await session.stream('Inspect package.json and summarize scripts.', {
  handlers: {
    onToolApproval: async (request) => {
      console.log('Approval request:', request.kind)
      return 'allow'
    },
    onUserInput: async (request) => {
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

## Provider Escape Hatches

Use shared API first. Drop down only when you need provider-specific functionality:

- `agent.asCodex()` returns `CodexClient | null`
- `agent.asClaude()` returns `ClaudeProviderHandle | null`

## Codex Compatibility Layer

`@ouim/agentkit` keeps compatibility exports for existing Codex integrations:

- `createCodex(options?)`
- `CodexClient`
- `CodexAuth`
- `CodexSession`
- `CodexThread`

Use this for direct Codex runtime control. Prefer shared `createAgent` for new multi-provider code.

## Examples

All README-listed examples exist and map to npm scripts:

- `npm run example` -> `examples/basic.ts` (Codex compatibility smoke, stream-only)
- `npm run smoke` -> `examples/basic.ts`
- `npm run example:agent:codex` -> `examples/agent-codex.ts`
- `npm run example:agent:claude` -> `examples/agent-claude.ts`
- `npm run example:lifecycle` -> `examples/agent-lifecycle.ts`
- `npm run example:handlers` -> `examples/handlers.ts`
- `npm run example:inventory` -> `examples/provider-inventory.ts`
- `npm run example:models` -> `examples/models.ts`
- `npm run example:skills` -> `examples/skills.ts`
- `npm run example:ci` -> `examples/ci.ts`

## Troubleshooting

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
