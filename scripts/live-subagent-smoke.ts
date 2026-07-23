import { createOpencodeClient } from "@opencode-ai/sdk/client"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { resolveEffectiveSessionState, type SessionState } from "../src/plugin/rexd-target"

const sourceRoot = process.env.OPENCODE_SOURCE_ROOT
if (!sourceRoot) throw new Error("Set OPENCODE_SOURCE_ROOT to an OpenCode source checkout")

const home = mkdtempSync(join(tmpdir(), "opencode-rexd-live-"))
const project = join(home, "project")
mkdirSync(project, { recursive: true })
const entry = resolve(sourceRoot, "packages/opencode/src/index.ts")
const proc = Bun.spawn(
  [process.execPath, "run", "--conditions=browser", entry, "serve", "--hostname", "127.0.0.1", "--port", "0"],
  {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OPENCODE_TEST_HOME: home,
      OPENCODE_CONFIG_CONTENT: "{}",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_AUTOCOMPACT: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_AUTH_CONTENT: "{}",
    },
    stdout: "pipe",
    stderr: "pipe",
  },
)

async function serverUrl(): Promise<string> {
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ""
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("OpenCode server startup timed out")), 30_000)),
    ])
    if (next.done) break
    output += decoder.decode(next.value, { stream: true })
    const match = output.match(/opencode server listening on (http:\/\/[^\s]+)/)
    if (match) return match[1]
  }
  throw new Error(`OpenCode server did not report a URL: ${output}`)
}

try {
  const url = await serverUrl()
  const client = createOpencodeClient({ baseUrl: url, directory: project })
  const parentResult = await client.session.create({
    body: { title: "REXD live parent" },
    query: { directory: project },
  })
  if (parentResult.error || !parentResult.data) throw new Error(`Could not create parent: ${JSON.stringify(parentResult.error)}`)
  const childResult = await client.session.create({
    body: { title: "REXD live child", parentID: parentResult.data.id },
    query: { directory: project },
  })
  if (childResult.error || !childResult.data) throw new Error(`Could not create child: ${JSON.stringify(childResult.error)}`)
  if (childResult.data.parentID !== parentResult.data.id) throw new Error("Live child did not retain parentID")

  const states = new Map<string, SessionState>([
    [parentResult.data.id, { activeTargetAlias: "live-target", remoteCwdOverride: null, lastUsedAt: Date.now() }],
  ])
  const dependencies = {
    loadState: (sessionID: string) => states.get(sessionID),
    getSession: async (sessionID: string) => {
      const result = await client.session.get({ path: { id: sessionID }, query: { directory: project } })
      if (result.error || !result.data) throw new Error(JSON.stringify(result.error))
      return { id: result.data.id, parentID: result.data.parentID }
    },
  }

  const inherited = await resolveEffectiveSessionState(childResult.data.id, dependencies)
  if (inherited.ownerSessionID !== parentResult.data.id || inherited.state.activeTargetAlias !== "live-target") {
    throw new Error("Live child did not inherit the active parent target")
  }

  states.set(parentResult.data.id, { activeTargetAlias: null, remoteCwdOverride: null, lastUsedAt: Date.now() })
  const cleared = await resolveEffectiveSessionState(childResult.data.id, dependencies)
  if (cleared.state.activeTargetAlias !== null) throw new Error("Live child did not observe parent target clear")

  console.log(`Live OpenCode parent/child target inheritance passed (${parentResult.data.id} -> ${childResult.data.id})`)
} finally {
  proc.kill("SIGTERM")
  await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
  if (proc.exitCode === null) proc.kill("SIGKILL")
  rmSync(home, { recursive: true, force: true })
}
