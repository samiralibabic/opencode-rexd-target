import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  buildRemoteReadRpcParams,
  createExecBuffer,
  executeForSessionState,
  formatReadOutput,
  isBinaryReadFile,
  loadSessionStateFromPath,
  outputChunks,
  readLocalResolvedPath,
  remotePermissionScope,
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

describe("permissions and capabilities", () => {
  test("asks external_directory before a local path permission outside the worktree", async () => {
    const worktree = tempDir()
    const external = tempDir()
    const { context, asks } = mockContext(worktree)

    await askLocalPathPermission(context as any, "read", join(external, "file.txt"))

    expect(asks.map((ask) => ask.permission)).toEqual(["external_directory", "read"])
    expect(asks[0].patterns[0]).toBe(`${external}/*`)
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
    expect(asks[0].patterns).toEqual([`${scope}/srv/secrets/*`])
    expect(asks[1].patterns).toEqual([`${scope}/srv/secrets/token`])
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

  test("asks external-directory permission for relative and home shell paths", async () => {
    const directory = tempDir()
    const plugin = await RexdTargetPlugin(mockPluginInput(directory))

    for (const command of ["cat ../secret", "cat ~/secret", "cat $HOME/secret", "cat ${HOME}/secret"]) {
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
