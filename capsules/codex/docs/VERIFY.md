# Verify (Codex)

```bash
codex --version && codex login status
npm install
node test/e2e/conformance.ts codex
```

Expect `codex 10/10` and `test/e2e/artifacts/codex.json` with every check `ok: true`.

Debugging:
- `codex app-server exited (...)`: run `codex app-server` by hand; stderr tail is in the error.
- Permission never asked in `read-only`: Codex may satisfy the task without writing; use the conformance prompt.
- `timed out after 120000ms`: raise `requestTimeoutMs`.
