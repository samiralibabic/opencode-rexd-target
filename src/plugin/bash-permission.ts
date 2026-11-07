import { lstatSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, posix } from "node:path"
import { fileURLToPath } from "node:url"
import { Language, Parser, type Node } from "web-tree-sitter"
import bashWasm from "tree-sitter-bash/tree-sitter-bash.wasm" with { type: "file" }
import treeSitterWasm from "web-tree-sitter/tree-sitter.wasm" with { type: "file" }

/** Commands which only change the shell's current directory. */
export const CWD_ONLY_COMMANDS = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])

/** A simple command as it appeared in the source and its permission-family tokens. */
export type ParsedSimpleCommand = {
  /** The trimmed source, including any redirections. */
  source: string
  /** Command words with assignments and redirections removed. */
  tokens: string[]
}

export type PosixCommandParse = {
  commands: ParsedSimpleCommand[]
  /** True when the Bash tree contains parse errors. */
  unsupported: boolean
}

/** A filesystem operand from a statically classifiable Bash command argument. */
export type ShellPathCandidate = {
  /** Original token, retained to distinguish shell expansion from quoted text. */
  raw: string
  /** Static path, or the directory containing the first glob component. */
  value: string
  /** A glob prefix denotes the directory the shell must enumerate. */
  directory?: true
}

export type BashShellPathScan = {
  candidates: ShellPathCandidate[]
  /** Reserved for callers which need to distinguish future parser failures. */
  unsupported: boolean
}

export type BashPermissionOptions = {
  /**
   * A caller-owned prefix that namespaces every generated rule, for example
   * `remote:production:`. Include any separator wanted in the prefix.
   */
  remoteScope?: string
  /** Effective local working directory supplied by the bash tool call. */
  cwd?: string
  /** Session git top level (ToolContext.worktree), never the tool cwd. */
  projectRoot?: string
  /** Alias for remoteScope for callers which use a generic scope name. */
  scope?: string
}

export type BashPermissionRequest = {
  patterns: string[]
  always: string[]
  commands: ParsedSimpleCommand[]
  unsupported: boolean
}

type BashPart = {
  type: string
  text: string
}

// Keep this aligned with OpenCode's FILES set in packages/opencode/src/tool/shell.ts.
// `find` remains a documented RexD extension limited to root operands below.
const FILE_COMMANDS = new Set([...CWD_ONLY_COMMANDS, "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat"])

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function resolveWasm(asset: string): string {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (isAbsolute(asset) || /^[a-z]:/i.test(asset)) return asset
  return fileURLToPath(new URL(asset, import.meta.url))
}

let bashParserPromise: Promise<Parser> | undefined

function bashParser(): Promise<Parser> {
  if (bashParserPromise) return bashParserPromise
  bashParserPromise = (async () => {
    await Parser.init({
      locateFile() {
        return resolveWasm(treeSitterWasm)
      },
    })
    const language = await Language.load(resolveWasm(bashWasm))
    const parser = new Parser()
    parser.setLanguage(language)
    return parser
  })()
  return bashParserPromise
}

/*
 * AST traversal and static path filtering follow OpenCode upstream at
 * packages/opencode/src/tool/shell.ts (284214c78d32a09fd9c729bdefc07be50f74eb40).
 */
function bashCommandParts(node: Node): BashPart[] {
  const parts: BashPart[] = []
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let partIndex = 0; partIndex < child.childCount; partIndex++) {
        const part = child.child(partIndex)
        if (!part || part.type === "command_argument_sep" || part.type === "redirection") continue
        parts.push({ type: part.type, text: part.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    parts.push({ type: child.type, text: child.text })
  }
  return parts
}

function unquote(text: string): string {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function staticPathPrefix(text: string): string | undefined {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function dynamicPath(text: string): boolean {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  return text.includes("$")
}

function globDirectoryPrefix(prefix: string): string {
  if (prefix.endsWith("/")) return prefix.replace(/\/+$/, "") || "/"
  return posix.dirname(prefix)
}

function staticPathCandidate(part: BashPart): ShellPathCandidate | undefined {
  const value = unquote(part.text)
  const prefix = staticPathPrefix(value)
  if (!prefix || dynamicPath(prefix)) return
  if (prefix === value) return { raw: part.text, value }
  return { raw: part.text, value: globDirectoryPrefix(prefix), directory: true }
}

function pathArguments(command: string, parts: BashPart[]): ShellPathCandidate[] {
  return parts
    .filter((part) => !part.text.startsWith("-") && !(command === "chmod" && part.text.startsWith("+")))
    .map(staticPathCandidate)
    .filter((candidate): candidate is ShellPathCandidate => Boolean(candidate))
}

function findRootArguments(parts: BashPart[]): ShellPathCandidate[] {
  const roots: ShellPathCandidate[] = []
  let options = true
  let optionOperand = false

  for (const part of parts) {
    const value = unquote(part.text)
    if (options && optionOperand) {
      optionOperand = false
      continue
    }
    if (options && value === "--") {
      options = false
      continue
    }
    if (options && (value === "-H" || value === "-L" || value === "-P" || value.startsWith("-O"))) continue
    if (options && value === "-D") {
      optionOperand = true
      continue
    }
    if (value.startsWith("-") || value === "!" || value === "(" || value === ")") break
    options = false
    const candidate = staticPathCandidate(part)
    if (candidate) roots.push(candidate)
  }
  return roots
}

/**
 * Finds filesystem operands by walking the same Bash command nodes and static
 * arguments as OpenCode. RexD additionally retains find roots and actual file
 * redirection destinations, which its local/remote boundary checks require.
 */
export async function scanBashShellPaths(command: string): Promise<BashShellPathScan> {
  const parser = await bashParser()
  const tree = parser.parse(command)
  if (!tree) throw new Error("Failed to parse Bash command")

  try {
    const candidates: ShellPathCandidate[] = []
    for (const node of tree.rootNode.descendantsOfType("command")) {
      const parts = bashCommandParts(node)
      const commandName = parts[0]?.text
      if (!commandName) continue
      const arguments_ = parts.slice(1)
      if (FILE_COMMANDS.has(commandName)) candidates.push(...pathArguments(commandName, arguments_))
      else if (commandName === "find") candidates.push(...findRootArguments(arguments_))
    }

    // OpenCode currently omits redirect destinations from path classification.
    // RexD intentionally keeps them because both local and remote execution can
    // write outside the selected workspace before the command itself starts.
    for (const redirect of tree.rootNode.descendantsOfType("file_redirect")) {
      const destination = redirect.childForFieldName("destination")
      if (!destination || destination.type === "number" || destination.text === "-") continue
      const candidate = staticPathCandidate({ type: destination.type, text: destination.text })
      if (candidate) candidates.push(candidate)
    }

    return {
      candidates: [
        ...new Map(
          candidates.map((candidate) => [`${candidate.raw}\0${candidate.value}\0${candidate.directory ? "directory" : "file"}`, candidate]),
        ).values(),
      ],
      unsupported: false,
    }
  } finally {
    tree.delete()
  }
}

/** Parse OpenCode's command nodes, including nested shell constructs. */
export async function parsePosixShellCommands(command: string): Promise<PosixCommandParse> {
  const tree = (await bashParser()).parse(command)
  if (!tree) throw new Error("Failed to parse Bash command")
  try {
    return {
      commands: tree.rootNode.descendantsOfType("command").map(parsedCommand),
      unsupported: tree.rootNode.hasError,
    }
  } finally {
    tree.delete()
  }
}

function parsedCommand(node: Node): ParsedSimpleCommand {
  return {
    source: (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim(),
    tokens: bashCommandParts(node).map((part) => part.text),
  }
}

/*
 * BashArity map and longest-prefix behavior copied from OpenCode 1.18.4
 * `src/permission/arity.ts` (https://github.com/anomalyco/opencode/blob/v1.18.4/packages/opencode/src/permission/arity.ts).
 */
export const BASH_ARITY: Readonly<Record<string, number>> = {
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  echo: 1,
  env: 1,
  export: 1,
  grep: 1,
  kill: 1,
  killall: 1,
  ln: 1,
  ls: 1,
  mkdir: 1,
  mv: 1,
  ps: 1,
  pwd: 1,
  rm: 1,
  rmdir: 1,
  sleep: 1,
  source: 1,
  tail: 1,
  touch: 1,
  unset: 1,
  which: 1,
  aws: 3,
  az: 3,
  bazel: 2,
  brew: 2,
  bun: 2,
  "bun run": 3,
  "bun x": 3,
  cargo: 2,
  "cargo add": 3,
  "cargo run": 3,
  cdk: 2,
  cf: 2,
  cmake: 2,
  composer: 2,
  consul: 2,
  "consul kv": 3,
  crictl: 2,
  deno: 2,
  "deno task": 3,
  doctl: 3,
  docker: 2,
  "docker builder": 3,
  "docker compose": 3,
  "docker container": 3,
  "docker image": 3,
  "docker network": 3,
  "docker volume": 3,
  eksctl: 2,
  "eksctl create": 3,
  firebase: 2,
  flyctl: 2,
  gcloud: 3,
  gh: 3,
  git: 2,
  "git config": 3,
  "git remote": 3,
  "git stash": 3,
  go: 2,
  gradle: 2,
  helm: 2,
  heroku: 2,
  hugo: 2,
  ip: 2,
  "ip addr": 3,
  "ip link": 3,
  "ip netns": 3,
  "ip route": 3,
  kind: 2,
  "kind create": 3,
  kubectl: 2,
  "kubectl kustomize": 3,
  "kubectl rollout": 3,
  kustomize: 2,
  make: 2,
  mc: 2,
  "mc admin": 3,
  minikube: 2,
  mongosh: 2,
  mysql: 2,
  mvn: 2,
  ng: 2,
  npm: 2,
  "npm exec": 3,
  "npm init": 3,
  "npm run": 3,
  "npm view": 3,
  nvm: 2,
  nx: 2,
  openssl: 2,
  "openssl req": 3,
  "openssl x509": 3,
  pip: 2,
  pipenv: 2,
  pnpm: 2,
  "pnpm dlx": 3,
  "pnpm exec": 3,
  "pnpm run": 3,
  poetry: 2,
  podman: 2,
  "podman container": 3,
  "podman image": 3,
  psql: 2,
  pulumi: 2,
  "pulumi stack": 3,
  pyenv: 2,
  python: 2,
  rake: 2,
  rbenv: 2,
  "redis-cli": 2,
  rustup: 2,
  serverless: 2,
  sfdx: 3,
  skaffold: 2,
  sls: 2,
  sst: 2,
  swift: 2,
  systemctl: 2,
  terraform: 2,
  "terraform workspace": 3,
  tmux: 2,
  turbo: 2,
  ufw: 2,
  vault: 2,
  "vault auth": 3,
  "vault kv": 3,
  vercel: 2,
  volta: 2,
  wp: 2,
  yarn: 2,
  "yarn dlx": 3,
  "yarn run": 3,
}

/** Returns the same longest matching command prefix as OpenCode's BashArity.prefix. */
export function bashArityPrefix(tokens: readonly string[]): string[] {
  for (let length = tokens.length; length > 0; length--) {
    const prefix = tokens.slice(0, length).join(" ")
    const arity = BASH_ARITY[prefix]
    if (arity !== undefined) return tokens.slice(0, arity)
  }
  if (tokens.length === 0) return []
  return tokens.slice(0, 1)
}

/** OpenCode-compatible shape for consumers which use BashArity.prefix. */
export const BashArity = {
  map: BASH_ARITY,
  prefix: bashArityPrefix,
} as const

function prefixRule(scope: string | undefined, rule: string): string {
  return scope ? scope + rule : rule
}

/** Decode literal words only; never expand variables or execute shell text. */
function literalWord(raw: string): string | undefined {
  if (/[$\n\r{}]/.test(raw) || raw.includes("`") || raw.includes("<(") || raw.includes(">(")) return
  let value = ""
  let quote: string | undefined
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]
    if (char === "\\" && quote !== "'") {
      const next = raw[++i]
      if (next === undefined) return
      if (quote === '"' && !['"', "\\"].includes(next)) value += "\\"
      value += next
    } else if (quote) {
      if (char === quote) quote = undefined
      else value += char
    } else if (char === "'" || char === '"') quote = char
    else value += char
  }
  return quote ? undefined : value
}

type Variables = Map<string, readonly string[]>

// These builtins can mutate shell state through options, indirection, traps,
// or dynamically named assignments. Never simulate their behavior.
const UNKNOWN_VARIABLE_WRITERS = new Set(["read", "eval", "source", ".", "let", "printf", "getopts", "mapfile", "readarray", "trap", "builtin", "command", "set", "shift", "local", "declare", "typeset", "readonly"])

/** Restricted shell-word decoder: no environment, evaluation, or rescan. */
function expandedWords(raw: string, variables: Variables, assignment = false): string[] | undefined {
  let values = [""]
  let quote: string | undefined
  const append = (parts: readonly string[]) => { values = values.flatMap((value) => parts.map((part) => value + part)) }
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]
    if (char === "\\" && quote !== "'") {
      const next = raw[++i]
      if (next === undefined || next === "\n" || next === "\r") return
      if (quote === '"' && !['"', "\\", "$", String.fromCharCode(96)].includes(next)) append(["\\"])
      append([next])
    } else if (quote === "'") {
      if (char === quote) quote = undefined
      else append([char])
    } else if (char === quote) quote = undefined
    else if (!quote && (char === "'" || char === '"')) quote = char
    else if (char === "$" && !assignment) {
      const match = /^(?:\$([a-zA-Z_][a-zA-Z_0-9]*)|\$\{([a-zA-Z_][a-zA-Z_0-9]*)\})/.exec(raw.slice(i))
      const known = match && variables.get(match[1] ?? match[2])
      if (!known) return
      if (!quote && known.some((value) => !value || /[\s?*[]/.test(value))) return
      append(known)
      i += match![0].length - 1
    } else {
      if (char === "$" || char === String.fromCharCode(96) || /[\n\r{}]/.test(char) || (!quote && /[<>]/.test(char))) return
      if (assignment && /[?*[]/.test(char)) return
      append([char])
    }
    if (values.length > 128) return
  }
  return quote ? undefined : unique(values)
}

function assignmentName(node: Node): string | undefined {
  const name = node.childForFieldName("name")?.text
  return name && /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name) ? name : undefined
}

/** Values flow only through unconditional same-line sequences, never env. */
function commandVariables(root: Node): Map<number, Variables> {
  const result = new Map<number, Variables>()
  const functions = new Set(root.descendantsOfType("function_definition").map((node) => node.childForFieldName("name")?.text))
  const written = (node: Node): Set<string> => {
    const assignments = [...(node.type === "variable_assignment" ? [node] : []), ...node.descendantsOfType("variable_assignment")]
    const names = new Set(assignments.map(assignmentName).filter((name): name is string => Boolean(name)))
    if (assignments.some((assignment) => !assignmentName(assignment))) names.add("*")
    if ([...(node.type === "declaration_command" ? [node] : []), ...node.descendantsOfType("declaration_command")].some((declaration) => !/^export\s/.test(declaration.text) || declaration.namedChildren.some((child) => child.type !== "variable_assignment"))) names.add("*")
    for (const loop of node.descendantsOfType("for_statement")) {
      const name = loop.childForFieldName("variable")?.text
      if (name) names.add(name)
    }
    for (const unset of [...(node.type === "unset_command" ? [node] : []), ...node.descendantsOfType("unset_command")]) for (const child of unset.namedChildren) names.add(child.text)
    // read options, arrays, namerefs, eval/source and function side effects are
    // deliberately not interpreted. Invalidate the whole snapshot instead.
    if ([...(node.type === "command" ? [node] : []), ...node.descendantsOfType("command")].some((cmd) => UNKNOWN_VARIABLE_WRITERS.has(bashCommandParts(cmd)[0]?.text) || functions.has(bashCommandParts(cmd)[0]?.text))) names.add("*")
    return names
  }
  const invalidate = (variables: Variables, names: Set<string>) => {
    if (names.has("*")) variables.clear()
    else for (const name of names) variables.delete(name)
  }
  const assign = (node: Node, variables: Variables, uncertain: boolean) => {
    const name = assignmentName(node)
    if (!name) { variables.clear(); return }
    const value = node.childForFieldName("value")
    const decoded = value ? expandedWords(value.text, new Map(), true) : [""]
    // += depends on an earlier value; arrays/indirection are not literals.
    if (uncertain || !decoded || node.text.includes("+=") || value?.type === "array") variables.delete(name)
    else variables.set(name, decoded)
  }
  const visit = (node: Node, variables: Variables, uncertain = false): void => {
    if (node.type === "declaration_command" && (!/^export(?:\s|$)/.test(node.text) || node.namedChildren.some((child) => child.type !== "variable_assignment"))) {
      variables.clear()
      for (const child of node.namedChildren) visit(child, new Map(), true)
      return
    }
    if (["expansion", "arithmetic_expansion"].includes(node.type)) {
      variables.clear()
      for (const child of node.namedChildren) visit(child, new Map(), true)
      return
    }
    if (node.type === "variable_assignment") {
      for (const child of node.namedChildren) visit(child, new Map(variables), uncertain)
      assign(node, variables, uncertain)
      return
    }
    if (node.type === "command") {
      // Shell expands command arguments before installing command-prefix
      // assignments. They must not override the snapshot used by rm or cd.
      result.set(node.id, new Map(variables))
      const nested = new Map(variables)
      for (const child of node.namedChildren) {
        // Prefix values are not visible during argument expansion. Still
        // visit their substitutions for nested permission checks.
        if (child.type === "variable_assignment") {
          for (const part of child.namedChildren) visit(part, new Map(variables), uncertain)
        } else visit(child, nested, uncertain)
      }
      const mutations = node.descendantsOfType(["expansion", "arithmetic_expansion"])
      if (mutations.length) variables.clear()
      const name = bashCommandParts(node)[0]?.text
      if (name && (UNKNOWN_VARIABLE_WRITERS.has(name) || functions.has(name))) variables.clear()
      return
    }
    if (node.type === "unset_command") {
      invalidate(variables, new Set(node.namedChildren.map((child) => child.text)))
      return
    }
    if (["subshell", "command_substitution", "process_substitution", "pipeline"].includes(node.type)) {
      for (const child of node.namedChildren) visit(child, new Map(variables), true)
      // Do not carry names written in ambiguous shell contexts forward.
      invalidate(variables, written(node))
      return
    }
    if (["function_definition", "for_statement", "c_style_for_statement", "while_statement", "if_statement", "case_statement"].includes(node.type)) {
      const names = written(node)
      const inner = node.type === "function_definition" ? new Map<string, readonly string[]>() : new Map(variables)
      invalidate(inner, names)
      if (node.type === "for_statement") {
        const name = node.childForFieldName("variable")?.text
        const words = node.childrenForFieldName("value")
        const values = words.map((word) => expandedWords(word.text, new Map(), true))
        // A body write/read can replace the loop variable before an rm.
        const body = node.childForFieldName("body")
        const bodyWrites = body ? written(body) : new Set(["*"])
        const loopValues = values.flatMap((value) => value ?? [])
        if (name && words.length && loopValues.length <= 128 && values.every(Boolean) && !bodyWrites.has(name) && !bodyWrites.has("*") && !names.has("*")) inner.set(name, loopValues)
      }
      for (const child of node.namedChildren) visit(child, inner, true)
      invalidate(variables, names)
      return
    }
    if (node.type === "list" && [node, ...node.descendantsOfType("list")].some((list) => list.children.some((child) => child.text === "||"))) {
      const inner = new Map(variables)
      invalidate(inner, written(node))
      for (const child of node.namedChildren) visit(child, new Map(inner), true)
      invalidate(variables, written(node))
      return
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (!child?.isNamed) continue
      if (node.child(i + 1)?.text === "&") {
        visit(child, new Map(variables), true)
        invalidate(variables, written(child))
      } else visit(child, variables, uncertain)
    }
  }
  visit(root, new Map(), root.hasError)
  return result
}

function absoluteOperand(raw: string, cwd: string | undefined, decoded?: string): string | undefined {
  let value = decoded ?? literalWord(raw)
  if (!value) return
  if (value.startsWith("~")) {
    // Quoted/escaped tildes and expanded variables are literal, not home.
    if (decoded !== undefined || raw !== value || !(value === "~" || value.startsWith("~/"))) return
    value = homedir() + value.slice(1)
  }
  if (!posix.isAbsolute(value)) {
    if (!cwd || !posix.isAbsolute(cwd)) return
    value = cwd.replace(/\/$/, "") + "/" + value
  }
  const glob = /[?*[]/.exec(value)
  if (glob) {
    const slash = value.lastIndexOf("/", glob.index)
    const suffix = value.slice(slash + 1)
    if (suffix.split("/").includes("..")) return
    const prefix = posix.normalize(value.slice(0, slash + 1))
    return prefix.replace(/\/$/, "") + "/" + suffix
  }
  const normalized = posix.normalize(value)
  return value.endsWith("/") && !normalized.endsWith("/") ? normalized + "/" : normalized
}

function commandArguments(node: Node): Node[] {
  return node.childrenForFieldName("argument")
}

function changedDirectory(node: Node, cwd: string | undefined, variables: Variables): string | undefined {
  const args = commandArguments(node).map((arg) => arg.text)
  if (args[0] === "--") args.shift()
  if (args.length !== 1 || args[0] === "-" || /[?*[]/.test(args[0])) return
  const values = expandedWords(args[0], variables)
  if (values?.length !== 1) return
  if (/[?*[]/.test(values[0])) return
  return absoluteOperand(args[0], cwd) ?? absoluteOperand(args[0], cwd, values[0])
}

/** Child shells never leak cwd; ambiguous control flow invalidates it. */
function commandDirectories(root: Node, initial: string | undefined, variables: Map<number, Variables>): Map<number, string | undefined> {
  const directories = new Map<number, string | undefined>()
  const functions = new Set(root.descendantsOfType("function_definition").map((node) => node.childForFieldName("name")?.text))
  const dynamicCwd = new Set(["eval", "source", ".", "builtin", "command"])
  const changesCwd = (node: Node) => node.descendantsOfType("command").some((item) =>
    CWD_ONLY_COMMANDS.has(bashCommandParts(item)[0]?.text ?? "") || dynamicCwd.has(bashCommandParts(item)[0]?.text ?? "") || functions.has(bashCommandParts(item)[0]?.text),
  )
  const visit = (node: Node, cwd: string | undefined): string | undefined => {
    if (node.type === "command") {
      directories.set(node.id, cwd)
      for (const child of node.namedChildren) visit(child, cwd)
      const name = bashCommandParts(node)[0]?.text
      if (name === "cd" || name === "chdir") return changedDirectory(node, cwd, variables.get(node.id) ?? new Map())
      return name && (CWD_ONLY_COMMANDS.has(name) || dynamicCwd.has(name) || functions.has(name)) ? undefined : cwd
    }
    if (["subshell", "command_substitution", "process_substitution", "pipeline"].includes(node.type)) {
      if (node.type === "pipeline") for (const child of node.namedChildren) visit(child, cwd)
      else sequence(node, cwd)
      return cwd
    }
    if (["function_definition", "for_statement", "c_style_for_statement", "while_statement", "if_statement", "case_statement"].includes(node.type)) {
      const changes = changesCwd(node)
      // Functions execute at their invocation cwd; loops may repeat relative
      // cd; conditional branches require a runtime join. Do not guess these.
      const start = node.type === "function_definition" || changes ? undefined : cwd
      if (changes && ["if_statement", "case_statement"].includes(node.type)) {
        for (const child of node.namedChildren) visit(child, undefined)
      } else sequence(node, start)
      return node.type === "function_definition" || !changes ? cwd : undefined
    }
    return sequence(node, cwd)
  }
  const sequence = (node: Node, cwd: string | undefined): string | undefined => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (!child?.isNamed) continue
      const next = node.child(i + 1)?.text
      const previous = node.child(i - 1)?.text
      const result = visit(child, previous === "||" ? undefined : cwd)
      if (next !== "&") {
        // Only && proves a preceding cd succeeded. With a following command
        // after ; or newline, a failed cd leaves a different runtime cwd.
        const hasFollowing = node.children.slice(i + 1).some((item) => item.isNamed)
        cwd = hasFollowing && next !== "&&" && result !== cwd ? undefined : result
      }
      if (previous === "||") cwd = undefined
    }
    return cwd
  }
  visit(root, initial)
  return directories
}

/** Unknown marker access never enables the project namespace. */
function hasGitEntry(directory: string): boolean | undefined {
  try { lstatSync(posix.join(directory, ".git")); return true }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false
    return undefined
  }
}

function validatedProjectRoot(root: string | undefined): string | undefined {
  if (!root || !posix.isAbsolute(root)) return
  const normalized = posix.normalize(root).replace(/\/$/, "") || "/"
  if (normalized === "/" || normalized === homedir() || hasGitEntry(normalized) !== true) return
  return normalized
}

function projectOperand(absolute: string, root: string | undefined): string {
  if (!root || !absolute.startsWith(root + "/")) return absolute
  const relative = absolute.slice(root.length + 1)
  if (!relative || relative.split("/").includes(".git") || /[?*[]/.test(relative)) return absolute
  // A .git file also identifies a linked Git worktree root.
  if (hasGitEntry(absolute) !== false) return absolute
  return "project:" + relative
}

function rmPatterns(node: Node, cwd: string | undefined, variables: Variables, projectRoot: string | undefined): string[] | undefined {
  const options: string[] = []
  const operands: string[] = []
  let ended = false
  for (const arg of commandArguments(node)) {
    const raw = arg.text
    const value = literalWord(raw)
    if (!ended && value === "--") {
      ended = true
      options.push(raw)
    } else if (!ended && value?.startsWith("-") && value !== "-") options.push(value)
    else {
      const values = expandedWords(raw, variables)
      const resolved = values?.map((value) => absoluteOperand(raw, cwd) ?? absoluteOperand(raw, cwd, value))
      if (!resolved?.length || resolved.some((value) => !value)) operands.push(raw)
      else operands.push(...resolved.map((value) => projectOperand(value!, projectRoot)))
    }
  }
  if (!operands.length) return
  return operands.map((operand) => ["rm", ...options, operand].join(" "))
}

function uncoveredError(root: Node, commands: Node[]): boolean {
  const visit = (node: Node, error = false): boolean => {
    if (commands.some((command) => command.startIndex <= node.startIndex && command.endIndex >= node.endIndex)) return false
    error ||= node.isError || node.isMissing
    if (!node.childCount) return error && (node.isMissing || Boolean(node.text.trim()))
    return node.children.some((child) => visit(child, error))
  }
  return visit(root)
}

/** Native command-node checks, with local-only rm operand normalization. */
export async function buildBashPermissionRequest(command: string, options: BashPermissionOptions = {}): Promise<BashPermissionRequest> {
  const scope = options.remoteScope ?? options.scope
  const tree = (await bashParser()).parse(command)
  // Native OpenCode aborts when parsing returns no tree; do not downgrade a
  // parser failure into a whole-line rule that a default-allow policy accepts.
  if (!tree) throw new Error("Failed to parse Bash command")
  try {
    const root = tree.rootNode
    const nodes = root.descendantsOfType("command")
    const commands = nodes.map(parsedCommand)
    const variables = scope ? new Map<number, Variables>() : commandVariables(root)
    const projectRoot = !scope && !root.hasError ? validatedProjectRoot(options.projectRoot) : undefined
    const directories = scope ? new Map<number, string | undefined>() : commandDirectories(root, root.hasError ? undefined : options.cwd, variables)
    const patterns: string[] = []
    const always: string[] = []
    for (let i = 0; i < nodes.length; i++) {
      const item = commands[i]
      const name = item.tokens[0]
      if (!item.tokens.length || (name && CWD_ONLY_COMMANDS.has(name))) continue
      const resolved = !scope && name === "rm" ? rmPatterns(nodes[i], directories.get(nodes[i].id), variables.get(nodes[i].id) ?? new Map(), projectRoot) : undefined
      patterns.push(...(resolved ?? [item.source]).map((rule) => prefixRule(scope, rule)))
      always.push(prefixRule(scope, bashArityPrefix(item.tokens).join(" ") + " *"))
    }
    if (root.hasError && uncoveredError(root, nodes)) {
      patterns.push(prefixRule(scope, command))
      always.push(prefixRule(scope, command))
    }
    return { patterns: unique(patterns), always: unique(always), commands, unsupported: root.hasError }
  } finally {
    tree.delete()
  }
}

/** Concise alias for callers that name the result a bash permission. */
export const buildBashPermission = buildBashPermissionRequest
