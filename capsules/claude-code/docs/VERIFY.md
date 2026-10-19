# Verify (Claude Code)

```bash
claude --version
npm install
node test/e2e/conformance.ts claude
```
Expect `claude 10/10` and `test/e2e/artifacts/claude.json`.

Debugging: `claude process exited` means the CLI died; run `claude -p hi` to confirm the login. A turn stuck waiting usually means an unanswered `permission_requested`.
