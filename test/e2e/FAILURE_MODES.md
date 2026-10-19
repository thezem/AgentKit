# How the unified layer can fail

Written before the conformance E2E. Each line names the check that covers it.

| # | Failure | Covered by |
| - | --- | --- |
| 1 | CLI missing / not signed in, but `isAvailable()` says yes | `available`, `catalog` (catalog needs a working login) |
| 2 | Catalog empty or models lack ids (pickers render nothing) | `catalog` |
| 3 | Turn never reaches a terminal event (UI spins forever) | every `run` has a timeout |
| 4 | Final text lost: deltas not stitched or emitted twice | `basic-turn` checks exact `pong` |
| 5 | Events for a turn carry the wrong/no turnId, so `run()` misses them | `basic-turn` (run result built only from turn-scoped events) |
| 6 | Permission request never surfaces (tool silently runs or hangs) | `permission` expects a `permission_requested` |
| 7 | Allow reply goes to the wrong wire field, so the tool is still blocked | `permission` checks the file exists afterwards |
| 8 | Tool call arrives untyped (`unknown`) so UIs can't render diffs/commands | `permission` checks `detail.type` |
| 9 | Interrupt doesn't stop the turn, or leaves the session wedged | `interrupt` then `after-interrupt` turn must complete |
| 10 | Handle not durable: resume loses conversation memory | `resume` asks what word was used earlier |
| 11 | Mode switch accepted but not applied | `mode-switch` reads back `info().modeId` |
| 12 | History replay drops the user's messages | `history` |
| 13 | Background processes leak after `shutdown()` | `cleanup` counts child processes |
| 14 | Transcript projection disagrees with run result | `transcript` compares last assistant text |
| 15 | Rewind drops the wrong messages or leaves the session unusable | `rewind` checks history and runs a turn after |

## Durable layer (store, submissions, inbox, fork, compact)

Written before `test/e2e/durable.ts`. Each line names the check that covers it.

| # | Failure | Covered by |
| - | --- | --- |
| 16 | Process dies mid-turn and the UI loses text it already showed | `crash`: everything the child printed is in the restored transcript |
| 17 | Crashed turn comes back still "running" forever | `crash`: restored status is idle, submission is `interrupted` |
| 18 | Crashed turn is silently re-sent on boot (double side effects) | `crash`: no new turn appears after restore until we submit |
| 19 | Same `requestId` submitted twice runs two turns (retry after a network blip) | `idempotency`: one turn, same submission id, both waits resolve to it |
| 20 | `kit.submission(id)` can't find a turn from another process | `crash` + `reattach`: lookup after restart returns the stored record |
| 21 | Queued prompt is invisible, or withdraw races and runs it anyway | `inbox`: item shows in `transcript.inbox`, withdrawn one never runs |
| 22 | `whenBusy: 'reject'` queues instead of failing (UI double-sends) | `inbox`: throws `SESSION_BUSY` |
| 23 | `whenBusy: 'steer'` on a provider without steer is lost | `inbox`: falls back to the inbox and still runs |
| 24 | Fork mutates the original conversation | `fork`: original history unchanged, fork lacks the later message |
| 25 | Fork handle isn't resumable | `fork`: a turn runs on the forked session and remembers early context |
| 26 | Compact wedges the session or wipes memory entirely | `compact`: next turn completes and still recalls the key word |

## Skills (discovery, search, `$skill` expansion)

Written before `test/e2e/skills.ts`. Ground truth from this machine: 278 SKILL.md files, ~160 names; Claude lists ~/.claude/skills, OpenCode lists .claude + .agents, Codex `skills/list` says ~/.codex + ~/.agents (+ nested, system, plugin; some disabled).

| # | Failure | Covered by |
| - | --- | --- |
| 27 | Same skill listed 2–3× (copies in .claude/.codex/.agents) | `discovery`: names unique, copies under `sources` |
| 28 | Drifted copies silently hidden | `discovery`: a planted differing copy appears in `variants` |
| 29 | Project skill loses to a user skill with the same name | `discovery`: planted project skill wins |
| 30 | `visibleTo` lies: says a provider loads a skill it doesn't | `visibility`: matches Claude/OpenCode `commands()` and Codex `skills/list` (disabled ones excluded) |
| 31 | Search misses exact names or ranks description hits above name hits | `search` |
| 32 | `$PATH`, `$5`, `$unknown`, `a$b` get rewritten | `expand`: untouched |
| 33 | Expansion moves or alters surrounding text | `expand`: text outside the token is byte-identical |
| 34 | The model ignores the tag (never reads the skill) | `invoke`: temp skill demands a nonce reply, every provider returns it |
| 35 | Codex gets the tag instead of its native skill item, or both | `invoke` (codex): text keeps `$name`, input carries `{type:'skill'}` |

## Tool hub (one MCP registry for every provider)

Written before `test/e2e/hub.ts`. The hub connects upstream servers once and exposes each on `127.0.0.1:<port>/<secret>/<name>`; every session gets those URLs.

| # | Failure | Covered by |
| - | --- | --- |
| 36 | A provider can't call a hub server's tool (transport mismatch) | `call:<provider>`: stdio fixture tool returns a nonce through the hub, all three |
| 37 | Native (in-process) tools unreachable from a provider | `native:<provider>`: hub-registered function returns a nonce |
| 38 | Hub servers duplicated by the CLI's own MCP config | `exclusive`: Claude strict config; Codex config.toml servers report `disabled`; OpenCode lists only hub names |
| 39 | A disabled server still reaches new threads | `toggle`: disabled server absent from the next session's MCP config |
| 40 | Upstream crash wedges the hub or every session | `status`: killed upstream goes `failed`, others stay `connected`; refresh reconnects |
| 41 | Anyone on the machine can call your tools through the port | `auth`: wrong secret → 404, no tool list |
| 42 | Config lost or corrupted across restarts | `persist`: servers + toggles + load mode survive a new hub on the same file |
| 43 | Import duplicates or drops servers | `import`: names from all CLI configs, deduped, existing entries untouched |
