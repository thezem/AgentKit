# Codexkit MVP Implementation Plan

## Goal

Build the smallest version of the product that is:

- deployable on a single machine
- authenticated once by a human
- callable over HTTP
- capable of running prompt actions and script workflows
- useful enough to hook into real services immediately

This MVP should optimize for:

- fast demoability
- direct usefulness
- low architectural regret

It should not optimize for:

- multi-node orchestration
- SaaS-style multi-tenancy
- polished hosted platform concerns
- overly generic plugin systems

## Product Shape

The MVP should be a single-machine service composed of:

1. the existing `@ouim/codexkit` runtime core
2. a new local HTTP server
3. a local action loader
4. persistent workspaces
5. persistent Codex auth/state

The service should be runnable on:

- a VPS
- a home lab box
- a self-hosted runner
- a Docker container with mounted volumes

## What To Build First

The first real milestone is:

"Remote Codex over HTTP, with named script workflows."

If that works, the product becomes real.

## Proposed Repo Direction

Keep the current `src/` as the library core for now.

Add a new service layer in-repo rather than creating a separate repo too early.

Suggested structure:

```text
src/
  ...existing client library...

server/
  index.ts
  config.ts
  http.ts
  runtime.ts
  jobs.ts
  actions.ts
  action-loader.ts
  types.ts

actions/
  repo-summary.md
  review-pr.ts
  fix-ci.ts

data/
  .gitkeep
```

This keeps momentum high and avoids premature package fragmentation.

Later, if needed:

- publish `@ouim/codexkit` as the library
- publish `codexkit-server` as the runtime package

## MVP Runtime Responsibilities

The service layer should do five things well.

### 1. Process Supervision

- start `codex app-server`
- verify initialization
- restart if it crashes
- expose health state

### 2. Auth Health

- read current account state through `account/read`
- expose whether Codex is authenticated
- fail clearly when not authenticated
- do not try to auto-launch interactive login from API requests

### 3. Action Execution

- run inline prompts
- run prompt-file actions
- run script-based workflows
- pass workspace and input payload through to the workflow

### 4. Job Tracking

- assign a job id
- persist basic metadata
- store status transitions
- keep final output and error state

### 5. HTTP Interface

- accept requests
- validate payloads
- start jobs
- return status
- optionally stream events

## Script-First Workflow Model

This is the important product choice.

Workflows should be code, not YAML.

Developers should be able to write files like:

```text
actions/
  review-pr.ts
  fix-ci.ts
  repo-summary.md
```

Then trigger them with HTTP:

```http
POST /actions/review-pr
POST /actions/fix-ci
POST /actions/repo-summary
```

### Why This Is The Right Shape

- developers can express real logic
- workflows are versionable
- workflows can call Codex multiple times
- workflows can combine repo prep, prompting, and post-actions
- it feels like a programmable automation runtime, not a config engine

This is the part that gives the product its personality.

## Workflow API Shape

The workflow contract should be intentionally small.

Example:

```ts
export default defineAction({
  name: 'review-pr',
  description: 'Review a pull request and summarize risks',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string' },
      prNumber: { type: 'number' },
      cwd: { type: 'string' },
    },
    required: ['repo', 'prNumber'],
    additionalProperties: false,
  },
  async run(ctx, input) {
    const thread = await ctx.codex.threads.create({
      cwd: input.cwd ?? ctx.workspaceRoot,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    })

    return thread.run(`Review PR #${input.prNumber} in ${input.repo} and summarize the risks.`)
  },
})
```

The main point is not the exact API. The point is:

- one file
- one exported action
- one `run()` entry point
- service handles the rest

## Minimal Action Types

Support exactly two action types in MVP.

### 1. Prompt Actions

For simple use cases:

- file extension: `.md`
- service reads file content
- optional frontmatter later, but not required now
- HTTP input can be interpolated or appended

Good for:

- summaries
- audits
- repo explainer prompts
- simple one-shot jobs

### 2. Script Actions

For real workflows:

- file extension: `.ts`
- loaded by the server at runtime
- exports a small action definition

Good for:

- PR review flows
- issue triage
- GitHub automation
- multi-step Codex orchestration

These two modes are enough for the first usable product.

## Proposed HTTP API

Keep the first HTTP surface very small.

### Health and Runtime

- `GET /health`
- `GET /account`
- `GET /actions`

### Direct Execution

- `POST /run`

Request:

```json
{
  "prompt": "Summarize this repository",
  "cwd": "/srv/codexkit/workspaces/my-repo"
}
```

### Named Actions

- `POST /actions/:name`

Request:

```json
{
  "input": {
    "repo": "owner/repo",
    "prNumber": 123
  },
  "cwd": "/srv/codexkit/workspaces/repo"
}
```

### Jobs

- `GET /jobs/:id`
- `GET /jobs/:id/events`

If streaming feels too heavy for day one, return polling first and add SSE second.

## Suggested Execution Model

For the MVP, execute jobs in-process.

That means:

- one Node server
- one Codex transport/client instance
- one in-memory queue
- job state persisted to disk

This is enough to prove the product.

Do not start with:

- Redis
- external queues
- worker fleets
- distributed locking

Those concerns can come later.

## Suggested Persistence Model

Use simple persistence first.

Store:

- server config
- action registry cache if useful
- job metadata
- job event logs
- workspace metadata

Simple options:

- JSON files
- SQLite

My recommendation:

- use SQLite quickly if you are comfortable with it
- otherwise start with JSON files and switch only when real pressure appears

For MVP, either is fine. The key is durability, not elegance.

## GitHub Bot Plan

GitHub is part of the MVP direction, but not all of it needs to land on day one.

### MVP-Adjacent GitHub Support

Do this early:

- ship `gh` in the runtime image or install docs
- document bot account auth
- allow script workflows to shell out to `gh`

That alone unlocks a lot.

Example workflows:

- `review-pr.ts`
- `comment-on-issue.ts`
- `open-fix-pr.ts`

### Full GitHub Webhooks

Do this next:

- `POST /webhooks/github`
- verify signatures
- map event type to action
- dispatch job

This is likely phase 2, not phase 1.

## Packaging Decision

You mentioned bundling Codex CLI with the package. For the deployable runtime, that is directionally right.

There are two practical choices.

### Option A: Depend On Installed `codex`

Pros:

- simplest now
- less packaging work
- aligns with current code

Cons:

- setup is less self-contained

### Option B: Bundle Codex With Runtime

Pros:

- much nicer deploy story
- fewer external prerequisites

Cons:

- packaging complexity
- platform handling
- update strategy

Recommendation:

- for the very first MVP, keep the current external `codex` dependency
- design the runtime so bundling can be added next without redesign

That keeps you moving.

## Security and Boundaries

The MVP still needs a few hard rules.

### Runtime

- require an API token for HTTP access
- bind to localhost by default unless explicitly opened
- log action execution

### Workspaces

- require explicit workspace paths
- avoid arbitrary filesystem access by default
- prefer action-specific workspace roots

### Codex

- default to `workspace-write`
- default to `approvalPolicy: never` only for trusted local deployments
- make the policy configurable

For your own VPS, trusted-mode defaults are acceptable. For open source users, document the risks clearly.

## Suggested Milestones

### Milestone 1: Daemon Core

Deliver:

- service starts
- service starts Codex
- `GET /health`
- `GET /account`
- `POST /run`

Success criteria:

- deploy to VPS
- authenticate once
- call it remotely
- get a Codex answer back

### Milestone 2: Action Loader

Deliver:

- load `.md` actions
- load `.ts` actions
- `GET /actions`
- `POST /actions/:name`

Success criteria:

- drop a file in `actions/`
- trigger it remotely
- get a real result

### Milestone 3: Job Tracking + Streaming

Deliver:

- job ids
- persisted status
- event stream or polling endpoint

Success criteria:

- observe long-running tasks
- inspect history
- debug failures

### Milestone 4: GitHub Bot Workflows

Deliver:

- `gh`-based workflow examples
- repo checkout conventions
- one or two high-value actions

Suggested examples:

- `review-pr.ts`
- `fix-ci.ts`
- `repo-summary.ts`

Success criteria:

- bot can operate on a real repo
- action can produce or publish meaningful output

### Milestone 5: GitHub Webhooks

Deliver:

- webhook endpoint
- signature verification
- event-to-action dispatch

Success criteria:

- PR or issue event triggers a Codex workflow automatically

## Recommended Immediate Build Order

If the goal is "something I can play with as fast as possible", do this:

1. Add `server/` with a tiny HTTP server
2. Reuse the existing `createCodex()` runtime inside it
3. Implement `GET /health`
4. Implement `GET /account`
5. Implement `POST /run`
6. Add a simple `actions/` directory
7. Implement `.md` actions
8. Implement `.ts` actions
9. Add job ids and persisted history
10. Add one GitHub workflow example

That will get you to a real VPS-deployable MVP fast.

## Hard Recommendation

Do not spend the next week polishing the library in isolation.

Build the daemon now.

The library is already good enough to serve as the engine for the MVP. The main missing value is not another wrapper refinement. It is the remotely callable runtime layer.

## MVP Demo Target

The MVP is successful when you can do this:

1. SSH into a VPS once
2. authenticate Codex once
3. start `codexkit-server`
4. `curl` a prompt or action from anywhere
5. watch Codex work on a real repository
6. optionally let a GitHub bot workflow act on the result

That is the first version that matches the original vision closely enough to matter.
