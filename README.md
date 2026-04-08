# @ouim/agentkit

One TypeScript SDK for local agent runtimes.

`@ouim/agentkit` gives builders a stable host-side API over Codex today, with room for Claude and additional providers over time. It handles the parts that are usually brittle in automation scripts: session lifecycle, resume handles, streaming events, approvals, user prompts, runtime discovery, and provider-specific escape hatches.

## Why this exists

Local agent CLIs are powerful, but the integration surface is fragmented:

- every provider ships a different session model
- resume semantics are easy to get wrong
- auth and runtime discovery are CLI-specific
- tool approvals and user input prompts need reliable wiring

This package is meant to remove that adapter tax. You work against one API and keep the provider details behind the curtain.

## What you get

- a shared provider API for `codex` and `claude`
- explicit session lifecycle with `openSession`, `resumeSession`, and cached `session(name)` access
- streaming turn and activity events
- tool approval and user input handling
- provider inventory and model discovery
- a Codex compatibility layer for existing integrations
- provider escape hatches when you need native behavior

## Install

```bash
npm install @ouim/agentkit
```

Requirements:

- Node.js `>=22.6`
- a local runtime available on the machine:
  - Codex: `codex` CLI
  - Claude: `@anthropic-ai/claude-agent-sdk` runtime requirements

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

If you want a cached session handle instead of an explicit open, use:

```ts
const session = agent.session('my-project')
```

## Core Concepts

### Sessions

- `session(name)` returns a cached local session handle
- `openSession(options?)` creates a new session explicitly
- `resumeSession(handle, options?)` resumes from a structured handle
- `clearSession(name)` and `clearSessions()` only evict local cache state
- `close()` shuts down local runtime resources

### Resume Handles

`AgentRunResult.handle` is the portable resume payload:

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

That gives you a provider-neutral way to persist and reopen a session without guessing at provider-specific thread IDs.

### Streaming and Control

Sessions can stream activity as events, including:

- partial message deltas
- reasoning deltas
- status changes
- tool approval requests
- user input prompts
- turn completion

The shared API also exposes interruption and session-level capability metadata.

### Discovery

Inventory is the canonical discovery surface:

```ts
import { getProviderInventory, getProviderInventoryEntry, listModels, listSkills } from '@ouim/agentkit'

const inventory = await getProviderInventory({ probeMode: 'cheap' })
const codexDeep = await getProviderInventoryEntry('codex', { probeMode: 'deep' })
const models = await listModels()
const codexSkills = await listSkills('codex', { cwd: process.cwd() })
```

Discovery currently works like this:

- Codex model listing is runtime-backed.
- Claude model listing is a curated catalog and marked stale where needed.
- Skill listing is Codex-first today.
- Skill configuration writes are provider-specific through `writeCodexSkillConfig(...)`.

Compatibility helpers remain exported:

- `getAvailableProviders()`
- `getProviderAvailability(provider)`

## Provider Support

### Codex

Codex is the primary provider and has the fullest surface area today:

- session lifecycle
- streaming turn events
- tool and permission approvals
- inventory and model discovery
- skills discovery and configuration
- compatibility exports for older Codex integrations

### Claude

Claude is supported through the shared provider API, with provider-specific behavior preserved behind the adapter:

- shared session lifecycle
- streaming activity
- inventory discovery
- model discovery
- native escape hatch via `asClaude()`

## API Surface

### Shared Provider API

- `createAgent(options)`
- `getProviderInventory()`
- `getProviderInventoryEntry(provider)`
- `getAvailableProviders()`
- `getProviderAvailability(provider)`
- `listModels(provider?, options?)`
- `listSkills(provider, options?)`
- `writeCodexSkillConfig(options)`

### Codex Compatibility API

- `createCodex(options?)`
- `CodexClient`
- `CodexAuth`
- `CodexSession`
- `CodexThread`
- existing Codex types from `src/types.ts`

### Codex-Specific Helper

- `writeCodexSkillConfig(...)` for enabling or disabling Codex skills on disk

### Escape Hatches

`AgentClient` exposes provider-native handles when you need to step outside the shared API:

- `asCodex(): CodexClient | null`
- `asClaude(): ClaudeProviderHandle | null`

## Examples

- Codex compatibility smoke: `examples/basic.ts`
- Generic Codex: `examples/agent-codex.ts`
- Generic Claude: `examples/agent-claude.ts`
- Lifecycle and resume handles: `examples/agent-lifecycle.ts`
- Provider inventory: `examples/provider-inventory.ts`
- Model discovery: `examples/models.ts`
- Skills discovery: `examples/skills.ts`

Run:

```bash
npm run example
npm run example:agent:codex
npm run example:agent:claude
```

The basic example prints progress during login and execution so you can see the runtime working end to end.

## Development

```bash
npm install
npm run typecheck
```
