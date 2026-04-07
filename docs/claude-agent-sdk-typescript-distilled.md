# Claude Agent SDK (TypeScript) — Distilled Notes

Sources:

- https://platform.claude.com/docs/en/agent-sdk/typescript
- https://platform.claude.com/docs/en/agent-sdk/quickstart
- https://platform.claude.com/docs/en/agent-sdk/agent-loop
- https://platform.claude.com/docs/en/agent-sdk/sessions

## What It Is

The Claude Agent SDK is Anthropic's TypeScript SDK for embedding the same autonomous agent loop used by Claude Code inside your own application.

Important framing:

- this is not just a plain API wrapper
- it includes the agent loop, built-in tools, session persistence, permissions, and sandbox controls
- you do **not** need the Claude Code CLI installed to use it

## Install

```bash
npm install @anthropic-ai/claude-agent-sdk
```

## Main Entry Point

The primary API is `query()`.

```ts
function query({
  prompt,
  options,
}: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query
```

Key idea:

- `query()` returns an async generator
- you iterate over streamed SDK messages as Claude works
- the SDK itself runs the inner tool loop automatically

## How The Loop Works

At a high level, each session works like this:

1. Claude receives the prompt, tools, history, and settings.
2. Claude responds with text and/or tool calls.
3. The SDK executes the requested tools.
4. Tool results are fed back into Claude.
5. The cycle repeats until Claude returns a final text response with no tool calls.

The docs describe this as the same execution loop that powers Claude Code.

## Core Mental Model

The TypeScript SDK is built around:

- `query()` for execution
- streamed `SDKMessage` events for observability
- `Options` for session/runtime control
- built-in tools plus MCP/custom tools
- persisted local sessions

For your project, this is the big contrast with Codex:

- Codex app-server exposes a lower-level runtime protocol
- Claude Agent SDK exposes a higher-level agent SDK directly

## Main Functions

### `query()`

Primary execution entry point.

Use when you want to:

- run a one-shot agent task
- stream progress
- resume or continue sessions
- control permissions, tools, sandboxing, and budgets

### `tool()`

Creates a type-safe MCP tool definition from:

- name
- description
- Zod input schema
- async handler

This is the clean custom-tool API for in-process MCP tooling.

### `createSdkMcpServer()`

Creates an MCP server instance that runs in the same process as your app.

This is how you package custom tools for the SDK without needing a separate external MCP server process.

### Session Helpers

The TypeScript SDK also exposes:

- `listSessions()`
- `getSessionMessages()`
- `getSessionInfo()`
- `renameSession()`
- `tagSession()`

These are useful for:

- transcript viewers
- session browsers
- resume UX
- organizing prior runs

## Important `Options`

The `Options` object is large. The most important fields for product/design purposes are:

- `cwd`
- `continue`
- `resume`
- `forkSession`
- `permissionMode`
- `allowedTools`
- `disallowedTools`
- `canUseTool`
- `tools`
- `toolConfig`
- `agents`
- `agent`
- `mcpServers`
- `settingSources`
- `maxTurns`
- `maxBudgetUsd`
- `effort`
- `thinking`
- `persistSession`
- `sandbox`
- `env`

Notable documented behaviors:

- `cwd` defaults to `process.cwd()`
- `persistSession` defaults to `true`
- `effort` defaults to `'high'`
- `tools` can use a preset for Claude Code's default tools
- `allowedTools` auto-approves listed tools but does not restrict Claude to only those tools
- `disallowedTools` wins over allows

## Permission Modes

The docs define these `PermissionMode` values:

- `default`
- `acceptEdits`
- `bypassPermissions`
- `plan`
- `dontAsk`
- `auto`

The important risk boundary is `bypassPermissions`.

Anthropic explicitly documents that if you combine:

- `permissionMode: 'bypassPermissions'`
- unsandboxed command allowance

then the model may run commands outside the sandbox without approval prompts.

That is a real production-danger setting.

## Query Object

`query()` returns a `Query` object that extends `AsyncGenerator<SDKMessage, void>`.

Important methods include:

- `interrupt()`
- `rewindFiles()`
- `setPermissionMode()`
- `setModel()`
- `initializationResult()`
- `supportedCommands()`
- `supportedModels()`
- `supportedAgents()`
- `mcpServerStatus()`
- `accountInfo()`
- `setMcpServers()`
- `streamInput()`
- `stopTask()`
- `close()`

This is a stronger interactive control surface than a simple one-shot SDK.

## Message Types

The stream includes multiple message/event types, especially:

- `SDKSystemMessage`
- `SDKAssistantMessage`
- `SDKUserMessage`
- `SDKResultMessage`
- `SDKPartialAssistantMessage`
- status/progress/rate-limit/tool/hook messages

Important practical takeaway:

- the SDK is designed for rich streaming and observability, not just final text output

## Built-In Tool Surface

The docs enumerate many tool schemas and outputs, including:

- file tools like `Read`, `Edit`, `Write`
- search tools like `Glob`, `Grep`
- execution via `Bash`
- web tools like `WebFetch`, `WebSearch`
- orchestration tools like `TodoWrite`
- MCP resource tools
- planning / task-control tools

This confirms the SDK is much closer to "Claude Code as a programmable runtime" than to a thin API client.

## Sandbox Model

The SDK has first-class sandbox configuration through `SandboxSettings`.

Key fields include:

- `enabled`
- `autoAllowBashIfSandboxed`
- `excludedCommands`
- `allowUnsandboxedCommands`
- `network`
- `filesystem`
- `ignoreViolations`

Important details from the docs:

- sandboxing is opt-in
- `allowUnsandboxedCommands` defaults to `true`
- excluded commands can bypass sandbox automatically

So if you are designing a wrapper or integration layer, you should treat Claude's sandbox and permission configuration as a primary API surface, not a side detail.

## Sessions

The SDK persists sessions to disk automatically.

Important documented behavior:

- sessions live under `~/.claude/projects/<encoded-cwd>/...`
- `resume` requires the same `cwd` mapping to find the right session
- resuming across hosts requires moving the session file to the matching path
- often it is more robust to persist the application state you care about instead of shipping transcript files around

This is especially relevant if you ever compare this to Codex:

- both systems have local-machine session assumptions
- host portability is possible, but not the default happy path

## Authentication Constraint

This is the most important product-level note from Anthropic's quickstart:

- third-party developers should use API key or supported provider runtime/account setup
- unless previously approved, Anthropic does **not** allow developers to offer `claude.ai` login or rate limits inside their products built on the Agent SDK

That matters a lot for your repo direction.

Inference from Anthropic's docs:

- Codex-style consumer login UX should be treated as provider-specific legacy behavior
- Claude-side SDK integrations should be designed around API/provider runtime setup, not consumer-login-style product flows

## V2 Preview

The reference page points to a TypeScript V2 preview with a simplified `send()` / `stream()` style interface for easier multi-turn conversations.

For now, the current stable reference still centers on:

- `query()`
- the `Query` async generator object

So if you document Claude support later, you should be explicit about whether you are targeting:

- current TypeScript SDK
- or V2 preview

## What Matters For `agentkit`

If you ever broaden this project conceptually, the clean takeaway is:

### Codex side

- lower-level runtime protocol
- app-server transport and lifecycle matter
- runtime/account behavior can be provider-specific and transitional

### Claude side

- higher-level agent SDK already exists
- local agent loop is already packaged for developers
- API/provider runtime setup is the expected model
- rich permissions/sandbox/session APIs are first-class

That suggests a future shared abstraction should likely sit above:

- Codex app-server
- Claude Agent SDK

not try to force both systems into the same low-level transport shape.

## Suggested Product Conclusion

For now, your repo should stay honest:

- it is a Codex SDK
- not a cross-runtime abstraction yet

If Claude support comes later, it should probably be framed as:

- a sibling adapter
- or a higher-level multi-runtime package

not as evidence that both backends already behave the same way.

## Links

- Official TypeScript reference: https://platform.claude.com/docs/en/agent-sdk/typescript
- Quickstart: https://platform.claude.com/docs/en/agent-sdk/quickstart
- Agent loop: https://platform.claude.com/docs/en/agent-sdk/agent-loop
- Sessions: https://platform.claude.com/docs/en/agent-sdk/sessions

## Note

I was able to use the official Anthropic docs directly. The extra link you provided did not return usable content in this session, so this distillation is based on the official documentation above.
