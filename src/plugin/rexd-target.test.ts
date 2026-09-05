import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  assertTargetSnapshot,
  buildTargetSystemContext,
  buildRemoteReadRpcParams,
  createExecBuffer,
  executeForSessionState,
  formatTargetEndpoint,
  formatReadOutput,
  isBinaryReadFile,
  loadTargetsFromPath,
  loadSessionStateFromPath,
  outputChunks,
  readLocalResolvedPath,
  remotePermissionScope,
  renderTargetList,
  renderExecOutput,
  resolveEffectiveSessionState,
  resolveBashTimeout,
  RexdTargetPlugin,
  runLocalExec,
  runRemoteProcessLifecycle,
  saveSessionStateToPath,
  sessionStatePath,
  sniffReadMime,
  assertTargetCapabilities,
  askBashPermission,
  askLocalPathPermission,
  askRemotePathPermission,
  appendExecOutput,
} from "./rexd-target"

const tempDirs: string[] = []
const stateFiles: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-rexd-target-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  for (const path of stateFiles.splice(0)) {
    rmSync(path, { force: true })
  }
})

describe("read helpers", () => {
  test("formats text reads with offset and limit", () => {
    expect(formatReadOutput("alpha\nbeta\ngamma", 2, 1)).toBe("2: beta")
  })

  test("attaches supported images detected from content", () => {
    const dir = tempDir()
    const file = join(dir, "image.bin")
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
    writeFileSync(file, jpeg)

    const result = readLocalResolvedPath(file)
    expect(typeof result).toBe("object")
    if (typeof result === "string") throw new Error("expected attachment result")
    expect(result.output).toBe("Image read successfully")
    expect(result.attachments?.[0].mime).toBe("image/jpeg")
    expect(result.attachments?.[0].url).toBe(`data:image/jpeg;base64,${jpeg.toString("base64")}`)
  })

  test("attaches PDFs", () => {
    const dir = tempDir()
    const file = join(dir, "example.pdf")
    const pdf = Buffer.from("%PDF-1.4\n")
    writeFileSync(file, pdf)

    const result = readLocalResolvedPath(file)
    expect(typeof result).toBe("object")
    if (typeof result === "string") throw new Error("expected attachment result")
    expect(result.output).toBe("PDF read successfully")
    expect(result.attachments?.[0].mime).toBe("application/pdf")
  })

  test("keeps printable unsupported image types as text", () => {
    const dir = tempDir()
    const file = join(dir, "image.bmp")
    writeFileSync(file, "BM text content")

    const result = readLocalResolvedPath(file)
    expect(result).toContain("BM text content")
  })

  test("rejects unsupported binary files", () => {
    const dir = tempDir()
    const file = join(dir, "module.wasm")
    writeFileSync(file, "not really wasm")

    expect(() => readLocalResolvedPath(file)).toThrow("Cannot read binary file")
    expect(isBinaryReadFile("null-byte.txt", Buffer.from([0x68, 0x00, 0x69]))).toBe(true)
  })

  test("reads directories with opencode-style metadata", () => {
    const dir = tempDir()
    mkdirSync(join(dir, "folder"))
    writeFileSync(join(dir, "file.txt"), "hello")

    const result = readLocalResolvedPath(dir)
    expect(typeof result).toBe("object")
    if (typeof result === "string") throw new Error("expected directory result")
    expect(result.output).toContain("<type>directory</type>")
    expect(result.metadata?.display).toMatchObject({
      type: "directory",
      entries: ["file.txt", "folder/"],
      totalEntries: 2,
    })
  })

  test("sniffs media signatures before extension fallback", () => {
    expect(sniffReadMime("photo.bin", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png",
    )
    expect(sniffReadMime("photo.webp", Buffer.from("text"))).toBe("image/webp")
  })

  test("builds remote base64 read params without line slicing", () => {
    expect(buildRemoteReadRpcParams({ sessionID: "s_1", path: "/srv/image.png", encoding: "base64" })).toEqual({
      session_id: "s_1",
      path: "/srv/image.png",
      encoding: "base64",
    })
    expect(
      buildRemoteReadRpcParams({ sessionID: "s_1", path: "/srv/image.png", encoding: "base64", length: 4096 }),
    ).toEqual({
      session_id: "s_1",
      path: "/srv/image.png",
      encoding: "base64",
      length: 4096,
    })
  })
})

function mockContext(directory: string, worktree = directory) {
  const asks: any[] = []
  return {
    asks,
    context: {
      sessionID: `test-${Math.random()}`,
      messageID: "message",
      agent: "test",
      directory,
      worktree,
      abort: new AbortController().signal,
      metadata() {},
      async ask(input: any) {
        asks.push(input)
      },
    },
  }
}

function mockPluginInput(directory: string, parents: Record<string, string | undefined> = {}) {
  return {
    directory,
    client: {
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            data: { id: path.id, directory, parentID: parents[path.id] },
            error: undefined,
          }
        },
      },
    },
  } as any
}

describe("target discovery and model context", () => {
  const inactiveState = { activeTargetAlias: null, remoteCwdOverride: null, lastUsedAt: 1 }

  test("lists endpoint, description, cwd, and active alias together", () => {
    const targets = {
      contabo: {
        transport: "ssh" as const,
        host: "161.97.89.121",
        user: "root",
        description: "Contabo\nCoolify control plane",
        defaultCwd: "/root",
      },
      future: {
        transport: "http" as const,
        description: "Future transport",
        defaultCwd: "/srv",
      },
      " prod ": {
        transport: "ssh" as const,
        host: "prod.example",
        description: "Primary | blue\tlane",
      },
    }

    expect(renderTargetList(targets, "contabo")).toBe(
      [
        "Available targets:",
        '  * contabo | root@161.97.89.121:22 | "Contabo\\nCoolify control plane" | cwd /root',
        "    future | http transport (unsupported) | Future transport | cwd /srv",
        '    " prod " | prod.example:22 | "Primary | blue\\tlane" | cwd /',
        "",
        'Use /target use <alias> or target(action="use", alias="<alias>") to select a target for this chat.',
      ].join("\n"),
    )
  })

  test("formats IPv6 SSH endpoints without ambiguity", () => {
    expect(formatTargetEndpoint({ transport: "ssh", host: "2001:db8::1", user: "root", port: 2222 })).toBe(
      "root@[2001:db8::1]:2222",
    )
  })

  test("reloads the target registry on every read", () => {
    const path = join(tempDir(), "targets.json")
    writeFileSync(path, JSON.stringify({ targets: { first: { transport: "ssh", host: "first.example" } } }))
    expect(Object.keys(loadTargetsFromPath(path))).toEqual(["first"])

    writeFileSync(path, JSON.stringify({ targets: { second: { transport: "ssh", host: "second.example" } } }))
    expect(Object.keys(loadTargetsFromPath(path))).toEqual(["second"])
  })

  test("rejects a changed target snapshot before connection use", () => {
    const expected = {
      transport: "ssh" as const,
      host: "first.example",
      capabilities: { shell: true, fs: true },
    }

    expect(() =>
      assertTargetSnapshot("prod", expected, {
        capabilities: { fs: true, shell: true },
        host: "first.example",
        transport: "ssh",
      }),
    ).not.toThrow()
    expect(() => assertTargetSnapshot("prod", expected, { ...expected, host: "second.example" })).toThrow(
      "configuration changed during the operation",
    )
    expect(() => assertTargetSnapshot("prod", expected, null)).toThrow("is no longer configured")
  })

  test("gives conditional discovery guidance only when a usable target exists", () => {
    expect(buildTargetSystemContext(inactiveState, {})).toBeNull()
    expect(buildTargetSystemContext(inactiveState, { future: { transport: "ws" } })).toBeNull()

    const context = buildTargetSystemContext(inactiveState, {
      contabo: { transport: "ssh", host: "161.97.89.121" },
    })
    expect(context).toContain("Prefer a configured REXD target")
    expect(context).toContain('target(action="list")')
    expect(context).toContain("Direct SSH remains appropriate")
  })

  test("reports active routing without exposing sensitive SSH configuration", () => {
    const context = buildTargetSystemContext(
      { activeTargetAlias: "contabo", remoteCwdOverride: "/ignored", lastUsedAt: 1 },
      {
        contabo: {
          transport: "ssh",
          host: "161.97.89.121",
          user: "root",
          description: "Do not include this description",
          defaultCwd: "/root",
          identityFile: "/secret/id_ed25519",
          sshOptions: ["ProxyCommand", "secret-proxy"],
          command: "/secret/rexd --stdio",
        },
      },
    )

    expect(context).toContain('Active REXD target: "contabo" ("root@161.97.89.121:22")')
    expect(context).toContain('configured remote cwd "/root"')
    expect(context).toContain("already routed")
    expect(context).not.toContain("Do not include this description")
    expect(context).not.toContain("/secret")
    expect(context).not.toContain("ProxyCommand")
    expect(context).not.toContain("/ignored")
  })

  test("warns instead of claiming local fallback for unusable active state", () => {
    const missing = buildTargetSystemContext(
      { activeTargetAlias: "missing", remoteCwdOverride: null, lastUsedAt: 1 },
      {},
    )
    const unsupported = buildTargetSystemContext(
      { activeTargetAlias: "future", remoteCwdOverride: null, lastUsedAt: 1 },
      { future: { transport: "http" } },
    )

    expect(missing).toContain("not configured")
    expect(missing).toContain("fail closed")
    expect(unsupported).toContain("transport is unsupported")
    expect(unsupported).toContain("fail closed")
  })

  test("system hook ignores calls without a session ID", async () => {
    const dir = tempDir()
    const plugin = await RexdTargetPlugin(mockPluginInput(dir))
    const output = { system: ["base"] }

    await plugin["experimental.chat.system.transform"]!({ model: {} as any }, output)

    expect(output.system).toEqual(["base"])
  })

  test("system hook follows inherited state changes", async () => {
    const dir = tempDir()
    const alias = `missing-${Math.random()}`
    const parentID = `parent-${Math.random()}`
    const childID = `child-${Math.random()}`
    const parentPath = sessionStatePath(parentID)
    stateFiles.push(parentPath)
    saveSessionStateToPath(parentPath, {
      activeTargetAlias: alias,
      remoteCwdOverride: null,
      lastUsedAt: Date.now(),
    })
    const plugin = await RexdTargetPlugin(mockPluginInput(dir, { [childID]: parentID }))
    const hook = plugin["experimental.chat.system.transform"]!
    const activeOutput = { system: ["base"] }

    await hook({ sessionID: childID, model: {} as any }, activeOutput)
    expect(activeOutput.system.join("\n")).toContain(alias)
    expect(activeOutput.system.join("\n")).toContain("fail closed")

    saveSessionStateToPath(parentPath, {
      activeTargetAlias: null,
      remoteCwdOverride: null,
      lastUsedAt: Date.now(),
    })
    const inactiveOutput = { system: ["base"] }
    await hook({ sessionID: childID, model: {} as any }, inactiveOutput)
    expect(inactiveOutput.system.join("\n")).not.toContain(alias)
  })

  test("system hook preserves fail-closed context when state is corrupt", async () => {
    const dir = tempDir()
    const sessionID = `corrupt-${Math.random()}`
    const path = sessionStatePath(sessionID)
    stateFiles.push(path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "{")
    const plugin = await RexdTargetPlugin(mockPluginInput(dir))
    const output = { system: ["base"] }

    await expect(
      plugin["experimental.chat.system.transform"]!({ sessionID, model: {} as any }, output),
    ).resolves.toBeUndefined()
    expect(output.system.join("\n")).toContain("routing state could not be resolved")
    expect(output.system.join("\n")).toContain("fail closed")
  })

  test("tool descriptions steer remote administration through target selection", async () => {
    const plugin = await RexdTargetPlugin(mockPluginInput(tempDir()))
    expect((plugin.tool!.target as any).description).toContain("list targets when the host-to-alias mapping is uncertain")
    expect((plugin.tool!.bash as any).description).toContain("matching configured REXD target before direct SSH")
  })
})

describe("permissions and capabilities", () => {
  test("asks external_directory before a local path permission outside the worktree", async () => {
    const worktree = tempDir()
    const external = tempDir()
    const { context, asks } = mockContext(worktree)

    await askLocalPathPermission(context as any, "read", join(external, "file.txt"))

    expect(asks.map((ask) => ask.permission)).toEqual(["external_directory", "read"])
    expect(asks[0].patterns[0]).toBe(join(external, "file.txt"))
  })

  test("uses canonical remote paths without comparing them to the local worktree", async () => {
    const { context, asks } = mockContext(tempDir())

    await askRemotePathPermission(context as any, {
      permission: "read",
      path: "/srv/app/../secrets/token",
      workspaceRoots: ["/srv/app"],
      target: "prod",
    })

    const scope = remotePermissionScope("prod")
    expect(asks.map((ask) => ask.permission)).toEqual(["external_directory", "read"])
    expect(asks[0].patterns).toEqual([`${scope}/srv/secrets/token`])
    expect(asks[1].patterns).toEqual([`${scope}/srv/secrets/token`])
  })

  test("keeps directory-wide external permissions scoped to directory contents", async () => {
    const external = tempDir()
    const local = mockContext(tempDir())
    const remote = mockContext(tempDir())

    await askLocalPathPermission(local.context as any, "read", external, {}, "directory")
    await askRemotePathPermission(remote.context as any, {
      permission: "read",
      path: "/srv/secrets",
      workspaceRoots: ["/srv/app"],
      target: "prod",
      kind: "directory",
    })

    expect(local.asks[0].patterns).toEqual([`${external}/*`])
    expect(remote.asks[0].patterns).toEqual([`${remotePermissionScope("prod")}/srv/secrets/*`])
  })

  test("treats OpenCode's root worktree sentinel as outside the project directory", async () => {
    const directory = tempDir()
    const external = tempDir()
    const { context, asks } = mockContext(directory, "/")

    await askLocalPathPermission(context as any, "read", join(external, "file.txt"))

    expect(asks.map((ask) => ask.permission)).toEqual(["external_directory", "read"])
  })

  test("uses search queries as glob and grep permission patterns", async () => {
    const directory = tempDir()
    const plugin = await RexdTargetPlugin(mockPluginInput(directory))
    for (const [toolName, args, expected] of [
      ["glob", { pattern: "**/*.env" }, "**/*.env"],
      ["grep", { pattern: "SECRET" }, "SECRET"],
    ] as const) {
      const { context, asks } = mockContext(directory)
      context.ask = async (input: any) => {
        asks.push(input)
        throw new Error("stop before execution")
      }
      await expect((plugin.tool![toolName] as any).execute(args, context)).rejects.toThrow("stop before execution")
      expect(asks[0].patterns).toEqual([expected])
    }
  })

  test("uses native command patterns and reusable families for compound shell commands", async () => {
    const directory = tempDir()
    const plugin = await RexdTargetPlugin(mockPluginInput(directory))

    for (const command of ["git status && rm -rf build", "git status & rm -rf build"]) {
      const { context, asks } = mockContext(directory)
      context.ask = async (input: any) => {
        asks.push(input)
        throw new Error("stop before execution")
      }
      await expect((plugin.tool!.bash as any).execute({ command }, context)).rejects.toThrow("stop before execution")
      expect(asks[0].permission).toBe("bash")
      expect(asks[0].patterns).toEqual(["git status", "rm -rf build"])
      expect(asks[0].always).toEqual(["git status *", "rm *"])
    }
  })

  test("asks external-directory permission for relative and tilde shell paths", async () => {
    const directory = tempDir()
    const plugin = await RexdTargetPlugin(mockPluginInput(directory))

    for (const command of ["cat ../secret", "cat ~/secret"]) {
      const { context, asks } = mockContext(directory)
      context.ask = async (input: any) => {
        asks.push(input)
        throw new Error("stop before execution")
      }
      await expect((plugin.tool!.bash as any).execute({ command }, context)).rejects.toThrow("stop before execution")
      expect(asks[0].permission).toBe("external_directory")
    }
  })

  test("does not assume a remote user's home directory", async () => {
    const { context, asks } = mockContext(tempDir())
    context.ask = async (input: any) => {
      asks.push(input)
      throw new Error("stop before execution")
    }

    await expect(
      askBashPermission(context as any, "cat ~/secret", "/srv/app", {
        target: "deploy",
        workspaceRoots: ["/srv/app"],
      }),
    ).rejects.toThrow("stop before execution")
    const scope = remotePermissionScope("deploy")
    expect(asks[0]).toMatchObject({ permission: "external_directory", patterns: [`${scope}*`] })
  })

  test("requests exact external files found in local and remote shell commands", async () => {
    const command = "command -v git > /dev/null"
    const local = mockContext(tempDir())
    const remote = mockContext(tempDir())
    const otherDevice = mockContext(tempDir())

    await askBashPermission(local.context as any, command, local.context.directory)
    await askBashPermission(remote.context as any, command, "/srv/app", {
      target: "deploy",
      workspaceRoots: ["/srv/app"],
    })
    await askBashPermission(otherDevice.context as any, "command -v git > /dev/tty", otherDevice.context.directory)

    expect(local.asks[0]).toMatchObject({ permission: "external_directory", patterns: ["/dev/null"] })
    expect(remote.asks[0]).toMatchObject({
      permission: "external_directory",
      patterns: [`${remotePermissionScope("deploy")}/dev/null`],
    })
    expect(otherDevice.asks[0]).toMatchObject({ permission: "external_directory", patterns: ["/dev/tty"] })
  })

  test("scans filesystem operands and redirection targets without treating search and route data as paths", async () => {
    const directory = tempDir()
    const worktree = join(directory, "worktree")
    mkdirSync(worktree)

    for (const command of [
      `rg '"/sitemap.xml"' frontend`,
      'grep "/api/foo" file.ts',
      "curl https://example.com/api/foo",
      "echo ok 2>&1",
      "read value <<</route/data",
    ]) {
      const { context, asks } = mockContext(worktree)
      await askBashPermission(context as any, command, worktree)
      expect(asks.map((ask) => ask.permission)).toEqual(["bash"])
    }

    for (const [command, expected] of [
      ["cat /etc/hosts", "/etc/hosts"],
      ["find .. -name package.json", directory],
      ["echo ok > /etc/output", "/etc/output"],
      ["echo ok>/etc/unspaced-output", "/etc/unspaced-output"],
      [">/etc/redirection-only", "/etc/redirection-only"],
      ["echo ok &>/etc/unsupported-redirection", "/etc/unsupported-redirection"],
    ]) {
      const { context, asks } = mockContext(worktree)
      await askBashPermission(context as any, command, worktree)
      expect(asks[0]).toMatchObject({ permission: "external_directory", patterns: [expected] })
    }
  })

  test("does not treat awk expressions in compound Bash commands as paths", async () => {
    const command = `for u in https://example.com/a https://example.com/b; do
  curl -sI "$u" | awk 'NR==1 || /^content-type:|^content-length:|^location:/'
done`
    const local = mockContext(tempDir())
    const remote = mockContext(tempDir())

    await askBashPermission(local.context as any, command, local.context.directory)
    await askBashPermission(remote.context as any, command, "/srv/app", {
      target: "deploy",
      workspaceRoots: ["/srv/app"],
    })

    expect(local.asks.map((ask) => ask.permission)).toEqual(["bash"])
    expect(remote.asks.map((ask) => ask.permission)).toEqual(["bash"])
    expect(remote.asks[0].patterns.every((pattern: string) => pattern.startsWith(remotePermissionScope("deploy")))).toBe(true)
  })

  test("checks the static prefix before normalizing a glob path", async () => {
    const local = mockContext(tempDir())
    const remote = mockContext(tempDir())

    await askBashPermission(local.context as any, "cat /tmp/*/../../srv/app/file", local.context.directory)
    await askBashPermission(remote.context as any, "cat /tmp/*/../../srv/app/file", "/srv/app", {
      target: "deploy",
      workspaceRoots: ["/srv/app"],
    })

    expect(local.asks[0]).toMatchObject({
      permission: "external_directory",
      patterns: ["/tmp/*"],
      metadata: { filepath: "/tmp" },
    })
    expect(remote.asks[0]).toMatchObject({
      permission: "external_directory",
      patterns: [`${remotePermissionScope("deploy")}/tmp/*`],
      metadata: { filepath: "/tmp", remote: true, target: "deploy" },
    })

    const basenameGlob = mockContext(tempDir())
    await askBashPermission(basenameGlob.context as any, "cat /tmp/foo*.txt", basenameGlob.context.directory)
    expect(basenameGlob.asks[0]).toMatchObject({ permission: "external_directory", patterns: ["/tmp/*"] })
  })

  test("preserves quoted literals and skips dynamic path operands like OpenCode", async () => {
    const directory = tempDir()

    for (const command of [
      "cat '~/secret'",
      "cat \\~/secret",
      "cat '$HOME/secret'",
      "cat \\$HOME/secret",
      "cat $HOME/secret",
      "cat ${HOME}/secret",
      'cat "$HOME/secret"',
    ]) {
      const { context, asks } = mockContext(directory)
      await askBashPermission(context as any, command, directory)
      expect(asks.map((ask) => ask.permission)).toEqual(["bash"])
    }
  })

  test("finds static paths in nested command substitutions", async () => {
    const directory = tempDir()
    const { context, asks } = mockContext(directory)

    await askBashPermission(context as any, 'echo "$(cat /etc/hosts)"', directory)

    expect(asks[0]).toMatchObject({ permission: "external_directory", patterns: ["/etc/hosts"] })
    expect(asks[1].permission).toBe("bash")
  })

  test("isolates remote bash approvals from local execution and other targets", async () => {
    const command = "git log --oneline"
    const local = mockContext(tempDir())
    const targetA = mockContext(tempDir())
    const targetB = mockContext(tempDir())

    await askBashPermission(local.context as any, command, local.context.directory)
    await askBashPermission(targetA.context as any, command, "/root", { target: "target-a", workspaceRoots: ["/root"] })
    await askBashPermission(targetB.context as any, command, "/root", { target: "target-b", workspaceRoots: ["/root"] })

    expect(local.asks[0]).toMatchObject({ permission: "bash", patterns: [command], always: ["git log *"] })
    expect(targetA.asks[0].always).toEqual([`${remotePermissionScope("target-a")}git log *`])
    expect(targetB.asks[0].always).toEqual([`${remotePermissionScope("target-b")}git log *`])
    expect(targetA.asks[0].always).not.toEqual(targetB.asks[0].always)
    expect(targetA.asks[0].always).not.toEqual(local.asks[0].always)
  })

  test("blocks disabled target capabilities before transport work", () => {
    const target = { transport: "ssh" as const, capabilities: { shell: false, fs: false, pty: false } }
    expect(() => assertTargetCapabilities("locked", target, ["shell"])).toThrow("does not support shell")
    expect(() => assertTargetCapabilities("locked", target, ["fs"])).toThrow("does not support fs")
    expect(() => assertTargetCapabilities("locked", target, ["pty"])).toThrow("does not support pty")
  })
})

describe("session state", () => {
  test("inherits active parent state and observes a later parent clear", async () => {
    const dir = tempDir()
    const marker = join(dir, "child-local-marker")
    const parentID = `parent-${Math.random()}`
    const childID = `child-${Math.random()}`
    const parentPath = sessionStatePath(parentID)
    stateFiles.push(parentPath)
    saveSessionStateToPath(parentPath, {
      activeTargetAlias: "missing-parent-target",
      remoteCwdOverride: null,
      lastUsedAt: Date.now(),
    })
    const { context } = mockContext(dir)
    context.sessionID = childID
    const plugin = await RexdTargetPlugin(mockPluginInput(dir, { [childID]: parentID }))

    await expect((plugin.tool!.bash as any).execute({ command: `touch '${marker}'` }, context)).rejects.toThrow(
      "is not configured",
    )
    expect(existsSync(marker)).toBe(false)

    saveSessionStateToPath(parentPath, {
      activeTargetAlias: null,
      remoteCwdOverride: null,
      lastUsedAt: Date.now(),
    })
    await (plugin.tool!.bash as any).execute({ command: `touch '${marker}'` }, context)
    expect(existsSync(marker)).toBe(true)
  })

  test("fails closed when an inherited parent state is corrupt", async () => {
    const dir = tempDir()
    const marker = join(dir, "must-not-exist")
    const parentID = `parent-${Math.random()}`
    const childID = `child-${Math.random()}`
    const parentPath = sessionStatePath(parentID)
    stateFiles.push(parentPath)
    mkdirSync(dirname(parentPath), { recursive: true })
    writeFileSync(parentPath, "{")
    const { context } = mockContext(dir)
    context.sessionID = childID
    const plugin = await RexdTargetPlugin(mockPluginInput(dir, { [childID]: parentID }))

    await expect((plugin.tool!.bash as any).execute({ command: `touch '${marker}'` }, context)).rejects.toThrow(
      "corrupt or invalid",
    )
    expect(existsSync(marker)).toBe(false)
  })

  test("uses nearest state and fails closed on ancestry lookup errors", async () => {
    const active = { activeTargetAlias: "prod", remoteCwdOverride: null, lastUsedAt: 1 }
    const inactive = { activeTargetAlias: null, remoteCwdOverride: null, lastUsedAt: 2 }
    const sessions = new Map([
      ["child", { id: "child", parentID: "parent" }],
      ["parent", { id: "parent" }],
    ])
    const states = new Map<string, any>([["parent", active]])
    const dependencies = {
      getSession: async (id: string) => {
        const session = sessions.get(id)
        if (!session) throw new Error("missing session")
        return session
      },
      loadState: (id: string) => states.get(id),
    }

    await expect(resolveEffectiveSessionState("child", dependencies)).resolves.toEqual({
      state: active,
      ownerSessionID: "parent",
    })
    states.set("child", inactive)
    await expect(resolveEffectiveSessionState("child", dependencies)).resolves.toEqual({
      state: inactive,
      ownerSessionID: "child",
    })
    await expect(
      resolveEffectiveSessionState("unknown", {
        loadState: () => undefined,
        getSession: async () => {
          throw new Error("SDK unavailable")
        },
      }),
    ).rejects.toThrow("SDK unavailable")
  })

  test("an active persisted state cannot execute the real bash tool locally", async () => {
    const dir = tempDir()
    const marker = join(dir, "must-not-exist")
    const { context } = mockContext(dir)
    const path = sessionStatePath(context.sessionID)
    stateFiles.push(path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ activeTargetAlias: "missing-target", lastUsedAt: 0 }))
    const plugin = await RexdTargetPlugin(mockPluginInput(dir))

    await expect((plugin.tool!.bash as any).execute({ command: `touch '${marker}'` }, context)).rejects.toThrow(
      "is not configured",
    )
    expect(existsSync(marker)).toBe(false)
  })

  test("a corrupt persisted state cannot execute the real bash tool locally", async () => {
    const dir = tempDir()
    const marker = join(dir, "must-not-exist")
    const { context } = mockContext(dir)
    const path = sessionStatePath(context.sessionID)
    stateFiles.push(path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "{")
    utimesSync(path, new Date(0), new Date(0))
    const plugin = await RexdTargetPlugin(mockPluginInput(dir))

    await expect((plugin.tool!.bash as any).execute({ command: `touch '${marker}'` }, context)).rejects.toThrow(
      "corrupt or invalid",
    )
    expect(existsSync(marker)).toBe(false)
  })

  test("an active state routes away from local execution", async () => {
    const dir = tempDir()
    const path = join(dir, "state.json")
    saveSessionStateToPath(path, { activeTargetAlias: "prod", remoteCwdOverride: null, lastUsedAt: 1 })
    const state = loadSessionStateFromPath(path)
    let localRuns = 0
    let remoteRuns = 0

    await expect(
      executeForSessionState(state, {
        local: async () => {
          localRuns++
          return "local"
        },
        remote: async () => {
          remoteRuns++
          return "remote"
        },
      }),
    ).resolves.toBe("remote")
    expect(localRuns).toBe(0)
    expect(remoteRuns).toBe(1)
  })

  test("a corrupt state fails closed without invoking local execution", async () => {
    const dir = tempDir()
    const path = join(dir, "state.json")
    writeFileSync(path, '{"activeTargetAlias":null}')
    let localRuns = 0

    try {
      await executeForSessionState(loadSessionStateFromPath(path), {
        local: async () => {
          localRuns++
          return "local"
        },
        remote: async () => "remote",
      })
    } catch (error) {
      expect(String(error)).toContain("corrupt or invalid")
    }
    expect(localRuns).toBe(0)
  })

  test("a valid inactive state still routes locally", async () => {
    let localRuns = 0
    const result = await executeForSessionState(
      { activeTargetAlias: null, remoteCwdOverride: null, lastUsedAt: 1 },
      {
        local: async () => {
          localRuns++
          return "local"
        },
        remote: async () => "remote",
      },
    )
    expect(result).toBe("local")
    expect(localRuns).toBe(1)
  })

  test("writes validated session state atomically and cleans a failed temp file", () => {
    const dir = tempDir()
    const path = join(dir, "state.json")
    const state = { activeTargetAlias: null, remoteCwdOverride: null, lastUsedAt: 1 }
    saveSessionStateToPath(path, state)
    expect(loadSessionStateFromPath(path)).toEqual(state)

    expect(() => saveSessionStateToPath(path, state, { rename: () => { throw new Error("rename failed") } })).toThrow(
      "rename failed",
    )
    expect(readdirSync(dir).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
    expect(() => saveSessionStateToPath(path, { ...state, ignored: true } as any)).toThrow("unknown fields")
  })
})

describe("execution safety", () => {
  test("preserves stdout/stderr arrival order and bounds retained output", () => {
    const buffer = createExecBuffer()
    appendExecOutput(buffer, "stdout", "one")
    appendExecOutput(buffer, "stderr", "two")
    appendExecOutput(buffer, "stdout", "three")
    expect(renderExecOutput(buffer)).toBe("onetwothree")
    expect(outputChunks(buffer).map((chunk) => chunk.stream)).toEqual(["stdout", "stderr", "stdout"])

    appendExecOutput(buffer, "stdout", "x".repeat(1_100_000))
    expect(Buffer.byteLength(outputChunks(buffer).map((chunk) => chunk.data).join(""), "utf8")).toBeLessThanOrEqual(1024 * 1024)
    expect(renderExecOutput(buffer)).toContain("plugin output safety cap reached")

    const fragmented = createExecBuffer()
    for (let index = 0; index < 5000; index++) appendExecOutput(fragmented, index % 2 ? "stdout" : "stderr", "x")
    expect(outputChunks(fragmented).length).toBeLessThanOrEqual(4096)
    expect(renderExecOutput(fragmented)).toContain("plugin output safety cap reached")
  })

  test("cancels a local process", async () => {
    const controller = new AbortController()
    const running = runLocalExec("sleep 5", { cwd: tempDir(), signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await expect(running).rejects.toThrow("Operation cancelled")
  })

  test("kills a remote process that starts after cancellation", async () => {
    let resolveStart!: (value: string) => void
    const start = new Promise<string>((resolve) => {
      resolveStart = resolve
    })
    const controller = new AbortController()
    const killed: string[] = []
    const running = runRemoteProcessLifecycle(
      {
        start: () => start,
        wait: async () => ({ exit_code: 0 }),
        kill: async (id) => {
          killed.push(id)
        },
        cleanup() {},
      },
      controller.signal,
    )
    controller.abort()
    await expect(running).rejects.toThrow("Operation cancelled")
    resolveStart("process-1")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(killed).toEqual(["process-1"])
  })
})

describe("structured results and bash timeout compatibility", () => {
  test("returns edit and patch UI metadata directly", async () => {
    const dir = tempDir()
    const { context, asks } = mockContext(dir)
    writeFileSync(join(dir, "file.txt"), "before")
    const plugin = await RexdTargetPlugin(mockPluginInput(dir))
    const edit = await (plugin.tool!.edit as any).execute(
      { filePath: "file.txt", oldString: "before", newString: "after" },
      context,
    )
    expect(edit.metadata.filediff.patch).toContain("-before")
    expect(edit.title).toBe("file.txt")
    expect(plugin["tool.execute.after"]).toBeUndefined()

    const patch = await (plugin.tool!.apply_patch as any).execute(
      { patchText: "*** Begin Patch\n*** Update File: file.txt\n@@\n-after\n+patched\n*** End Patch" },
      context,
    )
    expect(patch.metadata.files[0].patch).toContain("-after")

    await (plugin.tool!.list as any).execute({}, context)
    expect(asks.at(-1).permission).toBe("read")
  })

  test("accepts deprecated timeout_ms while timeout takes precedence", () => {
    expect(resolveBashTimeout({ timeout_ms: 10 })).toBe(10)
    expect(resolveBashTimeout({ timeout: 20, timeout_ms: 10 })).toBe(20)
    expect(() => resolveBashTimeout({ timeout: -1 })).toThrow("Invalid timeout")
  })
})
