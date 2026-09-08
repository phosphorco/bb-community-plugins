export type AnalyticsSqlToken = Readonly<{
  kind: "word" | "quoted-identifier" | "string" | "number" | "parameter" | "symbol";
  text: string;
  offset: number;
}>;

export type AnalyticsQueryPolicy = Readonly<{
  sql: string;
  parameters: readonly "range_days"[];
  relations: readonly string[];
}>;

/**
 * Text tokenization remains only an authoring-time early rejector for legacy
 * bundles. It is deliberately not the execution security boundary. The
 * isolated runtime binds SQL to DuckDB's json_serialize_sql parser entrypoint
 * and admits the complete returned tree before it materializes facts or runs
 * any authored statement.
 */
export const ANALYTICS_AST_POLICY_REVISION = "parser-tree-v1" as const;

const ALLOWED_RELATION = "tool_execution_fact_v1";
const FORBIDDEN_WORDS = new Set([
  "attach", "call", "copy", "create", "delete", "detach", "drop", "export",
  "import", "insert", "install", "load", "pragma", "set", "update", "vacuum",
  "read_csv", "read_csv_auto", "read_json", "read_json_auto", "read_ndjson",
  "read_parquet", "sqlite_scan", "glob", "httpfs",
]);
const FROM_END = new Set([
  "where", "group", "having", "order", "limit", "offset", "window", "qualify",
  "union", "intersect", "except", "returning",
]);

/**
 * Parse the deliberately narrow Analytics SQL dialect and return the bound
 * parameter/relation plan. Unsupported syntax is denied instead of guessed.
 */
export function parseAnalyticsQuery(sql: string): AnalyticsQueryPolicy {
  const tokens = tokenizeAnalyticsSql(sql);
  if (tokens.length === 0 || !isWord(tokens[0], "select", "with")) {
    throw new Error("Analytics queries must start with SELECT or WITH.");
  }
  const parameters: "range_days"[] = [];
  for (const token of tokens) {
    if (token.kind === "word") {
      const word = token.text.toLowerCase();
      if (FORBIDDEN_WORDS.has(word) || word.startsWith("read_")) {
        throw new Error("Analytics queries may only read the curated capability fact table.");
      }
    }
    if (token.kind === "parameter") {
      if (token.text !== "$range_days") throw new Error(`Unknown Analytics query parameter ${token.text}.`);
      parameters.push("range_days");
    }
  }

  const relations: string[] = [];
  analyzeQuery(tokens, 0, tokens.length, new Set(), relations);
  if (!relations.includes(ALLOWED_RELATION)) {
    throw new Error(`Analytics queries must read ${ALLOWED_RELATION}.`);
  }
  return { sql, parameters, relations };
}

export function bindAnalyticsQuery(policy: AnalyticsQueryPolicy): { sql: string; parameters: readonly "range_days"[] } {
  const tokens = tokenizeAnalyticsSql(policy.sql);
  let cursor = 0;
  let bound = "";
  for (const token of tokens) {
    bound += policy.sql.slice(cursor, token.offset);
    bound += token.kind === "parameter" ? "?" : token.text;
    cursor = token.offset + token.text.length;
  }
  bound += policy.sql.slice(cursor);
  return { sql: bound, parameters: policy.parameters };
}

export function tokenizeAnalyticsSql(sql: string): AnalyticsSqlToken[] {
  const tokens: AnalyticsSqlToken[] = [];
  for (let index = 0; index < sql.length;) {
    const character = sql[index] as string;
    if (/\s/.test(character)) { index += 1; continue; }
    if (character === ";") throw new Error("Analytics queries must contain exactly one statement without a semicolon.");
    if ((character === "-" && sql[index + 1] === "-") || (character === "/" && sql[index + 1] === "*")) {
      throw new Error("Analytics queries cannot contain comments.");
    }
    if (character === "'") {
      const end = scanQuoted(sql, index, "'");
      tokens.push({ kind: "string", text: sql.slice(index, end), offset: index });
      index = end;
      continue;
    }
    if (character === '"') {
      const end = scanQuoted(sql, index, '"');
      tokens.push({ kind: "quoted-identifier", text: sql.slice(index, end), offset: index });
      index = end;
      continue;
    }
    if (character === "$" && /[A-Za-z_]/.test(sql[index + 1] ?? "")) {
      const end = scanWhile(sql, index + 2, /[A-Za-z0-9_]/);
      tokens.push({ kind: "parameter", text: sql.slice(index, end), offset: index });
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const end = scanWhile(sql, index + 1, /[A-Za-z0-9_$]/);
      tokens.push({ kind: "word", text: sql.slice(index, end), offset: index });
      index = end;
      continue;
    }
    if (/[0-9]/.test(character)) {
      const end = scanWhile(sql, index + 1, /[0-9.eE_+-]/);
      tokens.push({ kind: "number", text: sql.slice(index, end), offset: index });
      index = end;
      continue;
    }
    tokens.push({ kind: "symbol", text: character, offset: index });
    index += 1;
  }
  return tokens;
}

function analyzeQuery(
  tokens: readonly AnalyticsSqlToken[],
  start: number,
  end: number,
  inheritedCtes: ReadonlySet<string>,
  relations: string[],
): void {
  let bodyStart = start;
  const ctes = new Set(inheritedCtes);
  if (isWord(tokens[bodyStart], "with")) {
    bodyStart += 1;
    if (isWord(tokens[bodyStart], "recursive")) bodyStart += 1;
    while (bodyStart < end) {
      const name = identifierValue(tokens[bodyStart]);
      if (name == null) throw syntaxError(tokens[bodyStart], "Expected a CTE name after WITH.");
      bodyStart += 1;
      if (tokens[bodyStart]?.text === "(") bodyStart = matchingClose(tokens, bodyStart, end) + 1;
      if (!isWord(tokens[bodyStart], "as")) throw syntaxError(tokens[bodyStart], `Expected AS for CTE ${name}.`);
      bodyStart += 1;
      if (isWord(tokens[bodyStart], "not")) bodyStart += 1;
      if (isWord(tokens[bodyStart], "materialized")) bodyStart += 1;
      if (tokens[bodyStart]?.text !== "(") throw syntaxError(tokens[bodyStart], `Expected a query body for CTE ${name}.`);
      const close = matchingClose(tokens, bodyStart, end);
      ctes.add(name);
      analyzeQuery(tokens, bodyStart + 1, close, ctes, relations);
      bodyStart = close + 1;
      if (tokens[bodyStart]?.text !== ",") break;
      bodyStart += 1;
    }
  }
  if (!isWord(tokens[bodyStart], "select")) throw syntaxError(tokens[bodyStart], "Only SELECT query bodies are supported.");

  let inFrom = false;
  for (let index = bodyStart; index < end; index += 1) {
    const token = tokens[index];
    if (token?.text === "(") {
      const close = matchingClose(tokens, index, end);
      if (isWord(tokens[index + 1], "select", "with")) analyzeQuery(tokens, index + 1, close, ctes, relations);
      index = close;
      continue;
    }
    if (token?.kind !== "word") continue;
    const word = token.text.toLowerCase();
    if (FROM_END.has(word)) { inFrom = false; continue; }
    if (word === "from" || word === "join") {
      index = analyzeRelation(tokens, index + 1, end, ctes, relations) - 1;
      inFrom = true;
      continue;
    }
    if (inFrom && token.text === ",") {
      index = analyzeRelation(tokens, index + 1, end, ctes, relations) - 1;
    }
  }

  // Commas are symbols, so inspect them separately while tracking only the
  // current query level. This closes the classic `FROM allowed, secret` gap.
  inFrom = false;
  for (let index = bodyStart; index < end; index += 1) {
    const token = tokens[index];
    if (token?.text === "(") { index = matchingClose(tokens, index, end); continue; }
    if (isWord(token, "from", "join")) { inFrom = true; continue; }
    if (token?.kind === "word" && FROM_END.has(token.text.toLowerCase())) { inFrom = false; continue; }
    if (inFrom && token?.text === ",") analyzeRelation(tokens, index + 1, end, ctes, relations);
  }
}

function analyzeRelation(
  tokens: readonly AnalyticsSqlToken[],
  start: number,
  end: number,
  ctes: ReadonlySet<string>,
  relations: string[],
): number {
  const token = tokens[start];
  if (token?.text === "(") {
    const close = matchingClose(tokens, start, end);
    if (!isWord(tokens[start + 1], "select", "with")) throw syntaxError(token, "FROM parentheses must contain a subquery.");
    analyzeQuery(tokens, start + 1, close, ctes, relations);
    return close + 1;
  }
  const name = identifierValue(token);
  if (name == null) throw syntaxError(token, "Expected a relation after FROM or JOIN.");
  if (tokens[start + 1]?.text === "(") throw new Error("Analytics queries cannot invoke table functions.");
  if (tokens[start + 1]?.text === ".") throw new Error(`Analytics queries may not read qualified relation ${name}.`);
  if (name !== ALLOWED_RELATION && !ctes.has(name)) throw new Error(`Analytics queries may not read relation ${name}.`);
  if (name === ALLOWED_RELATION) relations.push(name);
  return start + 1;
}

function identifierValue(token: AnalyticsSqlToken | undefined): string | null {
  if (token?.kind === "word") return token.text.toLowerCase();
  if (token?.kind === "quoted-identifier") return token.text.slice(1, -1).replaceAll('""', '"').toLowerCase();
  return null;
}

function matchingClose(tokens: readonly AnalyticsSqlToken[], open: number, end: number): number {
  let depth = 0;
  for (let index = open; index < end; index += 1) {
    if (tokens[index]?.text === "(") depth += 1;
    else if (tokens[index]?.text === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw syntaxError(tokens[open], "Unclosed parenthesis in Analytics query.");
}

function isWord(token: AnalyticsSqlToken | undefined, ...words: string[]): boolean {
  return token?.kind === "word" && words.includes(token.text.toLowerCase());
}

function scanQuoted(sql: string, start: number, quote: string): number {
  for (let index = start + 1; index < sql.length; index += 1) {
    if (sql[index] !== quote) continue;
    if (sql[index + 1] === quote) { index += 1; continue; }
    return index + 1;
  }
  throw new Error("Analytics query contains an unclosed quoted value.");
}

function scanWhile(sql: string, start: number, pattern: RegExp): number {
  let index = start;
  while (index < sql.length && pattern.test(sql[index] as string)) index += 1;
  return index;
}

function syntaxError(token: AnalyticsSqlToken | undefined, message: string): Error {
  return new Error(`${message}${token == null ? "" : ` Near character ${token.offset + 1}.`}`);
}
