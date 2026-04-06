# codexkit

High-level Node SDK for building on top of `codex app-server`.

`@ouim/codexkit` is for developers who want to integrate Codex into their own tools without speaking raw JSON-RPC or managing the full app-server lifecycle themselves.

It is not trying to replace Codex CLI. It is trying to be the ergonomic TypeScript layer you build on top of when you want to create:

- internal dev tools
- bots and automations
- review workflows
- coding assistants
- API backends and local services
- experiments that may later expand toward Codex- or Claude-style coding runtimes

Today, this package is Codex-first. The broader idea is to make the integration layer clean enough that higher-level systems can be built on top of it.

## Why It Exists

The raw `codex app-server` surface is powerful, but not pleasant to build against directly.

You have to deal with:

- transport startup and teardown
- JSON-RPC requests and notifications
- auth flow handling
- thread and turn lifecycle
- streamed item events
- approval requests
- tool input requests

Codexkit wraps those details in a small Node API so you can focus on your product instead of protocol plumbing.

## What You Get

- `createCodex()` to start and manage `codex app-server`
- ChatGPT browser login and device-auth helpers
- high-level thread and session APIs
- streamed turn events for messages, reasoning, MCP progress, approvals, and tool input
- raw request access when you need the full app-server surface
- TypeScript types for the important runtime objects

## Current Positioning

This repo is best understood as an SDK, not a full hosted automation product.

That means:

- the package itself should be small, composable, and pleasant to embed
- examples and downstream apps can implement servers, bots, and workflows on top
- Codex support should be excellent and explicit
- broader multi-runtime ambitions should not weaken the core SDK story

If you want to build your own deployable service later, this package should be the foundation for that, not the service itself.

## Install

```bash
npm install @ouim/codexkit
```

Requirements:

- Node.js `22.6+`
- `codex` on your `PATH`

This repo currently uses source imports directly, so in local development you can also run it from the repository checkout.

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

## Core API

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

### Run a Single Thread

```ts
const thread = await codex.threads.create()
const result = await thread.run('Find the highest-risk issue in this repo')

console.log(result.status)
console.log(result.text)
```

### Use a Session

Sessions let you keep working within the same conversation without manually storing the thread id.

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

When the SDK does not yet expose a convenience wrapper, you can still use the underlying app-server methods directly.

```ts
const models = await codex.raw.request('model/list', {})
```

## Auth

Codexkit follows the auth surface exposed by `codex app-server`.

### Browser Login

```ts
await codex.auth.loginWithChatGPT()
```

This uses app-server's ChatGPT login flow and is the primary intended path for this project.

### Device Auth

```ts
await codex.auth.loginWithDeviceCode()
```

This launches the native CLI device auth flow with inherited stdio.

The example in this repo also supports choosing device auth via environment variable:

```bash
CODEXKIT_LOGIN=device-code node --experimental-strip-types examples/basic.ts
```

## Examples

The current main smoke example is:

- [examples/basic.ts](/G:/PI/codex-sdk-node/examples/basic.ts)

It shows:

- visible login progress
- browser or device auth selection
- session usage
- streaming message deltas

## Who This Is For

Codexkit is a good fit if you are:

- building a Node service that needs to call Codex
- creating a bot or workflow runner
- experimenting with agentic coding UX on top of Codex
- embedding Codex inside a larger product
- tired of hand-rolling app-server transport and event handling

It is probably not the right fit if you only want:

- a human-facing CLI replacement
- a complete hosted orchestration platform
- a runtime-agnostic abstraction over every coding agent from day one

## Design Principles

- App-server first: wrap the real runtime surface, not a reduced imitation
- ChatGPT-first auth: match the intended Codex user experience
- Escape hatches matter: raw JSON-RPC remains available
- High-level where helpful: sessions, threads, and event typing should feel easy
- Honest scope: Codex support should be strong before the package grows broader ambitions

## Near-Term Direction

The strongest path for this package is:

1. become a genuinely good Node SDK for `codex app-server`
2. ship better examples for real integrations
3. support downstream tools that want to build bots, services, and workflow runners
4. only expand into broader multi-runtime ideas when the Codex SDK itself is solid

That means the priority is not to turn this repo into a huge product too early. The priority is to make it the SDK people actually want to build on.

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

The current shape is already useful for experimentation and internal tools, but the API, packaging, and docs are still being refined.
