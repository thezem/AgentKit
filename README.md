# codexkit

Small Node wrapper around `codex app-server`, intended to ship as `@ouim/codexkit`.

It gives you:

- ChatGPT-first login with browser auth or device-code fallback
- simple thread and session APIs
- streaming events for messages, reasoning, MCP progress, approvals, and tool input
- raw JSON-RPC access when you need the full app-server surface
- a deployable HTTP server for prompts and workflow actions

## Install

```bash
cd G:/PI/codex-sdk-node
npm install
```

Requires:

- Node.js 22.6+
- `codex` on your PATH

## Server MVP

You can run Codexkit as a small single-machine HTTP daemon:

```bash
npm run server
```

Default server behavior:

- binds to `127.0.0.1:3789`
- loads actions from `./actions`
- stores job metadata in `./data/jobs`
- expects Codex to already be authenticated on the machine

Useful env vars:

- `PORT` or `CODEXKIT_PORT`
- `HOST` or `CODEXKIT_HOST`
- `CODEXKIT_API_KEY`
- `CODEXKIT_ACTIONS_DIR`
- `CODEXKIT_DATA_DIR`
- `CODEXKIT_DEFAULT_CWD`
- `CODEXKIT_MODEL`
- `CODEXKIT_SANDBOX_MODE`
- `CODEXKIT_APPROVAL_POLICY`

If you bind to a non-local host, set `CODEXKIT_API_KEY`.

### Basic endpoints

```bash
curl http://127.0.0.1:3789/health
curl http://127.0.0.1:3789/account
curl http://127.0.0.1:3789/actions
```

Run a direct prompt:

```bash
curl -X POST http://127.0.0.1:3789/run \
  -H "content-type: application/json" \
  -d '{"prompt":"Summarize this repository","cwd":"'"$(pwd)"'"}'
```

Run a named action:

```bash
curl -X POST http://127.0.0.1:3789/actions/repo-summary \
  -H "content-type: application/json" \
  -d '{"cwd":"'"$(pwd)"'"}'
```

With API auth:

```bash
curl -X POST http://127.0.0.1:3789/actions/review-pr \
  -H "authorization: Bearer $CODEXKIT_API_KEY" \
  -H "content-type: application/json" \
  -d '{"input":{"repo":"owner/repo","prNumber":123},"cwd":"'"$(pwd)"'"}'
```

### Actions

Codexkit currently supports two action types in `./actions`:

- `.md` files for simple prompt actions
- `.ts` or `.js` files for script workflows

Script workflows export a default action object:

```ts
import { defineAction } from '../server/action-runtime.ts'

export default defineAction({
  name: 'hello',
  async run(ctx, input) {
    await ctx.log('running hello workflow')
    return ctx.runPrompt(`Say hello to ${JSON.stringify(input)}`)
  },
})
```

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

The example also supports device auth directly:

```bash
CODEXKIT_LOGIN=device-code bun examples/basic.ts
```

## Raw access

```ts
const models = await codex.raw.request('model/list', {})
```
