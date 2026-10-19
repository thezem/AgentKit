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
