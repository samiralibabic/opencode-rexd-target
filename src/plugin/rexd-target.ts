import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { dirname, isAbsolute, posix, relative, resolve } from "node:path"
import { createTwoFilesPatch } from "diff"

const TARGETS_PATH = resolve(homedir(), ".config/rexd/targets.json")
const SESSION_STATE_ROOT = resolve(homedir(), ".config/opencode/rexd-target/sessions")
const SESSION_STATE_TTL_MS = 1000 * 60 * 60 * 24 * 90
const CLIENT_VERSION = "0.3.1"

type TargetConfig = {
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

type SessionState = {
  activeTargetAlias: string | null
  remoteCwdOverride?: string | null
  lastUsedAt: number
}

type PendingRequest = {
  resolve: (value: any) => void
  reject: (err: Error) => void
  timer: Timer
}

type ExecBuffer = {
  stdout: string[]
  stderr: string[]
}

type ExitWaiter = {
  resolve: (value: any) => void
  reject: (err: Error) => void
  timer: Timer
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
  ptyBuffers: Map<string, string[]>
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
  diff: string
  before: string
  after: string
  additions: number
  deletions: number
  movePath?: string
}

type StagedUiState = {
  title?: string
  output?: string
  metadata?: Record<string, any>
}

const targetsCache = new Map<string, TargetConfig>()
const connections = new Map<string, Connection>()
const stagedUiState = new Map<string, StagedUiState>()

function uiStateKey(toolID: string, sessionID: string, callID?: string): string {
  return `${sessionID}:${callID ?? ""}:${toolID}`
}

function getCallID(context: ToolContext): string | undefined {
  const callID = (context as any).callID
  if (typeof callID === "string" && callID.length > 0) return callID
  if (typeof callID === "number") return String(callID)
  return undefined
}

function stageUiState(toolID: string, context: ToolContext, state: StagedUiState): void {
  const callID = getCallID(context)
  if (!callID) return
  stagedUiState.set(uiStateKey(toolID, context.sessionID, callID), state)
}

function consumeUiState(toolID: string, sessionID: string, callID: string): StagedUiState | undefined {
  const key = uiStateKey(toolID, sessionID, callID)
  const state = stagedUiState.get(key)
  if (!state) return undefined
  stagedUiState.delete(key)
  return state
}

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

function sessionStatePath(opencodeSessionID: string): string {
  return resolve(SESSION_STATE_ROOT, sessionFileName(opencodeSessionID))
}

function defaultSessionState(): SessionState {
  return {
    activeTargetAlias: null,
    remoteCwdOverride: null,
    lastUsedAt: Date.now(),
  }
}

function loadSessionState(opencodeSessionID: string): SessionState {
  const path = sessionStatePath(opencodeSessionID)
  if (!existsSync(path)) {
    return defaultSessionState()
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as SessionState
    return {
      activeTargetAlias: parsed.activeTargetAlias ?? null,
      remoteCwdOverride: parsed.remoteCwdOverride ?? null,
      lastUsedAt: parsed.lastUsedAt ?? Date.now(),
    }
  } catch {
    return defaultSessionState()
  }
}

function saveSessionState(opencodeSessionID: string, state: SessionState): void {
  if (!existsSync(SESSION_STATE_ROOT)) mkdirSync(SESSION_STATE_ROOT, { recursive: true })
  writeFileSync(sessionStatePath(opencodeSessionID), JSON.stringify(state, null, 2))
}

function touchSessionState(opencodeSessionID: string, state = loadSessionState(opencodeSessionID)): void {
  if (!state.activeTargetAlias) return
  state.lastUsedAt = Date.now()
  saveSessionState(opencodeSessionID, state)
}

function pruneSessionStateFiles(now = Date.now()): void {
  if (!existsSync(SESSION_STATE_ROOT)) return

  for (const entry of readdirSync(SESSION_STATE_ROOT)) {
    if (!entry.endsWith(".json")) continue

    const path = resolve(SESSION_STATE_ROOT, entry)
    try {
      const stats = statSync(path)
      if (!stats.isFile()) continue

      let lastUsedAt = stats.mtimeMs
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SessionState>
        if (typeof parsed.lastUsedAt === "number" && Number.isFinite(parsed.lastUsedAt)) {
          lastUsedAt = parsed.lastUsedAt
        }
      } catch {}

      if (now - lastUsedAt > SESSION_STATE_TTL_MS) unlinkSync(path)
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
  if (path === normalizedRoot) return true
  return path.startsWith(`${normalizedRoot}/`)
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

function formatReadOutput(content: string, offset?: number, limit?: number): string {
  const lines = content.split("\n")
  const start = Math.max(1, offset ?? 1)
  const startIndex = start - 1
  const endIndex = limit && limit > 0 ? startIndex + limit : undefined
  const sliced = lines.slice(startIndex, endIndex)
  if (sliced.length === 0) return ""

  return sliced.map((line, index) => `${start + index}: ${line}`).join("\n")
}

function formatListEntries(entries: Array<{ name: string; type: string }>): string {
  if (entries.length === 0) return ""
  return entries
    .map((entry) => (entry.type === "dir" ? `${entry.name}/` : entry.name))
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
        diff,
        before,
        after,
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
        diff,
        before,
        after,
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
      diff,
      before,
      after,
      additions,
      deletions,
      movePath: hunk.movePath ? destinationPath : undefined,
    })
  }

  return files
}

async function readRemoteFile(connection: Connection, path: string): Promise<string> {
  const response = await rpcRequest(connection, "fs.read", {
    session_id: connection.remoteSessionID,
    path,
  })
  const encoding = String(response?.encoding ?? "utf8")
  const raw = String(response?.content ?? "")
  return decodeData(raw, encoding)
}

async function buildRemotePatchUiFiles(connection: Connection, patchText: string): Promise<PatchUiFile[]> {
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
        diff,
        before,
        after,
        additions,
        deletions,
      })
      continue
    }

    if (hunk.type === "delete") {
      const before = await readRemoteFile(connection, sourcePath)
      const after = ""
      const diff = createUnifiedDiff(sourcePath, `/dev/null`, before, after)
      const { additions, deletions } = countDiffChanges(diff)

      files.push({
        filePath: sourcePath,
        relativePath: relativeUiPathFromCwd(connection.cwd, sourcePath, hunk.path),
        type: "delete",
        diff,
        before,
        after,
        additions,
        deletions,
      })
      continue
    }

    const before = await readRemoteFile(connection, sourcePath)
    const after = hunk.chunks.length > 0 ? derivePatchedContent(before, hunk.chunks) : before
    const destinationPath = hunk.movePath ? remotePath(connection.cwd, hunk.movePath) : sourcePath
    const diff = createUnifiedDiff(sourcePath, destinationPath, before, after)
    const { additions, deletions } = countDiffChanges(diff)

    files.push({
      filePath: sourcePath,
      relativePath: relativeUiPathFromCwd(connection.cwd, destinationPath, hunk.movePath ?? hunk.path),
      type: hunk.movePath ? "move" : "update",
      diff,
      before,
      after,
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
      before,
      after,
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
    pending.reject(new Error(reason ?? "Connection closed"))
  }
  connection.pending.clear()

  for (const waiter of connection.execExitWaiters.values()) {
    clearTimeout(waiter.timer)
    waiter.reject(new Error(reason ?? "Connection closed"))
  }
  connection.execExitWaiters.clear()

  connections.delete(connection.key)

  try {
    connection.proc.stdin?.end()
  } catch {}
  try {
    connection.proc.kill()
  } catch {}
}

function getExecBuffer(connection: Connection, processID: string): ExecBuffer {
  let buffer = connection.execBuffers.get(processID)
  if (!buffer) {
    buffer = { stdout: [], stderr: [] }
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
    if (method === "exec.stdout") buffer.stdout.push(data)
    else buffer.stderr.push(data)
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
    const chunks = connection.ptyBuffers.get(ptyID) ?? []
    chunks.push(data)
    if (chunks.length > 4000) chunks.shift()
    connection.ptyBuffers.set(ptyID, chunks)
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
): Promise<any> {
  if (!isAlive(connection)) {
    throw new Error(`Connection to target \"${connection.alias}\" is not active`)
  }

  if (!connection.proc.stdin) {
    throw new Error("Connection stdin is not available")
  }

  const id = ++connection.requestID
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pending.delete(id)
      reject(new Error(`Request \"${method}\" timed out`))
    }, timeoutMs)

    connection.pending.set(id, {
      resolve: (value) => resolve(value),
      reject: (err) => reject(err),
      timer,
    })

    connection.proc.stdin!.write(payload, (err) => {
      if (err) {
        clearTimeout(timer)
        connection.pending.delete(id)
        reject(err)
      }
    })
  })
}

async function createConnection(
  opencodeSessionID: string,
  alias: string,
  target: TargetConfig,
): Promise<Connection> {
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
    cwd: target.defaultCwd ?? "/",
    workspaceRoots: target.workspaceRoots ?? [],
    execBuffers: new Map(),
    execExits: new Map(),
    execExitWaiters: new Map(),
    ptyBuffers: new Map(),
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
    let newline = connection.buffer.indexOf("\n")
    while (newline !== -1) {
      const line = connection.buffer.slice(0, newline)
      connection.buffer = connection.buffer.slice(newline + 1)
      if (line.trim()) handleLine(connection, line)
      newline = connection.buffer.indexOf("\n")
    }
  })

  const session = await rpcRequest(
    connection,
      "session.open",
        {
          client_name: "opencode-rexd-target",
          client_version: CLIENT_VERSION,
          workspace_roots: target.workspaceRoots,
        },
      20000,
  )

  connection.remoteSessionID = String(session?.session_id ?? "")
  if (!connection.remoteSessionID) {
    closeConnection(connection, "session.open did not return session_id")
    throw new Error("session.open failed: missing session_id")
  }

  connection.workspaceRoots = Array.isArray(session?.workspace_roots)
    ? session.workspace_roots.map((root: string) => normalizeRemotePath(root))
    : target.workspaceRoots ?? []
  connection.cwd =
    normalizeRemotePath(target.defaultCwd ?? "") ||
    connection.workspaceRoots[0] ||
    "/"

  return connection
}

async function ensureConnection(opencodeSessionID: string): Promise<Connection> {
  const state = loadSessionState(opencodeSessionID)
  if (!state.activeTargetAlias) {
    throw new Error("No active target. Use /target use <alias> first.")
  }

  const target = getTarget(state.activeTargetAlias)
  if (!target) {
    throw new Error(`Target \"${state.activeTargetAlias}\" is not configured.`)
  }

  if (target.transport !== "ssh") {
    throw new Error(`Target \"${state.activeTargetAlias}\" uses unsupported transport \"${target.transport}\".`)
  }

  touchSessionState(opencodeSessionID, state)

  const key = connectionKey(opencodeSessionID, state.activeTargetAlias)
  const existing = connections.get(key)
  if (existing && isAlive(existing)) {
    return existing
  }

  return await createConnection(opencodeSessionID, state.activeTargetAlias, target)
}

function getPtyNoRemoteTargetMessage(opencodeSessionID: string): string | null {
  const state = loadSessionState(opencodeSessionID)
  if (state.activeTargetAlias) return null
  return "No remote target selected for this chat. PTY is remote-only. Commands run locally. Use /target use <alias> for a remote target."
}

function disconnectAlias(opencodeSessionID: string, alias: string): void {
  const key = connectionKey(opencodeSessionID, alias)
  const connection = connections.get(key)
  if (connection) closeConnection(connection, "Disconnected")
}

async function runLocalExec(
  command: string,
  options: { cwd: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn("/bin/bash", ["-lc", command], { cwd: options.cwd })
    let stdout = ""
    let stderr = ""
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGKILL")
    }, options.timeoutMs ?? 120000)

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
    })
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8")
    })

    proc.on("error", (err) => {
      clearTimeout(timer)
      rejectPromise(err)
    })

    proc.on("exit", (code) => {
      clearTimeout(timer)
      if (timedOut) {
        resolvePromise({ stdout, stderr: `${stderr}\nCommand timed out`, exitCode: 124 })
        return
      }
      resolvePromise({ stdout, stderr, exitCode: code ?? 0 })
    })
  })
}

async function waitForRemoteExit(
  connection: Connection,
  processID: string,
  timeoutMs: number,
): Promise<any> {
  const existing = connection.execExits.get(processID)
  if (existing) {
    connection.execExits.delete(processID)
    return existing
  }

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.execExitWaiters.delete(processID)
      reject(new Error(`Remote process ${processID} did not exit before timeout`))
    }, timeoutMs)

    connection.execExitWaiters.set(processID, {
      resolve: (value) => resolve(value),
      reject: (err) => reject(err),
      timer,
    })
  })
}

async function runRemoteExec(
  connection: Connection,
  command: string,
  options: { cwd?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const login = connection.target.loginShell === true
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

  const exit = await waitForRemoteExit(connection, processID, (options.timeoutMs ?? 120000) + 10000)

  const output = connection.execBuffers.get(processID) ?? { stdout: [], stderr: [] }
  connection.execBuffers.delete(processID)
  connection.execExits.delete(processID)
  return {
    stdout: output.stdout.join(""),
    stderr: output.stderr.join(""),
    exitCode: Number(exit?.exit_code ?? 0),
  }
}

function renderExecResult(stdout: string, stderr: string, exitCode: number): string {
  const cleanedStdout = stdout.trimEnd()
  const cleanedStderr = stderr.trimEnd()
  const body = [cleanedStdout, cleanedStderr].filter(Boolean).join("\n")
  if (body && exitCode === 0) return body
  if (body) return `${body}\n[exit code: ${exitCode}]`
  return exitCode === 0 ? "(no output)" : `[exit code: ${exitCode}]`
}

async function handleTargetSubcommand(opencodeSessionID: string, subcommand: string, alias?: string): Promise<string> {
  switch (subcommand) {
    case "list": {
      const targets = loadTargets()
      const state = loadSessionState(opencodeSessionID)
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

      const previous = loadSessionState(opencodeSessionID).activeTargetAlias
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
      const state = loadSessionState(opencodeSessionID)
      if (!state.activeTargetAlias) {
        return "No remote target selected for this chat. Commands run locally. Use /target use <alias> for a remote target."
      }

      touchSessionState(opencodeSessionID, state)

      const target = getTarget(state.activeTargetAlias)
      const host = target?.host || "unknown"
      const userPrefix = target?.user ? `${target.user}@` : ""
      const key = connectionKey(opencodeSessionID, state.activeTargetAlias)
      const connection = connections.get(key)
      const runtime = connection && isAlive(connection) ? "connected" : "disconnected"

      return `Active target: ${state.activeTargetAlias}\n\nHost: ${userPrefix}${host}\nConnection: ${runtime}`
    }

    case "clear": {
      const state = loadSessionState(opencodeSessionID)
      if (!state.activeTargetAlias) return "No active target to clear for this chat."

      const previous = state.activeTargetAlias
      disconnectAlias(opencodeSessionID, previous)

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

export const RexdTargetPlugin: Plugin = async () => {
  pruneSessionStateFiles()

  return {
    "command.execute.before": async (input, output) => {
      const parsed = parseTargetCommand(input)
      if (!parsed) return

      const message = await handleTargetSubcommand(input.sessionID, parsed.subcommand, parsed.alias)
      setCommandText(output, message)
    },

    "tool.execute.after": async (input, output) => {
      const staged = consumeUiState(input.tool, input.sessionID, input.callID)
      if (staged) {
        if (staged.title) output.title = staged.title
        if (staged.output) output.output = staged.output
        output.metadata = { ...(output.metadata ?? {}), ...(staged.metadata ?? {}) }
      }

      if (input.tool === "bash" && typeof output.output === "string") {
        const metadata = (output.metadata ?? {}) as Record<string, any>
        output.metadata = {
          ...metadata,
          output: output.output,
          description: typeof metadata.description === "string" ? metadata.description : "Shell",
        }
      }
    },

    tool: {
      target: tool({
        description: "Manage REXD targets: list/use/status/clear",
        args: {
          action: tool.schema.string().describe("Action: list, use, status, clear"),
          alias: tool.schema.string().optional().describe("Target alias for use"),
        },
        async execute(args, context: ToolContext) {
          return await handleTargetSubcommand(context.sessionID, args.action, args.alias)
        },
      }),

      bash: tool({
        description: "Execute shell commands locally or on active REXD target",
        args: {
          command: tool.schema.string().describe("Shell command"),
          description: tool.schema.string().optional().describe("Command description"),
          timeout_ms: tool.schema.number().optional().describe("Timeout in milliseconds"),
          workdir: tool.schema.string().optional().describe("Working directory"),
        },
        async execute(args, context: ToolContext) {
          const state = loadSessionState(context.sessionID)
          if (!state.activeTargetAlias) {
            const cwd = args.workdir ? localPath(context.directory, args.workdir) : context.directory
            const result = await runLocalExec(args.command, { cwd, timeoutMs: args.timeout_ms })
            return renderExecResult(result.stdout, result.stderr, result.exitCode)
          }

          const connection = await ensureConnection(context.sessionID)
          const remoteCwd = args.workdir ? remotePath(connection.cwd, args.workdir) : connection.cwd
          const guardError = guardRemotePath(connection.target, remoteCwd, connection.workspaceRoots)
          if (guardError) return guardError

          const result = await runRemoteExec(connection, args.command, {
            cwd: remoteCwd,
            timeoutMs: args.timeout_ms,
          })
          return renderExecResult(result.stdout, result.stderr, result.exitCode)
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
          const state = loadSessionState(context.sessionID)
          if (!state.activeTargetAlias) {
            const path = localPath(context.directory, args.filePath)
            const content = readFileSync(path, "utf-8")
            return formatReadOutput(content, args.offset, args.limit)
          }

          const connection = await ensureConnection(context.sessionID)
          const path = remotePath(connection.cwd, args.filePath)
          const guardError = guardRemotePath(connection.target, path, connection.workspaceRoots)
          if (guardError) return guardError

          const response = await rpcRequest(connection, "fs.read", {
            session_id: connection.remoteSessionID,
            path,
          })
          const encoding = String(response?.encoding ?? "utf8")
          const raw = String(response?.content ?? "")
          const content = decodeData(raw, encoding)
          return formatReadOutput(content, args.offset, args.limit)
        },
      }),

      write: tool({
        description: "Write a file locally or on active REXD target",
        args: {
          filePath: tool.schema.string().describe("Path to file"),
          content: tool.schema.string().describe("File content"),
        },
        async execute(args, context: ToolContext) {
          const state = loadSessionState(context.sessionID)
          if (!state.activeTargetAlias) {
            const path = localPath(context.directory, args.filePath)
            const dir = dirname(path)
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            writeFileSync(path, args.content)
            return `Wrote ${args.filePath}`
          }

          const connection = await ensureConnection(context.sessionID)
          const path = remotePath(connection.cwd, args.filePath)
          const guardError = guardRemotePath(connection.target, path, connection.workspaceRoots)
          if (guardError) return guardError

          await rpcRequest(connection, "fs.write", {
            session_id: connection.remoteSessionID,
            path,
            content: args.content,
            mode: "replace",
            mkdir_parents: true,
            atomic: true,
          })
          return `Wrote ${args.filePath}`
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
          const state = loadSessionState(context.sessionID)
          if (!state.activeTargetAlias) {
            const path = localPath(context.directory, args.filePath)
            const existed = existsSync(path)
            const current = existed ? readFileSync(path, "utf-8") : ""

            if (!existed && args.oldString !== "") {
              throw new Error(`File does not exist: ${path}`)
            }

            const edited = applyExactEdit(current, args.oldString, args.newString, args.replaceAll ?? false)
            const dir = dirname(path)
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            writeFileSync(path, edited.content)
            stageUiState("edit", context, {
              title: relativeUiPathFromWorktree(context.worktree, path, args.filePath),
              metadata: buildEditUiMetadata(path, current, edited.content),
            })
            return `Edited ${args.filePath} (${edited.replacements} replacement${edited.replacements === 1 ? "" : "s"})`
          }

          const connection = await ensureConnection(context.sessionID)
          const path = remotePath(connection.cwd, args.filePath)
          const guardError = guardRemotePath(connection.target, path, connection.workspaceRoots)
          if (guardError) return guardError

          let editMetadata: ReturnType<typeof buildEditUiMetadata> | undefined
          try {
            let current = ""
            try {
              current = await readRemoteFile(connection, path)
            } catch {
              current = ""
            }
            const edited = applyExactEdit(current, args.oldString, args.newString, args.replaceAll ?? false)
            editMetadata = buildEditUiMetadata(path, current, edited.content)
          } catch {}

          const response = await rpcRequest(connection, "fs.edit", {
            session_id: connection.remoteSessionID,
            path,
            old_string: args.oldString,
            new_string: args.newString,
            replace_all: args.replaceAll ?? false,
          })

          if (editMetadata) {
            stageUiState("edit", context, {
              title: relativeUiPathFromCwd(connection.cwd, path, args.filePath),
              metadata: editMetadata,
            })
          }

          const replacements = Number(response?.replacements ?? 0)
          return `Edited ${args.filePath} (${replacements} replacement${replacements === 1 ? "" : "s"})`
        },
      }),

      apply_patch: tool({
        description: "Apply a patch locally or on active REXD target",
        args: {
          patchText: tool.schema.string().describe("Patch text in apply_patch envelope format"),
        },
        async execute(args, context: ToolContext) {
          const state = loadSessionState(context.sessionID)
          if (!state.activeTargetAlias) {
            let files: PatchUiFile[] | undefined
            try {
              files = buildLocalPatchUiFiles(context.directory, args.patchText, context.worktree)
            } catch {}

            const summary = applyLocalPatch(context.directory, args.patchText)
            if (files) {
              stageUiState("apply_patch", context, {
                metadata: {
                  files,
                  diff: files.map((file) => file.diff).join("\n"),
                },
              })
            }
            return renderPatchSummary(summary)
          }

          const connection = await ensureConnection(context.sessionID)
          const guardError = guardRemotePatch(
            connection.target,
            connection.cwd,
            connection.workspaceRoots,
            args.patchText,
          )
          if (guardError) return guardError

          let files: PatchUiFile[] | undefined
          try {
            files = await buildRemotePatchUiFiles(connection, args.patchText)
          } catch {}

          const response = await rpcRequest(connection, "fs.patch", {
            session_id: connection.remoteSessionID,
            patch_text: args.patchText,
            cwd: connection.cwd,
          })

          if (files) {
            stageUiState("apply_patch", context, {
              metadata: {
                files,
                diff: files.map((file) => file.diff).join("\n"),
              },
            })
          }
          return renderPatchSummary(normalizePatchSummary(response))
        },
      }),

      list: tool({
        description: "List a directory locally or on active REXD target",
        args: {
          filePath: tool.schema.string().optional().describe("Directory path"),
        },
        async execute(args, context: ToolContext) {
          const state = loadSessionState(context.sessionID)
          if (!state.activeTargetAlias) {
            const path = localPath(context.directory, args.filePath ?? ".")
            const entries = readdirSync(path, { withFileTypes: true })
              .map((entry) => ({
                name: entry.name,
                type: entry.isDirectory() ? "dir" : "file",
              }))
              .sort((a, b) => a.name.localeCompare(b.name))
            return formatListEntries(entries)
          }

          const connection = await ensureConnection(context.sessionID)
          const path = remotePath(connection.cwd, args.filePath ?? ".")
          const guardError = guardRemotePath(connection.target, path, connection.workspaceRoots)
          if (guardError) return guardError

          const response = await rpcRequest(connection, "fs.list", {
            session_id: connection.remoteSessionID,
            path,
          })
          const entries = Array.isArray(response?.entries)
            ? response.entries.map((entry: any) => ({
                name: String(entry?.name ?? ""),
                type: String(entry?.type ?? "file"),
              }))
            : []
          return formatListEntries(entries)
        },
      }),

      glob: tool({
        description: "Glob files locally or on active REXD target",
        args: {
          pattern: tool.schema.string().describe("Glob pattern"),
          path: tool.schema.string().optional().describe("Base directory"),
        },
        async execute(args, context: ToolContext) {
          const state = loadSessionState(context.sessionID)
          if (!state.activeTargetAlias) {
            const cwd = localPath(context.directory, args.path ?? ".")
            const bunGlobal = (globalThis as any).Bun
            if (bunGlobal?.Glob) {
              const glob = new bunGlobal.Glob(args.pattern)
              const matches: string[] = []
              for await (const file of glob.scan({ cwd })) {
                matches.push(String(file))
              }
              return matches.join("\n")
            }

            const command = `cd ${shellQuote(cwd)} && rg --files -g ${shellQuote(args.pattern)}`
            const result = await runLocalExec(command, { cwd })
            if (result.exitCode !== 0 && !result.stdout.trim()) return ""
            return result.stdout.trimEnd()
          }

          const connection = await ensureConnection(context.sessionID)
          const cwd = remotePath(connection.cwd, args.path ?? ".")
          const guardError = guardRemotePath(connection.target, cwd, connection.workspaceRoots)
          if (guardError) return guardError

          const response = await rpcRequest(connection, "fs.glob", {
            session_id: connection.remoteSessionID,
            pattern: args.pattern,
            cwd,
          })
          const matches = Array.isArray(response?.matches)
            ? response.matches.map((value: unknown) => String(value))
            : []
          return matches.join("\n")
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
          const state = loadSessionState(context.sessionID)
          if (!state.activeTargetAlias) {
            const searchPath = localPath(context.directory, args.path ?? ".")
            let command = `rg -n --color=never ${shellQuote(args.pattern)}`
            if (args.include) command += ` --glob ${shellQuote(args.include)}`
            command += ` ${shellQuote(searchPath)}`
            const result = await runLocalExec(command, { cwd: context.directory })
            return renderExecResult(result.stdout, result.stderr, result.exitCode)
          }

          const connection = await ensureConnection(context.sessionID)
          const searchPath = remotePath(connection.cwd, args.path ?? ".")
          const guardError = guardRemotePath(connection.target, searchPath, connection.workspaceRoots)
          if (guardError) return guardError

          let command = `rg -n --color=never ${shellQuote(args.pattern)}`
          if (args.include) command += ` --glob ${shellQuote(args.include)}`
          command += ` ${shellQuote(searchPath)}`

          const result = await runRemoteExec(connection, command, { cwd: connection.cwd })
          return renderExecResult(result.stdout, result.stderr, result.exitCode)
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
          const noRemoteMessage = getPtyNoRemoteTargetMessage(context.sessionID)
          if (noRemoteMessage) return noRemoteMessage

          const connection = await ensureConnection(context.sessionID)
          if (connection.target.capabilities?.pty === false) {
            return `Target \"${connection.alias}\" does not support PTY.`
          }

          const response = await rpcRequest(connection, "pty.open", {
            session_id: connection.remoteSessionID,
            command: args.command ?? "bash",
            shell: true,
            cwd: connection.cwd,
            cols: args.cols ?? 120,
            rows: args.rows ?? 36,
          })

          const ptyID = String(response?.pty_id ?? "")
          if (!ptyID) return "Failed to open PTY"
          connection.ptyBuffers.set(ptyID, [])
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
          const noRemoteMessage = getPtyNoRemoteTargetMessage(context.sessionID)
          if (noRemoteMessage) return noRemoteMessage

          const connection = await ensureConnection(context.sessionID)
          await rpcRequest(connection, "pty.input", {
            session_id: connection.remoteSessionID,
            pty_id: args.id,
            data: args.data,
          })
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
          const noRemoteMessage = getPtyNoRemoteTargetMessage(context.sessionID)
          if (noRemoteMessage) return noRemoteMessage

          const connection = await ensureConnection(context.sessionID)
          const chunks = connection.ptyBuffers.get(args.id) ?? []
          if (!args.limit || args.limit <= 0) return chunks.join("")
          return chunks.slice(-args.limit).join("")
        },
      }),

      pty_list: tool({
        description: "List known PTY sessions",
        args: {},
        async execute(_, context: ToolContext) {
          const noRemoteMessage = getPtyNoRemoteTargetMessage(context.sessionID)
          if (noRemoteMessage) return noRemoteMessage

          const connection = await ensureConnection(context.sessionID)
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
          const noRemoteMessage = getPtyNoRemoteTargetMessage(context.sessionID)
          if (noRemoteMessage) return noRemoteMessage

          const connection = await ensureConnection(context.sessionID)
          await rpcRequest(connection, "pty.close", {
            session_id: connection.remoteSessionID,
            pty_id: args.id,
          })
          connection.ptyBuffers.delete(args.id)
          return "PTY closed"
        },
      }),
    },
  }
}

export default RexdTargetPlugin
