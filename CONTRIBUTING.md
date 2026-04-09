# Contributing

Thanks for taking an interest in `@ouim/agentkit`.

## Development

```bash
npm install
npm run typecheck
npm test
```

Examples are available under [`examples/`](./examples).

## Pull Requests

- Keep changes focused and intentional.
- Add or update tests for user-visible behavior.
- Prefer provider-neutral API improvements first, with provider-specific escape hatches only where needed.
- Update docs when behavior or expectations change.

## Release Priorities

The project values:

- stable runtime contracts
- predictable session lifecycle semantics
- good Windows behavior for local CLI runtimes
- clear provider-neutral primitives with explicit escape hatches
