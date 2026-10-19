# Verify (OpenCode)

```bash
opencode --version     # v2.x
opencode auth list     # at least one provider
npm install
node test/e2e/conformance.ts opencode
```
Expect `opencode 10/10` and `test/e2e/artifacts/opencode.json`.

Debugging: `opencode serve did not start` means you should run `opencode serve --port 0` by hand. `no connected providers` means you need to run `opencode auth login`. Version mismatch: pin `@opencode/client` to your CLI version.
