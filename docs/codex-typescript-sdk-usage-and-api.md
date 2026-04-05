# Codex TypeScript SDK — Usage & API Reference

Sources:
- https://developers.openai.com/codex/sdk
- https://github.com/openai/codex/tree/main/sdk/typescript

---

## Overview

The Codex SDK is a TypeScript library for embedding the Codex agent within applications and workflows. It wraps the `codex` CLI from `@openai/codex`, communicating via JSONL events through stdin/stdout.

**Key use cases:**
- Automating engineering tasks in CI/CD pipelines
- Building agents that leverage Codex capabilities
- Embedding code assistance in proprietary tools
- Creating custom applications with Codex functionality

---

## Installation

```bash
npm install @openai/codex-sdk
```

**Requirements:** Node.js 18 or higher

---

## Core API

### Basic Usage

```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread();
const turn = await thread.run("Diagnose the test failure and propose a fix");

console.log(turn.finalResponse);
console.log(turn.items);
```

### Continuing a Conversation

Call `run()` repeatedly on the same thread to continue multi-turn conversations:

```typescript
const firstTurn = await thread.run("Make a plan to diagnose and fix the CI failures");
console.log(firstTurn.finalResponse);

const secondTurn = await thread.run("Implement the plan");
console.log(secondTurn.finalResponse);
```

### Resuming a Previous Thread

Sessions persist in `~/.codex/sessions`. Resume using a saved thread ID:

```typescript
const savedThreadId = process.env.CODEX_THREAD_ID!;
const thread = codex.resumeThread(savedThreadId);
await thread.run("Pick up where you left off");
```

---

## Streaming Responses

Use `runStreamed()` for real-time progress tracking. It yields structured events as they arrive instead of waiting for full execution.

```typescript
const { events } = await thread.runStreamed(
  "Diagnose the test failure and propose a fix"
);

for await (const event of events) {
  switch (event.type) {
    case "item.completed":
      console.log("item", event.item);
      break;
    case "turn.completed":
      console.log("usage", event.usage);
      break;
  }
}
```

> `runStreamed()` buffers events until completion, unlike the non-streaming variant which waits for full execution before returning.

---

## Structured Output

### With Raw JSON Schema

```typescript
const schema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    status: { type: "string", enum: ["ok", "action_required"] },
  },
  required: ["summary", "status"],
  additionalProperties: false,
} as const;

const turn = await thread.run("Summarize repository status", {
  outputSchema: schema,
});
console.log(turn.finalResponse);
```

### With Zod (via `zod-to-json-schema`)

```typescript
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const schema = z.object({
  summary: z.string(),
  status: z.enum(["ok", "action_required"]),
});

const turn = await thread.run("Summarize repository status", {
  outputSchema: zodToJsonSchema(schema, { target: "openAi" }),
});
```

---

## Image Attachments

Pass structured entries as the prompt to include images alongside text:

```typescript
const turn = await thread.run([
  { type: "text", text: "Describe these screenshots" },
  { type: "local_image", path: "./ui.png" },
  { type: "local_image", path: "./diagram.jpg" },
]);
```

- Text entries are merged into the final prompt string
- Images are passed to the CLI via `--image` flags

---

## Configuration

### Working Directory

```typescript
const thread = codex.startThread({
  workingDirectory: "/path/to/project",
  skipGitRepoCheck: true, // bypass Git repo validation
});
```

By default, a Git repository is required. Use `skipGitRepoCheck: true` to bypass.

### Environment Variables

```typescript
const codex = new Codex({
  env: {
    PATH: "/usr/local/bin",
  },
});
```

The SDK injects required variables like `CODEX_API_KEY` automatically. Set `baseUrl` to override API endpoints via `--config openai_base_url=...`.

### CLI Configuration Overrides

Pass Codex CLI configuration as a flattened JSON object:

```typescript
const codex = new Codex({
  config: {
    show_raw_agent_reasoning: true,
    sandbox_workspace_write: { network_access: true },
  },
});
```

The SDK serializes nested objects to dotted paths and emits them as repeated `--config key=value` arguments.

> **Note:** Thread-level options override global configuration settings due to emission ordering.

---

## Project Structure

```
sdk/typescript/
├── src/          # Main source code
├── samples/      # Usage examples
├── tests/        # Test suite
├── tsconfig.json
├── .eslintrc
├── jest.config.js
└── prettier.config.js
```

---

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Thread** | A stateful conversation session. Persists in `~/.codex/sessions` |
| **Turn** | One `run()` call — user input → agent work → result |
| `turn.finalResponse` | Final text output from the agent |
| `turn.items` | All structured items produced during the turn |
| `runStreamed()` | Async generator yielding events in real-time |
| `outputSchema` | JSON Schema to constrain agent's structured output |
| `workingDirectory` | Sets the CWD for the agent's execution context |
| `skipGitRepoCheck` | Bypass Git repo requirement for the working directory |
| `config` | Passthrough CLI config as dotted key-value pairs |
| `env` | Override environment variables passed to the CLI process |
