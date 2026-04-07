# codexkit

`@ouim/codexkit` is a host-side TypeScript SDK for local coding agents already installed on a user's machine.

It now supports two API layers:

- Compatibility Codex API (unchanged): `createCodex`, `CodexClient`, `CodexSession`, `CodexThread`
- New provider API: `createAgent` with `provider: 'codex' | 'claude'`

## Install

```bash
npm install @ouim/codexkit
```

Requirements:

- Node.js `>=22.6`
- Local provider runtime installed/authenticated on the same machine as your app:
  - Codex: `codex` CLI
  - Claude: Claude Agent SDK runtime/auth as required by `@anthropic-ai/claude-agent-sdk`

## Quick Start (Generic API)

```ts
import { createAgent } from '@ouim/codexkit'

const agent = await createAgent({
  provider: 'codex',
  defaults: { cwd: process.cwd() },
})

const session = agent.session('demo')
const result = await session.run('Summarize this repository in 3 bullets')

console.log(result.status)
console.log(result.text)

await agent.close()
```

## Public APIs

### Compatibility Codex API (kept stable)

- `createCodex(options?)`
- `CodexClient`
- `CodexAuth`
- `CodexSession`
- `CodexThread`
- Existing Codex types from `src/types.ts`

### New Shared Multi-Provider API

- `createAgent(options)`
- `getAvailableProviders()`
- `getProviderAvailability(provider, options?)`

Shared types are exported from `src/agent-types.ts` through `src/index.ts`, including:

- `AgentClient`, `AgentSession`
- `AgentEvent`, `AgentRunResult`
- `AgentAccountState`, `AgentCapabilities`
- `CreateAgentOptions`, `AgentSessionOptions`, `AgentRunOptions`, `AgentHandlers`

## Provider Escape Hatches

`AgentClient` provides provider-specific raw access:

- `asCodex(): CodexClient | null`
- `asClaude(): ClaudeProviderHandle | null`

## Discovery

```ts
import { getAvailableProviders, getProviderAvailability } from '@ouim/codexkit'

const providers = await getAvailableProviders()
const claude = await getProviderAvailability('claude')
```

Discovery reports provider availability and authentication state without triggering login flows.

## Event Normalization

Generic sessions stream normalized events, for example:

- `message.delta`
- `message.completed`
- `reasoning.delta`
- `approval.tool`
- `user.input`
- `turn.completed`
- `provider.notification`
- `error`

Provider-native payloads remain available through each event's `raw` field.

## Claude Support Notes

Claude support is implemented through `@anthropic-ai/claude-agent-sdk` with:

- Long-lived runtime per session
- FIFO prompt queue
- Interrupt and close support
- Tool approval bridging via `onToolApproval`
- Elicitation/user-input bridging via `onUserInput`
- Opaque resume state surfaced on `AgentRunResult.resumeState`

The Claude adapter does not try to force raw runtime parity with Codex internals.

## Examples

- Codex compatibility smoke: `examples/basic.ts`
- Generic Codex: `examples/agent-codex.ts`
- Generic Claude: `examples/agent-claude.ts`

Run:

```bash
npm run example
npm run example:agent:codex
npm run example:agent:claude
```

## Development

```bash
npm install
npm run typecheck
```
