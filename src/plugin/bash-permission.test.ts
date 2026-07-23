import { describe, expect, test } from "bun:test"
import {
  bashArityPrefix,
  bashPermissionGuard,
  buildBashPermissionRequest,
  parsePosixShellCommands,
} from "./bash-permission"

// Mirrors OpenCode 1.18.4's anchored wildcard semantics for approval-boundary tests.
function matches(input: string, pattern: string): boolean {
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp(`^${escaped}$`, "s").test(input)
}

function allowed(patterns: string[], approvals: string[]): boolean {
  return patterns.every((pattern) => approvals.some((approval) => matches(pattern, approval)))
}

describe("bash permission request builder", () => {
  test("uses OpenCode's git log family", () => {
    const request = buildBashPermissionRequest("git log --oneline")

    expect(request).toMatchObject({
      patterns: ["git log --oneline"],
      always: ["git log *"],
      unsupported: false,
    })
    expect(bashArityPrefix(["git", "log", "--oneline"])).toEqual(["git", "log"])
  })

  test("keeps git blame as a distinct family", () => {
    const request = buildBashPermissionRequest("git log --oneline && git blame src/main.ts")

    expect(request.patterns).toEqual(["git log --oneline", "git blame src/main.ts"])
    expect(request.always).toEqual(["git log *", "git blame *"])
  })

  test("splits compound commands on each supported top-level operator", () => {
    const request = buildBashPermissionRequest("git log || git status; git diff & git show | cat\nnpm test")

    expect(request.patterns).toEqual(["git log", "git status", "git diff", "git show", "cat", "npm test"])
    expect(request.always).toEqual(["git log *", "git status *", "git diff *", "git show *", "cat *", "npm test *"])
  })

  test("treats a single ampersand as a command separator", () => {
    const request = buildBashPermissionRequest("git status & git diff")

    expect(request.patterns).toEqual(["git status", "git diff"])
    expect(request.always).toEqual(["git status *", "git diff *"])
  })

  test("does not split quoted or escaped operators", () => {
    const request = buildBashPermissionRequest("echo 'a && b | c; d' && git log \"x || y\" && echo \\|")

    expect(request.unsupported).toBe(false)
    expect(request.patterns).toEqual(["echo 'a && b | c; d'", 'git log "x || y"', "echo \\|"])
    expect(request.always).toEqual(["echo *", "git log *"])
  })

  test("fails closed for active command substitutions inside double quotes", () => {
    for (const command of ['echo "$(rm -rf build)"', 'cd "$(rm -rf build)"', 'X="$(dangerous-command)"', 'echo "`id`"']) {
      const request = buildBashPermissionRequest(command)
      expect(request.unsupported).toBe(true)
      expect(request.patterns).toEqual([command, bashPermissionGuard(command)])
      expect(request.always).toEqual(request.patterns)
    }

    expect(buildBashPermissionRequest("echo '$(literal)'").unsupported).toBe(false)
  })

  test("preserves quoted and escaped command names in approval families", () => {
    expect(buildBashPermissionRequest('"git" log --oneline').always).toEqual(['"git" *'])
    expect(buildBashPermissionRequest("g\\it log --oneline").always).toEqual(["g\\it *"])
  })

  test("preserves redirections but removes assignments and redirection operands from arity tokens", () => {
    const command = "GIT_PAGER=cat git log --oneline > output.txt 2>&1"
    const parsed = parsePosixShellCommands(command)
    const request = buildBashPermissionRequest(command)

    expect(parsed).toEqual({
      unsupported: false,
      commands: [{ source: command, tokens: ["git", "log", "--oneline"] }],
    })
    expect(request.patterns).toEqual([command])
    expect(request.always).toEqual(["git log *"])
  })

  test("excludes cwd-only commands while retaining later commands", () => {
    const request = buildBashPermissionRequest("cd build && pushd lib && git status && popd")

    expect(request.patterns).toEqual(["git status"])
    expect(request.always).toEqual(["git status *"])
  })

  test("uses the npm run and docker compose three-token families", () => {
    const request = buildBashPermissionRequest("npm run dev && docker compose up -d")

    expect(request.always).toEqual(["npm run dev *", "docker compose up *"])
  })

  test("deduplicates exact patterns and command families in source order", () => {
    const request = buildBashPermissionRequest("git log --oneline && git log --oneline && git log --decorate")

    expect(request.patterns).toEqual(["git log --oneline", "git log --decorate"])
    expect(request.always).toEqual(["git log *"])
  })

  test("prefixes every normal rule with an optional remote scope", () => {
    const request = buildBashPermissionRequest("git log && npm run dev", { remoteScope: "remote:prod:" })

    expect(request.patterns).toEqual(["remote:prod:git log", "remote:prod:npm run dev"])
    expect(request.always).toEqual(["remote:prod:git log *", "remote:prod:npm run dev *"])
  })

  test("keeps local and remote target approvals isolated", () => {
    const command = "git log --oneline"
    const local = buildBashPermissionRequest(command)
    const targetA = buildBashPermissionRequest(command, { remoteScope: "remote:a:" })
    const targetB = buildBashPermissionRequest(command, { remoteScope: "remote:b:" })

    expect(allowed(targetA.patterns, targetA.always)).toBe(true)
    expect(allowed(local.patterns, targetA.always)).toBe(false)
    expect(allowed(targetB.patterns, targetA.always)).toBe(false)
  })

  test("reuses identical compound approvals but not distinct command families", () => {
    const compound = buildBashPermissionRequest("git log --oneline && git status")
    const repeated = buildBashPermissionRequest("git log --oneline && git status")
    const distinct = buildBashPermissionRequest("git blame src/main.ts")

    expect(allowed(repeated.patterns, compound.always)).toBe(true)
    expect(allowed(distinct.patterns, compound.always)).toBe(false)
  })

  test("fails closed for malformed or unsupported shell syntax with a stable exact and opaque guard", () => {
    const command = 'git log && "unterminated'
    const first = buildBashPermissionRequest(command)
    const second = buildBashPermissionRequest(command)
    const guard = bashPermissionGuard(command)

    expect(first).toEqual({
      patterns: [command, guard],
      always: [command, guard],
      commands: [],
      unsupported: true,
      guard,
    })
    expect(second).toEqual(first)
    expect(guard).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first.always).not.toContain("git log *")
    expect(buildBashPermissionRequest("git log $(id)").unsupported).toBe(true)
  })
})
