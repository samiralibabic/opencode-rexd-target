import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"

const TARGETS_PATH = resolve(homedir(), ".config/rexd/targets.json")
const STATE_DIR = ".opencode"
const STATE_FILE = "rexd-state.json"

type TargetConfig = {
  transport: "ssh" | "http" | "ws"
  description?: string
  defaultCwd?: string
  workspaceRoots?: string[]
  rootPolicy?: { mode: string; extraRoots?: string[] }
  capabilities?: { shell?: boolean; fs?: boolean; pty?: boolean }
  host?: string
  user?: string
  port?: number
  identityFile?: string
  command?: string
}

type ProjectState = {
  activeTargetAlias: string | null
  lastUsedAt: number
}

const targetsCache = new Map<string, TargetConfig>()

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

function statePath(projectDir: string): string {
  return resolve(projectDir, STATE_DIR, STATE_FILE)
}

function loadState(projectDir: string): ProjectState {
  const path = statePath(projectDir)
  if (!existsSync(path)) {
    return { activeTargetAlias: null, lastUsedAt: Date.now() }
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ProjectState
    return {
      activeTargetAlias: parsed.activeTargetAlias ?? null,
      lastUsedAt: parsed.lastUsedAt ?? Date.now(),
    }
  } catch {
    return { activeTargetAlias: null, lastUsedAt: Date.now() }
  }
}

function saveState(projectDir: string, state: ProjectState): void {
  const dir = resolve(projectDir, STATE_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(statePath(projectDir), JSON.stringify(state, null, 2))
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

function handleTargetSubcommand(projectDir: string, subcommand: string, alias?: string): string {
  switch (subcommand) {
    case "list": {
      const targets = loadTargets()
      const state = loadState(projectDir)
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

      return `Available targets:\n${list}\n\nUse /target use <alias> to select a target.`
    }

    case "use": {
      if (!alias) return "Usage: /target use <alias>"
      const target = getTarget(alias)
      if (!target) {
        return `Target \"${alias}\" not found. Use /target list to see available targets.`
      }

      const state = loadState(projectDir)
      state.activeTargetAlias = alias
      state.lastUsedAt = Date.now()
      saveState(projectDir, state)

      const roots = target.workspaceRoots?.join(", ") || "N/A"
      return `Target \"${alias}\" activated.\n\nWorkspace roots: ${roots}\n\nAll file and shell operations will now be routed to the remote machine.`
    }

    case "status": {
      const state = loadState(projectDir)
      if (!state.activeTargetAlias) {
        return "No active target. Use /target use <alias> to select a target."
      }

      const target = getTarget(state.activeTargetAlias)
      const host = target?.host || "unknown"
      const userPrefix = target?.user ? `${target.user}@` : ""
      return `Active target: ${state.activeTargetAlias}\n\nHost: ${userPrefix}${host}`
    }

    case "clear": {
      const state = loadState(projectDir)
      if (!state.activeTargetAlias) return "No active target to clear."
      const previous = state.activeTargetAlias
      state.activeTargetAlias = null
      state.lastUsedAt = Date.now()
      saveState(projectDir, state)
      return `Target \"${previous}\" deactivated. Operations now use local execution.`
    }

    default:
      return "Usage: /target <list|use|status|clear> [alias]"
  }
}

export const RexdTargetPlugin: Plugin = async ({ directory }) => {
  return {
    "command.execute.before": async (input, output) => {
      const parsed = parseTargetCommand(input)
      if (!parsed) return

      const message = handleTargetSubcommand(directory, parsed.subcommand, parsed.alias)
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
          return handleTargetSubcommand(context.directory, args.action, args.alias)
        },
      }),

      bash: tool({
        description: "Remote-aware bash wrapper",
        args: { command: tool.schema.string().describe("Shell command") },
        async execute(args, context: ToolContext) {
          const state = loadState(context.directory)
          if (!state.activeTargetAlias) {
            return "No REXD target active. Use /target use <alias> first."
          }
          return `Remote bash would execute: ${args.command} (transport not wired yet)`
        },
      }),

      read: tool({
        description: "Remote-aware read wrapper",
        args: { filePath: tool.schema.string().describe("Path to file") },
        async execute(args, context: ToolContext) {
          const state = loadState(context.directory)
          if (!state.activeTargetAlias) {
            return "No REXD target active. Use /target use <alias> first."
          }
          return `Remote read: ${args.filePath} (transport not wired yet)`
        },
      }),

      write: tool({
        description: "Remote-aware write wrapper",
        args: {
          filePath: tool.schema.string().describe("Path to file"),
          content: tool.schema.string().describe("File content"),
        },
        async execute(args, context: ToolContext) {
          const state = loadState(context.directory)
          if (!state.activeTargetAlias) {
            return "No REXD target active. Use /target use <alias> first."
          }
          return `Remote write: ${args.filePath} (transport not wired yet)`
        },
      }),

      list: tool({
        description: "Remote-aware list wrapper",
        args: { filePath: tool.schema.string().describe("Path to directory") },
        async execute(args, context: ToolContext) {
          const state = loadState(context.directory)
          if (!state.activeTargetAlias) {
            return "No REXD target active. Use /target use <alias> first."
          }
          return `Remote list: ${args.filePath} (transport not wired yet)`
        },
      }),
    },
  }
}

export default RexdTargetPlugin
