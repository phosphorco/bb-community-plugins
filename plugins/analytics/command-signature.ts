export type CommandExecutionShape =
  | "simple"
  | "pipeline"
  | "joined"
  | "pipeline_and_joined"
  | "unparsed";

export interface CommandExecutionSignature {
  binary: string | null;
  argument1: string | null;
  argument2: string | null;
  usesHelp: boolean;
  shape: CommandExecutionShape;
  shellWrapped: boolean;
  attributionEligible: boolean;
}

interface ShellToken {
  value: string;
  quoted: boolean;
}

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh"]);
const SEGMENT_OPERATORS = new Set(["&&", "||", "|", ";", "\n"]);
const REDIRECT_OPERATORS = /^(?:\d+|&)?(?:>>?|<>|<<?<?|>\||>&|&>>?)$/u;
const MAX_SIGNATURE_TOKEN_LENGTH = 120;
const SAFE_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  bb: new Set(["analytics", "check", "guide", "plugin", "status", "thread"]),
  bun: new Set(["build", "install", "run", "test", "x"]),
  git: new Set(["add", "branch", "commit", "diff", "fetch", "log", "pull", "push", "show", "status"]),
  npm: new Set(["build", "ci", "install", "run", "test", "view"]),
};

/**
 * Produces a deliberately small, non-executable command signature. It is not
 * a shell evaluator: it only understands quoting and command separators well
 * enough to keep a pipeline or joined command visibly distinct from a single
 * invocation.
 */
export function describeCommandExecution(command: string | undefined): CommandExecutionSignature {
  if (command == null || command.trim() === "") return unparsedSignature();

  let tokens = tokenize(command);
  let shellWrapped = false;
  // A native execution commonly records `bash -lc "..."`. Unwrap only known
  // shell programs and only their explicit `-c` command argument.
  for (let depth = 0; depth < 3; depth += 1) {
    const nested = shellCommandArgument(tokens);
    if (nested == null) break;
    shellWrapped = true;
    tokens = tokenize(nested);
  }

  const usesHelp = tokens.some((token) => token.value === "--help" || token.value.startsWith("--help="));
  const hasPipeline = tokens.some((token) => !token.quoted && token.value === "|");
  const hasJoin = tokens.some((token) => !token.quoted && token.value !== "|" && SEGMENT_OPERATORS.has(token.value));
  const shape: CommandExecutionShape = hasPipeline && hasJoin
    ? "pipeline_and_joined"
    : hasPipeline
      ? "pipeline"
      : hasJoin
        ? "joined"
        : "simple";

  const segment = firstCommandSegment(tokens);
  const binaryIndex = commandIndex(segment);
  const binary = segment[binaryIndex]?.value;
  if (binary == null || binary === "") return { ...unparsedSignature(), usesHelp, shape, shellWrapped };
  const arguments_ = argumentTokens(segment.slice(binaryIndex + 1));
  const normalizedBinary = retainedToken(baseName(binary));
  const attributionEligible = !usesHelp && shape === "simple" && !shellWrapped;
  return {
    binary: normalizedBinary,
    argument1: arguments_[0] == null ? null : safeArgumentToken(normalizedBinary, arguments_[0]),
    argument2: arguments_[1] == null ? null : safeArgumentToken(normalizedBinary, arguments_[1]),
    usesHelp,
    shape,
    shellWrapped,
    attributionEligible,
  };
}

function unparsedSignature(): CommandExecutionSignature {
  return {
    binary: null,
    argument1: null,
    argument2: null,
    usesHelp: false,
    shape: "unparsed",
    shellWrapped: false,
    attributionEligible: false,
  };
}

function baseName(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1) || value;
}

function retainedToken(value: string): string {
  return value.length <= MAX_SIGNATURE_TOKEN_LENGTH ? value : `${value.slice(0, MAX_SIGNATURE_TOKEN_LENGTH - 1)}…`;
}

/** Keep flags and command-like subcommands, but never retain arbitrary values,
 * paths, URLs, assignments, or shell expansions from a raw command. */
function safeArgumentToken(binary: string, value: string): string {
  if (value.startsWith("-")) return retainedToken(value);
  return SAFE_SUBCOMMANDS[binary]?.has(value) ? value : "<redacted>";
}

function shellCommandArgument(tokens: readonly ShellToken[]): string | null {
  const program = tokens[0]?.value;
  if (program == null || !SHELL_WRAPPERS.has(baseName(program))) return null;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.value === "--") break;
    if (token.value === "-c" || (/^-[^-]*c/u.test(token.value) && token.value !== "-")) {
      return tokens[index + 1]?.value ?? null;
    }
  }
  return null;
}

function firstCommandSegment(tokens: readonly ShellToken[]): ShellToken[] {
  const segment: ShellToken[] = [];
  for (const token of tokens) {
    if (!token.quoted && SEGMENT_OPERATORS.has(token.value)) break;
    segment.push(token);
  }
  return segment;
}

function commandIndex(tokens: readonly ShellToken[]): number {
  let index = 0;
  while (index < tokens.length && !tokens[index]!.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index]!.value)) index += 1;
  return index;
}

function argumentTokens(tokens: readonly ShellToken[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.quoted && REDIRECT_OPERATORS.test(token.value)) {
      index += 1;
      continue;
    }
    result.push(token.value);
  }
  return result;
}

function tokenize(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let value = "";
  let quoted = false;
  let unquoted = false;
  let quote: "'" | '"' | null = null;
  let escaping = false;
  const flush = () => {
    if (value !== "" || quoted) tokens.push({ value, quoted: quoted && !unquoted });
    value = "";
    quoted = false;
    unquoted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaping) {
      value += character;
      if (quote == null) unquoted = true;
      else quoted = true;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote != null) {
      if (character === quote) quote = null;
      else {
        value += character;
        quoted = true;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      quoted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      flush();
      if (character === "\n") tokens.push({ value: "\n", quoted: false });
      continue;
    }
    if (character === "|" || character === "&" || character === ";") {
      flush();
      const next = command[index + 1];
      if ((character === "|" || character === "&") && next === character) {
        tokens.push({ value: `${character}${next}`, quoted: false });
        index += 1;
      } else {
        tokens.push({ value: character, quoted: false });
      }
      continue;
    }
    if (character === ">" || character === "<") {
      flush();
      const next = command[index + 1];
      if (next === character) {
        tokens.push({ value: `${character}${next}`, quoted: false });
        index += 1;
      } else {
        tokens.push({ value: character, quoted: false });
      }
      continue;
    }
    value += character;
    unquoted = true;
  }
  if (escaping) {
    value += "\\";
    unquoted = true;
  }
  flush();
  return tokens;
}
