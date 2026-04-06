# codexkit

TypeScript SDK for building on top of coding agents already installed on the user's machine.

`@ouim/codexkit` is an integration layer for developers who want to embed tools like Codex and Claude Code into their own products without learning every provider's runtime details from scratch.

The core idea is simple:

- the user already has the agent CLI or SDK installed
- the user is already authenticated in their environment
- your app uses Codexkit to talk to that local agent runtime

This package is not trying to replace Codex CLI or Claude Code. It is trying to make them programmable from Node in a way that feels consistent, typed, and product-friendly.

## What It Is

Codexkit is a host-side SDK for local coding agents.

That means it helps you build:

- devtools
- desktop apps
- editor integrations
- bots and workflow runners
- orchestration layers
- internal products that want to reuse the user's existing agent setup

Instead of making every builder learn:

- Codex app-server JSON-RPC
- Claude Agent SDK session/runtime quirks
- auth assumptions
- process lifecycle edge cases
- streaming and approval semantics

Codexkit aims to provide a cleaner integration layer on top.

## Current Reality

Today, the implementation in this repo is Codex-focused.

It already wraps:

- `codex app-server`
- ChatGPT browser login
- CLI device auth
- thread/session lifecycle
- turn streaming
- approval requests
- tool input requests

The product direction is broader:

- support local Codex integrations well
- add Claude support deliberately
- expose shared concepts where they are real
- keep provider-specific escape hatches where they matter

So the honest framing is:

- Codex support exists now
- Claude support is planned
- the package identity is broader than a raw Codex wrapper

## Why It Exists

If you build directly on provider runtimes, you quickly run into too much host-side complexity.

For Codex, that means:

- transport startup and teardown
- JSON-RPC notifications
- auth flow handling
- thread/turn coordination
- approval and tool-input events

For Claude, that means:

- long-lived runtime ownership
- prompt queue management
- streamed SDK message handling
- tool approval callbacks
- session resume and interruption semantics

Codexkit exists so application developers can build on these systems without rebuilding that integration layer from zero every time.

## Product Shape

Think of Codexkit as:

- one SDK
- multiple providers
- one host-side mental model
- provider-specific escape hatches when needed

The long-term shape should be closer to:

- `provider: 'codex'`
- `provider: 'claude'`

than to:

- one fake abstraction that pretends both runtimes are identical

## What You Get Today

Current implemented surface:

- `createCodex()` to start and manage `codex app-server`
- ChatGPT browser login and device-auth helpers
- high-level thread and session APIs
- streamed turn events for messages, reasoning, MCP progress, approvals, and tool input
- raw request access when you need the full app-server surface
- TypeScript types for the runtime objects you actually interact with

## Install

```bash
npm install @ouim/codexkit
```

Requirements right now:

- Node.js `22.6+`
- `codex` on your `PATH`

## Quick Start

```ts
import { createCodex } from './src/index.ts'

const codex = await createCodex({
  auth: {
    autoLogin: true,
    strategy: 'browser',
    onLoginRequired(info) {
      if (info.url) {
        console.log('Open this URL to sign in with ChatGPT:')
        console.log(info.url)
        console.log('Waiting for browser login to complete...')
      }
    },
    onLoginComplete(account) {
      if (account.type === 'chatgpt') {
        console.log(`Signed in as ${account.email} (${account.planType})`)
      }
    },
  },
  defaults: {
    model: 'gpt-5.4',
    cwd: process.cwd(),
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
  },
})

const thread = await codex.threads.create()
const result = await thread.run('Summarize this repository')

console.log(result.text)
await codex.close()
```

## Codex API Today

### Create a Client

```ts
const codex = await createCodex({
  auth: {
    autoLogin: false,
    strategy: 'browser',
  },
  defaults: {
    cwd: process.cwd(),
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
  },
})
```

### Run a Thread

```ts
const thread = await codex.threads.create()
const result = await thread.run('Find the highest-risk issue in this repo')

console.log(result.status)
console.log(result.text)
```

### Use a Session

```ts
const session = codex.session('repo-review')

await session.run('Audit the codebase')
await session.run('Now focus only on auth edge cases')
```

### Stream Events

```ts
const thread = await codex.threads.create()
const stream = await thread.stream('Fix the failing test suite')

for await (const event of stream) {
  if (event.type === 'message.delta') process.stdout.write(event.text)
  if (event.type === 'approval.command') console.log('Approval needed:', event.params.command)
  if (event.type === 'tool.input') console.log('Tool wants user input:', event.questions)
}
```

### Raw Access

```ts
const models = await codex.raw.request('model/list', {})
```

## Auth

### Browser Login

```ts
await codex.auth.loginWithChatGPT()
```

### Device Auth

```ts
await codex.auth.loginWithDeviceCode()
```

The example in this repo supports device auth selection with:

```bash
CODEXKIT_LOGIN=device-code node --experimental-strip-types examples/basic.ts
```

## Planned Claude Direction

Claude support should follow the same high-level philosophy:

- use what the user already has installed
- assume the user is already authenticated
- let host apps control sessions, prompts, approvals, interrupts, and resumes

But it should not pretend Claude works exactly like Codex.

Claude integration will need to account for:

- long-lived session runtimes
- prompt queues
- streamed SDK message handling
- tool approval through callback hooks
- opaque resume/session fields
- provider-specific model and permission semantics

See:

- [docs\claude-agent-sdk-typescript-distilled.md](/G:/PI/codex-sdk-node/docs/claude-agent-sdk-typescript-distilled.md)

## Examples

Current main smoke example:

- [examples/basic.ts](/G:/PI/codex-sdk-node/examples/basic.ts)

It shows:

- visible login progress
- browser or device auth selection
- session usage
- streaming message deltas

## Who This Is For

Codexkit is for developers who want to build on top of installed coding agents.

Good fits:

- local apps and desktop tools
- VS Code or editor-adjacent integrations
- CLI wrappers
- orchestration layers
- bots and automations
- internal tools that should reuse the user's existing agent install and login

Not the main goal:

- replacing the provider's human-facing CLI
- pretending every coding agent has the same runtime model
- shipping a giant hosted platform inside this repo

## Design Principles

- local-agent first
- provider adapters over fake uniformity
- high-level where helpful
- escape hatches where necessary
- honest scope
- strong TypeScript ergonomics

## Near-Term Direction

1. make the Codex integration genuinely strong
2. design a real provider abstraction
3. add Claude support deliberately
4. ship examples that prove the SDK is useful for real apps

That means the priority is to become a good host-side SDK, not to become a giant product too early.

## Development

Install dependencies:

```bash
npm install
```

Run the smoke example:

```bash
npm run example
```

## Status

This project is early.

The current implementation is Codex-focused, while the intended product identity is broader: a TypeScript SDK for building on top of local coding agents already present on the user's machine.
