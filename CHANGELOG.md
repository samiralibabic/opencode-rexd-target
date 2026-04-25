# Changelog

## v0.3.2 - 2026-04-25

- Update metadata contract for latest OpenCode (PR #21244): emit `patch` field in per-file diff objects instead of legacy `diff`/`before`/`after` fields.
- `PatchUiFile` type now uses `patch` instead of `diff`, `before`, `after`.
- Edit tool metadata uses `filediff.patch` instead of `filediff.before/after`.
- Apply-patch tool metadata uses `files[].patch` instead of `files[].diff/before/after`.
- Top-level `metadata.diff` retained for full unified diff.

## v0.3.1 - 2026-03-26

- Refresh chat-scoped session `lastUsedAt` during normal target use so active sessions are not pruned as stale after long-lived use.
- Remove the obsolete repo-local `.opencode/rexd-state.json` ignore entry.

## v0.3.0 - 2026-03-26

- Scope active target selection and connection reuse by OpenCode chat session instead of project directory.
- Persist session state under `~/.config/opencode/rexd-target/sessions/` using hashed session filenames and opportunistic stale-state pruning.
- Rename the spec document to remove MVP naming and update docs for the session-scoped behavior.

## v0.2.7 - 2026-03-19

- Add target-level `loginShell` compatibility setting in `targets.json`.
- Keep agent-facing `bash` tool arguments unchanged while forwarding login-shell compatibility to `rexd` when enabled.
- Document predictable non-login default and legacy login-shell compatibility mode.
