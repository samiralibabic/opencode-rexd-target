# Changelog

## v0.3.15 - 2026-11-09

- Percent-encode whitespace (and a literal %) inside each resolved local rm operand, so a quoted or escaped path with spaces or tabs yields one pattern token: allow rules for the scratch area and project paths match it, and rules aimed at several paths in one pattern no longer misread it.
- A single absolute path containing ` project:` or ` /tmp/agents/` in its name can no longer match a rule written for a second, allowed operand.
- Unresolved operands, whole-line fallbacks, options, and remote patterns keep their source text.

## v0.3.14 - 2026-11-07

- Same changes as v0.3.13, which was tagged but not released because a test used a machine-specific path; the test now uses the system temp directory.

## v0.3.13 - 2026-11-07

- Resolve literal same-command-line variables in local rm and cd operands, including plain export assignments, without consulting the environment or executing shell text.
- Expand literal for-in loop values into separate rm permission patterns; keep uncertain assignments, branches, and dynamic lists unresolved.
- Add opt-in project-relative rm permission patterns for verified session Git roots, excluding repository roots, Git metadata, nested repository/worktree roots, and glob-bearing paths.
- Document ordered project permission rules and preserve remote scopes and existing temporary-directory policies.

## v0.3.12 - 2026-11-06

- Check every nested Bash command with the same Tree-sitter command-node traversal as OpenCode, closing compound-command permission bypasses without whole-line hash guards.
- Check local rm operands individually, resolving literal paths against the tool working directory and statically successful cd chains while preserving dynamic operands and remote target scopes.
- Retain recovered command checks and uncovered error text on malformed input; abort on parser failure instead of weakening permission checks.

## v0.3.11 - 2026-09-05

- Add session-aware model context for target discovery, active routing, and fail-closed target-state errors.
- Show target aliases together with their endpoints, descriptions, and configured remote working directories.
- Reload the target registry on use and discard connections whose target configuration changed.
- Clarify model-facing `target` and `bash` guidance around configured targets and intentional direct SSH use.

## v0.3.10 - 2026-08-07

- Parse Bash path operands with `tree-sitter-bash` and OpenCode's command-based filesystem classification instead of scanning unsupported command text with a broad path regex.
- Stop regexes, URLs, routes, and other slash-prefixed command data from causing false `external_directory` prompts in compound Bash syntax.
- Preserve RexD's target-scoped remote permissions, `find` root checks, and real redirection checks while matching OpenCode's handling of dynamic operands and glob prefixes.
- Ship namespaced Tree-sitter runtime and Bash grammar assets with the plugin installer and release archive.

## v0.3.9 - 2026-07-31

- Request exact `external_directory` permission for external files instead of widening access to their parent directory.
- Keep directory reads, searches, and working directories scoped to their actual contents.
- Remove the `v0.3.8` `/dev/null` permission bypass so OpenCode configuration remains authoritative.

## v0.3.8 - 2026-07-31

- Treat the exact local or remote `/dev/null` shell path as harmless without allowing other `/dev` entries.

## v0.3.7 - 2026-07-23

- Match native OpenCode shell command-family approvals for local fallback and compound commands.
- Namespace all remote permission patterns by target so approvals cannot leak to local execution or another target.
- Resolve subagent target state dynamically through the nearest parent session, including immediate parent-clear behavior and fail-closed corrupt ancestry.
- Keep `/target` slash-command prompt behavior unchanged pending upstream no-reply hook support.

## v0.3.6 - 2026-07-23

- Add explicit OpenCode permission checks, capability enforcement, cancellation, bounded ordered command output, and hardened session/SSH cleanup.
- Return edit and patch UI metadata directly through the public plugin API and rename `bash.timeout_ms` to `timeout` (with temporary compatibility support).
- Update the tested OpenCode plugin dependency and CI coverage.

## v0.3.5 - 2026-06-18

- Fix `read` tool parity with current OpenCode for images and PDFs: local and remote reads now return media attachments instead of decoding binary data as UTF-8 text.
- Add directory read output and unsupported-binary rejection to the `read` override.
- Add first-party Bun coverage for text, directory, media, binary, and remote base64 read helpers.

## v0.3.4 - 2026-05-15

- Fix source-side remote path guard when `/` is configured as the workspace root.
- Update documentation and installer guidance for `rexd v0.1.5`.

## v0.3.3 - 2026-04-25

- Include the local `apply_patch` metadata fix in the release: top-level `metadata.diff` is now built from `files[].patch`.
- Bump the plugin client version reported to REXD to `0.3.3`.

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
