# @ouim/codexkit

`@ouim/codexkit` is a host-side TypeScript SDK for local agent runtimes.

It provides:

- a shared provider API for `codex` and `claude`
- explicit session lifecycle (`open`, `resume`, cached convenience `session(name)`)
- provider inventory/discovery for runtime selection
- a preserved Codex compatibility layer for existing integrations

## Install

```bash
npm install @ouim/codexkit
```

Requirements:

- Node.js `>=22.6`
- local runtime installed and authenticated as needed:
  - Codex: `codex` CLI
  - Claude: `@anthropic-ai/claude-agent-sdk` runtime requirements

## Shared Provider API

```ts
import { createAgent } from '@ouim/codexkit'

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

### Lifecycle Semantics

- `session(name)`:
  - convenience cached accessor in the local client
- `openSession(options?)`:
  - explicit create/open for a session
- `resumeSession(handle, options?)`:
  - explicit resume from a structured handle
- `clearSession(name)` / `clearSessions()`:
  - local cache eviction only
- `close()`:
  - closes local runtime resources

The shared API does not expose normalized remote-history deletion.

### Structured Resume Handle

`AgentRunResult.handle` is the preferred generic resume payload:

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

- Codex maps `sessionId/resumeKey` to thread id.
- Claude maps `resumeKey` and optional `resumeAt` to Claude runtime resume semantics.
- `resumeState` remains available on run results as a legacy provider-specific field.

## Discovery and Inventory

Inventory is the canonical discovery surface:

```ts
import { getProviderInventory, getProviderInventoryEntry } from '@ouim/codexkit'

const inventory = await getProviderInventory({ probeMode: 'cheap' })
const codexDeep = await getProviderInventoryEntry('codex', { probeMode: 'deep' })
```

Backward-compatible availability helpers are still exported:

- `getAvailableProviders()`
- `getProviderAvailability(provider)`

They are compatibility projections of inventory.

## Capabilities

`AgentClient.getCapabilities()` returns normalized capability groups:

- `sessionLifecycle`
- `controls`
- `interactions`
- `discovery`
- `semantics`

Compatibility booleans are still present in Phase 1.

## Shared API vs Codex Compatibility Layer

### Shared API

- `createAgent(options)`
- `getProviderInventory()`
- `getProviderInventoryEntry(provider)`
- `getAvailableProviders()` (compat)
- `getProviderAvailability(provider)` (compat)

### Codex Compatibility API (kept stable)

- `createCodex(options?)`
- `CodexClient`
- `CodexAuth`
- `CodexSession`
- `CodexThread`
- existing Codex types from `src/types.ts`

## Provider Escape Hatches

`AgentClient` still exposes:

- `asCodex(): CodexClient | null`
- `asClaude(): ClaudeProviderHandle | null`

Use these for provider-native behavior that is intentionally outside the shared API.

## Examples

- Codex compatibility smoke: `examples/basic.ts`
- Generic Codex: `examples/agent-codex.ts`
- Generic Claude: `examples/agent-claude.ts`
- Lifecycle + resume handle: `examples/agent-lifecycle.ts`
- Provider inventory: `examples/provider-inventory.ts`

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
