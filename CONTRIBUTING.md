# Contributing

Thanks for contributing to `opencode-rexd-target`.

## Getting started

1. Fork and clone the repository.
2. Install Bun.
3. Run:

```bash
bun install
make typecheck
make build
```

## Pull request checklist

- Keep changes focused and small.
- Update docs when behavior changes.
- Ensure `bun run typecheck` succeeds.
- Ensure `bun run build` succeeds.
- Include repro steps for bug fixes.

## Commit style

- Use concise, imperative commit messages.
- Explain the "why" in PR descriptions.

## Reporting issues

Please include:

- OpenCode version
- Plugin version
- REXD version
- Target config (redacted)
- Repro steps and expected behavior
