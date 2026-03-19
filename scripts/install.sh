#!/usr/bin/env bash
set -euo pipefail

REPO="${OPENCODE_REXD_TARGET_REPO:-samiralibabic/opencode-rexd-target}"
VERSION="${OPENCODE_REXD_TARGET_VERSION:-}"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
TARGETS_PATH="${REXD_TARGETS_PATH:-$HOME/.config/rexd/targets.json}"
REXD_REPO="${REXD_REPO:-samiralibabic/rexd}"
ASSET="opencode-rexd-target.tar.gz"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

hash_file() {
  local target="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$target" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target" | awk '{print $1}'
    return
  fi
  echo "Missing checksum tool: sha256sum or shasum" >&2
  exit 1
}

need_cmd curl
need_cmd tar

if [[ -z "${VERSION}" ]]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [[ -z "${VERSION}" ]]; then
    echo "Failed to resolve latest version from GitHub releases." >&2
    exit 1
  fi
fi

BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "Installing opencode-rexd-target ${VERSION} ..."
curl -fsSL "${BASE_URL}/${ASSET}" -o "${TMP_DIR}/${ASSET}"
curl -fsSL "${BASE_URL}/checksums.txt" -o "${TMP_DIR}/checksums.txt"

EXPECTED_SHA="$(awk "/  ${ASSET}\$/{print \$1}" "${TMP_DIR}/checksums.txt")"
if [[ -z "${EXPECTED_SHA}" ]]; then
  echo "Checksum entry for ${ASSET} not found." >&2
  exit 1
fi

ACTUAL_SHA="$(hash_file "${TMP_DIR}/${ASSET}")"
if [[ "${EXPECTED_SHA}" != "${ACTUAL_SHA}" ]]; then
  echo "Checksum mismatch for ${ASSET}." >&2
  exit 1
fi

tar -xzf "${TMP_DIR}/${ASSET}" -C "${TMP_DIR}"

PLUGIN_SRC="${TMP_DIR}/plugins/rexd-target.js"
COMMAND_SRC="${TMP_DIR}/commands/target.md"
if [[ ! -f "${PLUGIN_SRC}" ]]; then
  echo "Missing plugin payload: ${PLUGIN_SRC}" >&2
  exit 1
fi
if [[ ! -f "${COMMAND_SRC}" ]]; then
  echo "Missing command payload: ${COMMAND_SRC}" >&2
  exit 1
fi

mkdir -p "${CONFIG_DIR}/plugins" "${CONFIG_DIR}/commands"
install -m 0644 "${PLUGIN_SRC}" "${CONFIG_DIR}/plugins/rexd-target.js"
install -m 0644 "${COMMAND_SRC}" "${CONFIG_DIR}/commands/target.md"

echo "Installed plugin: ${CONFIG_DIR}/plugins/rexd-target.js"
echo "Installed command: ${CONFIG_DIR}/commands/target.md"

echo
echo "Next steps:"
echo "- REXD (Remote Execution Daemon): https://github.com/${REXD_REPO}"
if [[ -f "${TARGETS_PATH}" ]]; then
  echo "- Target registry found: ${TARGETS_PATH}"
else
  echo "- Create target registry at: ${TARGETS_PATH}"
  cat <<'EOF'
  Example:
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
EOF
fi
echo "- Ensure target hosts run rexd v0.1.4 or newer."
echo "  Install/update on target host:"
echo "  curl -fsSL https://raw.githubusercontent.com/${REXD_REPO}/main/scripts/install.sh | REXD_VERSION=v0.1.4 bash"
echo "- Restart OpenCode to load updates."
echo "- In OpenCode, run: /target list"
echo "- Then activate: /target use <alias>"
echo "- To update later, rerun this installer."
