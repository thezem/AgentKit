# codexkit

Small Node wrapper around `codex app-server`, intended to ship as `@ouim/codexkit`.

It gives you:

- ChatGPT-first login with browser auth or device-code fallback
- simple thread and session APIs
- streaming events for messages, reasoning, MCP progress, approvals, and tool input
- raw JSON-RPC access when you need the full app-server surface

## Install

```bash
cd G:/PI/codex-sdk-node
npm install
```

Requires:

- Node.js 22.6+
- `codex` on your PATH

## Quick start

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
const result = await thread.run('Summarize this repo')

console.log(result.text)
```

## Sessions

```ts
const session = codex.session('my-review')
await session.run('Audit the codebase')
await session.run('Now focus on auth edge cases')
```

## Streaming

```ts
const thread = await codex.threads.create()
const stream = await thread.stream('Fix the failing test suite')

for await (const event of stream) {
  if (event.type === 'message.delta') process.stdout.write(event.text)
  if (event.type === 'approval.command') console.log('Approval needed:', event.params.command)
  if (event.type === 'tool.input') console.log('Tool wants user input:', event.questions)
}
```

## Auth

Browser auth uses app-server's ChatGPT login flow:

```ts
await codex.auth.loginWithChatGPT()
```

Device-code fallback uses the CLI:

```ts
await codex.auth.loginWithDeviceCode()
```

## Raw access

```ts
const models = await codex.raw.request('model/list', {})
```
