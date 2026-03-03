# OpenCode × REXD Target Plugin MVP Spec (Revised)

## Goal

Make remote targets feel **native** in OpenCode.

Primary UX:
- `/target use <machine>`
- `/target status`
- `/target clear`
- `/target list`

After target selection, the agent should keep using the **same built-in tool names** (`bash`, `read`, `write`, etc.), but execution is transparently routed to the selected remote machine via REXD.

That means no “local vs remote tool” decision is pushed onto the model.

---

## Core Design Decisions (important)

1. **Transparent routing, not `rexd_exec`**
   - Do **not** introduce a separate shell tool for the model to choose.
   - Instead, override OpenCode built-in tools by name (`bash`, `read`, `write`, etc.) and route based on active target.
   - When no target is active, wrappers can either pass through to local behavior (later) or behave as normal local built-ins by not being enabled.

2. **SSH stdio is MVP transport**
   - Primary transport is `ssh <host> /usr/local/bin/rexd --stdio`.
   - HTTP/WS remain supported, but are not the first/default path for your workflow.

3. **PTY support is part of MVP scope**
   - OpenCode’s built-in `bash` behavior is synchronous/non-interactive, so PTY must be exposed via dedicated tools (similar UX to existing PTY plugins).
   - REXD already has PTY methods, so the adapter should expose them.

4. **File-tool parity is a first-class milestone**
   - Shell-only is not enough.
   - The agent must be able to read/write/edit/list/search remote files transparently once a target is active.

5. **Client-first compatibility is the right architecture**
   - We adapt to harnesses (OpenCode first).
   - The “REXD compatibility profile” is a derived contract from what harnesses actually need, not something clients must adopt wholesale.

---

## Why this approach is better

It matches your actual usage model:
- You start OpenCode locally.
- You select a remote target.
- The agent behaves as if it is operating inside that target’s workspace.
- The model does not need to reason about “destination” or pick different tools.

This avoids:
- tool duplication bloat (`bash_local`, `bash_remote`, `rexd_exec`, etc.)
- prompt instructions that rely on the model to remember routing rules
- fragile “please use X tool” steering

---

## MVP Scope (Revised)

### In scope (MVP)

### A) `/target` command UX
- `/target list`
- `/target use <alias>`
- `/target status`
- `/target clear`

### B) Persistent target state
- Active target per project (preferred)
- Optional global default target

### C) Transparent built-in tool routing (remote parity)
Override these OpenCode tool names and route to REXD when a target is active:
- `bash`  → REXD `exec.*`
- `read`  → REXD `fs.read`
- `write` → REXD `fs.write`
- `list`  → REXD `fs.list`
- `glob`  → REXD `fs.glob`
- `grep`  → implemented via remote `bash` (ripgrep/grep) or native REXD extension later
- `edit` / `patch` parity (see "File parity strategy" below)

### D) SSH stdio transport in plugin
- Plugin spawns `ssh ... rexd --stdio`
- JSON-RPC NDJSON over stdio
- Session reuse + reconnect handling

### E) PTY tools (remote interactive support)
Expose dedicated PTY tools backed by REXD PTY methods:
- `pty_spawn` (or `rexd_pty_spawn`)
- `pty_write`
- `pty_read`
- `pty_list`
- `pty_kill`

(Exact naming can match OpenCode PTY ecosystem conventions for better agent familiarity.)

### F) Prompt/session awareness
- Inject a short active-target line in prompt context (alias + remote cwd)
- Keep it minimal and factual

---

## Out of scope (MVP)

- Multi-target orchestration in a single prompt
- Secret management UI
- Fancy target badges / status bar widgets
- LSP forwarding over REXD (can come later)
- Background router daemon (`rexdctl`) as a hard dependency

---

## OpenCode Integration Constraints (what is real today)

1. **Custom slash commands are prompt-based**
   - `/target` should still be created via command file so it is discoverable.
   - Plugin intercepts and handles it without agent reasoning (best-effort depending on hook behavior).

2. **Plugins can hook command + tool execution**
   - This is the right place for target state and routing guardrails.

3. **Custom tools can override built-ins by name**
   - This is the key mechanism for transparent routing.

---

## Revised Architecture

## Components

### A) OpenCode plugin (`opencode-rexd-target`)
Responsibilities:
- `/target` command interception + handling
- target registry loading
- state persistence (project/global)
- prompt injection (active target context)
- SSH stdio client management (or delegates to transport module)
- optional permission/guardrail prompts for remote-root escapes

### B) OpenCode custom tool wrappers (`.opencode/tools/` or global tools)
Responsibilities:
- override built-in tool names with the same names
- same schemas/UX as built-ins
- route to local or remote execution depending on active target

This is the transparency layer.

### C) Target registry (`~/.config/rexd/targets.json`)
Stores aliases + SSH/HTTP transport details.

### D) REXD on remote hosts
Already running (or invokable over SSH stdio).

---

## File/Folder Layout (recommended)

Global plugin + tools:
- `~/.config/opencode/plugins/rexd-target.ts`
- `~/.config/opencode/commands/target.md`
- `~/.config/opencode/tools/bash.ts`
- `~/.config/opencode/tools/read.ts`
- `~/.config/opencode/tools/write.ts`
- `~/.config/opencode/tools/list.ts`
- `~/.config/opencode/tools/glob.ts`
- `~/.config/opencode/tools/grep.ts`
- `~/.config/opencode/tools/edit.ts` (if included in MVP cut)
- `~/.config/opencode/tools/patch.ts` (if included in MVP cut)
- `~/.config/opencode/tools/pty-*.ts` (PTY tools)

REXD config/state:
- `~/.config/rexd/targets.json`
- `~/.config/rexd/opencode-state.json` (optional global default)

Project state:
- `.opencode/rexd-state.json`

---

## Target Registry Spec (v1, revised)

File: `~/.config/rexd/targets.json`

### Schema

- `version`: number
- `targets`: object keyed by alias

Each target:
- `transport`: `ssh` | `http` | `ws`
- `description`: string (optional)
- `defaultCwd`: string (optional)
- `workspaceRoots`: string[] (recommended UX roots; where sessions normally start)
- `rootPolicy`: object (optional, adapter-side path behavior)
  - `mode`: `strict` | `allow_within_server_roots` | `ask_on_escape` (planned)
  - `extraRoots`: string[] (optional additional UX-allowed roots)
- `capabilities`: object (optional hints)
  - `shell`: boolean
  - `fs`: boolean
  - `pty`: boolean

### SSH target fields (MVP-default)
- `host`: string
- `user`: string (optional)
- `port`: number (optional)
- `identityFile`: string (optional)
- `command`: string (optional, default `/usr/local/bin/rexd --stdio`)
- `sshOptions`: string[] (optional)

### HTTP/WS target fields (supported, not primary)
- `url`: string
- `token`: string (optional)
- `headers`: object (optional)

Notes:
- REXD server config remains the hard security boundary (allowlisted roots on the remote server).
- `workspaceRoots` are the adapter’s default/UX roots (where the agent starts and is expected to operate).
- `rootPolicy` controls what happens when the agent tries to leave those UX roots.
- `defaultCwd` should be inside `workspaceRoots`.

---

## State Model

State must live outside model context and be managed by plugin/tool code.

### Project state (preferred)
`.opencode/rexd-state.json`

Fields:
- `activeTargetAlias`: string | null
- `remoteCwdOverride`: string | null (optional)
- `lastUsedAt`: timestamp

### Global state (optional)
`~/.config/rexd/opencode-state.json`

Fields:
- `defaultTargetAlias`: string | null

### In-memory runtime state
- `openCodeSessionId -> targetAlias -> rexdSession`
- `ssh connection handle` (if persistent)
- `pending requests map`
- `pty session map` (OpenCode session -> REXD PTY ids, optional)

---

## Slash Command Design (`/target`)

## Command file (`target.md`)

Create a standard custom command so `/target` appears in OpenCode.

Command content should be a marker payload the plugin can recognize, e.g.:
- `__REXD_TARGET__ $ARGUMENTS`

Supported subcommands (MVP):
- `/target list`
- `/target use <alias>`
- `/target status`
- `/target clear`

Optional:
- `/target cwd <path>`
- `/target ping`

---

## Plugin Hook Strategy (Revised)

Use the documented hooks and keep interception deterministic.

## 1) `tui.command.execute` (primary `/target` interception)

Purpose:
- detect `/target` marker payload
- parse subcommand
- execute plugin action immediately
- avoid unnecessary LLM involvement

Behavior:
- parse `list|use|status|clear`
- update state
- emit confirmation message/toast/log

If the current OpenCode version cannot fully suppress normal slash-command flow:
- plugin still performs the action
- returns a short synthetic result to minimize noise

---

## 2) `tui.prompt.append` (active target context injection)

Purpose:
- append concise, non-LLM-dependent execution context

Injected content when target is active:
- active target alias
- remote cwd (effective)
- remote workspace roots (shortened)
- note that shell/file tools are routed to target

Keep it very short.

---

## 3) `tool.execute.before` (guardrails + telemetry)

Purpose:
- guard accidental mismatches
- validate remote paths/cwd before sending to REXD
- add target metadata to logs

Examples:
- If target active and path escapes configured `workspaceRoots`, block or ask
- If target active but target lacks `pty` and model calls `pty_spawn`, return clear error
- If target inactive and remote-only PTY tool is used, return “No active target”

---

## Transparent Tool Override Strategy (core)

This is the most important change.

## Principle

Override OpenCode built-ins by **the same tool names** so the agent does not choose local vs remote.

### `bash` (remote shell)
- Same tool name: `bash`
- Same argument shape as OpenCode expects
- When target active:
  - route to REXD `exec.start/exec.wait` (or equivalent client helper)
- When no target active:
  - optional pass-through to local shell (phase choice)

### `read` / `write` / `list` / `glob`
- Same tool names and argument schemas
- Convert relative paths to remote cwd
- Enforce remote-root constraints
- Route to REXD `fs.*`

### `grep`
MVP options:
1. **Fastest path:** route to remote `bash` using `rg`/`grep`
2. **Cleaner protocol path:** add `fs.grep` to REXD later

Start with option 1 if you want speed.

### `edit` / `patch`

For this implementation track, use **native REXD methods** (Option B) and make them part of the MVP path.

#### Option B (MVP for this spec): native REXD `fs.edit` and `fs.patch`
- Add protocol methods to REXD first (if not already present):
  - `fs.edit` (structured exact replace / edit op)
  - `fs.patch` (unified diff patch application)
- Then route OpenCode `edit` / `patch` wrappers directly to those methods.

Why this is better for your goal:
- keeps edit semantics on the execution plane (REXD), not duplicated in harness wrappers
- avoids wrapper-side diff logic drift
- makes future harness adapters simpler (Claude/Codex/etc. reuse the same server methods)

MVP implication:
- Implement `fs.edit` / `fs.patch` in REXD before finalizing OpenCode adapter parity.
- Until those methods land, `edit` / `patch` in the adapter should be marked not-yet-enabled (rather than emulated locally).

## SSH stdio Transport (MVP)

## Why SSH first

It matches your current access model exactly:
- You already SSH into these machines
- Machines are not public
- No separate HTTP exposure required

## Plugin transport behavior

For an SSH target, plugin spawns something like:
- `ssh [opts] user@host /usr/local/bin/rexd --stdio`

Then:
- speaks JSON-RPC 2.0 over NDJSON stdio
- opens/reuses REXD sessions
- multiplexes requests in-process
- handles reconnect on broken pipe

## Session reuse

Keep one SSH+REXD connection per:
- OpenCode session × target alias

If connection drops:
- recreate transparently on next tool call

---

## PTY Support (MVP)

REXD already supports PTY; OpenCode’s default `bash` UX does not cover interactive/background PTY workflows.

So expose dedicated PTY tools (MVP):
- `pty_spawn` → `pty.open`
- `pty_write` → `pty.input`
- `pty_read` → buffered reads from streamed `pty.output`
- `pty_list` → plugin-side PTY session list (mapped to REXD PTYs)
- `pty_kill` → `pty.close`
- optional `pty_resize` → `pty.resize`

### PTY output model

Implement plugin-side buffering per PTY session:
- subscribe to REXD events (`pty.output`, `pty.exit`)
- append to ring buffer
- `pty_read` returns slices / pagination

This mirrors existing PTY plugin UX and works well with agents.

---

## Remote Path + Permission Model (important)

OpenCode’s local `external_directory` permission model is based on the local working directory, but remote routing changes the execution filesystem.

So the adapter must enforce a **remote equivalent** explicitly.

## Remote workspace guard (MVP)

Treat `workspaceRoots` as the **default remote workspace** (UX boundary), but make escape behavior configurable.

### Recommended behavior

1. Start in `defaultCwd` (inside `workspaceRoots`)
2. Normal relative operations resolve inside that workspace
3. If a path/command targets outside `workspaceRoots`, apply `rootPolicy.mode`

### `rootPolicy.mode`

- `strict` (default)
  - Block path access outside `workspaceRoots` / `extraRoots`
- `allow_within_server_roots`
  - Allow access outside adapter UX roots as long as it is still allowed by the remote REXD server roots
  - Useful for your “leave project folder and touch other system paths” workflow
- `ask_on_escape` (planned)
  - Prompt user when crossing adapter UX roots, then allow once/always/reject
  - Keep the remote REXD server allowlist as the hard boundary

### Important implementation note

OpenCode’s built-in `external_directory` permission is based on the **local** working directory, so it does not map cleanly to remote-root escape prompts.
Use adapter-side enforcement for remote paths. If OpenCode exposes stable plugin permission interception for this flow later, `ask_on_escape` can mirror native ask/always/reject UX.

## Local OpenCode permissions

Keep using OpenCode permissions for local behavior and for the wrapper tool names (`bash`, `read`, `edit`, etc.).

The wrappers should additionally enforce remote-root checks before calling REXD.

---

## File Parity Strategy (practical MVP cut)

This spec now assumes **native REXD edit/patch** for parity.

### REXD prerequisite (do this first)
Add and document:
- `fs.edit`
- `fs.patch`

Once those exist, the OpenCode adapter wraps them directly.

### MVP-1 (must have for remote-first workflow)
- `bash`
- `read`
- `write`
- `list`
- `glob`
- `grep`
- `/target` commands
- SSH stdio transport
- PTY tools (`pty_*`)

### MVP-2 (complete file parity, depends on REXD methods)
- `edit` → native `fs.edit`
- `patch` → native `fs.patch`

If you add `fs.edit/fs.patch` immediately in REXD, merge MVP-2 into MVP-1.

## Minimal Internal Modules

### Plugin side
1. `targets.ts`
   - load/validate target registry
   - resolve alias

2. `state.ts`
   - project/global state read/write
   - active target get/set/clear

3. `command-handler.ts`
   - parse `/target` subcommands
   - return standard messages

4. `prompt-context.ts`
   - generate concise target status line

### Transport side
5. `transport/ssh-stdio.ts`
   - spawn ssh process
   - NDJSON framing
   - request/response map
   - reconnect

6. `transport/http.ts` (optional in MVP)
7. `rexd-client.ts`
   - protocol helpers: `session.open`, `exec.start`, `fs.read`, `fs.write`, `fs.list`, `fs.glob`, `fs.edit`, `fs.patch`, `pty.*`

### Tool wrappers
8. `tools/bash.ts`
9. `tools/read.ts`
10. `tools/write.ts`
11. `tools/list.ts`
12. `tools/glob.ts`
13. `tools/grep.ts`
14. `tools/edit.ts` / `tools/patch.ts`
15. `tools/pty-*.ts`

---

## Failure Modes and UX

### Unknown target alias
- `/target use foo`
- Return clear error + suggest `/target list`

### SSH connection failed
- Include alias + host + ssh command hint
- Keep target active (user can retry)

### REXD binary missing on remote
- Return actionable error:
  - command attempted
  - expected path (`/usr/local/bin/rexd` or configured path)

### Remote path outside allowed roots
- Block with explicit message:
  - target alias
  - requested path
  - allowed roots

### PTY unsupported on target
- If `capabilities.pty=false`, PTY tools return clear error

### State file corruption
- Fall back to no active target
- Warn, do not crash OpenCode

---

## Test Plan (MVP)

## Manual tests

### `/target`
- `/target list`
- `/target use <valid>`
- `/target use <invalid>`
- `/target status`
- `/target clear`

### Transparent routing
With active target:
- ask agent to run `pwd`
- ask agent to read/write a file
- ask agent to list/glob files
- verify behavior is remote without changing prompts/tool names

### Remote-root guard
- try reading path outside `workspaceRoots`
- verify block

### SSH stdio resilience
- kill remote `rexd`
- run next command
- verify reconnect path or clear error

### PTY
- spawn long-running process (`tail -f` or dev server)
- read output
- send input / Ctrl+C
- kill session

---

## Automated tests (recommended)

### Unit
- target registry parsing
- path normalization + remote-root containment
- `/target` command parsing
- state read/write

### Integration
- mock REXD stdio server
- NDJSON framing + request correlation
- session reuse/reconnect
- tool wrapper routing (`bash`, `read`, `write`, `list`, `glob`)

### PTY integration
- mocked event stream buffering
- `pty_read` pagination
- exit event handling

---

## Packaging Recommendation

Start with a **separate adapter repo/package** for OpenCode (for example `opencode-rexd-target`), and keep `rexd` focused on the server/protocol.

### Why separate is better initially
- independent release cadence (OpenCode adapter changes faster than REXD server core)
- cleaner ownership boundaries (execution plane vs harness adapter)
- easier to add more harness adapters later without turning `rexd` into a mono-repo too early

### What should stay in `rexd`
- protocol spec
- server implementation
- generic verification scripts
- optional shared client library later (if you extract one)

### What should live in the adapter repo
- OpenCode plugin
- OpenCode tool wrappers
- SSH stdio transport glue (or a shared client package if extracted)
- OpenCode-specific tests and fixtures

If maintenance becomes annoying across adapters, extract a shared `@rexd/client` package later and reuse it from adapter repos.

## Recommended Build Order (your shortest path)

1. Add native `fs.edit` / `fs.patch` to REXD + protocol docs
2. `/target` plugin command + project state
3. SSH stdio transport (`ssh ... rexd --stdio`)
4. Transparent `bash` override
5. `read` / `write` / `list` / `glob` overrides
6. `grep` override
7. PTY tools (`pty_*`)
8. `edit` / `patch` wrappers routed to native `fs.edit` / `fs.patch`
9. (Later) shared router + second harness adapter

---

## Acceptance Criteria (Revised MVP)

- `/target use <alias>` activates a remote machine for the current project
- Agent continues using normal OpenCode tool names (`bash`, `read`, `write`, etc.)
- Those tools transparently operate on the remote target via REXD
- SSH stdio is the default working transport
- Remote filesystem operations follow per-target remote path policy (`strict` by default), with the remote REXD server allowlist as the hard boundary
- PTY workflows are available through plugin PTY tools
- Active target state survives OpenCode restart (project-level)

---

## Why this revised spec matches your intent

---

## Build Skeleton You Can Start From

This is the practical skeleton to implement next in OpenCode.

### Folder layout

- config package
  - `~/.config/opencode/package.json`
- slash command
  - `~/.config/opencode/commands/target.md`
- plugin
  - `~/.config/opencode/plugins/rexd-target.ts`
- transparent tool overrides
  - `~/.config/opencode/tools/bash.ts`
  - `~/.config/opencode/tools/read.ts`
  - `~/.config/opencode/tools/write.ts`
  - `~/.config/opencode/tools/list.ts`
  - `~/.config/opencode/tools/glob.ts`
  - `~/.config/opencode/tools/grep.ts`
  - `~/.config/opencode/tools/edit.ts`
  - `~/.config/opencode/tools/patch.ts`
  - `~/.config/opencode/tools/pty_spawn.ts`
  - `~/.config/opencode/tools/pty_read.ts`
  - `~/.config/opencode/tools/pty_write.ts`
  - `~/.config/opencode/tools/pty_list.ts`
  - `~/.config/opencode/tools/pty_kill.ts`
- shared adapter code
  - `~/.config/opencode/rexd-target/targets.ts`
  - `~/.config/opencode/rexd-target/state.ts`
  - `~/.config/opencode/rexd-target/path-guard.ts`
  - `~/.config/opencode/rexd-target/runtime.ts`
  - `~/.config/opencode/rexd-target/rexd-client.ts`
  - `~/.config/opencode/rexd-target/transport/ssh-stdio.ts`
- target registry
  - `~/.config/rexd/targets.json`

### Command file skeleton

`target.md` should contain a marker payload that the plugin can intercept.

- description frontmatter
- one body line with a marker string and the raw arguments placeholder

### Plugin skeleton

`rexd-target.ts` should implement three hooks:

1. `tui.command.execute`
   - detect the marker from `target.md`
   - parse subcommands `list`, `use`, `status`, `clear`
   - read and write project state in `.opencode/rexd-state.json`
   - return short messages without relying on the model

2. `tui.prompt.append`
   - append one short line like active target alias and remote cwd
   - keep it factual and short

3. `tool.execute.before`
   - block PTY calls if target says PTY is unsupported
   - add remote path guard checks for file tools

### Shared modules skeleton

`targets.ts`
- load `~/.config/rexd/targets.json`
- `getTarget(alias)`
- `listTargets()`

`state.ts`
- read project state from `.opencode/rexd-state.json`
- `setProjectTarget(projectDir, alias)`
- optional global default later

`path-guard.ts`
- resolve relative remote paths against remote cwd
- enforce `workspaceRoots` / `extraRoots`
- apply `rootPolicy.mode`
- throw clear error (or trigger planned ask-on-escape flow) when path crosses adapter UX roots

`runtime.ts`
- singleton map keyed by OpenCode session id and target alias
- store SSH transport instance
- store REXD session id
- store PTY buffers for `pty_read`

`rexd-client.ts`
- `ensureRexdSession(...)`
- `execShell(...)` using `exec.start` then `exec.wait`
- `fsRead(...)`
- `fsWrite(...)`
- `fsList(...)`
- `fsGlob(...)`
- `fsEdit(...)` (native REXD `fs.edit`)
- `fsPatch(...)` (native REXD `fs.patch`)
- PTY helpers later or now

`transport/ssh-stdio.ts`
- spawn SSH process to run `rexd --stdio`
- NDJSON request and response handling
- pending request map by JSON RPC id
- reconnect on next call if process exits

### Transparent tool wrapper pattern

Each OpenCode tool wrapper should follow the same pattern.

`bash.ts`
- read active target from project state
- load target config from registry
- resolve remote cwd
- call `execShell(...)`
- return the same shape OpenCode expects from `bash`

`read.ts`
- same active target lookup
- resolve remote absolute path
- enforce remote roots
- call `fsRead(...)`

Then repeat for:
- `write.ts` to `fsWrite(...)`
- `list.ts` to `fsList(...)`
- `glob.ts` to `fsGlob(...)`
- `grep.ts` via remote `rg` command over `execShell(...)`
- `edit.ts` to native `fsEdit(...)`
- `patch.ts` to native `fsPatch(...)`

### PTY skeleton

Add dedicated PTY tools because built in `bash` is not enough for interactive sessions.

- `pty_spawn.ts`
  - call `pty.open`
  - store returned PTY id in runtime map
- `pty_write.ts`
  - call `pty.input`
- `pty_read.ts`
  - read from plugin side ring buffer
- `pty_kill.ts`
  - call `pty.close`
- `pty_list.ts`
  - return PTY ids known for current OpenCode session and target

### First commit order

1. REXD: add `fs.edit` + `fs.patch` and update protocol docs
2. `targets.ts` and `state.ts`
3. `ssh-stdio.ts` transport
4. `rexd-client.ts` with `session.open`, shell exec, and `fs.edit/fs.patch`
5. plugin with `/target list`, `/target use`, `/target status`, `/target clear`
6. `bash.ts` transparent override
7. file tools `read`, `write`, `list`, `glob`
8. `grep.ts`
9. PTY tools
10. `edit.ts` and `patch.ts` (native methods)

### First proof test

- Start OpenCode locally in a project
- Run `/target use b`
- Ask for `pwd`
- Ask for `hostname`
- Ask for `ls`

If those execute on the remote host without changing your prompts, the adapter architecture is correct.

## Why this revised spec matches your intent

It preserves the exact mental model you want:
- harness-native UX (`/target use b`)
- no LLM routing decisions
- no “install opencode everywhere” requirement
- SSH-first for private machines
- generic execution plane (REXD) with harness adapters on top

This is the right architectural direction.

