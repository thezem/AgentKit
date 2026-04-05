# Codex App Server — JSON-RPC 2.0 Protocol Reference

Source: https://developers.openai.com/codex/app-server
Implementation: https://github.com/openai/codex/tree/main/codex-rs/app-server

---

## Overview

The **Codex App Server** is a JSON-RPC 2.0 protocol interface that enables deep integration of Codex into custom products. It powers rich clients like the Codex VS Code extension and provides: authentication, conversation history, approvals, and streamed agent events.

> Use it when you want a deep integration inside your own product.

---

## Transports

| Transport | Flag | Notes |
|-----------|------|-------|
| **stdio** (default) | `--listen stdio://` | Newline-delimited JSON |
| **WebSocket** (experimental) | `--listen ws://IP:PORT` | One JSON-RPC message per WebSocket frame |

In WebSocket mode, bounded queues reject overloaded requests with error code `-32001` ("Server overloaded; retry later").

---

## Message Schema

```json
// Request
{ "method": "thread/start", "id": 10, "params": { "model": "gpt-5.4" } }

// Response
{ "id": 10, "result": { "thread": { "id": "thr_123" } } }

// Error response
{ "id": 10, "error": { "code": 123, "message": "Something went wrong" } }

// Notification (no id field)
{ "method": "turn/started", "params": { "turn": { "id": "turn_456" } } }
```

---

## Getting Started

```bash
# Start with stdio
codex app-server

# Start with WebSocket
codex app-server --listen ws://127.0.0.1:4500

# Generate TypeScript types or JSON Schema artifacts
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

**Connection sequence:**
1. Send `initialize` request with client metadata
2. Send `initialized` notification
3. Call `thread/start` or `thread/resume`
4. Call `turn/start` with user input
5. Read notification stream for progress events

---

## Core Primitives

| Primitive | Description |
|-----------|-------------|
| **Thread** | A conversation between user and agent, containing turns |
| **Turn** | A single user request and resulting agent work, containing items |
| **Item** | A unit of input/output (messages, commands, file changes, tool calls) |

---

## Initialization

The `initialize` request **must be sent first** on any connection. The server rejects all other requests until initialized.

```json
{
  "method": "initialize",
  "id": 0,
  "params": {
    "clientInfo": {
      "name": "codex_vscode",
      "title": "Codex VS Code Extension",
      "version": "0.1.0"
    }
  }
}
```

### With experimental API + notification opt-out

```json
{
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": { "name": "my_client", "title": "My Client", "version": "0.1.0" },
    "capabilities": {
      "experimentalApi": true,
      "optOutNotificationMethods": ["thread/started", "item/agentMessage/delta"]
    }
  }
}
```

> Use `clientInfo.name` to identify your client for the OpenAI Compliance Logs Platform.

---

## Full API Method Reference

### Thread Management

| Method | Description |
|--------|-------------|
| `thread/start` | Create new thread |
| `thread/resume` | Reopen existing thread |
| `thread/fork` | Branch thread into new id |
| `thread/read` | Read stored thread without resuming |
| `thread/list` | Page through threads with filters |
| `thread/loaded/list` | List threads in memory |
| `thread/name/set` | Set thread title |
| `thread/archive` | Move to archived directory |
| `thread/unarchive` | Restore from archive |
| `thread/unsubscribe` | Remove connection subscription |
| `thread/compact/start` | Trigger history compaction |
| `thread/rollback` | Remove last N turns |
| `thread/status/changed` | Status change notification |

### Turn Management

| Method | Description |
|--------|-------------|
| `turn/start` | Begin user request and agent work |
| `turn/steer` | Append input to active turn |
| `turn/interrupt` | Cancel in-flight turn |

### Model & Feature Discovery

| Method | Description |
|--------|-------------|
| `model/list` | List available models with capabilities |
| `experimentalFeature/list` | List feature flags with lifecycle |
| `collaborationMode/list` | List mode presets |

### Configuration & Skills

| Method | Description |
|--------|-------------|
| `skills/list` | List available skills |
| `skills/config/write` | Enable/disable skills |
| `plugin/list` | List plugin marketplaces |
| `plugin/read` | Read plugin details |
| `app/list` | List available apps/connectors |

### Command Execution

| Method | Description |
|--------|-------------|
| `command/exec` | Run single command in sandbox |
| `command/exec/write` | Write stdin to running session |
| `command/exec/resize` | Resize PTY session |
| `command/exec/terminate` | End running session |

### Advanced Operations

| Method | Description |
|--------|-------------|
| `review/start` | Invoke reviewer |
| `tool/requestUserInput` | Prompt user for input |
| `mcpServer/oauth/login` | Start OAuth flow |
| `config/mcpServer/reload` | Reload MCP servers |
| `mcpServerStatus/list` | List MCP servers and tools |
| `windowsSandbox/setupStart` | Trigger Windows sandbox setup |
| `configRequirements/read` | Read admin requirements |
| `config/read` | Fetch effective configuration |
| `config/value/write` | Write config key/value |
| `config/batchWrite` | Atomic config edits |
| `fs/*` | Filesystem operations (read, write, directory, metadata) |

---

## Thread Operations

### Start Thread

```json
{
  "method": "thread/start",
  "id": 10,
  "params": {
    "model": "gpt-5.4",
    "cwd": "/Users/me/project",
    "approvalPolicy": "never",
    "sandbox": "workspaceWrite",
    "personality": "friendly",
    "serviceName": "my_app_server_client"
  }
}
```

Response includes thread id and metadata. Emits `thread/started` notification.

### Resume Thread

```json
{
  "method": "thread/resume",
  "id": 11,
  "params": {
    "threadId": "thr_123",
    "personality": "friendly"
  }
}
```

Continuing a session doesn't update timestamp unless a turn is started.

### Fork Thread

```json
{
  "method": "thread/fork",
  "id": 12,
  "params": { "threadId": "thr_123" }
}
```

Creates new thread id from existing history. Emits `thread/started` for new thread.

### Read Thread (Without Resuming)

```json
{
  "method": "thread/read",
  "id": 19,
  "params": {
    "threadId": "thr_123",
    "includeTurns": true
  }
}
```

Returns thread data without loading into memory or emitting `thread/started`.

### List Threads

```json
{
  "method": "thread/list",
  "id": 20,
  "params": {
    "cursor": null,
    "limit": 25,
    "sortKey": "created_at",
    "archived": false
  }
}
```

Filter options:
- `modelProviders` — Restrict to specific providers
- `sourceKinds` — Filter by source (`cli`, `vscode`, `exec`, `appServer`, etc.)
- `archived` — Include archived threads only
- `cwd` — Match exact working directory

Returns paginated results with `nextCursor` (null when final page).

### Archive / Unarchive Thread

```json
{ "method": "thread/archive", "id": 22, "params": { "threadId": "thr_b" } }
{ "method": "thread/unarchive", "id": 24, "params": { "threadId": "thr_b" } }
```

Emits `thread/archived` / `thread/unarchived` notifications.

### Thread Compaction

```json
{
  "method": "thread/compact/start",
  "id": 25,
  "params": { "threadId": "thr_b" }
}
```

Returns immediately. Progress streams via standard `turn/*` and `item/*` notifications.

### Rollback Turns

```json
{
  "method": "thread/rollback",
  "id": 26,
  "params": { "threadId": "thr_b", "numTurns": 1 }
}
```

Removes last N turns from memory and persists rollback marker.

---

## Turn Operations

### User Input Item Types

| Type | Shape |
|------|-------|
| Text | `{ "type": "text", "text": "Explain this diff" }` |
| Image URL | `{ "type": "image", "url": "https://..." }` |
| Local image | `{ "type": "localImage", "path": "/tmp/screenshot.png" }` |
| Skill | `{ "type": "skill", "name": "skill-creator", "path": "/path/SKILL.md" }` |

### Start Turn

```json
{
  "method": "turn/start",
  "id": 30,
  "params": {
    "threadId": "thr_123",
    "input": [{ "type": "text", "text": "Run tests" }],
    "cwd": "/Users/me/project",
    "approvalPolicy": "unlessTrusted",
    "sandboxPolicy": {
      "type": "workspaceWrite",
      "writableRoots": ["/Users/me/project"],
      "networkAccess": true
    },
    "model": "gpt-5.4",
    "effort": "medium",
    "summary": "concise",
    "personality": "friendly",
    "outputSchema": {
      "type": "object",
      "properties": { "answer": { "type": "string" } },
      "required": ["answer"],
      "additionalProperties": false
    }
  }
}
```

Response includes turn id with status `"inProgress"`. Configuration overrides become defaults for future turns on same thread.

### Steer Active Turn

```json
{
  "method": "turn/steer",
  "id": 32,
  "params": {
    "threadId": "thr_123",
    "input": [{ "type": "text", "text": "Actually focus on failing tests first." }],
    "expectedTurnId": "turn_456"
  }
}
```

Appends input to active turn without creating a new turn. `expectedTurnId` must match the currently active turn.

### Interrupt Turn

```json
{
  "method": "turn/interrupt",
  "id": 31,
  "params": { "threadId": "thr_123", "turnId": "turn_456" }
}
```

Cancels in-flight turn. Turn finishes with `status: "interrupted"`.

---

## Sandbox Policies

### Read-Only (full access)

```json
{ "type": "readOnly", "access": { "type": "fullAccess" } }
```

### Read-Only (restricted)

```json
{
  "type": "readOnly",
  "access": {
    "type": "restricted",
    "includePlatformDefaults": true,
    "readableRoots": ["/Users/me/shared-read-only"]
  }
}
```

### Workspace Write

```json
{
  "type": "workspaceWrite",
  "writableRoots": ["/Users/me/project"],
  "networkAccess": true
}
```

With restricted read access:

```json
{
  "type": "workspaceWrite",
  "writableRoots": ["/Users/me/project"],
  "readOnlyAccess": {
    "type": "restricted",
    "includePlatformDefaults": true,
    "readableRoots": ["/Users/me/shared-read-only"]
  },
  "networkAccess": false
}
```

### External Sandbox

```json
{
  "type": "externalSandbox",
  "networkAccess": "restricted"
}
```

Use when server process is already sandboxed. `networkAccess`: `"restricted"` (default) or `"enabled"`.

---

## Models

### List Models

```json
{ "method": "model/list", "id": 6, "params": { "limit": 20, "includeHidden": false } }
```

Response fields per model:
- `supportedReasoningEfforts` — Effort options
- `defaultReasoningEffort` — Suggested default
- `upgrade` — Recommended upgrade model id
- `hidden` — Hidden from default picker
- `inputModalities` — `["text"]` or `["text", "image"]`
- `supportsPersonality` — Personality-specific instructions
- `isDefault` — Recommended default model

---

## Approvals

The server sends **server-initiated** JSON-RPC requests to clients for approval decisions.

### Command Execution Approval Flow

1. `item/started` — pending command with `command`, `cwd`
2. `item/commandExecution/requestApproval` — includes `itemId`, `threadId`, `turnId`, optional `reason`, optional `networkApprovalContext`
3. Client responds with decision
4. `serverRequest/resolved` — confirms
5. `item/completed` — final status

**Decisions:**
- `"accept"`
- `"acceptForSession"`
- `"decline"`
- `"cancel"`
- `{ "acceptWithExecpolicyAmendment": { "execpolicy_amendment": ["cmd", "..."] } }`

### File Change Approval Flow

1. `item/started` — proposed `fileChange` with `changes`
2. `item/fileChange/requestApproval` — includes `itemId`, `threadId`, `turnId`, optional `reason`, `grantRoot`
3. Client responds
4. `serverRequest/resolved` — confirms
5. `item/completed` — final status

**Decisions:** `"accept"`, `"acceptForSession"`, `"decline"`, `"cancel"`

### Network Approvals

When `networkApprovalContext` is present in a command approval, the prompt targets network access (not the shell command). Contains `host` and `protocol`.

> Codex groups concurrent network approval prompts by destination (host, protocol, and port).

---

## Event Notifications

### Thread Events

| Notification | Description |
|-------------|-------------|
| `thread/started` | New thread created |
| `thread/archived` | Thread moved to archive |
| `thread/unarchived` | Thread restored |
| `thread/closed` | Thread unloaded from memory |
| `thread/status/changed` | Status transition (`threadId`, `status`) |

### Turn Events

| Notification | Description |
|-------------|-------------|
| `turn/started` | User request initiated |
| `turn/completed` | Turn finished (`status`: completed, interrupted, failed) |
| `turn/diff/updated` | Latest unified diff across file changes |
| `turn/plan/updated` | Agent plan updates (`step`, `status`) |
| `thread/tokenUsage/updated` | Token usage updates |

### Item Events

All items emit:
- `item/started` — Work unit begins
- `item/completed` — Work unit finishes (authoritative state)

Item delta notifications:

| Notification | Description |
|-------------|-------------|
| `item/agentMessage/delta` | Streamed text |
| `item/plan/delta` | Proposed plan text |
| `item/reasoning/summaryTextDelta` | Reasoning summaries |
| `item/reasoning/summaryPartAdded` | Reasoning boundary |
| `item/reasoning/textDelta` | Raw reasoning text |
| `item/commandExecution/outputDelta` | Command stdout/stderr |
| `item/fileChange/outputDelta` | Tool response |

### Item Types

| Type | Description |
|------|-------------|
| `userMessage` | User input |
| `agentMessage` | Agent reply, optional `phase` (commentary, final_answer) |
| `plan` | Proposed plan text |
| `reasoning` | Reasoning with `summary` and `content` |
| `commandExecution` | Command run: `command`, `cwd`, `status`, `exitCode` |
| `fileChange` | Proposed edits: `changes` and `status` |
| `mcpToolCall` | MCP server tool invocation |
| `dynamicToolCall` | Client-executed tool call |
| `collabToolCall` | Collaboration tool call |
| `webSearch` | Web search request |
| `imageView` | Image viewer invocation |
| `enteredReviewMode` | Review started |
| `exitedReviewMode` | Review finished |
| `contextCompaction` | History compaction completed |

---

## Error Handling

When a turn fails, the server emits an error then `turn/completed` with `status: "failed"`.

**Common `codexErrorInfo` values:**

| Value | Meaning |
|-------|---------|
| `ContextWindowExceeded` | Context too large |
| `UsageLimitExceeded` | Rate/quota limit hit |
| `HttpConnectionFailed` | Network failure |
| `ResponseStreamConnectionFailed` | Stream connection lost |
| `ResponseStreamDisconnected` | Stream dropped mid-response |
| `ResponseTooManyFailedAttempts` | Retry budget exhausted |
| `BadRequest` | Malformed request |
| `Unauthorized` | Auth failure |
| `SandboxError` | Sandbox policy violation |
| `InternalServerError` | Server-side error |
| `Other` | Unclassified |

HTTP status code forwarded in `httpStatusCode` when available.

---

## Skills

### Invoke a Skill

Include `$<skill-name>` in text and add a skill input item:

```json
{
  "type": "skill",
  "name": "skill-creator",
  "path": "/Users/me/.codex/skills/skill-creator/SKILL.md"
}
```

### List Skills

```json
{
  "method": "skills/list",
  "id": 25,
  "params": {
    "cwds": ["/Users/me/project"],
    "forceReload": true,
    "perCwdExtraUserRoots": [
      { "cwd": "/Users/me/project", "extraUserRoots": ["/Users/me/shared-skills"] }
    ]
  }
}
```

Returns: `name`, `description`, `enabled`, `interface`, `dependencies`.

### Enable/Disable Skill

```json
{
  "method": "skills/config/write",
  "id": 26,
  "params": {
    "path": "/Users/me/.codex/skills/skill-creator/SKILL.md",
    "enabled": false
  }
}
```

---

## Command Execution

```json
{
  "method": "command/exec",
  "id": 50,
  "params": {
    "command": ["ls", "-la"],
    "cwd": "/Users/me/project",
    "sandboxPolicy": { "type": "workspaceWrite" },
    "timeoutMs": 10000,
    "tty": true,
    "streamStdoutStderr": true
  }
}
```

```json
// Write stdin
{ "method": "command/exec/write", "id": 51, "params": { "processId": "pid_123", "bytes": "<base64>" } }

// Resize PTY
{ "method": "command/exec/resize", "id": 52, "params": { "processId": "pid_123", "rows": 24, "cols": 80 } }

// Terminate
{ "method": "command/exec/terminate", "id": 53, "params": { "processId": "pid_123" } }
```

---

## Configuration

```json
// Read effective config
{ "method": "config/read", "id": 54, "params": {} }

// Write single value
{ "method": "config/value/write", "id": 55, "params": { "key": "setting.name", "value": "value" } }

// Atomic batch write
{
  "method": "config/batchWrite",
  "id": 56,
  "params": {
    "edits": [
      { "key": "setting1", "value": "value1" },
      { "key": "setting2", "value": "value2" }
    ]
  }
}
```

---

## MCP Servers

```json
// List MCP server status
{ "method": "mcpServerStatus/list", "id": 60, "params": { "cursor": null, "limit": 50 } }

// Start OAuth login
{ "method": "mcpServer/oauth/login", "id": 61, "params": { "serverName": "github" } }

// Reload config from disk
{ "method": "config/mcpServer/reload", "id": 62, "params": {} }
```

---

## Filesystem API (v2)

| Method | Description |
|--------|-------------|
| `fs/readFile` | Read file contents |
| `fs/writeFile` | Write to file |
| `fs/createDirectory` | Create directory |
| `fs/getMetadata` | File/directory metadata |
| `fs/readDirectory` | List directory contents |
| `fs/remove` | Delete file/directory |
| `fs/copy` | Copy file/directory |

All operations use absolute filesystem paths.

---

## Dynamic Tools (Experimental)

Requires `capabilities.experimentalApi = true`.

When a dynamic tool is invoked during a turn:
1. `item/started` with `type: "dynamicToolCall"`, `status: "inProgress"`
2. `item/tool/call` server request sent to client
3. Client responds with content items
4. `item/completed` with final status and returned items

---

## Review Operations

```json
{
  "method": "review/start",
  "id": 40,
  "params": {
    "threadId": "thr_123",
    "delivery": "inline",
    "target": { "type": "commit", "sha": "1234567deadbeef", "title": "Polish tui colors" }
  }
}
```

**Target types:** `uncommittedChanges`, `baseBranch`, `commit`, `custom`
**Delivery modes:** `inline` (existing thread), `detached` (fork new thread)

Streams: `enteredReviewMode` and `exitedReviewMode` items.

---

## Windows Sandbox Setup

```json
{
  "method": "windowsSandbox/setupStart",
  "id": 63,
  "params": { "mode": "elevated" }
}
```

Modes: `elevated` or `unelevated`. Returns quickly; later emits `windowsSandbox/setupCompleted`.

---

## Notification Opt-Out

In `initialize`, suppress specific notifications by exact method name:

```json
{
  "capabilities": {
    "optOutNotificationMethods": [
      "thread/started",
      "item/agentMessage/delta"
    ]
  }
}
```

Unknown method names are silently ignored.
