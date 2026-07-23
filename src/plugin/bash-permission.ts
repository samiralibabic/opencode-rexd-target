import { createHash } from "node:crypto"

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
  /** True when this deliberately small parser cannot safely model the input. */
  unsupported: boolean
}

export type BashPermissionOptions = {
  /**
   * A caller-owned prefix that namespaces every generated rule, for example
   * `remote:production:`. Include any separator wanted in the prefix.
   */
  remoteScope?: string
  /** Alias for remoteScope for callers which use a generic scope name. */
  scope?: string
}

export type BashPermissionRequest = {
  patterns: string[]
  always: string[]
  commands: ParsedSimpleCommand[]
  unsupported: boolean
  /** Present only for a fail-closed request. */
  guard?: string
}

type LexItem =
  | { kind: "word"; raw: string; value: string }
  | { kind: "redirection"; raw: string }

type TopLevelScan = {
  sources: string[]
  unsupported: boolean
}

const SHELL_KEYWORDS = new Set([
  "!",
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "until",
  "while",
])

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function isCommentStart(input: string, index: number): boolean {
  return index === 0 || /[\s;&|(){}]/.test(input[index - 1] ?? "")
}

/**
 * Split the POSIX list operators needed by permission scanning.  Shell
 * substitutions, groups, heredocs, comments, and other grammar we cannot
 * inspect recursively are rejected rather than guessed at.
 */
function splitTopLevel(command: string): TopLevelScan {
  const sources: string[] = []
  let source = ""
  let quote: "single" | "double" | undefined
  let expectsCommand = false
  let finalOperator: "&&" | "||" | ";" | "&" | "|" | "newline" | undefined

  const push = (operator: NonNullable<typeof finalOperator>) => {
    const text = source.trim()
    source = ""
    if (!text) {
      // Blank lines are harmless. Other empty list elements are syntax we do
      // not model (except a newline after an incomplete list, which may be a
      // POSIX line continuation before the next command).
      if (operator === "newline") return true
      return false
    }
    sources.push(text)
    expectsCommand = operator !== ";" && operator !== "newline"
    finalOperator = operator
    return true
  }

  for (let index = 0; index < command.length; index++) {
    const char = command[index]

    if (quote === "single") {
      source += char
      if (char === "'") quote = undefined
      continue
    }

    if (quote === "double") {
      if (char === "`" || (char === "$" && command[index + 1] === "(")) {
        return { sources: [], unsupported: true }
      }
      if (char === "\\") {
        const next = command[index + 1]
        if (next === undefined || next === "\n") return { sources: [], unsupported: true }
        source += char + next
        index++
        continue
      }
      source += char
      if (char === '"') quote = undefined
      continue
    }

    if (char === "\\") {
      const next = command[index + 1]
      if (next === undefined || next === "\n") return { sources: [], unsupported: true }
      source += char + next
      index++
      continue
    }
    if (char === "'") {
      quote = "single"
      source += char
      continue
    }
    if (char === '"') {
      quote = "double"
      source += char
      continue
    }

    // Command substitutions and compound shell grammar need recursive
    // parsing, so a top-level split would not be safe.
    if (char === "`" || (char === "$" && command[index + 1] === "(") || "(){}".includes(char)) {
      return { sources: [], unsupported: true }
    }
    if (char === "#" && isCommentStart(command, index)) return { sources: [], unsupported: true }

    // Here-documents and Bash-only force-redirection cannot be represented by
    // this simple scanner. Ordinary <, >, >>, <>, <&, and >& are retained in
    // the simple-command source and handled by lexSimple below.
    if (char === "<" && command[index + 1] === "<") return { sources: [], unsupported: true }
    if (char === ">" && command[index + 1] === "|") return { sources: [], unsupported: true }
    if (char === "&" && command[index + 1] === ">") return { sources: [], unsupported: true }

    if (char === "&" && (command[index - 1] === ">" || command[index - 1] === "<")) {
      source += char
      continue
    }

    if (char === "&" || char === "|" || char === ";" || char === "\n") {
      let operator: NonNullable<typeof finalOperator>
      if (char === "&" && command[index + 1] === "&") {
        operator = "&&"
        index++
      } else if (char === "|" && command[index + 1] === "|") {
        operator = "||"
        index++
      } else if (char === "&") {
        operator = "&"
      } else if (char === "|") {
        operator = "|"
      } else if (char === ";") {
        operator = ";"
      } else {
        operator = "newline"
      }
      if (!push(operator)) return { sources: [], unsupported: true }
      continue
    }

    source += char
  }

  if (quote) return { sources: [], unsupported: true }
  const final = source.trim()
  if (final) {
    sources.push(final)
    expectsCommand = false
  }
  if (expectsCommand && finalOperator !== ";" && finalOperator !== "newline") {
    return { sources: [], unsupported: true }
  }
  return { sources, unsupported: false }
}

/** Lex one simple command enough to remove assignments and redirections. */
function lexSimple(source: string): { items: LexItem[]; unsupported: boolean } {
  const items: LexItem[] = []
  let raw = ""
  let value = ""
  let started = false
  let quote: "single" | "double" | undefined

  const pushWord = () => {
    if (!started) return
    items.push({ kind: "word", raw, value })
    raw = ""
    value = ""
    started = false
  }

  for (let index = 0; index < source.length; index++) {
    const char = source[index]

    if (quote === "single") {
      raw += char
      if (char === "'") quote = undefined
      else value += char
      continue
    }

    if (quote === "double") {
      if (char === "`" || (char === "$" && source[index + 1] === "(")) {
        return { items: [], unsupported: true }
      }
      raw += char
      if (char === "\\") {
        const next = source[index + 1]
        if (next === undefined || next === "\n") return { items: [], unsupported: true }
        raw += next
        value += next
        index++
      } else if (char === '"') {
        quote = undefined
      } else {
        value += char
      }
      continue
    }

    if (/\s/.test(char)) {
      pushWord()
      continue
    }
    if (char === "'") {
      started = true
      raw += char
      quote = "single"
      continue
    }
    if (char === '"') {
      started = true
      raw += char
      quote = "double"
      continue
    }
    if (char === "\\") {
      const next = source[index + 1]
      if (next === undefined || next === "\n") return { items: [], unsupported: true }
      started = true
      raw += char + next
      value += next
      index++
      continue
    }
    if (char === "<" || char === ">") {
      let io = ""
      if (started && /^\d+$/.test(raw)) {
        io = raw
        raw = ""
        value = ""
        started = false
      } else {
        pushWord()
      }

      const next = source[index + 1]
      if (char === "<" && next === "<") return { items: [], unsupported: true }
      if (char === ">" && next === "|") return { items: [], unsupported: true }
      let operator = char
      if ((char === ">" && next === ">") || (char === "<" && (next === ">" || next === "&")) || (char === ">" && next === "&")) {
        operator += next
        index++
      }
      items.push({ kind: "redirection", raw: io + operator })
      continue
    }

    started = true
    raw += char
    value += char
  }

  if (quote) return { items: [], unsupported: true }
  pushWord()
  return { items, unsupported: false }
}

function commandTokens(source: string): { tokens: string[]; unsupported: boolean } {
  const lexed = lexSimple(source)
  if (lexed.unsupported) return { tokens: [], unsupported: true }

  const tokens: string[] = []
  let redirectionOperand = false
  for (const item of lexed.items) {
    if (item.kind === "redirection") {
      if (redirectionOperand) return { tokens: [], unsupported: true }
      redirectionOperand = true
      continue
    }
    if (redirectionOperand) {
      redirectionOperand = false
      continue
    }
    // POSIX assignment words appear before the command name. Removing every
    // assignment-looking word is also harmless for BashArity's command prefix.
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(item.raw)) continue
    // OpenCode's tree-sitter nodes retain quoting and escaping in token text.
    tokens.push(item.raw)
  }
  return redirectionOperand ? { tokens: [], unsupported: true } : { tokens, unsupported: false }
}

/**
 * Parses ordinary POSIX simple-command lists without executing or expanding
 * anything. Unsupported shell grammar is reported instead of approximated.
 */
export function parsePosixShellCommands(command: string): PosixCommandParse {
  const split = splitTopLevel(command)
  if (split.unsupported) return { commands: [], unsupported: true }

  const commands: ParsedSimpleCommand[] = []
  for (const source of split.sources) {
    const parsed = commandTokens(source)
    if (parsed.unsupported || SHELL_KEYWORDS.has(parsed.tokens[0] ?? "")) {
      return { commands: [], unsupported: true }
    }
    commands.push({ source, tokens: parsed.tokens })
  }
  return { commands, unsupported: false }
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

/** An opaque, stable rule used only when parsing must fail closed. */
export function bashPermissionGuard(command: string): string {
  return `sha256:${createHash("sha256").update(command, "utf8").digest("hex")}`
}

function prefixRule(scope: string | undefined, rule: string): string {
  return scope ? scope + rule : rule
}

/**
 * Build OpenCode-style bash permission patterns without shell parser/runtime
 * dependencies. A parse failure intentionally has no command-family rule:
 * both its exact command and an opaque SHA-256 guard must be approved.
 */
export function buildBashPermissionRequest(command: string, options: BashPermissionOptions = {}): BashPermissionRequest {
  const scope = options.remoteScope ?? options.scope
  const parsed = parsePosixShellCommands(command)
  if (parsed.unsupported) {
    const guard = bashPermissionGuard(command)
    const exact = prefixRule(scope, command)
    const scopedGuard = prefixRule(scope, guard)
    return {
      patterns: unique([exact, scopedGuard]),
      always: unique([exact, scopedGuard]),
      commands: [],
      unsupported: true,
      guard: scopedGuard,
    }
  }

  const patterns: string[] = []
  const always: string[] = []
  for (const item of parsed.commands) {
    const commandName = item.tokens[0]
    if (commandName && CWD_ONLY_COMMANDS.has(commandName)) continue
    // An assignments-only command has no executable command name. A
    // redirection-only command still changes the filesystem, so retain its
    // exact source but deliberately do not grant a command family.
    if (item.tokens.length === 0 && !/[<>]/.test(item.source)) continue
    patterns.push(prefixRule(scope, item.source))
    if (item.tokens.length > 0) {
      always.push(prefixRule(scope, bashArityPrefix(item.tokens).join(" ") + " *"))
    } else {
      always.push(prefixRule(scope, item.source))
    }
  }

  return {
    patterns: unique(patterns),
    always: unique(always),
    commands: parsed.commands,
    unsupported: false,
  }
}

/** Concise alias for callers that name the result a bash permission. */
export const buildBashPermission = buildBashPermissionRequest
