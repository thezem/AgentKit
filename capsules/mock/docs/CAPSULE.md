# Mock capsule

Deterministic fake provider, every capability on, no CLI or tokens. Use it to build harness UIs and in CI (`npm run verify`).

```ts
const kit = createAgentKit({ mock: { tokenDelayMs: 15 } })
const s = await kit.session({ provider: 'mock', cwd: '/tmp' })
await s.run('hello [tool] [ask]')   // permission + question round-trips
```

Directives: `[tool]` permissioned shell call, `[ask]` question, `[fail]` failed turn, `[slow]` slow stream for interrupt testing. Mode `auto` skips permission prompts. Sessions live in memory for the process lifetime.
