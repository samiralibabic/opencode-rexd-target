import { tool, type Plugin, type ToolContext, type ToolResult } from "@opencode-ai/plugin"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { dirname, isAbsolute, posix, relative, resolve } from "node:path"
import { createTwoFilesPatch } from "diff"
import { buildBashPermissionRequest } from "./bash-permission"

const TARGETS_PATH = resolve(homedir(), ".config/rexd/targets.json")
const SESSION_STATE_ROOT = resolve(homedir(), ".config/opencode/rexd-target/sessions")
const SESSION_STATE_TTL_MS = 1000 * 60 * 60 * 24 * 90
const CLIENT_VERSION = "0.3.7"
const DEFAULT_READ_LIMIT = 2000
const SAMPLE_BYTES = 4096
const EXEC_OUTPUT_MAX_BYTES = 1024 * 1024
const EXEC_OUTPUT_MAX_CHUNKS = 4096
const SSH_STDERR_MAX_BYTES = 16 * 1024
const RPC_LINE_MAX_BYTES = 1024 * 1024
const OUTPUT_CAP_MARKER = "[plugin output safety cap reached; additional output dropped]"
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const BINARY_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".class",
  ".jar",
  ".war",
  ".7z",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".bin",
  ".dat",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".wasm",
  ".pyc",
  ".pyo",
])

export type TargetConfig = {
  transport: "ssh" | "http" | "ws"
  description?: string
  loginShell?: boolean
  defaultCwd?: string
  workspaceRoots?: string[]
  rootPolicy?: { mode: "strict" | "allow_within_server_roots" | "ask_on_escape"; extraRoots?: string[] }
  capabilities?: { shell?: boolean; fs?: boolean; pty?: boolean }
  host?: string
  user?: string
  port?: number
  identityFile?: string
  command?: string
  sshOptions?: string[]
}

export type SessionState = {
  activeTargetAlias: string | null
  remoteCwdOverride?: string | null
  lastUsedAt: number
}

export type EffectiveSessionState = {
  state: SessionState
  ownerSessionID: string
}

type SessionStateResolverDependencies = {
  getSession: (sessionID: string) => Promise<{ id: string; parentID?: string }>
  loadState: (sessionID: string) => SessionState | undefined
}

type PendingRequest = {
  resolve: (value: any) => void
  reject: (err: Error) => void
  timer: Timer
  cleanup: () => void
}

type OutputStream = "stdout" | "stderr"

export type OutputChunk = {
  stream: OutputStream
  data: string
}

export type ExecBuffer = {
  chunks: OutputChunk[]
  bytes: number
  dropped: boolean
}

type ExitWaiter = {
  resolve: (value: any) => void
  reject: (err: Error) => void
  timer: Timer
  cleanup: () => void
}

type Connection = {
  key: string
  opencodeSessionID: string
  alias: string
  target: TargetConfig
  proc: ReturnType<typeof spawn>
  buffer: string
  requestID: number
  pending: Map<number, PendingRequest>
  closed: boolean
  remoteSessionID: string
  cwd: string
  workspaceRoots: string[]
  execBuffers: Map<string, ExecBuffer>
  execExits: Map<string, any>
  execExitWaiters: Map<string, ExitWaiter>
  ptyBuffers: Map<string, ExecBuffer>
  sshStderr: string
}

type PatchChunk = {
  oldLines: string[]
  newLines: string[]
  changeContext?: string
  isEndOfFile?: boolean
}

type PatchHunk =
  | {
      type: "add"
      path: string
      contents: string
    }
  | {
      type: "delete"
      path: string
    }
  | {
      type: "update"
      path: string
      movePath?: string
      chunks: PatchChunk[]
    }

type PatchSummary = {
  added: string[]
  updated: string[]
  deleted: string[]
  moved: Array<{ from: string; to: string }>
}

type PatchUiFile = {
  filePath: string
  relativePath: string
  type: "add" | "update" | "delete" | "move"
  patch: string
  additions: number
  deletions: number
  movePath?: string
}

type ReadArgs = {
  filePath: string
  offset?: number
  limit?: number
}

type ReadAttachment = {
  type: "file"
  mime: string
  url: string
}

type ReadToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: Record<string, any>
      attachments?: ReadAttachment[]
    }

const targetsCache = new Map<string, TargetConfig>()
const connections = new Map<string, Connection>()

function loadTargets(): Record<string, TargetConfig> {
  if (targetsCache.size > 0) return Object.fromEntries(targetsCache)
  if (!existsSync(TARGETS_PATH)) return {}

  try {
    const parsed = JSON.parse(readFileSync(TARGETS_PATH, "utf-8")) as {
      targets?: Record<string, TargetConfig>
    }
    if (parsed.targets) {
      for (const [alias, config] of Object.entries(parsed.targets)) {
        targetsCache.set(alias, config)
      }
    }
    return parsed.targets ?? {}
  } catch {
    return {}
  }
}

function getTarget(alias: string): TargetConfig | null {
  loadTargets()
  return targetsCache.get(alias) ?? null
}

function sessionFileName(opencodeSessionID: string): string {
  return `${createHash("sha256").update(opencodeSessionID).digest("hex")}.json`
}

export function sessionStatePath(opencodeSessionID: string): string {
  return resolve(SESSION_STATE_ROOT, sessionFileName(opencodeSessionID))
}

function defaultSessionState(): SessionState {
  return {
    activeTargetAlias: null,
    remoteCwdOverride: null,
    lastUsedAt: Date.now(),
  }
}

export function validateSessionState(value: unknown): SessionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Session state is invalid: expected an object")
  }

  const state = value as Record<string, unknown>
  const keys = Object.keys(state)
  const allowed = new Set(["activeTargetAlias", "remoteCwdOverride", "lastUsedAt"])
  if (keys.some((key) => !allowed.has(key))) {
    throw new Error("Session state is invalid: contains unknown fields")
  }
  if (!("activeTargetAlias" in state) || !("lastUsedAt" in state)) {
    throw new Error("Session state is invalid: missing required fields")
  }
  if (state.activeTargetAlias !== null && (typeof state.activeTargetAlias !== "string" || !state.activeTargetAlias)) {
    throw new Error("Session state is invalid: activeTargetAlias must be a non-empty string or null")
  }
  if (state.remoteCwdOverride !== undefined && state.remoteCwdOverride !== null && typeof state.remoteCwdOverride !== "string") {
    throw new Error("Session state is invalid: remoteCwdOverride must be a string or null")
  }
  if (typeof state.lastUsedAt !== "number" || !Number.isFinite(state.lastUsedAt)) {
    throw new Error("Session state is invalid: lastUsedAt must be a finite number")
  }

  return {
    activeTargetAlias: state.activeTargetAlias as string | null,
    remoteCwdOverride: (state.remoteCwdOverride as string | null | undefined) ?? null,
    lastUsedAt: state.lastUsedAt as number,
  }
}

export function loadSessionStateFromPath(path: string): SessionState {
  try {
    return validateSessionState(JSON.parse(readFileSync(path, "utf-8")))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Session state at "${path}" is corrupt or invalid: ${detail}`)
  }
}

type SessionStateFileOps = {
  mkdir?: (path: string, options: { recursive: true }) => void
  writeFile?: (path: string, content: string) => void
  rename?: (from: string, to: string) => void
  unlink?: (path: string) => void
}

export function saveSessionStateToPath(path: string, state: SessionState, ops: SessionStateFileOps = {}): void {
  const validated = validateSessionState(state)
  const mkdir = ops.mkdir ?? ((dir, options) => mkdirSync(dir, options))
  const writeFile = ops.writeFile ?? ((file, content) => writeFileSync(file, content))
  const rename = ops.rename ?? renameSync
  const unlink = ops.unlink ?? unlinkSync
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`

  try {
    mkdir(dirname(path), { recursive: true })
    writeFile(temp, JSON.stringify(validated, null, 2))
    rename(temp, path)
  } catch (error) {
    try {
      unlink(temp)
    } catch {}
    throw error
  }
}

function loadSessionState(opencodeSessionID: string): SessionState {
  const path = sessionStatePath(opencodeSessionID)
  return existsSync(path) ? loadSessionStateFromPath(path) : defaultSessionState()
}

function loadSessionStateIfPresent(opencodeSessionID: string): SessionState | undefined {
  const path = sessionStatePath(opencodeSessionID)
  return existsSync(path) ? loadSessionStateFromPath(path) : undefined
}

export async function resolveEffectiveSessionState(
  opencodeSessionID: string,
  dependencies: SessionStateResolverDependencies,
): Promise<EffectiveSessionState> {
  const visited = new Set<string>()
  let current = opencodeSessionID

  while (true) {
    if (visited.has(current)) throw new Error(`Session ancestry cycle detected at "${current}"`)
    visited.add(current)

    const state = dependencies.loadState(current)
    if (state) return { state, ownerSessionID: current }

    let session: { id: string; parentID?: string }
    try {
      session = await dependencies.getSession(current)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Could not resolve target state for session "${current}": ${detail}`)
    }
    if (!session || session.id !== current) {
      throw new Error(`Could not resolve target state for session "${current}": invalid session response`)
    }
    if (!session.parentID) return { state: defaultSessionState(), ownerSessionID: current }
    current = session.parentID
  }
}

function saveSessionState(opencodeSessionID: string, state: SessionState): void {
  saveSessionStateToPath(sessionStatePath(opencodeSessionID), state)
}

function pruneSessionStateFiles(now = Date.now()): void {
  if (!existsSync(SESSION_STATE_ROOT)) return

  for (const entry of readdirSync(SESSION_STATE_ROOT)) {
    if (!entry.endsWith(".json")) continue

    const path = resolve(SESSION_STATE_ROOT, entry)
    try {
      const stats = statSync(path)
      if (!stats.isFile()) continue

      let state: SessionState
      try {
        state = validateSessionState(JSON.parse(readFileSync(path, "utf-8")))
      } catch {
        continue
      }

      if (!state.activeTargetAlias && now - state.lastUsedAt > SESSION_STATE_TTL_MS) unlinkSync(path)
    } catch {}
  }
}

function parseTargetCommand(input: { command: string; arguments: string }): {
  subcommand: string
  alias?: string
} | null {
  let raw = ""

  if (input.command === "target" || input.command === "/target") {
    raw = input.arguments ?? ""
  } else if (input.command.startsWith("target ")) {
    raw = input.command.slice("target ".length)
  } else if (input.command.startsWith("/target ")) {
    raw = input.command.slice("/target ".length)
  } else {
    return null
  }

  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  return {
    subcommand: tokens[0] ?? "help",
    alias: tokens[1],
  }
}

function setCommandText(output: { parts: any[] }, text: string): void {
  const existingText = output.parts.find(
    (part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string",
  )

  if (existingText) {
    existingText.text = text
    return
  }

  output.parts = [{ type: "text", text }]
}

function decodeData(data: string, encoding: string): string {
  if (encoding === "base64") {
    try {
      return Buffer.from(data, "base64").toString("utf-8")
    } catch {
      return ""
    }
  }
  return data
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function localPath(baseDir: string, inputPath: string): string {
  if (!inputPath) return baseDir
  if (isAbsolute(inputPath)) return inputPath
  return resolve(baseDir, inputPath)
}

function normalizeRemotePath(path: string): string {
  const normalized = posix.normalize(path)
  if (normalized === ".") return "/"
  return normalized
}

function remotePath(cwd: string, inputPath: string): string {
  if (!inputPath) return normalizeRemotePath(cwd)
  if (inputPath.startsWith("~")) {
    return normalizeRemotePath(posix.join("/root", inputPath.slice(1)))
  }
  if (inputPath.startsWith("/")) {
    return normalizeRemotePath(inputPath)
  }
  return normalizeRemotePath(posix.join(cwd, inputPath))
}

function inRoot(path: string, root: string): boolean {
  const normalizedRoot = normalizeRemotePath(root)
  if (normalizedRoot === "/") return path.startsWith("/")
  if (path === normalizedRoot) return true
  return path.startsWith(`${normalizedRoot}/`)
}

function pathWithin(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel))
}

function localPathInProject(context: ToolContext, path: string): boolean {
  if (pathWithin(context.directory, path)) return true
  return resolve(context.worktree) !== resolve("/") && pathWithin(context.worktree, path)
}

function localPermissionRoot(context: ToolContext): string {
  return resolve(context.worktree) === resolve("/") ? context.directory : context.worktree
}

function localExternalPattern(path: string, kind: "file" | "directory"): string {
  const dir = kind === "directory" ? path : dirname(path)
  return resolve(dir, "*").replaceAll("\\", "/")
}

function remoteExternalPattern(path: string, kind: "file" | "directory"): string {
  const dir = kind === "directory" ? path : posix.dirname(path)
  return posix.join(dir, "*")
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Operation cancelled")
}

async function askPermission(
  context: ToolContext,
  permission: string,
  patterns: string[],
  always: string[],
  metadata: Record<string, unknown>,
): Promise<void> {
  throwIfAborted(context.abort)
  await context.ask({ permission, patterns, always, metadata })
  throwIfAborted(context.abort)
}

export async function askLocalPathPermission(
  context: ToolContext,
  permission: string,
  path: string,
  metadata: Record<string, unknown> = {},
  kind: "file" | "directory" = "file",
): Promise<void> {
  if (!localPathInProject(context, path)) {
    const pattern = localExternalPattern(path, kind)
    await askPermission(context, "external_directory", [pattern], [pattern], {
      ...metadata,
      filepath: path,
      parentDir: kind === "directory" ? path : dirname(path),
    })
  }
  await askPermission(context, permission, [relative(localPermissionRoot(context), path) || "."], ["*"], {
    ...metadata,
    filepath: path,
  })
}

async function askLocalSearchPermission(
  context: ToolContext,
  permission: "glob" | "grep",
  query: string,
  path: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await askPermission(context, permission, [query], ["*"], metadata)
  if (!localPathInProject(context, path)) {
    const pattern = localExternalPattern(path, "directory")
    await askPermission(context, "external_directory", [pattern], [pattern], {
      ...metadata,
      filepath: path,
      parentDir: path,
    })
  }
}

async function askRemoteSearchPermission(
  context: ToolContext,
  input: {
    permission: "glob" | "grep"
    query: string
    path: string
    workspaceRoots: string[]
    target: string
    metadata: Record<string, unknown>
  },
): Promise<void> {
  const path = normalizeRemotePath(input.path)
  await askPermission(
    context,
    input.permission,
    [remotePermissionPattern(input.target, input.query)],
    [remotePermissionPattern(input.target, "*")],
    {
      ...input.metadata,
      filepath: path,
      target: input.target,
      remote: true,
    },
  )
  const roots = input.workspaceRoots.map(normalizeRemotePath)
  if (roots.length > 0 && !roots.some((root) => inRoot(path, root))) {
    const pattern = remoteExternalPattern(path, "directory")
    const scoped = remotePermissionPattern(input.target, pattern)
    await askPermission(context, "external_directory", [scoped], [scoped], {
      ...input.metadata,
      filepath: path,
      parentDir: path,
      target: input.target,
      remote: true,
    })
  }
}

function shellPaths(command: string, cwd: string, remote: boolean): string[] {
  const paths = new Set<string>()
  const pattern = /(?:^|[\s"'=])((?:\/|\.\.?(?:\/|$)|~\/|\$HOME\/|\$\{HOME\}\/)[^\s"';&|<>`()]*?)(?=$|[\s"';&|<>`()])/g
  for (const match of command.matchAll(pattern)) {
    const value = match[1]
    let path: string
    if (value.startsWith("~/")) {
      if (remote) continue
      path = resolve(homedir(), value.slice(2))
    } else if (value.startsWith("$HOME/") || value.startsWith("${HOME}/")) {
      if (remote) continue
      const suffix = value.slice(value.indexOf("/") + 1)
      path = resolve(homedir(), suffix)
    } else {
      path = remote ? remotePath(cwd, value) : resolve(cwd, value)
    }
    paths.add(path)
  }
  return [...paths]
}

export function remotePermissionScope(target: string): string {
  const identity = createHash("sha256").update(`rexd-target\0${target}`).digest("hex")
  return `rexd.remote.${identity}:`
}

function remotePermissionPattern(target: string, pattern: string): string {
  return `${remotePermissionScope(target)}${pattern}`
}

export async function askRemotePathPermission(
  context: ToolContext,
  input: {
    permission: string
    path: string
    workspaceRoots: string[]
    target: string
    kind?: "file" | "directory"
    metadata?: Record<string, unknown>
  },
): Promise<void> {
  const path = normalizeRemotePath(input.path)
  const kind = input.kind ?? "file"
  const roots = input.workspaceRoots.map(normalizeRemotePath)
  if (roots.length > 0 && !roots.some((root) => inRoot(path, root))) {
    const pattern = remoteExternalPattern(path, kind)
    const scoped = remotePermissionPattern(input.target, pattern)
    await askPermission(context, "external_directory", [scoped], [scoped], {
      ...(input.metadata ?? {}),
      filepath: path,
      parentDir: kind === "directory" ? path : posix.dirname(path),
      target: input.target,
      remote: true,
    })
  }
  await askPermission(
    context,
    input.permission,
    [remotePermissionPattern(input.target, path)],
    [remotePermissionPattern(input.target, "*")],
    {
      ...(input.metadata ?? {}),
      filepath: path,
      target: input.target,
      remote: true,
    },
  )
}

export async function askBashPermission(
  context: ToolContext,
  command: string,
  cwd: string,
  remote?: { target: string; workspaceRoots: string[] },
): Promise<void> {
  if (remote) {
    const roots = remote.workspaceRoots.map(normalizeRemotePath)
    if (roots.length > 0 && !roots.some((root) => inRoot(cwd, root))) {
      const pattern = remoteExternalPattern(cwd, "directory")
      const scoped = remotePermissionPattern(remote.target, pattern)
      await askPermission(context, "external_directory", [scoped], [scoped], {
        command,
        cwd,
        target: remote.target,
        remote: true,
      })
    }
    if (/(?:^|[\s"'=])(?:~\/|\$HOME\/|\$\{HOME\}\/)/.test(command)) {
      const scoped = remotePermissionPattern(remote.target, "*")
      await askPermission(context, "external_directory", [scoped], [scoped], {
        command,
        filepath: "remote home directory",
        target: remote.target,
        remote: true,
      })
    }
    for (const path of shellPaths(command, cwd, true)) {
      if (roots.some((root) => inRoot(normalizeRemotePath(path), root))) continue
      const pattern = remoteExternalPattern(normalizeRemotePath(path), "file")
      const scoped = remotePermissionPattern(remote.target, pattern)
      await askPermission(context, "external_directory", [scoped], [scoped], {
        command,
        filepath: normalizeRemotePath(path),
        target: remote.target,
        remote: true,
      })
    }
  } else if (!localPathInProject(context, cwd)) {
    const pattern = localExternalPattern(cwd, "directory")
    await askPermission(context, "external_directory", [pattern], [pattern], { command, cwd })
  }

  if (!remote) {
    for (const path of shellPaths(command, cwd, false)) {
      if (localPathInProject(context, path)) continue
      const pattern = localExternalPattern(path, "file")
      await askPermission(context, "external_directory", [pattern], [pattern], { command, filepath: path })
    }
  }

  const request = buildBashPermissionRequest(command, {
    remoteScope: remote ? remotePermissionScope(remote.target) : undefined,
  })
  if (request.patterns.length === 0) return
  await askPermission(context, "bash", request.patterns, request.always, {
    command,
    cwd,
    ...(remote ? { target: remote.target, remote: true, permissionScope: remotePermissionScope(remote.target) } : {}),
  })
}

function configuredRemoteCwd(target: TargetConfig): string {
  return normalizeRemotePath(target.defaultCwd ?? target.workspaceRoots?.[0] ?? "/")
}

function configuredWorkspaceRoots(target: TargetConfig): string[] {
  return (target.workspaceRoots ?? []).map(normalizeRemotePath)
}

export function assertTargetCapabilities(
  alias: string,
  target: TargetConfig,
  required: Array<"shell" | "fs" | "pty">,
): void {
  for (const capability of required) {
    if (target.capabilities?.[capability] === false) {
      throw new Error(`Target "${alias}" does not support ${capability} operations.`)
    }
  }
}

function configuredActiveTarget(state: SessionState): { alias: string; target: TargetConfig } {
  if (!state.activeTargetAlias) throw new Error("No active target. Use /target use <alias> first.")
  const target = getTarget(state.activeTargetAlias)
  if (!target) throw new Error(`Target "${state.activeTargetAlias}" is not configured.`)
  if (target.transport !== "ssh") {
    throw new Error(`Target "${state.activeTargetAlias}" uses unsupported transport "${target.transport}".`)
  }
  return { alias: state.activeTargetAlias, target }
}

export async function executeForSessionState<T>(
  state: SessionState,
  handlers: { local: () => Promise<T>; remote: (alias: string) => Promise<T> },
): Promise<T> {
  return state.activeTargetAlias ? await handlers.remote(state.activeTargetAlias) : await handlers.local()
}

function guardRemotePath(target: TargetConfig, path: string, workspaceRoots: string[]): string | null {
  const mode = target.rootPolicy?.mode ?? "strict"
  if (mode === "allow_within_server_roots") return null

  const roots = (target.workspaceRoots && target.workspaceRoots.length > 0
    ? target.workspaceRoots
    : workspaceRoots
  ).map(normalizeRemotePath)
  const extraRoots = (target.rootPolicy?.extraRoots ?? []).map(normalizeRemotePath)
  const allRoots = [...roots, ...extraRoots]

  if (allRoots.length === 0) return null
  if (allRoots.some((root) => inRoot(path, root))) return null

  return `Path \"${path}\" is outside allowed roots: ${allRoots.join(", ")}`
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value)
}

function mimeFromPath(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".pdf")) return "application/pdf"
  if (lower.endsWith(".bmp")) return "image/bmp"
  if (lower.endsWith(".svg")) return "image/svg+xml"
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff"
  if (lower.endsWith(".avif")) return "image/avif"
  return "application/octet-stream"
}

export function sniffReadMime(path: string, bytes: Uint8Array): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp"
  }

  return mimeFromPath(path)
}

export function isSupportedReadMedia(mime: string): boolean {
  return SUPPORTED_IMAGE_MIMES.has(mime) || mime === "application/pdf"
}

export function isBinaryReadFile(path: string, bytes: Uint8Array): boolean {
  const lower = path.toLowerCase()
  for (const ext of BINARY_EXTENSIONS) {
    if (lower.endsWith(ext)) return true
  }

  if (bytes.length === 0) return false

  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++
    }
  }

  return nonPrintableCount / bytes.length > 0.3
}

export function formatReadOutput(content: string, offset?: number, limit?: number): string {
  const lines = content.split("\n")
  const start = Math.max(1, offset ?? 1)
  const startIndex = start - 1
  const endIndex = limit && limit > 0 ? startIndex + limit : undefined
  const sliced = lines.slice(startIndex, endIndex)
  if (sliced.length === 0) return ""

  return sliced.map((line, index) => `${start + index}: ${line}`).join("\n")
}

function readEntryName(entry: { name: string; type: string }): string {
  return entry.type === "dir" || entry.type === "directory" ? `${entry.name}/` : entry.name
}

export function buildDirectoryReadResult(
  path: string,
  entries: Array<{ name: string; type: string }>,
  offset?: number,
  limit?: number,
): Exclude<ReadToolResult, string> {
  const formatted = entries.map(readEntryName).sort((a, b) => a.localeCompare(b))
  const start = Math.max(1, offset ?? 1)
  const max = limit && limit > 0 ? limit : DEFAULT_READ_LIMIT
  const startIndex = start - 1
  const sliced = formatted.slice(startIndex, startIndex + max)
  const truncated = startIndex + sliced.length < formatted.length

  return {
    title: path,
    output: [
      `<path>${path}</path>`,
      `<type>directory</type>`,
      `<entries>`,
      sliced.join("\n"),
      truncated
        ? `\n(Showing ${sliced.length} of ${formatted.length} entries. Use 'offset' parameter to read beyond entry ${start + sliced.length - 1})`
        : `\n(${formatted.length} entries)`,
      `</entries>`,
    ].join("\n"),
    metadata: {
      preview: sliced.slice(0, 20).join("\n"),
      truncated,
      loaded: [],
      display: {
        type: "directory",
        path,
        entries: sliced,
        offset: start,
        totalEntries: formatted.length,
        truncated,
      },
    },
  }
}

export function buildMediaReadResult(path: string, mime: string, base64: string): Exclude<ReadToolResult, string> {
  const msg = mime === "application/pdf" ? "PDF read successfully" : "Image read successfully"
  return {
    title: path,
    output: msg,
    metadata: {
      preview: msg,
      truncated: false,
      loaded: [],
    },
    attachments: [
      {
        type: "file",
        mime,
        url: `data:${mime};base64,${base64}`,
      },
    ],
  }
}

export function buildRemoteReadRpcParams(input: {
  sessionID: string
  path: string
  encoding?: "utf8" | "base64"
  length?: number
}): Record<string, unknown> {
  return {
    session_id: input.sessionID,
    path: input.path,
    ...(input.encoding ? { encoding: input.encoding } : {}),
    ...(input.length && input.length > 0 ? { length: input.length } : {}),
  }
}

export function readLocalResolvedPath(path: string, args: Pick<ReadArgs, "offset" | "limit"> = {}): ReadToolResult {
  const stats = statSync(path)
  if (stats.isDirectory()) {
    const entries = readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "dir" : "file",
    }))
    return buildDirectoryReadResult(path, entries, args.offset, args.limit)
  }

  const bytes = readFileSync(path)
  const sample = bytes.subarray(0, SAMPLE_BYTES)
  const mime = sniffReadMime(path, sample)
  if (isSupportedReadMedia(mime)) {
    return buildMediaReadResult(path, mime, bytes.toString("base64"))
  }

  if (isBinaryReadFile(path, sample)) {
    throw new Error(`Cannot read binary file: ${path}`)
  }

  return formatReadOutput(bytes.toString("utf-8"), args.offset, args.limit)
}

function formatListEntries(entries: Array<{ name: string; type: string }>): string {
  if (entries.length === 0) return ""
  return entries
    .map(readEntryName)
    .join("\n")
}

function applyExactEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): { content: string; replacements: number } {
  if (oldString === newString) {
    throw new Error("oldString and newString are identical")
  }

  if (oldString === "") {
    return { content: newString, replacements: 1 }
  }

  if (replaceAll) {
    const replacements = content.split(oldString).length - 1
    if (replacements <= 0) {
      throw new Error("oldString not found")
    }
    return {
      content: content.split(oldString).join(newString),
      replacements,
    }
  }

  const first = content.indexOf(oldString)
  if (first === -1) {
    throw new Error("oldString not found")
  }
  if (content.indexOf(oldString, first + oldString.length) !== -1) {
    throw new Error("oldString matched multiple locations; set replaceAll=true")
  }

  return {
    content: content.slice(0, first) + newString + content.slice(first + oldString.length),
    replacements: 1,
  }
}

function parsePatchEnvelope(patchText: string): PatchHunk[] {
  const normalized = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const lines = normalized.split("\n")

  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch")
  if (begin === -1) {
    throw new Error("Invalid patch format: missing *** Begin Patch")
  }

  let end = -1
  for (let i = begin + 1; i < lines.length; i++) {
    if (lines[i].trim() === "*** End Patch") {
      end = i
      break
    }
  }
  if (end === -1 || end <= begin) {
    throw new Error("Invalid patch format: missing *** End Patch")
  }

  const hunks: PatchHunk[] = []
  let i = begin + 1
  while (i < end) {
    const line = lines[i]

    if (line.startsWith("*** Add File:")) {
      const filePath = line.slice("*** Add File:".length).trim()
      if (!filePath) throw new Error(`Invalid add file header at line ${i + 1}`)
      i += 1

      const contentLines: string[] = []
      while (i < end && !lines[i].startsWith("***")) {
        if (lines[i].startsWith("+")) {
          contentLines.push(lines[i].slice(1))
        }
        i += 1
      }

      hunks.push({ type: "add", path: filePath, contents: contentLines.join("\n") })
      continue
    }

    if (line.startsWith("*** Delete File:")) {
      const filePath = line.slice("*** Delete File:".length).trim()
      if (!filePath) throw new Error(`Invalid delete file header at line ${i + 1}`)
      hunks.push({ type: "delete", path: filePath })
      i += 1
      continue
    }

    if (line.startsWith("*** Update File:")) {
      const filePath = line.slice("*** Update File:".length).trim()
      if (!filePath) throw new Error(`Invalid update file header at line ${i + 1}`)
      i += 1

      let movePath: string | undefined
      if (i < end && lines[i].startsWith("*** Move to:")) {
        movePath = lines[i].slice("*** Move to:".length).trim()
        if (!movePath) throw new Error(`Invalid move target at line ${i + 1}`)
        i += 1
      }

      const chunks: PatchChunk[] = []
      while (i < end && !lines[i].startsWith("***")) {
        if (!lines[i].startsWith("@@")) {
          i += 1
          continue
        }

        const changeContext = lines[i].slice(2).trim()
        i += 1
        const oldLines: string[] = []
        const newLines: string[] = []
        let isEndOfFile = false

        while (i < end && !lines[i].startsWith("@@") && !lines[i].startsWith("***")) {
          const changeLine = lines[i]
          if (changeLine === "*** End of File") {
            isEndOfFile = true
            i += 1
            break
          }
          if (changeLine.length === 0) {
            i += 1
            continue
          }

          const prefix = changeLine[0]
          const body = changeLine.slice(1)
          if (prefix === " ") {
            oldLines.push(body)
            newLines.push(body)
          } else if (prefix === "-") {
            oldLines.push(body)
          } else if (prefix === "+") {
            newLines.push(body)
          }
          i += 1
        }

        chunks.push({ oldLines, newLines, changeContext, isEndOfFile })
      }

      hunks.push({ type: "update", path: filePath, movePath, chunks })
      continue
    }

    i += 1
  }

  if (hunks.length === 0) {
    throw new Error("Patch does not contain any hunks")
  }
  return hunks
}

function splitPatchLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const lines = normalized.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1)
  }
  return lines
}

function diffPathLabel(value: string): string {
  return value.replace(/\\/g, "/")
}

function createUnifiedDiff(oldPath: string, newPath: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(
    diffPathLabel(oldPath),
    diffPathLabel(newPath),
    before,
    after,
    "",
    "",
    { context: 3 },
  )

  const lines = patch.split("\n")
  if (lines[0]?.startsWith("===================================================================")) {
    return lines.slice(1).join("\n")
  }
  return patch
}

function detectEol(content: string): "\r\n" | "\n" | "\r" {
  const lf = content.indexOf("\n")
  if (lf !== -1) {
    return lf > 0 && content[lf - 1] === "\r" ? "\r\n" : "\n"
  }
  return content.includes("\r") ? "\r" : "\n"
}

function hasTrailingNewline(content: string): boolean {
  return /\r\n$|\n$|\r$/.test(content)
}

function countDiffChanges(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("@@")) continue
    if (line.startsWith("+")) additions += 1
    if (line.startsWith("---")) continue
    if (line.startsWith("-")) deletions += 1
  }
  return { additions, deletions }
}

function relativeUiPathFromWorktree(worktree: string, absolutePath: string, fallback: string): string {
  const relPath = resolve(absolutePath).startsWith(resolve(worktree))
    ? relative(worktree, absolutePath).replace(/\\/g, "/")
    : fallback.replace(/\\/g, "/")
  return relPath || fallback.replace(/\\/g, "/")
}

function relativeUiPathFromCwd(cwd: string, absolutePath: string, fallback: string): string {
  const normalizedCwd = normalizeRemotePath(cwd)
  const normalizedPath = normalizeRemotePath(absolutePath)
  if (inRoot(normalizedPath, normalizedCwd)) {
    const value = posix.relative(normalizedCwd, normalizedPath)
    return value || "."
  }
  return fallback
}

function sequenceMatches(
  lines: string[],
  pattern: string[],
  start: number,
  compare: (left: string, right: string) => boolean,
): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (!compare(lines[start + i], pattern[i])) return false
  }
  return true
}

function tryMatchSequence(
  lines: string[],
  pattern: string[],
  start: number,
  endOfFile: boolean,
  compare: (left: string, right: string) => boolean,
): number {
  if (pattern.length === 0 || lines.length < pattern.length) return -1

  if (endOfFile) {
    const fromEnd = lines.length - pattern.length
    if (fromEnd >= start && sequenceMatches(lines, pattern, fromEnd, compare)) {
      return fromEnd
    }
  }

  const maxStart = lines.length - pattern.length
  for (let i = start; i <= maxStart; i++) {
    if (sequenceMatches(lines, pattern, i, compare)) {
      return i
    }
  }
  return -1
}

function seekPatchSequence(lines: string[], pattern: string[], start: number, endOfFile: boolean): number {
  if (pattern.length === 0) return -1

  const exact = tryMatchSequence(lines, pattern, start, endOfFile, (left, right) => left === right)
  if (exact !== -1) return exact

  const rstrip = tryMatchSequence(lines, pattern, start, endOfFile, (left, right) => {
    return left.replace(/[ \t]+$/, "") === right.replace(/[ \t]+$/, "")
  })
  if (rstrip !== -1) return rstrip

  return tryMatchSequence(lines, pattern, start, endOfFile, (left, right) => {
    return left.trim() === right.trim()
  })
}

function derivePatchedContent(original: string, chunks: PatchChunk[]): string {
  const originalLines = splitPatchLines(original)
  const originalEol = detectEol(original)
  const originalHadTrailingNewline = hasTrailingNewline(original)
  const replacements: Array<{ start: number; oldLen: number; newLines: string[] }> = []
  let searchStart = 0

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextIndex = seekPatchSequence(originalLines, [chunk.changeContext], searchStart, false)
      if (contextIndex === -1) {
        throw new Error(`Failed to find patch context: ${chunk.changeContext}`)
      }
      searchStart = contextIndex + 1
    }

    if (chunk.oldLines.length === 0) {
      replacements.push({ start: originalLines.length, oldLen: 0, newLines: chunk.newLines })
      continue
    }

    let oldLines = [...chunk.oldLines]
    let newLines = [...chunk.newLines]
    let found = seekPatchSequence(originalLines, oldLines, searchStart, Boolean(chunk.isEndOfFile))

    if (found === -1 && oldLines.length > 0 && oldLines[oldLines.length - 1] === "") {
      oldLines = oldLines.slice(0, -1)
      if (newLines.length > 0 && newLines[newLines.length - 1] === "") {
        newLines = newLines.slice(0, -1)
      }
      found = seekPatchSequence(originalLines, oldLines, searchStart, Boolean(chunk.isEndOfFile))
    }

    if (found === -1) {
      throw new Error("Failed to find expected patch lines")
    }

    replacements.push({ start: found, oldLen: oldLines.length, newLines })
    searchStart = found + oldLines.length
  }

  let result = [...originalLines]
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]
    result = [
      ...result.slice(0, replacement.start),
      ...replacement.newLines,
      ...result.slice(replacement.start + replacement.oldLen),
    ]
  }

  if (originalHadTrailingNewline) {
    if (result.length === 0 || result[result.length - 1] !== "") {
      result.push("")
    }
  }

  return result.join(originalEol)
}

function applyLocalPatch(baseDir: string, patchText: string): PatchSummary {
  const hunks = parsePatchEnvelope(patchText)
  const summary: PatchSummary = { added: [], updated: [], deleted: [], moved: [] }

  for (const hunk of hunks) {
    const targetPath = localPath(baseDir, hunk.path)

    if (hunk.type === "add") {
      if (existsSync(targetPath)) {
        throw new Error(`File already exists: ${targetPath}`)
      }
      const dir = dirname(targetPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const content = hunk.contents !== "" && !hunk.contents.endsWith("\n") ? `${hunk.contents}\n` : hunk.contents
      writeFileSync(targetPath, content)
      summary.added.push(targetPath)
      continue
    }

    if (hunk.type === "delete") {
      if (!existsSync(targetPath)) {
        throw new Error(`File does not exist: ${targetPath}`)
      }
      unlinkSync(targetPath)
      summary.deleted.push(targetPath)
      continue
    }

    if (!existsSync(targetPath)) {
      throw new Error(`File does not exist: ${targetPath}`)
    }

    const current = readFileSync(targetPath, "utf-8")
    const next = hunk.chunks.length > 0 ? derivePatchedContent(current, hunk.chunks) : current

    if (hunk.movePath) {
      const movePath = localPath(baseDir, hunk.movePath)
      const moveDir = dirname(movePath)
      if (!existsSync(moveDir)) mkdirSync(moveDir, { recursive: true })
      writeFileSync(movePath, next)

      if (movePath === targetPath) {
        summary.updated.push(targetPath)
      } else {
        unlinkSync(targetPath)
        summary.moved.push({ from: targetPath, to: movePath })
      }
      continue
    }

    writeFileSync(targetPath, next)
    summary.updated.push(targetPath)
  }

  return summary
}

function buildLocalPatchUiFiles(baseDir: string, patchText: string, worktree: string): PatchUiFile[] {
  const hunks = parsePatchEnvelope(patchText)
  const files: PatchUiFile[] = []

  for (const hunk of hunks) {
    const sourcePath = localPath(baseDir, hunk.path)

    if (hunk.type === "add") {
      const before = ""
      const after = hunk.contents !== "" && !hunk.contents.endsWith("\n") ? `${hunk.contents}\n` : hunk.contents
      const diff = createUnifiedDiff(`/dev/null`, sourcePath, before, after)
      const { additions, deletions } = countDiffChanges(diff)

      files.push({
        filePath: sourcePath,
        relativePath: relativeUiPathFromWorktree(worktree, sourcePath, hunk.path),
        type: "add",
        patch: diff,
        additions,
        deletions,
      })
      continue
    }

    if (hunk.type === "delete") {
      const before = readFileSync(sourcePath, "utf-8")
      const after = ""
      const diff = createUnifiedDiff(sourcePath, `/dev/null`, before, after)
      const { additions, deletions } = countDiffChanges(diff)

      files.push({
        filePath: sourcePath,
        relativePath: relativeUiPathFromWorktree(worktree, sourcePath, hunk.path),
        type: "delete",
        patch: diff,
        additions,
        deletions,
      })
      continue
    }

    const before = readFileSync(sourcePath, "utf-8")
    const after = hunk.chunks.length > 0 ? derivePatchedContent(before, hunk.chunks) : before
    const destinationPath = hunk.movePath ? localPath(baseDir, hunk.movePath) : sourcePath
    const diff = createUnifiedDiff(sourcePath, destinationPath, before, after)
    const { additions, deletions } = countDiffChanges(diff)

    files.push({
      filePath: sourcePath,
      relativePath: relativeUiPathFromWorktree(worktree, destinationPath, hunk.movePath ?? hunk.path),
      type: hunk.movePath ? "move" : "update",
      patch: diff,
      additions,
      deletions,
      movePath: hunk.movePath ? destinationPath : undefined,
    })
  }

  return files
}

async function readRemoteFile(connection: Connection, path: string, signal?: AbortSignal): Promise<string> {
  const response = await rpcRequest(
    connection,
    "fs.read",
    { session_id: connection.remoteSessionID, path },
    30000,
    signal,
  )
  const encoding = String(response?.encoding ?? "utf8")
  const raw = String(response?.content ?? "")
  return decodeData(raw, encoding)
}

async function readRemoteBase64(connection: Connection, path: string, length?: number, signal?: AbortSignal): Promise<any> {
  return await rpcRequest(
    connection,
    "fs.read",
    buildRemoteReadRpcParams({
      sessionID: connection.remoteSessionID,
      path,
      encoding: "base64",
      length,
    }),
    30000,
    signal,
  )
}

async function readRemoteResolvedPath(
  connection: Connection,
  path: string,
  args: Pick<ReadArgs, "offset" | "limit"> = {},
  signal?: AbortSignal,
): Promise<ReadToolResult> {
  const stat = await rpcRequest(
    connection,
    "fs.stat",
    { session_id: connection.remoteSessionID, path },
    30000,
    signal,
  )
  if (stat?.exists === false) {
    throw new Error(`File not found: ${path}`)
  }

  if (String(stat?.type ?? "file") === "dir") {
    const response = await rpcRequest(
      connection,
      "fs.list",
      { session_id: connection.remoteSessionID, path },
      30000,
      signal,
    )
    const entries = Array.isArray(response?.entries)
      ? response.entries.map((entry: any) => ({
          name: String(entry?.name ?? ""),
          type: String(entry?.type ?? "file"),
        }))
      : []
    return buildDirectoryReadResult(path, entries, args.offset, args.limit)
  }

  const sampleResponse = await readRemoteBase64(connection, path, SAMPLE_BYTES, signal)
  const sample = Buffer.from(String(sampleResponse?.content ?? ""), "base64")
  const mime = sniffReadMime(path, sample)

  if (isSupportedReadMedia(mime)) {
    const response = await readRemoteBase64(connection, path, undefined, signal)
    if (response?.truncated === true) {
      throw new Error(
        `Cannot attach media file because REXD truncated the read: ${path}. Increase max_file_read_bytes on the target or use a smaller file.`,
      )
    }
    return buildMediaReadResult(path, mime, String(response?.content ?? ""))
  }

  if (isBinaryReadFile(path, sample)) {
    throw new Error(`Cannot read binary file: ${path}`)
  }

  const response = await rpcRequest(
    connection,
    "fs.read",
    buildRemoteReadRpcParams({
      sessionID: connection.remoteSessionID,
      path,
      encoding: "utf8",
    }),
    30000,
    signal,
  )
  const encoding = String(response?.encoding ?? "utf8")
  const raw = String(response?.content ?? "")
  const content = decodeData(raw, encoding)
  return formatReadOutput(content, args.offset, args.limit)
}

async function buildRemotePatchUiFiles(
  connection: Connection,
  patchText: string,
  signal?: AbortSignal,
): Promise<PatchUiFile[]> {
  const hunks = parsePatchEnvelope(patchText)
  const files: PatchUiFile[] = []

  for (const hunk of hunks) {
    const sourcePath = remotePath(connection.cwd, hunk.path)

    if (hunk.type === "add") {
      const before = ""
      const after = hunk.contents !== "" && !hunk.contents.endsWith("\n") ? `${hunk.contents}\n` : hunk.contents
      const diff = createUnifiedDiff(`/dev/null`, sourcePath, before, after)
      const { additions, deletions } = countDiffChanges(diff)

      files.push({
        filePath: sourcePath,
        relativePath: relativeUiPathFromCwd(connection.cwd, sourcePath, hunk.path),
        type: "add",
        patch: diff,
        additions,
        deletions,
      })
      continue
    }

    if (hunk.type === "delete") {
      const before = await readRemoteFile(connection, sourcePath, signal)
      const after = ""
      const diff = createUnifiedDiff(sourcePath, `/dev/null`, before, after)
      const { additions, deletions } = countDiffChanges(diff)

      files.push({
        filePath: sourcePath,
        relativePath: relativeUiPathFromCwd(connection.cwd, sourcePath, hunk.path),
        type: "delete",
        patch: diff,
        additions,
        deletions,
      })
      continue
    }

    const before = await readRemoteFile(connection, sourcePath, signal)
    const after = hunk.chunks.length > 0 ? derivePatchedContent(before, hunk.chunks) : before
    const destinationPath = hunk.movePath ? remotePath(connection.cwd, hunk.movePath) : sourcePath
    const diff = createUnifiedDiff(sourcePath, destinationPath, before, after)
    const { additions, deletions } = countDiffChanges(diff)

    files.push({
      filePath: sourcePath,
      relativePath: relativeUiPathFromCwd(connection.cwd, destinationPath, hunk.movePath ?? hunk.path),
      type: hunk.movePath ? "move" : "update",
      patch: diff,
      additions,
      deletions,
      movePath: hunk.movePath ? destinationPath : undefined,
    })
  }

  return files
}

function buildEditUiMetadata(filePath: string, before: string, after: string) {
  const diff = createUnifiedDiff(filePath, filePath, before, after)
  const { additions, deletions } = countDiffChanges(diff)
  return {
    diff,
    filediff: {
      file: filePath,
      patch: diff,
      additions,
      deletions,
    },
    diagnostics: {},
  }
}

function normalizePatchSummary(value: any): PatchSummary {
  const toArray = (input: unknown): string[] =>
    Array.isArray(input) ? input.map((item) => String(item)) : []

  const moved = Array.isArray(value?.moved)
    ? value.moved
        .map((item: any) => ({ from: String(item?.from ?? ""), to: String(item?.to ?? "") }))
        .filter((item: { from: string; to: string }) => item.from && item.to)
    : []

  return {
    added: toArray(value?.added),
    updated: toArray(value?.updated),
    deleted: toArray(value?.deleted),
    moved,
  }
}

function renderPatchSummary(summary: PatchSummary): string {
  const lines: string[] = []
  if (summary.added.length > 0) lines.push(`Added: ${summary.added.join(", ")}`)
  if (summary.updated.length > 0) lines.push(`Updated: ${summary.updated.join(", ")}`)
  if (summary.deleted.length > 0) lines.push(`Deleted: ${summary.deleted.join(", ")}`)
  if (summary.moved.length > 0) {
    lines.push(`Moved: ${summary.moved.map((item) => `${item.from} -> ${item.to}`).join(", ")}`)
  }
  if (lines.length === 0) return "Patch applied with no file changes"
  return `Patch applied:\n${lines.join("\n")}`
}

function guardRemotePatch(
  target: TargetConfig,
  cwd: string,
  workspaceRoots: string[],
  patchText: string,
): string | null {
  let hunks: PatchHunk[]
  try {
    hunks = parsePatchEnvelope(patchText)
  } catch (error) {
    return `Invalid patch: ${error instanceof Error ? error.message : String(error)}`
  }

  for (const hunk of hunks) {
    const targetPath = remotePath(cwd, hunk.path)
    const targetGuard = guardRemotePath(target, targetPath, workspaceRoots)
    if (targetGuard) return targetGuard

    if (hunk.type === "update" && hunk.movePath) {
      const movePath = remotePath(cwd, hunk.movePath)
      const moveGuard = guardRemotePath(target, movePath, workspaceRoots)
      if (moveGuard) return moveGuard
    }
  }

  return null
}

function connectionKey(opencodeSessionID: string, alias: string): string {
  return `${opencodeSessionID}::${alias}`
}

function isAlive(connection: Connection): boolean {
  return !connection.closed && connection.proc.exitCode === null && !connection.proc.killed
}

function closeConnection(connection: Connection, reason?: string): void {
  if (connection.closed) return
  connection.closed = true

  for (const pending of connection.pending.values()) {
    clearTimeout(pending.timer)
    pending.cleanup()
    pending.reject(new Error(reason ?? "Connection closed"))
  }
  connection.pending.clear()

  for (const waiter of connection.execExitWaiters.values()) {
    clearTimeout(waiter.timer)
    waiter.cleanup()
    waiter.reject(new Error(reason ?? "Connection closed"))
  }
  connection.execExitWaiters.clear()
  connection.execBuffers.clear()
  connection.execExits.clear()
  connection.ptyBuffers.clear()

  connections.delete(connection.key)

  try {
    connection.proc.stdin?.end()
  } catch {}
  try {
    connection.proc.stdout?.removeAllListeners("data")
    connection.proc.stderr?.removeAllListeners("data")
  } catch {}
  try {
    connection.proc.kill()
  } catch {}
}

export function createExecBuffer(): ExecBuffer {
  return { chunks: [], bytes: 0, dropped: false }
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  const bytes = Buffer.from(value, "utf8")
  if (bytes.length <= maxBytes) return value
  let end = Math.min(maxBytes, bytes.length)
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString("utf8")
}

export function appendExecOutput(buffer: ExecBuffer, stream: OutputStream, data: string): void {
  if (!data) return
  if (buffer.chunks.length >= EXEC_OUTPUT_MAX_CHUNKS) {
    buffer.dropped = true
    return
  }
  const remaining = EXEC_OUTPUT_MAX_BYTES - buffer.bytes
  if (remaining <= 0) {
    buffer.dropped = true
    return
  }
  const kept = takeUtf8Prefix(data, remaining)
  if (kept) {
    buffer.chunks.push({ stream, data: kept })
    buffer.bytes += Buffer.byteLength(kept, "utf8")
  }
  if (kept.length !== data.length) buffer.dropped = true
}

export function renderExecOutput(buffer: ExecBuffer): string {
  const body = buffer.chunks.map((chunk) => chunk.data).join("")
  return buffer.dropped ? `${body}${body.endsWith("\n") || !body ? "" : "\n"}${OUTPUT_CAP_MARKER}` : body
}

export function outputChunks(buffer: ExecBuffer): ReadonlyArray<OutputChunk> {
  return buffer.chunks
}

function appendSshStderr(connection: Connection, chunk: string): void {
  const joined = connection.sshStderr + chunk
  connection.sshStderr = takeUtf8Prefix(joined.slice(-SSH_STDERR_MAX_BYTES * 2), SSH_STDERR_MAX_BYTES)
  if (Buffer.byteLength(joined, "utf8") > SSH_STDERR_MAX_BYTES) {
    const bytes = Buffer.from(joined, "utf8")
    connection.sshStderr = bytes.subarray(Math.max(0, bytes.length - SSH_STDERR_MAX_BYTES)).toString("utf8")
  }
}

function connectionError(connection: Connection, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  const stderr = connection.sshStderr.trim()
  return new Error(stderr ? `${message}\nSSH stderr: ${stderr}` : message)
}

function getExecBuffer(connection: Connection, processID: string): ExecBuffer {
  let buffer = connection.execBuffers.get(processID)
  if (!buffer) {
    buffer = createExecBuffer()
    connection.execBuffers.set(processID, buffer)
  }
  return buffer
}

function handleNotification(connection: Connection, method: string, params: any): void {
  if (method === "exec.stdout" || method === "exec.stderr") {
    const processID = String(params?.process_id ?? "")
    if (!processID) return
    const data = decodeData(String(params?.data ?? ""), String(params?.encoding ?? "utf8"))
    const buffer = getExecBuffer(connection, processID)
    appendExecOutput(buffer, method === "exec.stdout" ? "stdout" : "stderr", data)
    return
  }

  if (method === "exec.exit") {
    const processID = String(params?.process_id ?? "")
    if (!processID) return
    connection.execExits.set(processID, params)
    const waiter = connection.execExitWaiters.get(processID)
    if (waiter) {
      connection.execExitWaiters.delete(processID)
      clearTimeout(waiter.timer)
      waiter.resolve(params)
    }
    return
  }

  if (method === "pty.output") {
    const ptyID = String(params?.pty_id ?? "")
    if (!ptyID) return
    const data = decodeData(String(params?.data ?? ""), String(params?.encoding ?? "utf8"))
    const buffer = connection.ptyBuffers.get(ptyID) ?? createExecBuffer()
    appendExecOutput(buffer, "stdout", data)
    connection.ptyBuffers.set(ptyID, buffer)
  }
}

function handleLine(connection: Connection, line: string): void {
  let message: any
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  if (typeof message.id !== "undefined") {
    const id = Number(message.id)
    const pending = connection.pending.get(id)
    if (!pending) return
    connection.pending.delete(id)
    clearTimeout(pending.timer)

    if (message.error) {
      pending.reject(new Error(String(message.error?.message ?? "Unknown RPC error")))
    } else {
      pending.resolve(message.result)
    }
    return
  }

  if (typeof message.method === "string") {
    handleNotification(connection, message.method, message.params)
  }
}

async function rpcRequest(
  connection: Connection,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 30000,
  signal?: AbortSignal,
): Promise<any> {
  if (signal) throwIfAborted(signal)
  if (!isAlive(connection)) {
    throw new Error(`Connection to target \"${connection.alias}\" is not active`)
  }

  if (!connection.proc.stdin) {
    throw new Error("Connection stdin is not available")
  }

  const id = ++connection.requestID
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"

  return await new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      connection.pending.delete(id)
      reject(error)
    }
    const succeed = (value: any) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      connection.pending.delete(id)
      resolve(value)
    }
    const onAbort = () => fail(new Error("Operation cancelled"))
    const timer = setTimeout(() => {
      fail(new Error(`Request \"${method}\" timed out`))
    }, timeoutMs)

    connection.pending.set(id, {
      resolve: succeed,
      reject: fail,
      timer,
      cleanup,
    })

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    }

    if (settled) return
    connection.proc.stdin!.write(payload, (err) => {
      if (err) {
        fail(err)
      }
    })
  })
}

async function createConnection(
  opencodeSessionID: string,
  alias: string,
  target: TargetConfig,
  signal?: AbortSignal,
): Promise<Connection> {
  if (signal) throwIfAborted(signal)
  if (!target.host) {
    throw new Error(`Target \"${alias}\" is missing \"host\"`)
  }

  const key = connectionKey(opencodeSessionID, alias)
  const existing = connections.get(key)
  if (existing) closeConnection(existing)

  const args: string[] = []
  if (target.port) args.push("-p", String(target.port))
  if (target.identityFile) args.push("-i", target.identityFile)
  if (target.sshOptions?.length) args.push(...target.sshOptions)
  args.push("-T")
  args.push(target.user ? `${target.user}@${target.host}` : target.host)
  args.push(target.command ?? "/usr/local/bin/rexd --stdio")

  const proc = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] })
  const connection: Connection = {
    key,
    opencodeSessionID,
    alias,
    target,
    proc,
    buffer: "",
    requestID: 0,
    pending: new Map(),
    closed: false,
    remoteSessionID: "",
    cwd: configuredRemoteCwd(target),
    workspaceRoots: configuredWorkspaceRoots(target),
    execBuffers: new Map(),
    execExits: new Map(),
    execExitWaiters: new Map(),
    ptyBuffers: new Map(),
    sshStderr: "",
  }
  connections.set(key, connection)

  proc.on("error", (err) => {
    closeConnection(connection, `SSH error: ${err.message}`)
  })

  proc.on("exit", (code, signal) => {
    const reason = `SSH exited with code ${String(code)}${signal ? ` (${signal})` : ""}`
    closeConnection(connection, reason)
  })

  proc.stdout?.setEncoding("utf8")
  proc.stdout?.on("data", (chunk: string) => {
    connection.buffer += chunk
    if (Buffer.byteLength(connection.buffer, "utf8") > RPC_LINE_MAX_BYTES) {
      closeConnection(connection, "REXD RPC response exceeded the safety limit")
      return
    }
    let newline = connection.buffer.indexOf("\n")
    while (newline !== -1) {
      const line = connection.buffer.slice(0, newline)
      connection.buffer = connection.buffer.slice(newline + 1)
      if (line.trim()) handleLine(connection, line)
      newline = connection.buffer.indexOf("\n")
    }
  })

  proc.stderr?.setEncoding("utf8")
  proc.stderr?.on("data", (chunk: string) => appendSshStderr(connection, chunk))

  try {
    const session = await rpcRequest(
      connection,
      "session.open",
      {
        client_name: "opencode-rexd-target",
        client_version: CLIENT_VERSION,
        workspace_roots: target.workspaceRoots,
      },
      20000,
      signal,
    )

    connection.remoteSessionID = String(session?.session_id ?? "")
    if (!connection.remoteSessionID) {
      throw new Error("session.open failed: missing session_id")
    }

    connection.workspaceRoots = Array.isArray(session?.workspace_roots)
      ? session.workspace_roots.map((root: string) => normalizeRemotePath(root))
      : configuredWorkspaceRoots(target)
    connection.cwd = configuredRemoteCwd(target)
    return connection
  } catch (error) {
    const failure = connectionError(connection, error)
    closeConnection(connection, failure.message)
    throw failure
  }
}

async function ensureConnection(opencodeSessionID: string, state = loadSessionState(opencodeSessionID), signal?: AbortSignal): Promise<Connection> {
  const { alias, target } = configuredActiveTarget(state)
  if (signal) throwIfAborted(signal)

  const key = connectionKey(opencodeSessionID, alias)
  const existing = connections.get(key)
  if (existing && isAlive(existing)) {
    return existing
  }

  return await createConnection(opencodeSessionID, alias, target, signal)
}

function getPtyNoRemoteTargetMessage(state: SessionState): string | null {
  if (state.activeTargetAlias) return null
  return "No remote target selected for this chat. PTY is remote-only. Commands run locally. Use /target use <alias> for a remote target."
}

function disconnectAlias(opencodeSessionID: string, alias: string): void {
  const key = connectionKey(opencodeSessionID, alias)
  const connection = connections.get(key)
  if (connection) closeConnection(connection, "Disconnected")
}

function reconcileSessionConnections(opencodeSessionID: string, state: SessionState): void {
  for (const connection of connections.values()) {
    if (connection.opencodeSessionID !== opencodeSessionID) continue
    if (state.activeTargetAlias === connection.alias) continue
    closeConnection(connection, "Target selection changed")
  }
}

type ExecResult = { output: ExecBuffer; exitCode: number }

function terminateLocalProcess(proc: ReturnType<typeof spawn>): void {
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal)
      else proc.kill(signal)
    } catch {
      try {
        proc.kill(signal)
      } catch {}
    }
  }
  kill("SIGTERM")
  const forceTimer = setTimeout(() => kill("SIGKILL"), 1000)
  proc.once("exit", () => clearTimeout(forceTimer))
}

export async function runLocalExec(
  command: string,
  options: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<ExecResult> {
  if (options.signal) throwIfAborted(options.signal)
  return await new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn("/bin/bash", ["-lc", command], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
    })
    const output = createExecBuffer()
    let timedOut = false
    let settled = false

    const onAbort = () => {
      terminateLocalProcess(proc)
      finish(new Error("Operation cancelled"))
    }
    const onStdout = (chunk: Buffer) => appendExecOutput(output, "stdout", chunk.toString("utf8"))
    const onStderr = (chunk: Buffer) => appendExecOutput(output, "stderr", chunk.toString("utf8"))
    const cleanup = () => {
      clearTimeout(timer)
      if (options.signal) options.signal.removeEventListener("abort", onAbort)
      proc.stdout?.off("data", onStdout)
      proc.stderr?.off("data", onStderr)
      proc.off("error", onError)
      proc.off("exit", onExit)
    }
    const finish = (error?: Error, result?: ExecResult) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) rejectPromise(error)
      else resolvePromise(result!)
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminateLocalProcess(proc)
    }, options.timeoutMs ?? 120000)

    proc.stdout?.on("data", onStdout)
    proc.stderr?.on("data", onStderr)

    const onError = (err: Error) => finish(err)
    const onExit = (code: number | null) => {
      if (timedOut) appendExecOutput(output, "stderr", "\nCommand timed out")
      finish(undefined, { output, exitCode: timedOut ? 124 : code ?? 0 })
    }
    proc.on("error", onError)
    proc.on("exit", onExit)

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true })
      if (options.signal.aborted) onAbort()
    }
  })
}

export function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new Error("Operation cancelled"))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      reject(new Error("Operation cancelled"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

async function waitForRemoteExit(
  connection: Connection,
  processID: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<any> {
  if (signal) throwIfAborted(signal)
  const existing = connection.execExits.get(processID)
  if (existing) {
    connection.execExits.delete(processID)
    return existing
  }

  return await new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      connection.execExitWaiters.delete(processID)
      reject(error)
    }
    const succeed = (value: any) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      connection.execExitWaiters.delete(processID)
      resolve(value)
    }
    const onAbort = () => fail(new Error("Operation cancelled"))
    const timer = setTimeout(() => {
      fail(new Error(`Remote process ${processID} did not exit before timeout`))
    }, timeoutMs)

    connection.execExitWaiters.set(processID, {
      resolve: succeed,
      reject: fail,
      timer,
      cleanup,
    })
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
  })
}

export async function runRemoteProcessLifecycle<T>(
  operations: {
    start: () => Promise<string>
    wait: (processID: string, signal?: AbortSignal) => Promise<T>
    kill: (processID: string) => Promise<void>
    cleanup: (processID: string) => void
  },
  signal?: AbortSignal,
): Promise<{ processID: string; exit: T }> {
  if (signal) throwIfAborted(signal)
  const start = operations.start()
  let processID = ""
  try {
    processID = await waitForAbort(start, signal)
  } catch (error) {
    if (signal?.aborted) {
      void start.then(
        async (id) => {
          try {
            await operations.kill(id)
          } catch {
          } finally {
            operations.cleanup(id)
          }
        },
        () => {},
      )
    }
    throw error
  }

  try {
    const exit = await operations.wait(processID, signal)
    return { processID, exit }
  } catch (error) {
    try {
      await operations.kill(processID)
    } catch {}
    operations.cleanup(processID)
    throw error
  }
}

async function killRemoteExec(connection: Connection, processID: string): Promise<void> {
  if (!isAlive(connection)) return
  await rpcRequest(
    connection,
    "exec.kill",
    { session_id: connection.remoteSessionID, process_id: processID, signal: "KILL" },
    5000,
  )
}

function cleanupRemoteExec(connection: Connection, processID: string): void {
  const waiter = connection.execExitWaiters.get(processID)
  if (waiter) {
    clearTimeout(waiter.timer)
    waiter.cleanup()
    connection.execExitWaiters.delete(processID)
  }
  connection.execBuffers.delete(processID)
  connection.execExits.delete(processID)
}

async function runRemoteExec(
  connection: Connection,
  command: string,
  options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<ExecResult> {
  if (options.signal) throwIfAborted(options.signal)
  const login = connection.target.loginShell === true
  const lifecycle = await runRemoteProcessLifecycle(
    {
      start: async () => {
        const start = await rpcRequest(
          connection,
          "exec.start",
          {
            session_id: connection.remoteSessionID,
            command,
            shell: true,
            ...(login ? { login: true } : {}),
            cwd: options.cwd ?? connection.cwd,
            timeout_ms: options.timeoutMs,
          },
          20000,
        )
        const processID = String(start?.process_id ?? "")
        if (!processID) throw new Error("exec.start failed: missing process_id")
        getExecBuffer(connection, processID)
        return processID
      },
      wait: (processID, signal) => waitForRemoteExit(connection, processID, (options.timeoutMs ?? 120000) + 10000, signal),
      kill: (processID) => killRemoteExec(connection, processID),
      cleanup: (processID) => cleanupRemoteExec(connection, processID),
    },
    options.signal,
  )

  try {
    return {
      output: connection.execBuffers.get(lifecycle.processID) ?? createExecBuffer(),
      exitCode: Number(lifecycle.exit?.exit_code ?? 0),
    }
  } finally {
    cleanupRemoteExec(connection, lifecycle.processID)
  }
}

function renderExecResult(result: ExecResult): string {
  const body = renderExecOutput(result.output).trimEnd()
  if (body && result.exitCode === 0) return body
  if (body) return `${body}\n[exit code: ${result.exitCode}]`
  return result.exitCode === 0 ? "(no output)" : `[exit code: ${result.exitCode}]`
}

export function resolveBashTimeout(input: { timeout?: number; timeout_ms?: number }): number | undefined {
  const timeout = input.timeout ?? input.timeout_ms
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
    throw new Error("Invalid timeout value: timeout must be a non-negative number of milliseconds.")
  }
  return timeout
}

type EffectiveStateResolver = (sessionID: string) => Promise<EffectiveSessionState>

async function handleTargetSubcommand(
  opencodeSessionID: string,
  subcommand: string,
  alias: string | undefined,
  resolveState: EffectiveStateResolver,
): Promise<string> {
  switch (subcommand) {
    case "list": {
      const targets = loadTargets()
      const { state } = await resolveState(opencodeSessionID)
      const list = Object.entries(targets)
        .map(([name, config]) => {
          const active = state.activeTargetAlias === name ? "*" : " "
          const description = config.description || config.host || "No description"
          return `  ${active} ${name}: ${description}`
        })
        .join("\n")

      if (!list) {
        return "No targets configured. Create ~/.config/rexd/targets.json"
      }

      return `Available targets:\n${list}\n\nUse /target use <alias> to select a target for this chat.`
    }

    case "use": {
      if (!alias) return "Usage: /target use <alias>"
      const target = getTarget(alias)
      if (!target) {
        return `Target \"${alias}\" not found. Use /target list to see available targets.`
      }
      if (target.transport !== "ssh") {
        return `Target \"${alias}\" uses unsupported transport \"${target.transport}\".`
      }

      pruneSessionStateFiles()

      const previous = (await resolveState(opencodeSessionID)).state.activeTargetAlias
      try {
        await createConnection(opencodeSessionID, alias, target)
      } catch (error) {
        return `Failed to connect to target \"${alias}\": ${error instanceof Error ? error.message : String(error)}`
      }

      if (previous && previous !== alias) disconnectAlias(opencodeSessionID, previous)

      const state = loadSessionState(opencodeSessionID)
      state.activeTargetAlias = alias
      state.lastUsedAt = Date.now()
      saveSessionState(opencodeSessionID, state)

      const roots = target.workspaceRoots?.join(", ") || "N/A"
      return `Target \"${alias}\" activated for this chat.\n\nWorkspace roots: ${roots}\n\nAll file and shell operations now route to the remote machine.`
    }

    case "status": {
      const { state } = await resolveState(opencodeSessionID)
      if (!state.activeTargetAlias) {
        return "No remote target selected for this chat. Commands run locally. Use /target use <alias> for a remote target."
      }

      const target = getTarget(state.activeTargetAlias)
      const host = target?.host || "unknown"
      const userPrefix = target?.user ? `${target.user}@` : ""
      const key = connectionKey(opencodeSessionID, state.activeTargetAlias)
      const connection = connections.get(key)
      const runtime = connection && isAlive(connection) ? "connected" : "disconnected"

      return `Active target: ${state.activeTargetAlias}\n\nHost: ${userPrefix}${host}\nConnection: ${runtime}`
    }

    case "clear": {
      const effective = (await resolveState(opencodeSessionID)).state
      if (!effective.activeTargetAlias) return "No active target to clear for this chat."

      const previous = effective.activeTargetAlias
      disconnectAlias(opencodeSessionID, previous)

      const state = loadSessionState(opencodeSessionID)
      state.activeTargetAlias = null
      state.remoteCwdOverride = null
      state.lastUsedAt = Date.now()
      saveSessionState(opencodeSessionID, state)
      return `Target \"${previous}\" deactivated for this chat. Operations now use local execution.`
    }

    default:
      return "Usage: /target <list|use|status|clear> [alias]"
  }
}

export const RexdTargetPlugin: Plugin = async (input) => {
  pruneSessionStateFiles()

  const resolveState: EffectiveStateResolver = async (sessionID) => {
    const resolved = await resolveEffectiveSessionState(sessionID, {
      loadState: loadSessionStateIfPresent,
      getSession: async (id) => {
        const result = await input.client.session.get({
          path: { id },
          query: { directory: input.directory },
        })
        if (result.error || !result.data) {
          const detail = result.error ? JSON.stringify(result.error) : "session was not found"
          throw new Error(detail)
        }
        return { id: result.data.id, parentID: result.data.parentID }
      },
    })
    reconcileSessionConnections(sessionID, resolved.state)
    return resolved
  }

  return {
    "command.execute.before": async (input, output) => {
      const parsed = parseTargetCommand(input)
      if (!parsed) return

      const message = await handleTargetSubcommand(input.sessionID, parsed.subcommand, parsed.alias, resolveState)
      setCommandText(output, message)
    },

    tool: {
      target: tool({
        description: "Manage REXD targets: list/use/status/clear",
        args: {
          action: tool.schema.string().describe("Action: list, use, status, clear"),
          alias: tool.schema.string().optional().describe("Target alias for use"),
        },
        async execute(args, context: ToolContext) {
          return await handleTargetSubcommand(context.sessionID, args.action, args.alias, resolveState)
        },
      }),

      bash: tool({
        description: "Execute shell commands locally or on active REXD target",
        args: {
          command: tool.schema.string().describe("Shell command"),
          description: tool.schema.string().optional().describe("Command description"),
          timeout: tool.schema.number().optional().describe("Timeout in milliseconds"),
          timeout_ms: tool.schema.number().optional().describe("Deprecated alias for timeout; timeout takes precedence"),
          workdir: tool.schema.string().optional().describe("Working directory"),
        },
        async execute(args, context: ToolContext) {
          const { state } = await resolveState(context.sessionID)
          const timeoutMs = resolveBashTimeout(args)
          return await executeForSessionState(state, {
            local: async () => {
              const cwd = args.workdir ? localPath(context.directory, args.workdir) : context.directory
              await askBashPermission(context, args.command, cwd)
              const result = await runLocalExec(args.command, { cwd, timeoutMs, signal: context.abort })
              const output = renderExecResult(result)
              return { title: args.command, output, metadata: { output, description: args.description ?? "Shell" } }
            },
            remote: async () => {
              const { alias, target } = configuredActiveTarget(state)
              assertTargetCapabilities(alias, target, ["shell"])
              const remoteCwd = args.workdir
                ? remotePath(configuredRemoteCwd(target), args.workdir)
                : configuredRemoteCwd(target)
              const guardError = guardRemotePath(target, remoteCwd, configuredWorkspaceRoots(target))
              if (guardError) throw new Error(guardError)
              await askBashPermission(context, args.command, remoteCwd, {
                target: alias,
                workspaceRoots: configuredWorkspaceRoots(target),
              })
              const connection = await ensureConnection(context.sessionID, state, context.abort)
              const result = await runRemoteExec(connection, args.command, {
                cwd: remoteCwd,
                timeoutMs,
                signal: context.abort,
              })
              const output = renderExecResult(result)
              return { title: args.command, output, metadata: { output, description: args.description ?? "Shell" } }
            },
          })
        },
      }),

      read: tool({
        description: "Read a file locally or on active REXD target",
        args: {
          filePath: tool.schema.string().describe("Path to file"),
          offset: tool.schema.number().optional().describe("Line offset (1-indexed)"),
          limit: tool.schema.number().optional().describe("Max lines to return"),
        },
        async execute(args, context: ToolContext) {
          const { state } = await resolveState(context.sessionID)
          return await executeForSessionState(state, {
            local: async () => {
              const path = localPath(context.directory, args.filePath)
              await askLocalPathPermission(context, "read", path)
              return readLocalResolvedPath(path, args) as ToolResult
            },
            remote: async () => {
              const { alias, target } = configuredActiveTarget(state)
              assertTargetCapabilities(alias, target, ["fs"])
              const path = remotePath(configuredRemoteCwd(target), args.filePath)
              const guardError = guardRemotePath(target, path, configuredWorkspaceRoots(target))
              if (guardError) throw new Error(guardError)
              await askRemotePathPermission(context, {
                permission: "read",
                path,
                workspaceRoots: configuredWorkspaceRoots(target),
                target: alias,
              })
              const connection = await ensureConnection(context.sessionID, state, context.abort)
              return (await readRemoteResolvedPath(connection, path, args, context.abort)) as ToolResult
            },
          })
        },
      }),

      write: tool({
        description: "Write a file locally or on active REXD target",
        args: {
          filePath: tool.schema.string().describe("Path to file"),
          content: tool.schema.string().describe("File content"),
        },
        async execute(args, context: ToolContext) {
          const { state } = await resolveState(context.sessionID)
          return await executeForSessionState(state, {
            local: async () => {
              const path = localPath(context.directory, args.filePath)
              await askLocalPathPermission(context, "edit", path)
              const dir = dirname(path)
              if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
              writeFileSync(path, args.content)
              return `Wrote ${args.filePath}`
            },
            remote: async () => {
              const { alias, target } = configuredActiveTarget(state)
              assertTargetCapabilities(alias, target, ["fs"])
              const path = remotePath(configuredRemoteCwd(target), args.filePath)
              const guardError = guardRemotePath(target, path, configuredWorkspaceRoots(target))
              if (guardError) throw new Error(guardError)
              await askRemotePathPermission(context, {
                permission: "edit",
                path,
                workspaceRoots: configuredWorkspaceRoots(target),
                target: alias,
              })
              const connection = await ensureConnection(context.sessionID, state, context.abort)
              await rpcRequest(
                connection,
                "fs.write",
                {
                  session_id: connection.remoteSessionID,
                  path,
                  content: args.content,
                  mode: "replace",
                  mkdir_parents: true,
                  atomic: true,
                },
                30000,
                context.abort,
              )
              return `Wrote ${args.filePath}`
            },
          })
        },
      }),

      edit: tool({
        description: "Edit a file locally or on active REXD target",
        args: {
          filePath: tool.schema.string().describe("Path to file"),
          oldString: tool.schema.string().describe("Exact text to replace"),
          newString: tool.schema.string().describe("Replacement text"),
          replaceAll: tool.schema.boolean().optional().describe("Replace all matches"),
        },
        async execute(args, context: ToolContext) {
          const { state } = await resolveState(context.sessionID)
          return await executeForSessionState(state, {
            local: async () => {
              const path = localPath(context.directory, args.filePath)
              await askLocalPathPermission(context, "edit", path)
              const existed = existsSync(path)
              const current = existed ? readFileSync(path, "utf-8") : ""
              if (!existed && args.oldString !== "") throw new Error(`File does not exist: ${path}`)
              const edited = applyExactEdit(current, args.oldString, args.newString, args.replaceAll ?? false)
              const dir = dirname(path)
              if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
              writeFileSync(path, edited.content)
              return {
                title: relativeUiPathFromWorktree(context.worktree, path, args.filePath),
                output: `Edited ${args.filePath} (${edited.replacements} replacement${edited.replacements === 1 ? "" : "s"})`,
                metadata: buildEditUiMetadata(path, current, edited.content),
              }
            },
            remote: async () => {
              const { alias, target } = configuredActiveTarget(state)
              assertTargetCapabilities(alias, target, ["fs"])
              const path = remotePath(configuredRemoteCwd(target), args.filePath)
              const guardError = guardRemotePath(target, path, configuredWorkspaceRoots(target))
              if (guardError) throw new Error(guardError)
              await askRemotePathPermission(context, {
                permission: "edit",
                path,
                workspaceRoots: configuredWorkspaceRoots(target),
                target: alias,
              })
              const connection = await ensureConnection(context.sessionID, state, context.abort)
              let editMetadata: ReturnType<typeof buildEditUiMetadata> | undefined
              try {
                let current = ""
                try {
                  current = await readRemoteFile(connection, path, context.abort)
                } catch {
                  current = ""
                }
                const edited = applyExactEdit(current, args.oldString, args.newString, args.replaceAll ?? false)
                editMetadata = buildEditUiMetadata(path, current, edited.content)
              } catch {}
              const response = await rpcRequest(
                connection,
                "fs.edit",
                {
                  session_id: connection.remoteSessionID,
                  path,
                  old_string: args.oldString,
                  new_string: args.newString,
                  replace_all: args.replaceAll ?? false,
                },
                30000,
                context.abort,
              )
              const replacements = Number(response?.replacements ?? 0)
              return {
                title: relativeUiPathFromCwd(connection.cwd, path, args.filePath),
                output: `Edited ${args.filePath} (${replacements} replacement${replacements === 1 ? "" : "s"})`,
                metadata: editMetadata,
              }
            },
          })
        },
      }),

      apply_patch: tool({
        description: "Apply a patch locally or on active REXD target",
        args: {
          patchText: tool.schema.string().describe("Patch text in apply_patch envelope format"),
        },
        async execute(args, context: ToolContext) {
          const { state } = await resolveState(context.sessionID)
          return await executeForSessionState(state, {
            local: async () => {
              const hunks = parsePatchEnvelope(args.patchText)
              for (const hunk of hunks) {
                await askLocalPathPermission(context, "edit", localPath(context.directory, hunk.path))
                if (hunk.type === "update" && hunk.movePath) {
                  await askLocalPathPermission(context, "edit", localPath(context.directory, hunk.movePath))
                }
              }
              let files: PatchUiFile[] | undefined
              try {
                files = buildLocalPatchUiFiles(context.directory, args.patchText, context.worktree)
              } catch {}
              const summary = applyLocalPatch(context.directory, args.patchText)
              return {
                output: renderPatchSummary(summary),
                metadata: files ? { files, diff: files.map((file) => file.patch).join("\n") } : undefined,
              }
            },
            remote: async () => {
              const { alias, target } = configuredActiveTarget(state)
              assertTargetCapabilities(alias, target, ["fs"])
              const cwd = configuredRemoteCwd(target)
              const roots = configuredWorkspaceRoots(target)
              const guardError = guardRemotePatch(target, cwd, roots, args.patchText)
              if (guardError) throw new Error(guardError)
              const hunks = parsePatchEnvelope(args.patchText)
              for (const hunk of hunks) {
                await askRemotePathPermission(context, {
                  permission: "edit",
                  path: remotePath(cwd, hunk.path),
                  workspaceRoots: roots,
                  target: alias,
                })
                if (hunk.type === "update" && hunk.movePath) {
                  await askRemotePathPermission(context, {
                    permission: "edit",
                    path: remotePath(cwd, hunk.movePath),
                    workspaceRoots: roots,
                    target: alias,
                  })
                }
              }
              const connection = await ensureConnection(context.sessionID, state, context.abort)
              let files: PatchUiFile[] | undefined
              try {
                files = await buildRemotePatchUiFiles(connection, args.patchText, context.abort)
              } catch {}
              const response = await rpcRequest(
                connection,
                "fs.patch",
                { session_id: connection.remoteSessionID, patch_text: args.patchText, cwd },
                30000,
                context.abort,
              )
              return {
                output: renderPatchSummary(normalizePatchSummary(response)),
                metadata: files ? { files, diff: files.map((file) => file.patch).join("\n") } : undefined,
              }
            },
          })
        },
      }),

      list: tool({
        description: "List a directory locally or on active REXD target",
        args: {
          filePath: tool.schema.string().optional().describe("Directory path"),
        },
        async execute(args, context: ToolContext) {
          const { state } = await resolveState(context.sessionID)
          return await executeForSessionState(state, {
            local: async () => {
              const path = localPath(context.directory, args.filePath ?? ".")
              await askLocalPathPermission(context, "read", path, {}, "directory")
              const entries = readdirSync(path, { withFileTypes: true })
                .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file" }))
                .sort((a, b) => a.name.localeCompare(b.name))
              return formatListEntries(entries)
            },
            remote: async () => {
              const { alias, target } = configuredActiveTarget(state)
              assertTargetCapabilities(alias, target, ["fs"])
              const path = remotePath(configuredRemoteCwd(target), args.filePath ?? ".")
              const guardError = guardRemotePath(target, path, configuredWorkspaceRoots(target))
              if (guardError) throw new Error(guardError)
              await askRemotePathPermission(context, {
                permission: "read",
                path,
                workspaceRoots: configuredWorkspaceRoots(target),
                target: alias,
                kind: "directory",
              })
              const connection = await ensureConnection(context.sessionID, state, context.abort)
              const response = await rpcRequest(
                connection,
                "fs.list",
                { session_id: connection.remoteSessionID, path },
                30000,
                context.abort,
              )
              const entries = Array.isArray(response?.entries)
                ? response.entries.map((entry: any) => ({
                    name: String(entry?.name ?? ""),
                    type: String(entry?.type ?? "file"),
                  }))
                : []
              return formatListEntries(entries)
            },
          })
        },
      }),

      glob: tool({
        description: "Glob files locally or on active REXD target",
        args: {
          pattern: tool.schema.string().describe("Glob pattern"),
          path: tool.schema.string().optional().describe("Base directory"),
        },
        async execute(args, context: ToolContext) {
          const { state } = await resolveState(context.sessionID)
          return await executeForSessionState(state, {
            local: async () => {
              const cwd = localPath(context.directory, args.path ?? ".")
              await askLocalSearchPermission(context, "glob", args.pattern, cwd, { pattern: args.pattern, path: cwd })
              const bunGlobal = (globalThis as any).Bun
              if (bunGlobal?.Glob) {
                const glob = new bunGlobal.Glob(args.pattern)
                const matches: string[] = []
                for await (const file of glob.scan({ cwd })) matches.push(String(file))
                return matches.join("\n")
              }
              const command = `cd ${shellQuote(cwd)} && rg --files -g ${shellQuote(args.pattern)}`
              const result = await runLocalExec(command, { cwd, signal: context.abort })
              const output = renderExecOutput(result.output)
              return result.exitCode !== 0 && !output.trim() ? "" : output.trimEnd()
            },
            remote: async () => {
              const { alias, target } = configuredActiveTarget(state)
              assertTargetCapabilities(alias, target, ["fs"])
              const cwd = remotePath(configuredRemoteCwd(target), args.path ?? ".")
              const guardError = guardRemotePath(target, cwd, configuredWorkspaceRoots(target))
              if (guardError) throw new Error(guardError)
              await askRemoteSearchPermission(context, {
                permission: "glob",
                query: args.pattern,
                path: cwd,
                workspaceRoots: configuredWorkspaceRoots(target),
                target: alias,
                metadata: { pattern: args.pattern },
              })
              const connection = await ensureConnection(context.sessionID, state, context.abort)
              const response = await rpcRequest(
                connection,
                "fs.glob",
                { session_id: connection.remoteSessionID, pattern: args.pattern, cwd },
                30000,
                context.abort,
              )
              const matches = Array.isArray(response?.matches)
                ? response.matches.map((value: unknown) => String(value))
                : []
              return matches.join("\n")
            },
          })
        },
      }),

      grep: tool({
        description: "Grep files locally or on active REXD target",
        args: {
          pattern: tool.schema.string().describe("Regex pattern"),
          path: tool.schema.string().optional().describe("Search path"),
          include: tool.schema.string().optional().describe("Glob include filter"),
        },
        async execute(args, context: ToolContext) {
          const { state } = await resolveState(context.sessionID)
          return await executeForSessionState(state, {
            local: async () => {
              const searchPath = localPath(context.directory, args.path ?? ".")
              await askLocalSearchPermission(context, "grep", args.pattern, searchPath, {
                pattern: args.pattern,
                include: args.include,
                path: searchPath,
              })
              let command = `rg -n --color=never ${shellQuote(args.pattern)}`
              if (args.include) command += ` --glob ${shellQuote(args.include)}`
              command += ` ${shellQuote(searchPath)}`
              return renderExecResult(await runLocalExec(command, { cwd: context.directory, signal: context.abort }))
            },
            remote: async () => {
              const { alias, target } = configuredActiveTarget(state)
              assertTargetCapabilities(alias, target, ["fs", "shell"])
              const searchPath = remotePath(configuredRemoteCwd(target), args.path ?? ".")
              const guardError = guardRemotePath(target, searchPath, configuredWorkspaceRoots(target))
              if (guardError) throw new Error(guardError)
              await askRemoteSearchPermission(context, {
                permission: "grep",
                query: args.pattern,
                path: searchPath,
                workspaceRoots: configuredWorkspaceRoots(target),
                target: alias,
                metadata: { pattern: args.pattern, include: args.include },
              })
              const connection = await ensureConnection(context.sessionID, state, context.abort)
              let command = `rg -n --color=never ${shellQuote(args.pattern)}`
              if (args.include) command += ` --glob ${shellQuote(args.include)}`
              command += ` ${shellQuote(searchPath)}`
              return renderExecResult(
                await runRemoteExec(connection, command, { cwd: configuredRemoteCwd(target), signal: context.abort }),
              )
            },
          })
        },
      }),

      pty_spawn: tool({
        description: "Open a remote PTY session",
        args: {
          command: tool.schema.string().optional().describe("Command to run"),
          cols: tool.schema.number().optional().describe("Terminal columns"),
          rows: tool.schema.number().optional().describe("Terminal rows"),
        },
        async execute(args, context: ToolContext) {
          const { state } = await resolveState(context.sessionID)
          if (!state.activeTargetAlias) return getPtyNoRemoteTargetMessage(state)!
          const { alias, target } = configuredActiveTarget(state)
          assertTargetCapabilities(alias, target, ["pty", "shell"])
          const cwd = configuredRemoteCwd(target)
          await askBashPermission(context, args.command ?? "bash", cwd, {
            target: alias,
            workspaceRoots: configuredWorkspaceRoots(target),
          })
          const connection = await ensureConnection(context.sessionID, state, context.abort)
          const open = rpcRequest(
            connection,
            "pty.open",
            {
              session_id: connection.remoteSessionID,
              command: args.command ?? "bash",
              shell: true,
              cwd,
              cols: args.cols ?? 120,
              rows: args.rows ?? 36,
            },
            30000,
          )
          let response: any
          try {
            response = await waitForAbort(open, context.abort)
          } catch (error) {
            if (context.abort.aborted) {
              void open.then(async (result) => {
                const ptyID = String(result?.pty_id ?? "")
                if (ptyID) {
                  try {
                    await rpcRequest(connection, "pty.close", { session_id: connection.remoteSessionID, pty_id: ptyID }, 5000)
                  } catch {}
                }
              })
            }
            throw error
          }
          const ptyID = String(response?.pty_id ?? "")
          if (!ptyID) return "Failed to open PTY"
          connection.ptyBuffers.set(ptyID, createExecBuffer())
          return `PTY opened: ${ptyID}`
        },
      }),

      pty_write: tool({
        description: "Write input to a remote PTY",
        args: {
          id: tool.schema.string().describe("PTY id"),
          data: tool.schema.string().describe("Input data"),
        },
        async execute(args, context: ToolContext) {
          const { state } = await resolveState(context.sessionID)
          if (!state.activeTargetAlias) return getPtyNoRemoteTargetMessage(state)!
          const { alias, target } = configuredActiveTarget(state)
          assertTargetCapabilities(alias, target, ["pty", "shell"])
          await askBashPermission(context, args.data, configuredRemoteCwd(target), {
            target: alias,
            workspaceRoots: configuredWorkspaceRoots(target),
          })
          const connection = await ensureConnection(context.sessionID, state, context.abort)
          await rpcRequest(
            connection,
            "pty.input",
            { session_id: connection.remoteSessionID, pty_id: args.id, data: args.data },
            30000,
            context.abort,
          )
          return "ok"
        },
      }),

      pty_read: tool({
        description: "Read buffered output from a remote PTY",
        args: {
          id: tool.schema.string().describe("PTY id"),
          limit: tool.schema.number().optional().describe("Number of chunks to read"),
        },
        async execute(args, context: ToolContext) {
          const { state } = await resolveState(context.sessionID)
          if (!state.activeTargetAlias) return getPtyNoRemoteTargetMessage(state)!
          const { alias, target } = configuredActiveTarget(state)
          assertTargetCapabilities(alias, target, ["pty"])
          const connection = await ensureConnection(context.sessionID, state, context.abort)
          const buffer = connection.ptyBuffers.get(args.id) ?? createExecBuffer()
          if (!args.limit || args.limit <= 0) return renderExecOutput(buffer)
          return buffer.chunks.slice(-args.limit).map((chunk) => chunk.data).join("")
        },
      }),

      pty_list: tool({
        description: "List known PTY sessions",
        args: {},
        async execute(_, context: ToolContext) {
          const { state } = await resolveState(context.sessionID)
          if (!state.activeTargetAlias) return getPtyNoRemoteTargetMessage(state)!
          const { alias, target } = configuredActiveTarget(state)
          assertTargetCapabilities(alias, target, ["pty"])
          const connection = await ensureConnection(context.sessionID, state, context.abort)
          const ids = [...connection.ptyBuffers.keys()]
          return ids.length > 0 ? ids.join("\n") : "No active PTY sessions"
        },
      }),

      pty_kill: tool({
        description: "Close a remote PTY session",
        args: {
          id: tool.schema.string().describe("PTY id"),
        },
        async execute(args, context: ToolContext) {
          const { state } = await resolveState(context.sessionID)
          if (!state.activeTargetAlias) return getPtyNoRemoteTargetMessage(state)!
          const { alias, target } = configuredActiveTarget(state)
          assertTargetCapabilities(alias, target, ["pty"])
          const connection = await ensureConnection(context.sessionID, state, context.abort)
          await rpcRequest(
            connection,
            "pty.close",
            { session_id: connection.remoteSessionID, pty_id: args.id },
            30000,
            context.abort,
          )
          connection.ptyBuffers.delete(args.id)
          return "PTY closed"
        },
      }),
    },
  }
}

export default RexdTargetPlugin
