# Codexkit Service Vision

## Why This Exists

`@ouim/codexkit` started as a high-level Node wrapper around `codex app-server`, but the more durable product direction is larger than a wrapper.

The real goal is a deployable Codex runtime that can live on a VPS, home lab, self-hosted runner, or container host and be called from anywhere through HTTP, webhooks, scheduled jobs, and automation flows.

In other words:

- not just "run Codex from Node"
- but "run a remotely callable Codex worker with persistent identity, storage, and integrations"

That makes this project more like an automation runtime than a simple SDK.

## Core Product Direction

The best deployment model is:

- Codex runs inside the service environment itself
- the service owns a persistent `~/.codex` home
- auth is performed once by a human during bootstrap
- the runtime then remains callable through APIs and integrations

This avoids the brittle design where a container tries to reach outside itself to borrow the host machine's Codex installation or auth state.

## Working Assumptions

- A user can access the machine at least once to authenticate Codex manually
- That one-time bootstrap is acceptable for the first versions
- Persistent storage is available for `~/.codex`
- A dedicated GitHub bot account can be configured for automation work
- Later, the project may be open sourced and documented as a self-hostable automation stack

## Recommended Runtime Model

Run a long-lived service process with these responsibilities:

- own the Codex process lifecycle
- spawn and supervise `codex app-server`
- expose HTTP endpoints for jobs and workflows
- persist job history, thread ids, and workspace metadata
- maintain local workspaces or clones for repositories
- route webhooks into Codex jobs
- optionally expose streaming output to clients

Conceptually:

```text
HTTP / Webhooks / Schedules
            |
            v
      codexkit-server
            |
            v
      codex app-server
            |
            v
     local workspaces + ~/.codex
```

## Auth Model

For now, the right auth story is operational rather than programmatic:

1. install the service
2. install Codex CLI
3. authenticate Codex one time on the machine
4. persist `~/.codex`
5. run the service normally afterward

This is acceptable for:

- VPS installs
- home lab deployments
- long-lived VMs
- Docker containers with mounted persistent volumes

This should be treated as the initial bootstrap flow, not as a hidden hack.

### What To Avoid

- Do not design around copying a developer's personal `auth.json` into random environments
- Do not make containers depend on the host machine's Codex binary or home directory
- Do not assume CI-style ephemeral environments are the primary target

## Docker Position

Docker is still viable, but only when the container owns its own Codex environment.

Recommended container posture:

- ship Codex CLI with the image
- mount a persistent volume for `~/.codex`
- mount or create persistent workspace directories
- perform one-time auth inside the running container or on the mounted volume

That gives a clean operational model:

- container restarts are fine
- Codex state survives restarts
- the service remains self-contained

## GitHub Automation Position

The service should support a dedicated GitHub bot account as a first-class workflow.

That means:

- `gh` should be available in the runtime
- the bot account should authenticate once during setup
- the bot should be invited to repos/orgs as needed
- Codex jobs should be able to act through that bot identity

Likely capabilities:

- clone repos
- inspect branches, PRs, and issues
- create branches
- commit changes
- push updates
- open PRs
- respond to automation triggers

This fits the intended usage much better than treating GitHub as an optional afterthought.

## Product Surface

The future product likely has two layers.

### 1. Library Layer

Keep `@ouim/codexkit` as the Node wrapper around `codex app-server`.

Its job:

- process lifecycle
- auth helpers
- thread/session abstraction
- event streaming
- approval handling
- raw app-server escape hatch

### 2. Service Layer

Build a companion runtime on top of the library.

Possible identity:

- `codexkit-server`
- `codexkit-runtime`
- `codexkitd`

Its job:

- expose HTTP endpoints
- register prompts and workflows
- manage workspaces
- persist job state
- integrate with GitHub and webhooks
- enforce runtime policy and multi-tenant boundaries if needed later

## First Version Scope

The first version should optimize for "cool things that can be tested quickly" rather than broad platform ambition.

### Phase 1: Single-Machine Daemon

Build a local daemon/service that:

- starts and supervises `codex app-server`
- checks whether Codex is authenticated
- exposes a minimal HTTP API
- runs prompts against a configured workspace
- returns final output and optional streamed events

Example early endpoints:

- `POST /run`
- `POST /threads/:id/run`
- `GET /health`
- `GET /account`

### Phase 2: Prompt and Workflow Actions

Support actions triggered over HTTP.

Two useful action types:

- prompts as actions
- scripts/workflows as actions

Examples:

- `POST /actions/review-pr`
- `POST /actions/fix-ci`
- `POST /actions/repo-summary`

Action sources could be:

- inline prompt text
- markdown prompt files
- JavaScript or TypeScript workflow scripts
- optional manifests only where they add real value

This is likely where the project becomes immediately fun and useful.

### Phase 3: GitHub Bot Automation

Make GitHub automation a core path.

Initial features:

- webhook receiver
- verify webhook signatures
- map events to actions
- run Codex in a checked-out workspace
- create commits/PRs via bot account

This enables the original vision:

- mentionable automation
- repo workflows
- issue/PR response
- background engineering tasks

### Phase 4: Packaging and Docs

Once the local daemon and GitHub path work, package the whole thing for outside users.

Deliverables:

- Docker image
- install guide
- one-time auth guide
- GitHub bot setup guide
- persistent volume guide
- example workflows

At that point, open source distribution starts making sense.

## Suggested Filesystem Model

The service will likely need explicit directories for:

- `~/.codex` for Codex auth and runtime state
- `/srv/codexkit/workspaces` for cloned repos or checked-out projects
- `/srv/codexkit/actions` for prompt files and workflow definitions
- `/srv/codexkit/data` for service metadata and job state
- `/srv/codexkit/logs` for operational logs

The exact paths do not matter yet, but the separation does.

## Suggested Action Model

An action should be a named executable unit that the service can invoke.

Possible shape:

- name
- description
- input schema
- workspace rules
- prompt source
- model/sandbox defaults
- optional GitHub behavior

The preferred UX should be script-first, not YAML-first.

That means developers should be able to write real JavaScript or TypeScript workflow files that live on the machine and are invoked by name over HTTP.

This could live as files in a directory, for example:

```text
actions/
  repo-summary.md
  review-pr.md
  fix-ci.md
  sync-labels.ts
  triage-issue.ts
  review-pr.ts
```

The `.md` actions are useful for dead-simple prompt workflows.

The `.ts` or `.js` actions are the more important long-term shape because they allow:

- validation
- branching logic
- preflight checks
- repository prep
- multiple Codex calls in a single workflow
- post-processing
- GitHub automation steps

This is closer to the right mental model:

- workflows as code
- locally hosted
- remotely triggerable

Not:

- giant YAML pipelines
- declarative-only config systems
- vendor-controlled workflow DSLs

Manifests can still exist later, but only as lightweight metadata around script workflows where useful.

For example:

```text
actions/
  review-pr/
    action.json
    run.ts
  fix-ci/
    action.json
    run.ts
```

But the key point is that the script is the product surface, and manifests are optional support files.

That would let users self-host and add custom workflows without recompiling the service.

## Approvals and Safety

A deployable Codex runtime needs a clear opinion on approvals and permissions.

For the early version:

- prefer explicit workspace boundaries
- prefer `workspace-write` over broader access when possible
- keep approval policy configurable per action
- log every command and file change event
- make GitHub operations traceable

If this becomes a bot that can act inside real repositories, auditability matters.

## Key Product Insight

The central shift is:

- from a wrapper around Codex
- to a hostable Codex automation runtime

That means the main design objects are no longer only:

- thread
- turn
- stream

They become:

- service
- worker
- action
- workspace
- identity
- webhook
- audit log

This is the layer where the original vision actually lives.

## Proposed Near-Term Roadmap

1. Keep the current library stable as the transport and runtime core
2. Add a small daemon/server package on top of it
3. Implement one-machine local execution with persistent state
4. Add action loading from prompt files
5. Add HTTP-triggered runs
6. Add GitHub bot support and webhook handling
7. Package for Docker and document setup

## Practical Bootstrap Story for Future Users

The eventual setup story should feel this simple:

1. install `codexkit-server`
2. install or bundle Codex CLI
3. run `codex auth` once on the machine
4. run `gh auth login` once for the bot account
5. start the service
6. trigger actions over HTTP or GitHub webhooks

In human terms:

- Codex auth
- GitHub bot auth
- done

That is probably the right north star for the project.
