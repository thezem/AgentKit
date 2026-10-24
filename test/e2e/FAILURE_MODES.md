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

## Native tools: context, cancel, results, always-on hub

Written before the `native-*` checks in `test/e2e/hub.ts`. Each session gets its own hub URLs (`/<secret>/<name>/<token>`); the token maps to that session's context.

| # | Failure | Covered by |
| - | --- | --- |
| 44 | A tool can't tell which session called it, or sees another session's context | `native-ctx:<provider>`: two sessions (different keys/cwds) call the same tool; each `ctx` matches its own session, all three |
| 45 | A forged or released session token still reaches the tools | `native-ctx`: unknown token → 404; after `session.close()` its token → 404 |
| 46 | Interrupt leaves a native tool running (or the turn hanging on it) | `native-cancel:<provider>`: interrupt mid-call aborts `ctx.signal`; a tool that ignores the signal still gets answered as canceled at once |
| 47 | Non-text results break the call (image, error, undefined, unserialisable) | `native-results`: `toolResult.image/error`, `undefined`, circular object → valid MCP results, `isError` where it should be |
| 48 | Always-present `kit.hub` changes behaviour for apps that never use it | `native-default`: kit without `hub` option and an empty hub → no port bound, no MCP config passed, CLI's own servers untouched |
| 49 | Fork/resume loses the tool context | `native-ctx`: a resumed session gets a fresh token carrying the same `key` |

## Provider servers outliving the host (#17)

Written before `test/e2e/orphans.ts`. `opencode serve` runs detached (own process group) so it can be group-killed; that also cut its lifetime loose from the host.

| # | Failure | Covered by |
| - | --- | --- |
| 50 | Host is SIGKILLed → `opencode serve` (and its children) keep running forever under init | `orphans`: host child opens an OpenCode session, gets `kill -9`; no process carrying the run's marker env survives 10s |
| 51 | The watchdog itself leaks (a `cat`/`sh` left behind) after a normal shutdown | `orphans`: graceful `kit.shutdown()` → no marked process left |
| 52 | The watchdog kills a healthy server early, or swallows the "listening" line | `orphans`: session opens and answers `server.info` through the watchdog before the kill |
| 53 | Server exits on its own → watchdog keeps the pipe-reader alive | `orphans`: kill only the `opencode` process → no marked `sh`/`cat` left |

## Attachments, plan usage, one-shot complete, paged snapshots

Written before `test/e2e/host.ts`. A thread never changes provider; none of these swap one.

| # | Failure | Covered by |
| - | --- | --- |
| 54 | The model can't read an attached file (path not reachable, or a permission prompt blocks it) | `attach-file:<p>`: a text file with a nonce; reply contains the nonce, **zero** permission prompts, all three |
| 55 | An attached image never reaches the model as an image | `attach-image:<p>`: a PNG with a word drawn in it; the model names the word (vision), on providers with `images` |
| 56 | The user's text is changed, or the transcript loses which files were attached | `attach-transcript`: `user_message.text` equals what was typed; `user_message.attachments` lists name/path/mime; survives `kit.restore` |
| 57 | Unsafe names write outside the attachments folder (`../x`, `/etc/x`) | `attach-names`: saved path stays under the session's folder |
| 58 | Plan usage throws, or invents numbers when the provider has none | `plan-usage:<p>`: Claude/Codex windows with 0–100 percent and an ISO reset; OpenCode → `UNSUPPORTED_CAPABILITY` |
| 59 | `complete()` leaves a session behind (listed, saved, process running) or uses tools | `complete:<p>`: exact-answer prompt; session list unchanged; no tool_call |
| 60 | Paged snapshot drops or duplicates items, or the cursor walks wrong | `page`: latest N + cursor, then older pages, concatenate to the full transcript exactly; live session page matches stored |

## Issue #15 leftovers: settings merge, steer replay, questions, file rewind

Written before `test/e2e/proof.ts`.

| # | Failure | Covered by |
| - | --- | --- |
| 61 | Per-session `providerOptions.settings` / `env` replace the capsule's own (fast mode, host flag settings, process env) | `claude-settings-merge`: fast + `flagSettings` + `sdkOptions.settings` + per-session `settings`/`env` all present in the options Claude gets |
| 62 | A steered message vanishes from history after a resume (stored differently from a normal prompt) | `steer-replay:<p>`: steer a nonce mid-turn, resume from the handle in a fresh kit, `history()` has a `user_message` with the nonce, all three |
| 63 | A structured question never reaches the host, or the answer never reaches the model | `question:<p>`: model must ask tea/coffee via its question tool; `kind: 'question'` arrives with options; we answer "coffee"; reply says coffee |
| 64 | File rewind leaves files as they were (or rewinds the wrong turn) | `rewind-files:<p>`: turn 1 writes "one", turn 2 overwrites with "two", rewind to turn 2's message → file says "one" again (providers with `rewindFiles`) |
| 65 | An HTTP upstream that times out, can't be reached or returns 5xx shows a legacy-SSE 405 instead of its real error | `retry-after-failure` (nothing listening → `fetch failed`, no "SSE"), `no-sse-on-5xx` (503 → the Streamable HTTP error) |
| 66 | A failed upstream stays failed until someone refreshes it, so one blip hides its tools from every new session | `retry-after-failure`: start a real Streamable HTTP server on the dead port → `connected` with 1 tool within 20s, no refresh (measured ~5s) |
| 67 | Narrowing the fallback breaks legacy servers that only speak SSE | `sse-fallback-on-405`: POST → 405, GET → real `SSEServerTransport` → `connected`, 1 tool |
| 68 | A Claude CLI that ignores an interrupt keeps working after the turn was reported canceled, so the next prompt lands mid-turn and host and CLI disagree about what is running | `claude-interrupt`: `query.interrupt()` made a no-op mid-tool → turn canceled after the grace (10s), process stopped, no events after; next turn resumes and recalls a nonce (fails before the fix: query still attached) |
| 69 | Images in tool results are lost (Claude flattens them to "[image]") or stored as base64 in every event, checkpoint and snapshot (Codex) | `tool-images`: a hub tool returns a PNG; claude + codex call it → output `{ type: "image", path }` under `attachmentsDir/<key>/tools/`, the file is the PNG, no image data in events or session rows (fails before: no path, base64 stored) |
| 70 | The host cannot change the order of queued prompts (users reorder what runs next) | `inbox-reorder` (mock): A,B,C queued behind a busy turn, `reorderInbox([C,A,B])` → inbox and run order C,A,B; unknown ids ignored, left-out entries keep order, same order = false |
| 71 | A Claude tool call is invisible while the model writes its arguments (a big Write/Edit streams for minutes), so a working thread looks dead | `claude-tool-drafts`: Haiku writes a ~900-word file; a running row with the same callId arrives the moment the call starts and grows ≥3 times (sizes never shrink, strings cut to a 2000-char tail) well before the complete call, which matches the file; `partial-json` checks the prefix parser on every cut of a document |
| 72 | Batch dictation returns nothing useful (wrong sample rate/channels sent, so the server hears noise) | `transcribe-batch`: a phonon WAV (24 kHz) with a nonce word → `kit.transcribe('claude', { data })` text contains the nonce; also the same audio as raw 16 kHz PCM16 |
| 73 | Streaming dictation shows nothing while the user talks, or loses the tail when they stop | `transcribe-stream`: the clip written in 100 ms real-time chunks → `interim` events arrive before `end()`; `end()` text contains the nonce and the last word |
| 74 | A pause in speaking drops the socket (no KeepAlive), so the rest of the dictation is lost | `transcribe-pause`: first half, 8 s of writing nothing, second half → one stream, final text has words from both halves |
| 75 | Signed out / expired sign-in crashes the host or hangs | `transcribe-signed-out`: a credentials file with an expired token (and one with none) → rejects with `AgentKitError` `SIGNED_OUT`, no socket, `stream.end()` rejects with the same, no unhandled error |
| 76 | Endpoint changed / blocked (404, Cloudflare 403, DNS) crashes or hangs instead of a typed error | `transcribe-unreachable`: base URL pointed at a loopback server answering 404 → `TRANSCRIBE_FAILED` mentioning the status, `error` event once, `end()` rejects, process keeps running |
| 77 | `abort()` leaves a socket open or keeps emitting | `transcribe-abort`: abort mid-stream → `end()` rejects with `ABORTED`, no events after abort |
| 78 | Dictation offered where it can't work | `capabilities.transcribe` true only for Claude; `kit.transcribe('codex', …)` → `UNSUPPORTED_CAPABILITY`; a non-PCM16 WAV (8-bit) → `INVALID_INPUT` |

## Audit fixes: CI, stream(), hub close race, context window, stored submissions, TOML

Written before `test/e2e/lifecycle.ts` and the new `hub-retry.ts` check.

| # | Failure | Covered by |
| - | --- | --- |
| 79 | CI and the publish workflow run `npm test`, which doesn't exist, so every run fails before the build and a release can't ship | `npm test` runs `verify` and exits 0 (CI runs exactly that) |
| 80 | `session.stream()` never ends after `close()` (a reader waiting for the next event hangs forever, though the doc says it ends on close) | `lifecycle` `stream-ends-on-close`: a waiting reader and an idle one both finish within a second of `close()` |
| 81 | Closing a hub server while it is still connecting leaves it connected (a stdio child keeps running, its tools get listed, status flips from `off` to `connected`); a connect that times out leaks the half-open client | `hub-retry` `close-during-connect`: the server answers `initialize` after 1.5 s; `remove()` at 0.3 s → no `tools/list` ever arrives and the state stays removed |
| 82 | Reading Claude's context size after a structured-output turn restarts the CLI (`ensureQuery(undefined)` sees a different schema key) | checked by hand with a probe (one Haiku structured turn): the CLI query was replaced after the turn before the fix, the same query object stays after it; not in the suite, it needs a live turn for one assertion |
| 83 | `kit.submission(id)` for a turn another process owns polls the store forever if the row is deleted, and its timer starts (and keeps the process alive) even if nobody waits | `lifecycle` `stored-wait-deleted` (row deleted → `wait()` settles `canceled`), `stored-wait-lazy` (no timer until `wait()`/`result` is used) |
| 84 | A `#` after a space inside a quoted TOML value (`"pass #1"`) cuts the value, so the imported Codex MCP server has broken args or env | `lifecycle` `toml-hash-in-string`: quoted values keep their ` #`, real trailing comments are still dropped |
