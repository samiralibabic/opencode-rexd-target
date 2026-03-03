# opencode-rexd-target

`opencode-rexd-target` is an OpenCode plugin that makes a selected REXD target feel like local development.

Once a target is active, the plugin transparently routes shell and filesystem tools to the remote host over SSH stdio (`ssh ... rexd --stdio`).

## Features

- `/target` command handling: `list`, `use`, `status`, `clear`
- Transparent tool routing to remote REXD when a target is active
- Local fallback when no target is active
- Core remote filesystem and shell support: `bash`, `read`, `write`, `list`, `glob`, `grep`
- Remote file parity with native REXD methods: `edit`, `apply_patch`/`patch`
- PTY support via dedicated tools: `pty_spawn`, `pty_write`, `pty_read`, `pty_list`, `pty_kill`

## Requirements

- OpenCode with plugin support
- REXD installed on target hosts and reachable over SSH
- Target registry at `~/.config/rexd/targets.json`
- REXD version with `fs.edit` and `fs.patch` support (v0.1.3+)

## Install

Latest release:

```bash
curl -fsSL https://raw.githubusercontent.com/samiralibabic/opencode-rexd-target/main/scripts/install.sh | bash
```

Pinned version:

```bash
curl -fsSL https://raw.githubusercontent.com/samiralibabic/opencode-rexd-target/main/scripts/install.sh | OPENCODE_REXD_TARGET_VERSION=v0.2.0 bash
```

The installer places files in your OpenCode config directory:

- `~/.config/opencode/plugins/rexd-target.js`
- `~/.config/opencode/commands/target.md`

## Post-install setup (required)

1. Ensure every target host runs `rexd` v0.1.3 or newer.
2. Create/update `~/.config/rexd/targets.json` on your local machine.
3. Restart OpenCode so the plugin is reloaded.
4. Run `/target list` and then `/target use <alias>`.

## Configure targets

Example `~/.config/rexd/targets.json`:

```json
{
  "version": 1,
  "targets": {
    "prod": {
      "transport": "ssh",
      "host": "example.com",
      "user": "deploy",
      "workspaceRoots": ["/srv/app"],
      "defaultCwd": "/srv/app"
    }
  }
}
```

## Usage

In OpenCode:

- `/target list`
- `/target use <alias>`
- `/target status`
- `/target clear`

Active target state is persisted per project at `.opencode/rexd-state.json`.

## Updating (existing users)

Update in this order:

1. Update `rexd` on remote target hosts.
2. Update this plugin locally.
3. Restart OpenCode.
4. Reconnect with `/target clear` and `/target use <alias>`.

Update commands:

```bash
# 1) remote hosts
curl -fsSL https://raw.githubusercontent.com/samiralibabic/rexd/main/scripts/install.sh | REXD_VERSION=v0.1.3 bash

# 2) local plugin
curl -fsSL https://raw.githubusercontent.com/samiralibabic/opencode-rexd-target/main/scripts/install.sh | OPENCODE_REXD_TARGET_VERSION=v0.2.0 bash
```

If you update the plugin before `rexd`, remote `edit`/`apply_patch` calls can fail with method-not-found errors on older servers.

## Development

```bash
make typecheck
make build
```

## Open-source docs

- License: `LICENSE`
- Contributing: `CONTRIBUTING.md`
- Code of conduct: `CODE_OF_CONDUCT.md`
- Security policy: `SECURITY.md`
