# Claude Support Plan For Codexkit

## Purpose

This document defines what Codexkit needs in order to support Claude alongside Codex without turning the package into a dishonest lowest-common-denominator abstraction.

The goal is not:

- "make Claude look exactly like Codex"

The goal is:

- provide one host-side SDK for local coding agents
- expose shared concepts where they are real
- preserve provider-specific control surfaces where they matter

## Product Position

Codexkit should support agents that:

- are already installed on the user's machine
- have existing runtime/account state in the user's environment
- can be controlled from a host Node application

Claude fits that model.

The host-side promise becomes:

- developers build against Codexkit
- Codexkit talks to Codex or Claude
- the user keeps using their own local provider setup

## Key Constraint

Codex and Claude have different runtime shapes.

### Codex

- lower-level runtime surface
- `codex app-server`
- JSON-RPC transport
- explicit thread/turn objects
- server-initiated requests for approvals and tool input

### Claude

- higher-level host SDK
- long-lived runtime object from `query()`
- prompt queue model
- callback-based tool approval
- streamed SDK messages
- opaque session resume fields

So Codexkit must not be designed as:

- "everything is secretly a thread/turn protocol"

It should instead be designed as:

- a provider system with shared concepts and provider-specific adapters

## What Must Be Shared

These concepts are real across both providers and should become first-class Codexkit abstractions.

### 1. Provider

An explicit provider id:

- `codex`
- `claude`

### 2. Session

A long-lived conversational runtime owned by the host application.

Shared ideas:

- create
- send input
- stream output/events
- interrupt
- close
- optional resume/continue

### 3. Events

The host needs a unified event stream shape at the SDK layer.

Examples:

- message delta
- reasoning delta
- status
- approval request
- user-input request
- turn completed
- error

This does **not** mean both providers emit identical raw data.
It means Codexkit should normalize the common host-facing concepts.

### 4. Account / Runtime Availability

The host should be able to ask:

- is the provider installed?
- is it reachable?
- what current runtime/account state is available?

### 5. Session Controls

The host should be able to do this in a provider-neutral way when supported:

- interrupt active work
- close the session
- change model
- change permission mode

## What Must Stay Provider-Specific

These should remain provider-specific or be exposed behind capability checks.

### Codex-specific

- raw JSON-RPC methods
- app-server transport lifecycle
- thread ids / turn ids as first-class objects
- legacy runtime/account helpers (transitional compatibility)
- approval request payload shapes

### Claude-specific

- prompt queue lifecycle
- `query()` runtime object
- `canUseTool` callback details
- resume cursor / session token fields
- Claude-specific model/effort/thinking behavior

This means Codexkit should expose:

- shared APIs
- plus provider-specific escape hatches

## Proposed Architecture

Introduce an internal provider layer.

Suggested concepts:

```text
AgentProvider
AgentClient
AgentSession
AgentEvent
AgentAccountState
AgentCapabilities
```

### `AgentProvider`

Responsible for:

- installation detection
- runtime/account-state checks
- client creation
- provider metadata

Possible shape:

```ts
type AgentProvider = {
  id: 'codex' | 'claude'
  isAvailable(): Promise<boolean>
  createClient(options): Promise<AgentClient>
}
```

### `AgentClient`

Responsible for:

- provider account/runtime info
- session creation
- provider-specific raw access

Possible shape:

```ts
type AgentClient = {
  provider: 'codex' | 'claude'
  getAccount(): Promise<AgentAccountState>
  createSession(options?): Promise<AgentSession>
  close(): Promise<void>
}
```

### `AgentSession`

Responsible for:

- sending turns
- streaming events
- interruption
- shutdown
- optional resume metadata

Possible shape:

```ts
type AgentSession = {
  id: string | null
  run(input, options?): Promise<AgentRunResult>
  stream(input, options?): Promise<AsyncIterable<AgentEvent>>
  interrupt(): Promise<void>
  close(): Promise<void>
}
```

## Proposed Public API Direction

Do not remove the Codex-first API yet.

Instead:

### Keep

- `createCodex()`
- `CodexClient`
- `CodexSession`
- `CodexThread`

### Add

- `createAgent({ provider: 'codex' | 'claude' })`
- shared agent types
- provider capability discovery

This gives:

- backward compatibility
- room to add Claude cleanly
- time to learn what the right common API actually is

## Claude Adapter Requirements

To support Claude properly, the adapter will need to do all of the following.

### 1. Runtime Creation

- call Claude's `query()`
- own one runtime per session
- keep one prompt source per session
- keep one consumer loop per session

### 2. Prompt Queue

Codexkit must create and manage an async prompt queue for each Claude session.

Requirements:

- deterministic ordering
- multi-turn input support
- clean close behavior
- no dropped prompts on shutdown

### 3. Event Normalization

Claude SDK messages must be mapped into Codexkit-level events.

Likely mappings:

- assistant partials -> `message.delta`
- assistant finals -> `message.completed` or final turn result
- system status -> `status`
- tool approvals / clarifications -> request events
- result -> turn/session completion

### 4. Tool Approval Bridge

Claude uses `canUseTool`.

Codexkit will need to bridge that into a host-friendly event/callback model similar to how Codex approvals currently work.

Important cases:

- allow
- deny
- clarifying question / user input
- plan mode handling

### 5. Resume Support

Claude resume data should be treated as opaque.

Codexkit should:

- store it
- return it
- pass it back unchanged

Codexkit should not try to interpret its internal structure.

### 6. Account / Availability Detection

Codexkit should detect:

- whether the Claude SDK package is available
- what local Claude runtime/account state is available
- whether the configured executable path exists when relevant

This should be surfaced as provider health/account info.

## Detection Strategy

The SDK should support both automatic detection and explicit configuration.

### Automatic

Try to detect:

- `codex` on `PATH`
- Claude SDK package installed in the host app
- optional provider executable overrides

### Explicit

Allow apps to specify:

- provider
- executable path
- provider-specific options

This is important because host apps may bundle or pin their own provider paths.

## Suggested Option Shapes

At the shared level:

```ts
type CreateAgentOptions = {
  provider: 'codex' | 'claude'
  cwd?: string
  model?: string
  env?: Record<string, string>
}
```

Then provider-specific sub-options:

```ts
type CodexProviderOptions = {
  codexPath?: string
  // legacy runtime/account options (transitional)
  auth?: ...
}

type ClaudeProviderOptions = {
  claudeSdk?: {
    includePartialMessages?: boolean
    settingSources?: Array<'user' | 'project' | 'local'>
    additionalDirectories?: string[]
    permissionMode?: string
    pathToClaudeCodeExecutable?: string
  }
}
```

## Event Design Recommendation

The event model is the hardest part. Start with a minimal shared event set.

Suggested shared events:

- `message.delta`
- `message.completed`
- `reasoning.delta`
- `status`
- `approval.tool`
- `user.input`
- `turn.completed`
- `error`
- `provider.notification`

Also include raw provider payloads where useful:

```ts
type AgentEvent = {
  provider: 'codex' | 'claude'
  type: string
  raw?: unknown
}
```

That keeps the abstraction useful without erasing provider detail.

## Implementation Milestones

### Milestone 1: Provider Skeleton

Add:

- shared provider interfaces
- provider registry
- `createAgent()`
- Codex adapter using the existing implementation

Goal:

- no Claude support yet
- but the architecture is ready

### Milestone 2: Claude Availability Probe

Add:

- package/executable detection
- basic account/runtime probe
- typed provider health info

Goal:

- host apps can see whether Claude support is available on the current machine

### Milestone 3: Claude Session Runtime

Add:

- prompt queue
- long-lived runtime ownership
- streaming message consumption
- interrupt/close support

Goal:

- basic Claude multi-turn sessions work through Codexkit

### Milestone 4: Approval / Input Bridging

Add:

- `canUseTool` bridge
- clarifying question flow
- plan mode handling strategy

Goal:

- host apps can treat Claude approvals and user-input requests as first-class events

### Milestone 5: Resume + Capability Model

Add:

- opaque resume state support
- provider capability metadata
- model / permission mode switching

Goal:

- host apps can build durable multi-turn UX

## Immediate Next Steps

The next practical work should be:

1. define the shared provider interfaces in code
2. adapt the current Codex implementation behind them
3. keep existing Codex exports for backward compatibility
4. only then start the Claude adapter

That sequence reduces thrash and gives a stable place to land Claude support.

## Important Rule

Do not add Claude support by sprinkling conditionals across the current Codex code.

That will create a confused architecture quickly.

The provider boundary needs to exist first.

## Success Criteria

Claude support is "real" only when a host app can:

- detect Claude availability
- start a Claude-backed session
- send multiple turns through one runtime
- stream partial output
- handle tool approvals and clarifying questions
- interrupt cleanly
- resume from stored opaque state

Until then, the docs should describe Claude as planned, not supported.
