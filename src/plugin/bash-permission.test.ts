import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join, posix } from "node:path"
import { homedir, tmpdir } from "node:os"
import { describe, expect, spyOn, test } from "bun:test"
import { Parser } from "web-tree-sitter"
import {
  bashArityPrefix,
  buildBashPermissionRequest,
  parsePosixShellCommands,
  scanBashShellPaths,
} from "./bash-permission"

// Mirrors OpenCode 1.18.4's anchored wildcard semantics for approval-boundary tests.
function matches(input: string, pattern: string): boolean {
  input = input.replaceAll("\\", "/")
  pattern = pattern.replaceAll("\\", "/")
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
  test("uses OpenCode's git log family", async () => {
    const request = await buildBashPermissionRequest("git log --oneline")

    expect(request).toMatchObject({
      patterns: ["git log --oneline"],
      always: ["git log *"],
      unsupported: false,
    })
    expect(bashArityPrefix(["git", "log", "--oneline"])).toEqual(["git", "log"])
  })

  test("keeps git blame as a distinct family", async () => {
    const request = await buildBashPermissionRequest("git log --oneline && git blame src/main.ts")

    expect(request.patterns).toEqual(["git log --oneline", "git blame src/main.ts"])
    expect(request.always).toEqual(["git log *", "git blame *"])
  })

  test("splits compound commands on each supported top-level operator", async () => {
    const request = await buildBashPermissionRequest("git log || git status; git diff & git show | cat\nnpm test")

    expect(request.patterns).toEqual(["git log", "git status", "git diff", "git show", "cat", "npm test"])
    expect(request.always).toEqual(["git log *", "git status *", "git diff *", "git show *", "cat *", "npm test *"])
  })

  test("treats a single ampersand as a command separator", async () => {
    const request = await buildBashPermissionRequest("git status & git diff")

    expect(request.patterns).toEqual(["git status", "git diff"])
    expect(request.always).toEqual(["git status *", "git diff *"])
  })

  test("does not split quoted or escaped operators", async () => {
    const request = await buildBashPermissionRequest("echo 'a && b | c; d' && git log \"x || y\" && echo \\|")

    expect(request.unsupported).toBe(false)
    expect(request.patterns).toEqual(["echo 'a && b | c; d'", 'git log "x || y"', "echo \\|"])
    expect(request.always).toEqual(["echo *", "git log *"])
  })

  test("ignores shell comments without discarding surrounding commands", async () => {
    const request = await buildBashPermissionRequest("git status # /outside/is/comment-data\ngit diff")

    expect(request.unsupported).toBe(false)
    expect(request.patterns).toEqual(["git status", "git diff"])
    expect(await scanBashShellPaths("rg /api/foo frontend # /outside/is/comment-data")).toEqual({
      unsupported: false,
      candidates: [],
    })
  })

  test("checks active substitutions recursively instead of whole-line hash guards", async () => {
    for (const command of ['echo "$(rm -rf build)"', 'cd "$(rm -rf build)"', 'X="$(rm -rf build)"']) {
      const request = await buildBashPermissionRequest(command)
      expect(request.unsupported).toBe(false)
      expect(request.patterns).toContain("rm -rf build")
      expect(request.patterns.some((pattern) => pattern.startsWith("sha256:"))).toBe(false)
    }
    expect((await buildBashPermissionRequest("echo '$(literal)'")).unsupported).toBe(false)
  })

  test("preserves quoted and escaped command names in approval families", async () => {
    expect((await buildBashPermissionRequest('"git" log --oneline')).always).toEqual(['"git" *'])
    expect((await buildBashPermissionRequest("g\\it log --oneline")).always).toEqual(["g\\it *"])
  })

  test("preserves redirections but removes assignments and redirection operands from arity tokens", async () => {
    const command = "GIT_PAGER=cat git log --oneline > output.txt 2>&1"
    const parsed = await parsePosixShellCommands(command)
    const request = await buildBashPermissionRequest(command)

    expect(parsed).toEqual({
      unsupported: false,
      commands: [{ source: command, tokens: ["git", "log", "--oneline"] }],
    })
    expect(request.patterns).toEqual([command])
    expect(request.always).toEqual(["git log *"])
  })

  test("collects only filesystem operands, find roots, and real redirection targets", async () => {
    expect(await scanBashShellPaths("cat -n /etc/hosts && find .. -name '/api/foo' && echo ok > /dev/null && echo ok>/dev/tty && >/tmp/redirection-only && echo 2>&1")).toEqual({
      unsupported: false,
      candidates: [
        { raw: "/etc/hosts", value: "/etc/hosts" },
        { raw: "..", value: ".." },
        { raw: "/dev/null", value: "/dev/null" },
        { raw: "/dev/tty", value: "/dev/tty" },
        { raw: "/tmp/redirection-only", value: "/tmp/redirection-only" },
      ],
    })
    expect(await scanBashShellPaths(`rg '"/sitemap.xml"' frontend && grep "/api/foo" file.ts && curl https://example.com/api/foo`)).toEqual({
      unsupported: false,
      candidates: [],
    })
  })

  test("walks compound Bash commands without scanning their raw text", async () => {
    const command = `for u in https://example.com/a https://example.com/b; do
  curl -sI "$u" | awk 'NR==1 || /^content-type:|^content-length:|^location:/'
done`

    expect(await scanBashShellPaths(command)).toEqual({ unsupported: false, candidates: [] })
    expect(await scanBashShellPaths("for n in 1 2; do cat /etc/hosts; done")).toEqual({
      unsupported: false,
      candidates: [{ raw: "/etc/hosts", value: "/etc/hosts" }],
    })
    expect(await scanBashShellPaths("cat /tmp/*/../../srv/app/file")).toEqual({
      unsupported: false,
      candidates: [{ raw: "/tmp/*/../../srv/app/file", value: "/tmp", directory: true }],
    })
    expect(await scanBashShellPaths("cat /tmp/foo*.txt")).toEqual({
      unsupported: false,
      candidates: [{ raw: "/tmp/foo*.txt", value: "/tmp", directory: true }],
    })
    // OpenCode does not infer the loop value flowing into the dynamic cat argument.
    expect(await scanBashShellPaths('for f in /etc/*; do cat "$f"; done')).toEqual({
      unsupported: false,
      candidates: [],
    })
  })

  test("excludes cwd-only commands while retaining later commands", async () => {
    const request = await buildBashPermissionRequest("cd build && pushd lib && git status && popd")

    expect(request.patterns).toEqual(["git status"])
    expect(request.always).toEqual(["git status *"])
  })

  test("uses the npm run and docker compose three-token families", async () => {
    const request = await buildBashPermissionRequest("npm run dev && docker compose up -d")

    expect(request.always).toEqual(["npm run dev *", "docker compose up *"])
  })

  test("deduplicates exact patterns and command families in source order", async () => {
    const request = await buildBashPermissionRequest("git log --oneline && git log --oneline && git log --decorate")

    expect(request.patterns).toEqual(["git log --oneline", "git log --decorate"])
    expect(request.always).toEqual(["git log *"])
  })

  test("prefixes every normal rule with an optional remote scope", async () => {
    const request = await buildBashPermissionRequest("git log && npm run dev", { remoteScope: "remote:prod:" })

    expect(request.patterns).toEqual(["remote:prod:git log", "remote:prod:npm run dev"])
    expect(request.always).toEqual(["remote:prod:git log *", "remote:prod:npm run dev *"])
  })

  test("keeps local and remote target approvals isolated", async () => {
    const command = "git log --oneline"
    const local = await buildBashPermissionRequest(command)
    const targetA = await buildBashPermissionRequest(command, { remoteScope: "remote:a:" })
    const targetB = await buildBashPermissionRequest(command, { remoteScope: "remote:b:" })

    expect(allowed(targetA.patterns, targetA.always)).toBe(true)
    expect(allowed(local.patterns, targetA.always)).toBe(false)
    expect(allowed(targetB.patterns, targetA.always)).toBe(false)
  })

  test("reuses identical compound approvals but not distinct command families", async () => {
    const compound = await buildBashPermissionRequest("git log --oneline && git status")
    const repeated = await buildBashPermissionRequest("git log --oneline && git status")
    const distinct = await buildBashPermissionRequest("git blame src/main.ts")

    expect(allowed(repeated.patterns, compound.always)).toBe(true)
    expect(allowed(distinct.patterns, compound.always)).toBe(false)
  })

  test("retains recovered commands and adds uncovered malformed text without hash guards", async () => {
    const command = 'git log && "unterminated'
    const request = await buildBashPermissionRequest(command)
    expect(request.unsupported).toBe(true)
    expect(request.patterns).toEqual(["git log", command])
    expect(request.always).toEqual(["git log *", command])
    expect(await buildBashPermissionRequest(command)).toEqual(request)
    expect((await buildBashPermissionRequest("git log $(id)")).patterns).toEqual(["git log $(id)", "id"])
  })

  test("finds rm in every native shell command-node context", async () => {
    const rm = "rm -rf /outside/private"
    const forms = [
      "echo $(" + rm + ")",
      "echo " + "`" + rm + "`",
      "(" + rm + ")", "{ " + rm + "; }",
      "for w in 1 2; do " + rm + "; done",
      "while true; do " + rm + "; done",
      "until true; do " + rm + "; done",
      "if true; then " + rm + "; fi",
      "f() { " + rm + "; }; f", "echo x | " + rm,
      "echo x & " + rm, "echo x & ; " + rm,
      "case x in x) " + rm + ";; esac",
      "cat <(" + rm + ")",
    ]
    for (const command of forms) expect((await buildBashPermissionRequest(command)).patterns).toContain(rm)
  })

  test("closes the compound-command holes and removes the loop false prompt", async () => {
    expect((await buildBashPermissionRequest("cd /tmp/agents/x && ls $(pwd) && rm -rf ~/Documents")).patterns)
      .toContain("rm -rf " + homedir() + "/Documents")
    expect((await buildBashPermissionRequest("cd x && (rm -rf ~/Documents)")).patterns)
      .toContain("rm -rf " + homedir() + "/Documents")
    const request = await buildBashPermissionRequest("rm -rf /tmp/agents/r/crops && for w in 1 2; do echo $w; done")
    expect(request.patterns).toEqual(["rm -rf /tmp/agents/r/crops", "echo $w"])
  })

  test("retains redirected source without treating heredoc data as commands", async () => {
    const command = "cat <<'EOF'\nrm -rf /outside/private\nEOF"
    expect((await buildBashPermissionRequest(command)).patterns).toEqual([command])
    for (const command of ["echo ok &>/tmp/log", "echo ok >|/tmp/log", "cat </tmp/input"]) {
      expect((await buildBashPermissionRequest(command)).patterns).toEqual([command])
    }
    // Unquoted heredoc expansions really do execute commands.
    const expanded = "cat <<EOF\n$(rm -rf /outside/private)\nEOF"
    expect((await buildBashPermissionRequest(expanded)).patterns).toContain("rm -rf /outside/private")
  })

  test("splits rm operands and retains options including -- and options after operands", async () => {
    expect((await buildBashPermissionRequest("rm -rf /tmp/agents/x/before /tmp/agents/x/after")).patterns)
      .toEqual(["rm -rf /tmp/agents/x/before", "rm -rf /tmp/agents/x/after"])
    expect((await buildBashPermissionRequest("rm /tmp/agents/x/before -rf /outside/private")).patterns)
      .toEqual(["rm -rf /tmp/agents/x/before", "rm -rf /outside/private"])
    expect((await buildBashPermissionRequest("rm -rf -- before -after", { cwd: "/tmp/agents/x" })).patterns)
      .toEqual(["rm -rf -- /tmp/agents/x/before", "rm -rf -- /tmp/agents/x/-after"])
  })

  test("resolves relative rm operands against tool cwd and preceding literal cd", async () => {
    expect((await buildBashPermissionRequest("rm -rf build", { cwd: "/tmp/agents/x" })).patterns)
      .toEqual(["rm -rf /tmp/agents/x/build"])
    expect((await buildBashPermissionRequest("cd /tmp/agents/x/h && rm -rf build")).patterns)
      .toEqual(["rm -rf /tmp/agents/x/h/build"])
    expect((await buildBashPermissionRequest("cd ../h && rm -rf ./build/", { cwd: "/tmp/agents/x/a" })).patterns)
      .toEqual(["rm -rf /tmp/agents/x/h/build/"])
    expect((await buildBashPermissionRequest("cd ~ && rm -rf Documents", { cwd: "/tmp/agents/x" })).patterns)
      .toEqual(["rm -rf " + homedir() + "/Documents"])
  })

  test("normalizes traversal, expands home and preserves glob suffixes and trailing slashes", async () => {
    expect((await buildBashPermissionRequest("rm -rf /tmp/agents/x/../../../etc ~/Documents /tmp/agents/x/trace/* /tmp/agents/x/after/")).patterns)
      .toEqual(["rm -rf /etc", "rm -rf " + homedir() + "/Documents", "rm -rf /tmp/agents/x/trace/*", "rm -rf /tmp/agents/x/after/"])
    expect((await buildBashPermissionRequest("rm -rf ../../../../etc", { cwd: "/tmp/agents/x/h" })).patterns)
      .toEqual(["rm -rf /etc"])
    expect((await buildBashPermissionRequest("rm -rf /tmp/agents/x/../../etc")).patterns)
      .toEqual(["rm -rf /tmp/etc"])
    // A traversal after a glob must not be lexically collapsed before expansion.
    expect((await buildBashPermissionRequest("rm -rf /tmp/agents/*/../../etc")).patterns)
      .toEqual(["rm -rf /tmp/agents/*/../../etc"])
  })

  test("leaves dynamic operands and unknown cd paths unresolved", async () => {
    for (const cd of ["cd $TARGET", "cd $(pwd)", "cd -", "cd", "pushd /tmp/agents/x"]) {
      expect((await buildBashPermissionRequest(cd + " && rm -rf build", { cwd: "/tmp/agents/x" })).patterns)
        .toContain("rm -rf build")
    }
    for (const operand of ["$P/build", '"$P/build"', "/tmp/agents/$P/build", "$(pwd)/build", "/tmp/agents/{a,b}"]) {
      expect((await buildBashPermissionRequest("rm -rf " + operand, { cwd: "/tmp/agents/x" })).patterns)
        .toContain("rm -rf " + operand)
    }
  })

  test("does not leak cwd from child shells or background jobs or alternate branches", async () => {
    for (const prefix of ["(cd /tmp/agents/x);", "echo $(cd /tmp/agents/x);", "cd /tmp/agents/x | cat;", "cd /tmp/agents/x &"]) {
      expect((await buildBashPermissionRequest(prefix + " rm -rf build", { cwd: "/outside" })).patterns)
        .toContain("rm -rf /outside/build")
    }
    expect((await buildBashPermissionRequest("cd /tmp/agents/x || rm -rf build", { cwd: "/outside" })).patterns)
      .toContain("rm -rf build")
  })

  test("preserves remote scope and source without local rm normalization", async () => {
    const request = await buildBashPermissionRequest("cd /tmp/agents/x && echo $(rm -rf ~/Documents) && rm -rf before after", {
      remoteScope: "remote:test:", cwd: "/tmp/agents/x",
    })
    expect(request.patterns).toEqual(["remote:test:echo $(rm -rf ~/Documents)", "remote:test:rm -rf ~/Documents", "remote:test:rm -rf before after"])
    expect(request.always).toEqual(["remote:test:echo *", "remote:test:rm *"])
  })

  test("checks each rm operand even with assignments or redirection wrappers", async () => {
    for (const command of ["X=1 rm -rf /tmp/agents/x /outside/private", "rm -rf /tmp/agents/x /outside/private >/tmp/log"]) {
      expect((await buildBashPermissionRequest(command)).patterns)
        .toEqual(["rm -rf /tmp/agents/x", "rm -rf /outside/private"])
      expect((await buildBashPermissionRequest(command)).commands[0].source).toBe(command)
    }
    expect((await buildBashPermissionRequest('rm "-rf" /outside/private')).patterns).toEqual(["rm -rf /outside/private"])
  })

  test("does not propagate a cd across alternative branches or a function call", async () => {
    expect((await buildBashPermissionRequest("if true; then cd /tmp/agents/x; else rm -rf build; fi", { cwd: "/outside" })).patterns)
      .toContain("rm -rf build")
    expect((await buildBashPermissionRequest("f() { cd /outside; }; cd /tmp/agents/x && f && rm -rf build", { cwd: "/outside" })).patterns)
      .toContain("rm -rf build")
  })

  test("does not assume a fallible cd succeeded without an && success dependency", async () => {
    for (const command of ["cd /tmp/agents/missing; rm -rf build", "cd /tmp/agents/missing\nrm -rf build", "cd /tmp/agents/missing && true; rm -rf build"]) {
      expect((await buildBashPermissionRequest(command, { cwd: "/outside" })).patterns).toContain("rm -rf build")
    }
    expect((await buildBashPermissionRequest("cd /tmp/agents/x && true && rm -rf build", { cwd: "/outside" })).patterns)
      .toContain("rm -rf /tmp/agents/x/build")
  })

  test("matches anchored last-rule-wins recursive-delete policies", async () => {
    const rules: [string, "allow" | "ask"][] = [
      ["*", "allow"], ["rm -r*", "ask"], ["rm -r* /tmp/agents/?*", "allow"],
      ["rm * ?* /tmp/agents/*", "ask"], ["rm * /tmp/agents/?* ?*", "ask"],
      ["rm * /tmp/agents/*..*", "ask"], ["rm * /tmp/agents/*$*", "ask"],
      ["rm * /tmp/agents/*" + "`" + "*", "ask"],
    ]
    const cases: [string, "allow" | "ask"][] = [
      ["cd /tmp/agents/x && ls $(pwd) && rm -rf ~/Documents", "ask"],
      ["cd x && (rm -rf ~/Documents)", "ask"],
      ["rm -rf /tmp/agents/x/before /tmp/agents/x/after", "allow"],
      ["cd /tmp/agents/x/h && rm -rf build", "allow"],
      ["rm -rf /tmp/agents/r/crops && for w in 1 2; do echo $w; done", "allow"],
      ["rm -rf /tmp/agents/x/../../../etc", "ask"],
      ["rm -rf /tmp/agents/$P/build", "ask"],
      ["cd /tmp/agents/missing; rm -rf build", "ask"],
    ]
    for (const [command, expected] of cases) {
      const request = await buildBashPermissionRequest(command, { cwd: "/outside" })
      const actions = request.patterns.map((pattern) => rules.findLast(([rule]) => matches(pattern, rule))![1])
      expect(actions.includes("ask") ? "ask" : "allow").toBe(expected)
    }
  })

  test("aborts like native OpenCode when the parser returns no tree", async () => {
    // Initialize the shared parser before replacing its parse method.
    await buildBashPermissionRequest("echo ok")
    const parse = spyOn(Parser.prototype, "parse").mockReturnValue(null)
    try {
      await expect(buildBashPermissionRequest("rm -rf /outside/private")).rejects.toThrow("Failed to parse Bash command")
    } finally {
      parse.mockRestore()
    }
  })

  test("keeps recovered rm checks and full error text after an invalid & ; separator", async () => {
    const command = "echo ok & ; rm -rf /outside/private"
    const request = await buildBashPermissionRequest(command)
    expect(request.unsupported).toBe(true)
    expect(request.patterns).toEqual(["echo ok", "rm -rf /outside/private", command])
    const remote = await buildBashPermissionRequest(command, { scope: "remote:test:" })
    expect(remote.patterns).toEqual(request.patterns.map((pattern) => "remote:test:" + pattern))
  })

})

describe("literal variables and project-local rm permissions", () => {
  const deletes = async (command: string, options = {}) => (await buildBashPermissionRequest(command, options)).patterns.filter((pattern) => pattern.startsWith("rm "))

  test("tracks assignments, export, reassignment, braced expansions, and cd", async () => {
    for (const separator of [";", "&&", "\n"]) {
      expect(await deletes('A=/tmp/agents/x' + separator + ' rm -rf $A/after')).toEqual(["rm -rf /tmp/agents/x/after"])
    }
    expect(await deletes('export A=/tmp/agents/x; rm -rf "${A}/after"')).toEqual(["rm -rf /tmp/agents/x/after"])
    expect(await deletes('A=/outside; A=/tmp/agents/x; rm -rf ${A}/after')).toEqual(["rm -rf /tmp/agents/x/after"])
    expect(await deletes('A="/tmp/agents/two words"; rm -rf "$A/after"')).toEqual(["rm -rf /tmp/agents/two%20words/after"])
    expect(await deletes('A=/tmp/agents/x; cd $A && rm -rf after')).toEqual(["rm -rf /tmp/agents/x/after"])
  })

  test("command-prefix assignments do not leak or override argument expansion", async () => {
    expect(await deletes('A=/tmp/agents/x echo ok; rm -rf $A/after')).toEqual(["rm -rf $A/after"])
    expect(await deletes('A=/outside; A=/tmp/agents/x rm -rf $A/after; rm -rf $A/again')).toEqual(["rm -rf /outside/after", "rm -rf /outside/again"])
    expect(await deletes('A=/tmp/agents/x rm -rf $A/after')).toEqual(["rm -rf $A/after"])
  })

  test("invalidates uncertain writes and never uses environment values", async () => {
    for (const middle of ["unset A", "read A", "A=$(pwd)", "A=$HOME", "A+=other", "if true; then A=/tmp/agents/x; fi", "for n in a; do A=/tmp/agents/x; done", "case x in x) A=/tmp/agents/x;; esac", "(A=/tmp/agents/x)"]) {
      expect(await deletes('A=/outside; ' + middle + '; rm -rf $A/after')).toEqual(["rm -rf $A/after"])
    }
    expect(await deletes('rm -rf $HOME/x')).toEqual(["rm -rf $HOME/x"])
    expect(await deletes('A=/outside; if true; then A=/tmp/agents/x; rm -rf $A; fi')).toEqual(["rm -rf $A"])
    expect(await deletes('A=/outside; A=/tmp/agents/x || true; rm -rf $A')).toEqual(["rm -rf $A"])
    expect(await deletes('A=/outside; f() { A=/tmp/agents/x; }; f; rm -rf $A')).toEqual(["rm -rf $A"])
  })

  test("expands literal for-in words only and keeps body writes unknown", async () => {
    expect(await deletes('for d in a b c; do mkdir -p $d; rm -rf "/path/$d/before"; done')).toEqual(["rm -rf /path/a/before", "rm -rf /path/b/before", "rm -rf /path/c/before"])
    for (const words of ["a *", "a $(printf b)", "a $ENV", "a {b,c}"]) {
      expect(await deletes('for d in ' + words + '; do rm -rf /path/$d/before; done')).toEqual(["rm -rf /path/$d/before"])
    }
    expect(await deletes('for d in a b; do A=/tmp/agents/x; rm -rf $A; done')).toEqual(["rm -rf $A"])
    expect(await deletes('for d in a b; do d=x; rm -rf /path/$d; done')).toEqual(["rm -rf /path/$d"])
    expect(await deletes('for d in a b; do echo $d; done; rm -rf /path/$d')).toEqual(["rm -rf /path/$d"])
  })

  test("emits project paths only strictly within a verified session git root", async () => {
    const root = mkdtempSync(join(tmpdir(), 'rexd-project-'))
    try {
      mkdirSync(root + '/.git')
      mkdirSync(root + '/.worktrees/x/sub', { recursive: true })
      writeFileSync(root + '/.worktrees/x/.git', 'gitdir: fixture')
      mkdirSync(root + '/nested/.git', { recursive: true })
      const options = { cwd: root, projectRoot: root }
      expect(await deletes('rm -rf apps/x/build', options)).toEqual(['rm -rf project:apps/x/build'])
      expect(await deletes('rm -rf ' + root + '/.worktrees/x/sub', options)).toEqual(['rm -rf project:.worktrees/x/sub'])
      expect(await deletes('cd ' + root + '/.worktrees/x && rm -rf apps/dashboard/zz-shots', options)).toEqual(['rm -rf project:.worktrees/x/apps/dashboard/zz-shots'])
      for (const suffix of ['', '/', '/.git', '/.git/config', '/.worktrees/x', '/.worktrees/x/', '/nested', '/*', '/a*', '/a/.git/config', '/../other']) {
        const absolute = root + suffix
        const normalized = suffix === '/../other' ? posix.normalize(absolute) : absolute
        expect(await deletes('rm -rf ' + absolute, options)).toEqual(['rm -rf ' + normalized])
      }
      expect(await deletes('rm -rf ' + root + '/apps/*', options)).toEqual(['rm -rf ' + root + '/apps/*'])
      expect(await deletes('rm -rf /outside/build', options)).toEqual(['rm -rf /outside/build'])
      for (const projectRoot of ['/', homedir(), root + '/missing']) {
        expect(await deletes('rm -rf apps/build', { cwd: root, projectRoot })).toEqual(['rm -rf ' + root + '/apps/build'])
      }
      expect((await buildBashPermissionRequest('A=' + root + '; rm -rf $A/apps/build', { ...options, remoteScope: 'remote:test:' })).patterns).toEqual(['remote:test:rm -rf $A/apps/build'])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe("ambiguous variable joins", () => {
  test("does not carry background, OR-chain, read, or declaration writes", async () => {
    const commands = [
      'A=/outside; A=/tmp/agents/x & rm -rf $A',
      'A=/outside; true || A=/tmp/agents/x && rm -rf $A',
      'A=/outside; true && A=/tmp/agents/x || true; rm -rf $A',
      'A=/outside; for d in a b; do read A; rm -rf $A; done',
      'A=/outside; declare -n A=B; rm -rf $A',
      'A=/outside; printf -v A /tmp/agents/x; rm -rf $A',
      'A=/outside; let A=1; rm -rf $A',
      'A=/outside; if true; then declare -n A=B; fi; rm -rf $A',
    ]
    for (const command of commands) expect((await buildBashPermissionRequest(command)).patterns).toContain('rm -rf $A')
  })
  test("does not resolve word splitting or glob-valued loop lists", async () => {
    expect((await buildBashPermissionRequest('A="/tmp/agents/a b"; rm -rf $A')).patterns).toContain('rm -rf $A')
    expect((await buildBashPermissionRequest('for d in a "*"; do rm -rf /path/$d; done')).patterns).toContain('rm -rf /path/$d')
  })
})

describe("whitespace inside one rm operand", () => {
  // A documented scratch and project recursive-delete policy, in order, after
  // OpenCode's default `*` allow. Multi-path asks stay for fallback patterns.
  const policy: [string, "allow" | "ask"][] = [
    ["*", "allow"],
    ["rm -r*", "ask"], ["rm -R*", "ask"], ["rm -?r*", "ask"], ["rm -?R*", "ask"],
    ["rm * -r*", "ask"], ["rm * -R*", "ask"], ["rm * -?r*", "ask"], ["rm * -?R*", "ask"],
    ["rm -r* /tmp/agents/?*", "allow"], ["rm -R* /tmp/agents/?*", "allow"],
    ["rm -?r* /tmp/agents/?*", "allow"], ["rm -?R* /tmp/agents/?*", "allow"],
    ["rm * ?* /tmp/agents/*", "ask"], ["rm * /tmp/agents/?* ?*", "ask"],
    ["rm * /tmp/agents/*..*", "ask"], ["rm * /tmp/agents/*$*", "ask"], ["rm * /tmp/agents/*`*", "ask"],
    ["rm -r* project:?*", "allow"], ["rm -R* project:?*", "allow"],
    ["rm -?r* project:?*", "allow"], ["rm -?R* project:?*", "allow"],
    ["rm * project:*..*", "ask"], ["rm * project:*$*", "ask"], ["rm * project:*`*", "ask"],
  ]
  const decide = async (command: string, options = {}) => {
    const actions = (await buildBashPermissionRequest(command, options)).patterns.map((pattern) => policy.findLast(([rule]) => matches(pattern, rule))![1])
    return actions.includes("ask") ? "ask" : "allow"
  }
  const reported = '/tmp/agents/tas-974-walk3/final/after/en-1280/08-04 Angaben ergänzen – in der Einrichtung gelandet.png'

  test("percent-encodes whitespace and the escape character in resolved operands", async () => {
    expect((await buildBashPermissionRequest('rm -rf "' + reported + '"')).patterns)
      .toEqual(["rm -rf /tmp/agents/tas-974-walk3/final/after/en-1280/08-04%20Angaben%20ergänzen%20–%20in%20der%20Einrichtung%20gelandet.png"])
    expect((await buildBashPermissionRequest("rm -rf /tmp/agents/x/a\\ b '/tmp/agents/x/c\td' '/tmp/agents/x/e\nf'")).patterns)
      .toEqual(["rm -rf /tmp/agents/x/a%20b", "rm -rf /tmp/agents/x/c%09d", "rm -rf /tmp/agents/x/e%0Af"])
    expect((await buildBashPermissionRequest('rm -rf "/tmp/agents/x/my dir"/sub/file /tmp/agents/x/"c d"e')).patterns)
      .toEqual(["rm -rf /tmp/agents/x/my%20dir/sub/file", "rm -rf /tmp/agents/x/c%20de"])
    expect((await buildBashPermissionRequest('cd "/tmp/agents/x/two words" && rm -rf "c d"')).patterns)
      .toEqual(["rm -rf /tmp/agents/x/two%20words/c%20d"])
    // The escape character is encoded too, so distinct names stay distinct.
    expect((await buildBashPermissionRequest('rm -rf "/tmp/agents/x/100% done" /tmp/agents/x/100%20done')).patterns)
      .toEqual(["rm -rf /tmp/agents/x/100%25%20done", "rm -rf /tmp/agents/x/100%2520done"])
    // Unresolved operands, options and remote scopes keep their source text.
    expect((await buildBashPermissionRequest('rm -rf "/tmp/agents/x/a b/$y"')).patterns).toEqual(['rm -rf "/tmp/agents/x/a b/$y"'])
    expect((await buildBashPermissionRequest('rm -rf "/tmp/agents/x/a b"', { remoteScope: "remote:test:" })).patterns)
      .toEqual(['remote:test:rm -rf "/tmp/agents/x/a b"'])
  })

  test("allows one scratch or project operand whatever whitespace it contains", async () => {
    for (const command of [
      'rm -rf "' + reported + '"',
      "rm -rf /tmp/agents/x/a\\ b",
      "rm -rf '/tmp/agents/x/c\td'",
      'rm -rf "/tmp/agents/x/my dir"/sub/file /tmp/agents/x/"c d"e',
      'cd "/tmp/agents/x/two words" && rm -rf "c d"',
      'A="/tmp/agents/two words"; rm -rf "$A/after"',
    ]) expect(await decide(command, { cwd: "/outside" })).toBe("allow")

    const root = mkdtempSync(join(tmpdir(), "rexd project "))
    try {
      mkdirSync(root + "/.git")
      mkdirSync(root + "/nested repo/.git", { recursive: true })
      const options = { cwd: root, projectRoot: root }
      expect((await buildBashPermissionRequest('rm -rf "docs/my file.txt" docs/a\\ b/"c\td"', options)).patterns)
        .toEqual(["rm -rf project:docs/my%20file.txt", "rm -rf project:docs/a%20b/c%09d"])
      expect(await decide('rm -rf "docs/my file.txt" docs/a\\ b/"c\td"', options)).toBe("allow")
      expect(await decide('rm -rf "' + root + '/build output"', options)).toBe("allow")

      for (const command of [
        'rm -rf "' + root + '"',
        'rm -rf "' + root + '/.git"',
        'rm -rf "nested repo"',
        'rm -rf "a b"/*',
        'rm -rf "a b/../../outside dir"',
        "rm -rf 'a b/$x'",
        "rm -rf 'a b/`id`'",
        'rm -rf "docs/a b" "/outside/c d"',
      ]) expect(await decide(command, options)).toBe("ask")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("keeps asking for paths outside the scratch area and every fallback", async () => {
    for (const command of [
      'rm -rf "/tmp/agents/x/a b" /etc',
      'rm -rf "/tmp/agents/x/a b" "/outside/c d"',
      'rm -rf / "/tmp/agents/x/a b"',
      // One path outside the scratch area or project must not pass for a
      // second, allowed operand because of a space in its name.
      'rm -rf "/outside/a /tmp/agents/b"',
      'rm -rf "/outside/a project:b"',
      'rm -rf "/tmp/agents/x/a b/../../../etc"',
      'rm -rf "/tmp/agents/x/a b/"*/../../etc',
      'rm -rf "/tmp/agents/x/a b..c"',
      "rm -rf '/tmp/agents/x/a b/$y' && rm -rf \"/tmp/agents/x/a b/$y\"",
      "rm -rf '/tmp/agents/x/a b/`id`'",
      'rm -rf "$X/a b"',
      'rm -rf ~/"My Documents"',
      'cd ~ && rm -rf "My Documents"',
      'cd "$X" && rm -rf a\\ /tmp/agents/x',
      'echo ok & ; rm -rf "/tmp/agents/x/a b" /etc',
    ]) expect(await decide(command, { cwd: "/outside" })).toBe("ask")
  })

  test("emits the project: namespace only for operands proven to be inside the project", async () => {
    const root = mkdtempSync(join(tmpdir(), "rexd-unproven-"))
    try {
      mkdirSync(root + "/.git")
      mkdirSync(root + "/sub")
      writeFileSync(root + "/project:foo", "")
      writeFileSync(root + "/sub/project:foo", "")
      const project = { cwd: root, projectRoot: root }
      const unproven: [string, object, string[]][] = [
        // An unknown working directory leaves the operand unresolved.
        ['cd "$X" && rm -rf project:foo', project, ["rm -rf project%3Afoo"]],
        ['cd "$X" && rm -rf project:foo', { cwd: "/outside" }, ["rm -rf project%3Afoo"]],
        ['rm -rf project:foo', {}, ["rm -rf project%3Afoo"]],
        ['rm -rf "project:foo"', {}, ['rm -rf "project%3Afoo"']],
        ['rm -rf project\\:foo', {}, ["rm -rf project\\:foo"]],
        ['rm -rf project:"foo"', {}, ['rm -rf project%3A"foo"']],
        ['rm -rf PROJECT:foo', {}, ["rm -rf PROJECT%3Afoo"]],
        ['rm -Rf project:foo', {}, ["rm -Rf project%3Afoo"]],
        ['rm -fr project:foo', {}, ["rm -fr project%3Afoo"]],
        // Text after quoted or escaped whitespace inside one unresolved operand.
        ['rm -rf "a project:foo"', {}, ['rm -rf "a project%3Afoo"']],
        ['rm -rf a\\ project:foo', {}, ["rm -rf a\\ project%3Afoo"]],
        ['rm -rf "/tmp/agents/$x project:y"', {}, ['rm -rf "/tmp/agents/$x project%3Ay"']],
        // Options, recovered commands, and whole-line fallbacks.
        ['rm -r"f project:x" /etc', {}, ["rm -rf project%3Ax /etc"]],
        ['rm -rf project:foo )', {}, ["rm -rf project%3Afoo", "rm -rf project%3Afoo )"]],
      ]
      for (const [command, options, patterns] of unproven) {
        expect((await buildBashPermissionRequest(command, options)).patterns).toEqual(patterns)
        expect(await decide(command, options)).toBe("ask")
      }

      // A real file named project:foo resolves like any other relative operand.
      expect((await buildBashPermissionRequest("rm -rf project:foo", project)).patterns).toEqual(["rm -rf project:project:foo"])
      expect(await decide("rm -rf project:foo", project)).toBe("allow")
      expect((await buildBashPermissionRequest("cd sub && rm -rf project:foo", project)).patterns).toEqual(["rm -rf project:sub/project:foo"])
      expect(await decide("cd sub && rm -rf project:foo", project)).toBe("allow")
      expect((await buildBashPermissionRequest("rm -rf " + root + "/project:foo", project)).patterns).toEqual(["rm -rf project:project:foo"])
      expect((await buildBashPermissionRequest("rm -rf project:foo", { cwd: "/outside", projectRoot: root })).patterns).toEqual(["rm -rf /outside/project:foo"])
      expect(await decide("rm -rf project:foo", { cwd: "/outside", projectRoot: root })).toBe("ask")
      expect((await buildBashPermissionRequest("rm -rf project:foo", { cwd: root })).patterns).toEqual(["rm -rf " + root + "/project:foo"])
      expect(await decide("rm -rf project:foo", { cwd: root })).toBe("ask")

      // Remote patterns keep their source text and never match local rules.
      expect((await buildBashPermissionRequest("rm -rf project:foo", { remoteScope: "remote:test:" })).patterns).toEqual(["remote:test:rm -rf project:foo"])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
