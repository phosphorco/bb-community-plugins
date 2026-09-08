const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  PARAMETER_BRIDGE_SOURCE_SHA256,
  PARAMETER_BRIDGE_TRANSFORM_REVISION,
  bridgeNamedParameters,
  isValidatedLogicalTypeMetadata,
  isValidatedOrderByEnvelope,
  policyAstFromSerialized,
  verifyPositionalBridge,
} = require("./parameter-bridge.cjs");
const requireHere = createRequire(__filename);
const duckdb = requireHere("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
const duckdbEntry = requireHere.resolve(
  "@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs",
);
const DUCKDB_WASM_VERSION =
  require(join(dirname(duckdbEntry), "..", "package.json"))
    .version;
const WORKER_SOURCE_SHA256 = createHash("sha256")
  .update(readFileSync(__filename))
  .digest("hex");
const MAX_BRIDGED_AST_BYTES = 1024 * 1024;
const MAX_BRIDGED_SQL_BYTES = 64 * 1024;

const FACT_COLUMNS = [
  "source_event_id",
  "thread_id",
  "turn_id",
  "sequence",
  "project_id",
  "provider_id",
  "created_at_ms",
  "turn_started_at_ms",
  "turn_completed_at_ms",
  "capability_kind",
  "capability_key",
  "status",
  "duration_ms",
  "failed",
  "error_class",
  "error_signature",
  "command_binary",
  "command_argument_1",
  "command_argument_2",
  "command_uses_help",
  "command_shape",
  "command_shell_wrapped",
  "command_attribution_eligible",
];
const FACT_TYPES = [
  "VARCHAR",
  "VARCHAR",
  "VARCHAR",
  "BIGINT",
  "VARCHAR",
  "VARCHAR",
  "BIGINT",
  "BIGINT",
  "BIGINT",
  "VARCHAR",
  "VARCHAR",
  "VARCHAR",
  "BIGINT",
  "BOOLEAN",
  "VARCHAR",
  "VARCHAR",
  "VARCHAR",
  "VARCHAR",
  "VARCHAR",
  "BOOLEAN",
  "VARCHAR",
  "BOOLEAN",
  "BOOLEAN",
];
const VETTED_FUNCTIONS = new Set([
  "avg",
  "coalesce",
  "count",
  "count_star",
  "count_if",
  "epoch_ms",
  "greatest",
  "lag",
  "least",
  "max",
  "min",
  "quantile_cont",
  "row_number",
  "strftime",
  "sum",
]);
const VETTED_OPERATOR_ARITIES = new Map([
  ["*", new Set([2])],
  ["/", new Set([2])],
  ["-", new Set([2])],
  ["||", new Set([2])],
]);
const VOLATILE = new Set([
  "current_date",
  "current_localtime",
  "current_localtimestamp",
  "current_time",
  "current_timestamp",
  "now",
  "random",
  "uuid",
]);
const KNOWN_TYPES = new Set([
  "SELECT_NODE",
  "BASE_TABLE",
  "STAR",
  "COLUMN_REF",
  "FUNCTION",
  "WINDOW_LAG",
  "WINDOW_ROW_NUMBER",
  "WINDOW_RANK",
  "WINDOW_DENSE_RANK",
  "WINDOW",
  "COMPARE_EQUAL",
  "COMPARE_NOTEQUAL",
  "COMPARE_LESSTHAN",
  "COMPARE_LESSTHANOREQUALTO",
  "COMPARE_GREATERTHAN",
  "COMPARE_GREATERTHANOREQUALTO",
  "CONJUNCTION_AND",
  "CONJUNCTION_OR",
  "OPERATOR_NOT",
  "OPERATOR_IS_NULL",
  "OPERATOR_IS_NOT_NULL",
  "OPERATOR_PLUS",
  "OPERATOR_MINUS",
  "OPERATOR_MULTIPLY",
  "OPERATOR_DIVIDE",
  "OPERATOR_CONCAT",
  "OPERATOR_COALESCE",
  "OPERATOR_CAST",
  "VALUE_CONSTANT",
  "VALUE_PARAMETER",
  "CASE_EXPR",
  "ORDER_MODIFIER",
  "LIMIT_MODIFIER",
  "EMPTY",
  "CROSS_PRODUCT",
  "COMPARISON_JOIN",
  "ANY_JOIN",
  "JOIN",
  "LEFT_JOIN",
  "RIGHT_JOIN",
  "INNER_JOIN",
]);
const ADMISSION_POLICY_CAPSULE = Object.freeze({
  algorithmRevision: "analytics-parser-walk-v1",
  canonicalFormatIdentity: "analytics-canonical-json-v1",
  parserFormatIdentity: "duckdb-json_serialize_sql-v1",
  packageName: "@duckdb/duckdb-wasm",
  packageVersion: DUCKDB_WASM_VERSION,
  parameterBridgeTransformRevision: PARAMETER_BRIDGE_TRANSFORM_REVISION,
  parameterBridgeSourceSha256: PARAMETER_BRIDGE_SOURCE_SHA256,
  workerSourceSha256: WORKER_SOURCE_SHA256,
  knownNodeTypes: [...KNOWN_TYPES].sort(),
  vettedFunctions: [...VETTED_FUNCTIONS].sort(),
  vettedOperatorArities: Object.fromEntries(
    [...VETTED_OPERATOR_ARITIES.entries()].map(([name, arities]) => [
      name,
      [...arities].sort(),
    ]),
  ),
  volatileFunctions: [...VOLATILE].sort(),
});

let database;
let connection;
let materializationKey = null;
let pending = new Map();
let materializationCheckpoints = new Map();
let phase = "new";
let bootstrapMaxResultBytes = null;
let astPolicyRevision = null;
process.on("message", (message) => {
  void handleMessage(message);
});
// Parent IPC loss ends the child when it is idle or between synchronous calls.
// A parent cannot interrupt a synchronously wedged Wasm call after its own
// death; the external supervisor remains responsible for that stronger bound.
process.once("disconnect", terminateClosed);

async function handleMessage(message) {
  try {
    if (isBootstrap(message) && phase === "new") {
      // Set this before the first await: Node may deliver another IPC message
      // while Wasm is instantiating.
      phase = "bootstrapping";
      await bootstrap(message);
      return;
    }
    if (
      isAdmit(message) && phase === "ready" && pending.size === 0 &&
      materializationCheckpoints.size === 0
    ) {
      await admit(message);
      return;
    }
    if (
      isPrepare(message) && phase === "ready" && pending.size === 0 &&
      materializationCheckpoints.size === 0
    ) {
      await prepare(message);
      return;
    }
    if (
      isContinue(message) && phase === "ready" && pending.has(message.token)
    ) {
      await execute(message.token);
      return;
    }
    if (
      isCommitMaterialization(message) && phase === "ready" &&
      materializationCheckpoints.has(message.token)
    ) {
      await commitMaterialization(message.token);
      return;
    }
    if (isClose(message) && phase !== "closed") {
      await close();
      return;
    }
    if (typeof message?.token === "string") {
      send({
        kind: "result",
        token: message.token,
        error: {
          code: "invalid-request",
          message:
            "Child IPC message does not match the closed runtime protocol.",
        },
      });
    }
    terminateClosed();
  } catch {
    if (token(message?.token)) {
      send({
        kind: "result",
        token: message.token,
        error: {
          code: "worker-crashed",
          message:
            "Isolated worker could not complete the requested operation.",
        },
      });
    }
    terminateClosed();
  }
}

async function bootstrap(message) {
  database = await duckdb.createDuckDB(
    {
      mvp: {
        mainModule: requireHere.resolve(
          "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm",
        ),
      },
      eh: {
        mainModule: requireHere.resolve(
          "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm",
        ),
      },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  );
  await database.instantiate();
  database.open({
    path: ":memory:",
    maximumThreads: 1,
    allowUnsignedExtensions: false,
  });
  connection = database.connect();
  // This fixed bootstrap is the only code permitted to use temporary external access.
  for (
    const sql of [
      "SET autoinstall_known_extensions = false",
      "SET autoload_known_extensions = false",
      "SET allow_community_extensions = false",
      "SET allow_unsigned_extensions = false",
    ]
  ) connection.query(sql);
  const externalAccessBeforeLoad = connection.query(
    "SELECT current_setting('enable_external_access') AS external_access",
  ).toArray()[0]?.external_access;
  if (externalAccessBeforeLoad !== true) {
    throw new Error("bootstrap external access was unavailable for fixed LOAD");
  }
  for (
    const sql of [
      "LOAD json",
      `SET memory_limit = '${Math.floor(message.databaseMemoryLimitBytes)}B'`,
      `CREATE TABLE tool_execution_fact_v1 (${
        FACT_COLUMNS.map((name, index) => `${name} ${FACT_TYPES[index]}`).join(
          ", ",
        )
      })`,
      "SET enable_external_access = false",
      "SET lock_configuration = true",
    ]
  ) connection.query(sql);
  const settings = connection.query(
    "SELECT current_setting('allow_unsigned_extensions') AS unsigned, current_setting('allow_community_extensions') AS community, current_setting('autoinstall_known_extensions') AS autoinstall, current_setting('autoload_known_extensions') AS autoload, current_setting('enable_external_access') AS external_access, current_setting('lock_configuration') AS locked",
  ).toArray()[0];
  if (
    settings?.unsigned !== false || settings?.community !== false ||
    settings?.autoinstall !== false || settings?.autoload !== false ||
    settings?.external_access !== false || settings?.locked !== true
  ) throw new Error("bootstrap settings failed");
  const selectedDuckdbLibraryVersion = connection.query(
    "SELECT version() AS version",
  ).toArray()[0]?.version;
  if (
    typeof selectedDuckdbLibraryVersion !== "string" ||
    !/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/.test(
      selectedDuckdbLibraryVersion,
    )
  ) throw new Error("bootstrap engine version failed");
  astPolicyRevision = sha256(canonicalJson({
    ...ADMISSION_POLICY_CAPSULE,
    selectedDuckdbLibraryVersion,
  }));
  bootstrapMaxResultBytes = message.maxResultBytes;
  phase = "ready";
  send({
    kind: "ready",
    bootstrapFingerprint: createHash("sha256").update(canonicalJson({
      packageName: "@duckdb/duckdb-wasm",
      packageVersion: DUCKDB_WASM_VERSION,
      bootstrap: {
        statement: "LOAD json",
        externalAccessBeforeLoad,
        allowUnsignedExtensions: settings.unsigned,
        allowCommunityExtensions: settings.community,
        autoinstallKnownExtensions: settings.autoinstall,
        autoloadKnownExtensions: settings.autoload,
        externalAccessAfterLoad: settings.external_access,
        lockConfigurationBeforeAuthoredSql: settings.locked,
      },
    })).digest("hex"),
  });
}

function prepare(message) {
  const admission = admitTree(
    message.sql,
    message.parameters,
    message.cacheability,
    message.limits.maxAstNodes,
  );
  if (typeof admission === "string") {
    return send({
      kind: "result",
      token: message.token,
      error: { code: "invalid-request", message: admission },
    });
  }
  if (!sameAdmission(admission.admission, message.admission)) {
    return send({
      kind: "result",
      token: message.token,
      error: {
        code: "invalid-request",
        message:
          "Query admission attestation does not match child parser policy.",
      },
    });
  }
  const preparedMessage = {
    ...message,
    boundValues: admission.boundValues,
    executionSql: admission.executionSql,
  };
  const source = materializeTrustedSource(
    preparedMessage.source,
    preparedMessage.snapshot,
    preparedMessage.limits,
    materializationKey,
    message.testMaterializationCheckpoint,
  );
  if (source.error) {
    return send({
      kind: "result",
      token: preparedMessage.token,
      error: source.error,
    });
  }
  if (source.awaitingCommit) {
    materializationCheckpoints.set(preparedMessage.token, {
      message: preparedMessage,
      source,
    });
    return send({
      kind: "materialization-checkpoint",
      token: preparedMessage.token,
    });
  }
  completePrepare(preparedMessage, source);
}

function admit(message) {
  const admission = admitTree(
    message.sql,
    message.parameters,
    message.cacheability,
    message.maxAstNodes,
  );
  if (typeof admission === "string") {
    return send({
      kind: "result",
      token: message.token,
      error: { code: "invalid-request", message: admission },
    });
  }
  send({
    kind: "admitted",
    token: message.token,
    admission: admission.admission,
  });
}

function commitMaterialization(token) {
  const checkpoint = materializationCheckpoints.get(token);
  materializationCheckpoints.delete(token);
  try {
    connection.query("COMMIT");
    materializationKey = checkpoint.source.materializationKey;
    completePrepare(checkpoint.message, checkpoint.source);
  } catch {
    try {
      connection.query("ROLLBACK");
    } catch {}
    send({
      kind: "result",
      token,
      error: {
        code: "materialization-limit",
        message: "Trusted materialization could not commit.",
      },
    });
  }
}

function completePrepare(message, source) {
  if (!source.reused) materializationKey = source.materializationKey;
  pending.set(message.token, { ...message, started: performance.now() });
  // Source read/validation and trusted in-memory materialization have already
  // completed under the locked connection; only then may parent dispatch SQL.
  send({
    kind: "started",
    token: message.token,
    materializationId: createHash("sha256").update(source.materializationKey)
      .digest("hex"),
    childReadCount: source.childReadCount,
    reused: source.reused,
  });
}

function execute(token) {
  const message = pending.get(token);
  if (!message) return;
  pending.delete(token);
  try {
    const statement = connection.prepare(
      `SELECT * FROM (${message.executionSql}) AS analytics_result LIMIT ${
        message.maxRows + 1
      }`,
    );
    let table;
    try {
      // The worker executes only its parser-derived positional artifact. The
      // original immutable SQL remains the attested request; values are bound
      // separately in validated parser map-index order.
      table = statement.query(...message.boundValues);
    } finally {
      statement.close();
    }
    const output = boundedResult(table, message.maxRows, message.limits);
    if (output.error) {
      return send({ kind: "result", token, error: output.error });
    }
    send({
      kind: "result",
      token,
      ...output,
      elapsedMs: Math.floor(performance.now() - message.started),
    });
  } catch {
    send({
      kind: "result",
      token,
      error: {
        code: "invalid-request",
        message:
          "Authored SQL could not execute against the curated fact schema.",
      },
    });
  }
}

function materializeTrustedSource(
  source,
  snapshot,
  limits,
  existingKey,
  checkpoint,
) {
  if (source?.kind === "generation-checked-stream") {
    return {
      error: {
        code: "materialization-limit",
        message:
          "Generation-checked streaming handoff is not available in this isolated runtime build.",
      },
    };
  }
  if (
    source?.kind !== "node-sqlite-readonly" ||
    typeof source.readonlyDatabasePath !== "string" ||
    !source.readonlyDatabasePath.startsWith("/") ||
    source.readonlyDatabasePath.includes("\0") ||
    !Number.isSafeInteger(source.factProjectionVersion) ||
    source.snapshotId !== snapshot?.snapshotId ||
    source.sourceGeneration !==
      snapshot?.coverage?.observed?.projectionGeneration ||
    canonicalJson(source.sourceScope) !== canonicalJson(snapshot?.sourceScope)
  ) {
    return {
      error: {
        code: "identity-mismatch",
        message: "Trusted source does not match the frozen execution snapshot.",
      },
    };
  }
  const start = performance.now();
  const expired = () =>
    performance.now() - start > limits.materializationDeadlineMs;
  const maxBatchBytes = Math.min(
    source.maxChunkBytes,
    limits.maxTransferChunkBytes,
  );
  const maxBatchRows = Math.min(
    source.maxRowsPerChunk,
    limits.maxTransferRowsPerChunk,
  );
  let db;
  try {
    if (expired()) throw new Error("materialization deadline");
    const sqlite = require("node:sqlite");
    db = new sqlite.DatabaseSync(source.readonlyDatabasePath, {
      readOnly: true,
    });
    db.exec("BEGIN");
    if (expired()) throw new Error("materialization deadline");
    const state = db.prepare(
      "SELECT generation_id, fact_projection_version, loaded_threads, fact_count, truncated_threads, degraded, snapshot_updated_at FROM analytics_index_state WHERE singleton = 1",
    ).get();
    const population = snapshot?.coverage?.population;
    if (
      state?.generation_id !== source.sourceGeneration ||
      state?.fact_projection_version !== source.factProjectionVersion ||
      !Number.isSafeInteger(state?.loaded_threads) ||
      !Number.isSafeInteger(state?.fact_count) ||
      !Number.isSafeInteger(state?.truncated_threads) ||
      !(state?.degraded === 0 || state?.degraded === 1) ||
      state.loaded_threads !== population?.loadedThreads ||
      state.fact_count !== population?.retainedFacts ||
      state.truncated_threads !== population?.cappedThreads ||
      Boolean(state.degraded) !== Boolean(snapshot?.coverage?.degraded) ||
      !Number.isSafeInteger(state.snapshot_updated_at) ||
      // capturedAtMs is the execution as-of time, not the SQLite update time.
      // Without a persisted source-snapshot timestamp, a source state that is
      // no newer than that as-of time is the strongest atomic child check.
      state.snapshot_updated_at > snapshot?.capturedAtMs
    ) {
      db.exec("COMMIT");
      return {
        error: {
          code: "stale-snapshot",
          message: "Trusted source state changed before child materialization.",
        },
      };
    }
    const materializationKey = canonicalJson({
      scope: source.sourceScope,
      generation: source.sourceGeneration,
      factProjectionVersion: source.factProjectionVersion,
      revision: snapshot.coverage.observed.projectionRevision,
      range: snapshot.frozenRange,
    });
    if (materializationKey === existingKey) {
      db.exec("COMMIT");
      return {
        rows: null,
        materializationKey,
        childReadCount: 0,
        reused: true,
      };
    }
    const query = db.prepare(
      `SELECT ${
        FACT_COLUMNS.join(", ")
      } FROM tool_execution_facts_v1 WHERE created_at_ms >= ? AND created_at_ms < ? ORDER BY created_at_ms ASC, source_event_id ASC`,
    );
    // A failed replacement rolls back to the previously materialized table;
    // materializationKey is advanced only after both transactions commit.
    connection.query("BEGIN TRANSACTION");
    if (expired()) throw new Error("materialization deadline");
    connection.query("DELETE FROM tool_execution_fact_v1");
    let rows = 0;
    let batchBytes = 0;
    let batch = [];
    const flush = () => {
      if (batch.length === 0) return;
      if (expired()) throw new Error("materialization deadline");
      const placeholders = `(${FACT_COLUMNS.map(() => "?").join(", ")})`;
      const insert = connection.prepare(
        `INSERT INTO tool_execution_fact_v1 VALUES ${
          batch.map(() => placeholders).join(", ")
        }`,
      );
      try {
        insert.query(
          ...batch.flatMap((row) => FACT_COLUMNS.map((name) => row[name])),
        );
      } finally {
        insert.close();
      }
      if (expired()) throw new Error("materialization deadline");
      batch = [];
      batchBytes = 0;
    };
    for (
      const row of query.iterate(
        snapshot.frozenRange.startInclusiveMs,
        snapshot.frozenRange.endExclusiveMs,
      )
    ) {
      const rowBytes = Buffer.byteLength(JSON.stringify(row));
      if (
        rowBytes > maxBatchBytes ||
        expired()
      ) throw new Error("materialization deadline");
      if (
        batch.length >= maxBatchRows ||
        batchBytes + rowBytes > maxBatchBytes
      ) flush();
      batch.push(row);
      rows++;
      batchBytes += rowBytes;
    }
    flush();
    if (expired()) throw new Error("materialization deadline");
    db.exec("COMMIT");
    if (checkpoint) {
      return {
        materializationKey,
        childReadCount: rows,
        reused: false,
        awaitingCommit: true,
      };
    }
    if (expired()) throw new Error("materialization deadline");
    connection.query("COMMIT");
    return {
      materializationKey,
      childReadCount: rows,
      reused: false,
      awaitingCommit: false,
    };
  } catch {
    try {
      connection.query("ROLLBACK");
    } catch {}
    try {
      db?.exec("ROLLBACK");
    } catch {}
    return {
      error: {
        code: "materialization-limit",
        message:
          "Trusted source could not be materialized in the isolated child.",
      },
    };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function admitTree(sql, parameters, cacheability, maxNodes) {
  if (typeof astPolicyRevision !== "string") {
    return "Parser policy identity is unavailable before trusted bootstrap.";
  }
  let serialized;
  try {
    serialized = serializeSqlTree(sql);
  } catch {
    return "Parser did not return a valid SQL tree.";
  }
  let parsed;
  try {
    parsed = policyAstFromSerialized(
      serialized,
      maxNodes,
      MAX_BRIDGED_AST_BYTES,
    );
  } catch {
    return "Parser did not return a lossless SQL tree.";
  }
  if (
    parsed?.error !== false || !Array.isArray(parsed.statements) ||
    parsed.statements.length !== 1 ||
    parsed.statements[0]?.node?.type !== "SELECT_NODE"
  ) return "Only one SELECT statement is allowed.";
  let nodes = 0;
  let denied = null;
  let volatile = false;
  const foundParameters = new Set();
  const walk = (value, scope) => {
    if (denied || value == null || typeof value !== "object") return;
    if (++nodes > maxNodes) {
      denied = "SQL tree exceeds its AST node limit.";
      return;
    }
    const type = typeof value.type === "string" ? value.type : null;
    if (
      type && !KNOWN_TYPES.has(type) &&
      !isValidatedLogicalTypeMetadata(value) &&
      !isValidatedOrderByEnvelope(value)
    ) {
      denied = "SQL contains an unsupported parse-tree feature.";
      return;
    }
    if (type === "SELECT_NODE") {
      const local = new Set(scope);
      const entries = Array.isArray(value?.cte_map?.map)
        ? value.cte_map.map
        : [];
      for (const entry of entries) {
        walk(entry?.value?.query?.node, local);
        const name = typeof entry?.key === "string"
          ? entry.key
          : entry?.key?.alias ?? entry?.key?.cte_name ?? entry?.key?.name;
        if (typeof name !== "string") {
          denied = "SQL has an unsupported CTE declaration.";
          return;
        }
        local.add(name.toLowerCase());
      }
      for (const [key, child] of Object.entries(value)) {
        if (key !== "cte_map") {
          Array.isArray(child)
            ? child.forEach((item) => walk(item, local))
            : walk(child, local);
        }
      }
      return;
    }
    if (type === "TABLE_FUNCTION" || type === "SUBQUERY" || type === "MACRO") {
      denied = "Table functions and unsupported relation sources are denied.";
      return;
    }
    if (type === "BASE_TABLE") {
      const table = String(value.table_name ?? "").toLowerCase();
      if (
        String(value.schema_name ?? "") || String(value.catalog_name ?? "") ||
        (table !== "tool_execution_fact_v1" && !scope.has(table))
      ) {
        denied =
          "Only the curated fact relation and lexically declared CTEs may be read.";
        return;
      }
    }
    if (
      type === "OPERATOR_COALESCE" &&
      (!Array.isArray(value.children) || value.children.length === 0)
    ) {
      denied = "SQL contains an unsupported parse-tree feature.";
      return;
    }
    if (type === "FUNCTION" || type?.startsWith("WINDOW_")) {
      const name = String(value.function_name ?? "").toLowerCase();
      if (String(value.schema ?? "") || String(value.catalog ?? "")) {
        denied = "Qualified functions are denied.";
        return;
      }
      if (type === "FUNCTION" && value.is_operator === true) {
        const arities = VETTED_OPERATOR_ARITIES.get(name);
        if (
          !Array.isArray(value.children) || !arities?.has(value.children.length)
        ) {
          denied = "SQL calls an operator outside the vetted analytics policy.";
          return;
        }
      } else {
        if (type === "FUNCTION" && value.is_operator !== false) {
          denied = "SQL has an unsupported function operator flag.";
          return;
        }
        if (VOLATILE.has(name)) volatile = true;
        else if (!VETTED_FUNCTIONS.has(name)) {
          denied = "SQL calls a function outside the vetted analytics policy.";
          return;
        }
      }
    }
    if (
      type === "COLUMN_REF" &&
      (value.column_names ?? []).some((name) =>
        VOLATILE.has(String(name).toLowerCase())
      )
    ) volatile = true;
    if (type === "VALUE_PARAMETER") {
      foundParameters.add(String(value.identifier ?? ""));
    }
    for (const child of Object.values(value)) {
      Array.isArray(child)
        ? child.forEach((item) => walk(item, scope))
        : walk(child, scope);
    }
  };
  walk(parsed.statements[0], new Set());
  const supplied = new Set(
    (parameters ?? []).map((parameter) => parameter.name),
  );
  if (denied) return denied;
  const actualCacheability = volatile ? "volatile-uncacheable" : "stable";
  if (cacheability !== actualCacheability) {
    return "Requested cacheability does not match the admitted SQL.";
  }
  if (
    foundParameters.size !== supplied.size ||
    [...foundParameters].some((name) => !supplied.has(name))
  ) return "SQL parameters do not match the admitted bound values.";
  let bridge;
  try {
    bridge = bridgeNamedParameters({
      serialized,
      parameters,
      maxAstNodes: maxNodes,
      maxGeneratedBytes: MAX_BRIDGED_AST_BYTES,
    });
  } catch {
    return "SQL parameters cannot be safely bridged to the selected runtime.";
  }
  let executionSql;
  try {
    executionSql = deserializeSqlTree(bridge.generatedJson);
    const reparsed = serializeSqlTree(executionSql);
    verifyPositionalBridge({
      originalSerialized: serialized,
      reparsedSerialized: reparsed,
      parameters,
      maxAstNodes: maxNodes,
      maxGeneratedBytes: MAX_BRIDGED_AST_BYTES,
    });
  } catch {
    return "SQL parameter bridge could not establish parser equivalence.";
  }
  return {
    boundValues: bridge.boundValues,
    executionSql,
    admission: {
      astPolicyRevision,
      astNodeCount: nodes,
      sqlSha256: sha256(sql),
      parameterDeclarationDigest: sha256(
        parameterDeclarationDigestInput(parameters),
      ),
      cacheability: actualCacheability,
    },
  };
}

function serializeSqlTree(sql) {
  const statement = connection.prepare(
    "SELECT json_serialize_sql(CAST(? AS VARCHAR)) AS serialized",
  );
  try {
    const serialized = statement.query(sql).toArray()[0]?.serialized;
    if (
      typeof serialized !== "string" ||
      Buffer.byteLength(serialized) > MAX_BRIDGED_AST_BYTES
    ) throw new Error("serialized AST exceeds the bridge limit");
    return serialized;
  } finally {
    statement.close();
  }
}

function deserializeSqlTree(serialized) {
  const statement = connection.prepare(
    "SELECT json_deserialize_sql(CAST(? AS JSON)) AS sql",
  );
  try {
    const sql = statement.query(serialized).toArray()[0]?.sql;
    if (
      typeof sql !== "string" || sql.length === 0 ||
      Buffer.byteLength(sql) > MAX_BRIDGED_SQL_BYTES
    ) throw new Error("deparsed SQL exceeds the bridge limit");
    return sql;
  } finally {
    statement.close();
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameAdmission(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function parameterDeclarationDigestInput(parameters) {
  return canonicalJson(
    parameters
      .map((parameter) => ({
        name: parameter.name,
        logicalType: parameter.logicalType,
      }))
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      ),
  );
}

function boundedResult(table, maxRows, limits) {
  const fields = table.schema.fields;
  if (
    fields.length < 1 || fields.length > limits.maxColumns ||
    fields.length * Math.min(maxRows + 1, limits.maxRows + 1) >
      limits.maxCells + limits.maxColumns
  ) {
    return {
      error: {
        code: "result-limit",
        message: "Query result exceeds column or cell limit.",
      },
    };
  }
  if (fields.some((field) => arrowDescriptor(field.type) == null)) {
    return {
      error: {
        code: "result-limit",
        message: "Query result contains an unsupported Arrow logical type.",
      },
    };
  }
  if (
    fields.some((field) =>
      typeof field.name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(field.name)
    ) || new Set(fields.map((field) => field.name)).size !== fields.length
  ) {
    return {
      error: {
        code: "result-limit",
        message: "Query result has duplicate or invalid column names.",
      },
    };
  }
  const raw = table.toArray();
  if (raw.length > maxRows + 1) {
    return {
      error: {
        code: "result-limit",
        message: "Query result exceeds row limit.",
      },
    };
  }
  const rows = [];
  for (const item of raw.slice(0, maxRows)) {
    if ((rows.length + 1) * fields.length > limits.maxCells) {
      return {
        error: {
          code: "result-limit",
          message: "Query result exceeds cell limit.",
        },
      };
    }
    const row = Object.create(null);
    for (const field of fields) {
      const descriptor = arrowDescriptor(field.type);
      const value = scalar(item[field.name], descriptor);
      if (
        value === undefined ||
        (typeof value === "string" &&
          Buffer.byteLength(value) > limits.maxCellStringBytes)
      ) {
        return {
          error: {
            code: "result-limit",
            message: "Query result contains an unsupported or oversized value.",
          },
        };
      }
      Object.defineProperty(row, field.name, {
        value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    rows.push(row);
  }
  const columns = fields.map((field) => ({
    name: field.name,
    logicalType: arrowDescriptor(field.type)?.logicalType,
    nullable: field.nullable === true,
  }));
  const wire = JSON.stringify({ columns, rows });
  if (Buffer.byteLength(wire) > limits.maxCanonicalResultBytes) {
    return {
      error: {
        code: "result-limit",
        message: "Query result exceeds IPC byte limit.",
      },
    };
  }
  return { columns, rows, truncated: raw.length > maxRows };
}
function arrowDescriptor(type) {
  switch (type?.[Symbol.toStringTag]) {
    case "Bool":
      return { logicalType: "boolean", kind: "boolean" };
    case "Utf8":
    case "LargeUtf8":
      return { logicalType: "utf8", kind: "utf8" };
    case "Int":
      return {
        logicalType: "integer",
        kind: "integer",
        bitWidth: type.bitWidth,
      };
    case "Float":
      return { logicalType: "float64", kind: "float" };
    case "Decimal":
      return {
        logicalType: "decimal",
        kind: "decimal",
        precision: type.precision,
        scale: type.scale,
        bitWidth: type.bitWidth,
      };
    case "Date":
      return { logicalType: "date_utc", kind: "date", unit: type.unit };
    case "Timestamp":
      return {
        logicalType: "timestamp_utc_ms",
        kind: "timestamp",
        unit: type.unit,
        timezone: type.timezone,
      };
    default:
      return null;
  }
}

function scalar(value, descriptor) {
  if (value == null) return null;
  if (!descriptor) return undefined;
  if (descriptor.kind === "boolean") {
    return typeof value === "boolean" ? value : undefined;
  }
  if (descriptor.kind === "utf8") {
    return typeof value === "string" ? value : undefined;
  }
  if (descriptor.kind === "integer") {
    if (typeof value === "bigint") {
      return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
          value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : undefined;
    }
    return typeof value === "number" && Number.isSafeInteger(value)
      ? value
      : undefined;
  }
  if (descriptor.kind === "float") {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }
  if (descriptor.kind === "decimal") {
    return canonicalDecimal(value, descriptor.scale);
  }
  if (descriptor.kind === "date") {
    return typeof value === "number" && Number.isSafeInteger(value) &&
        Number.isFinite(value)
      ? utcDate(value)
      : undefined;
  }
  if (descriptor.kind === "timestamp") {
    return typeof value === "number" && Number.isSafeInteger(value) &&
        Number.isFinite(value)
      ? value
      : undefined;
  }
  return undefined;
}

function canonicalDecimal(value, scale) {
  // Arrow decimal vectors expose either BigInt or Arrow BigNum words.  A JS
  // number is deliberately rejected: it has already lost decimal precision.
  const raw = typeof value === "bigint"
    ? value.toString()
    : value?.[Symbol.for("isArrowBigNum")] === true &&
        typeof value.toString === "function"
    ? value.toString()
    : null;
  if (
    raw == null || !/^-?\d+$/.test(raw) || !Number.isSafeInteger(scale) ||
    scale < -38 || scale > 38
  ) return undefined;
  const negative = raw.startsWith("-");
  let digits = raw.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  const sign = negative && digits !== "0" ? "-" : "";
  if (scale < 0) return `${sign}${digits}${"0".repeat(-scale)}`;
  if (scale === 0) return `${sign}${digits}`;
  digits = digits.padStart(scale + 1, "0");
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function utcDate(milliseconds) {
  const value = new Date(milliseconds);
  return Number.isNaN(value.getTime())
    ? undefined
    : value.toISOString().slice(0, 10);
}
function send(value) {
  process.send?.(value);
}
function close() {
  phase = "closed";
  try {
    connection?.close();
    database?.reset();
  } finally {
    process.exit(0);
  }
}
function terminateClosed() {
  if (phase === "closed") return;
  phase = "closed";
  try {
    connection?.close();
    database?.reset();
  } finally {
    process.exit(1);
  }
}
function canonicalJson(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${
    Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")
  }}`;
}
function exactKeys(value, keys) {
  return value != null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function token(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}
function parameterName(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}
function sourceScope(value) {
  return exactKeys(value, ["scopeKey", "projection", "storage"]) &&
    typeof value.scopeKey === "string" &&
    /^analytics-scope_[A-Za-z0-9_-]{1,184}$/.test(value.scopeKey) &&
    value.projection === "tool_execution_fact_v1" &&
    value.storage === "plugin-owned-sqlite";
}
function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function optionalInteger(value, minimum, maximum) {
  return value === null || integer(value, minimum, maximum);
}
function range(value) {
  return exactKeys(value, ["startInclusiveMs", "endExclusiveMs"]) &&
    integer(value.startInclusiveMs, 0, Number.MAX_SAFE_INTEGER) &&
    integer(value.endExclusiveMs, 0, Number.MAX_SAFE_INTEGER) &&
    value.endExclusiveMs > value.startInclusiveMs;
}
function isSource(value) {
  const nodeSqlite = exactKeys(value, [
    "kind",
    "sourceScope",
    "snapshotId",
    "sourceGeneration",
    "factProjectionVersion",
    "readonlyDatabasePath",
    "maxChunkBytes",
    "maxRowsPerChunk",
  ]) && value.kind === "node-sqlite-readonly" &&
    typeof value.readonlyDatabasePath === "string" &&
    value.readonlyDatabasePath.startsWith("/") &&
    Buffer.byteLength(value.readonlyDatabasePath) <= 4096 &&
    !value.readonlyDatabasePath.includes("\0");
  const stream = exactKeys(value, [
    "kind",
    "sourceScope",
    "snapshotId",
    "sourceGeneration",
    "factProjectionVersion",
    "maxChunkBytes",
    "maxRowsPerChunk",
  ]) && value.kind === "generation-checked-stream";
  return (nodeSqlite || stream) && sourceScope(value.sourceScope) &&
    typeof value.snapshotId === "string" &&
    /^analytics-snapshot_[A-Za-z0-9_-]{1,181}$/.test(value.snapshotId) &&
    integer(value.sourceGeneration, 0, Number.MAX_SAFE_INTEGER) &&
    integer(value.factProjectionVersion, 1, Number.MAX_SAFE_INTEGER) &&
    integer(value.maxChunkBytes, 1, 256 * 1024) &&
    integer(value.maxRowsPerChunk, 1, 1_000);
}
function isSnapshot(value) {
  if (
    !exactKeys(value, [
      "version",
      "snapshotId",
      "sourceScope",
      "frozenRange",
      "capturedAtMs",
      "coverage",
    ]) || value.version !== 2 ||
    typeof value.snapshotId !== "string" ||
    !/^analytics-snapshot_[A-Za-z0-9_-]{1,181}$/.test(value.snapshotId) ||
    !sourceScope(value.sourceScope) || !range(value.frozenRange) ||
    !integer(value.capturedAtMs, 0, Number.MAX_SAFE_INTEGER)
  ) return false;
  const coverage = value.coverage;
  if (
    !exactKeys(coverage, [
      "coverageRevision",
      "retention",
      "observed",
      "population",
      "mode",
      "incompleteReasons",
      "backfill",
      "reconciliation",
      "degraded",
    ]) || !integer(coverage.coverageRevision, 0, Number.MAX_SAFE_INTEGER) ||
    !isRetention(coverage.retention) || !isObserved(coverage.observed) ||
    !isPopulation(coverage.population) || !isBackfill(coverage.backfill) ||
    !isReconciliation(coverage.reconciliation) ||
    typeof coverage.degraded !== "boolean" ||
    ![
      "complete-retained-projection",
      "partial-retained-projection",
      "degraded-observed",
    ].includes(coverage.mode) ||
    !Array.isArray(coverage.incompleteReasons) ||
    coverage.incompleteReasons.length > 7 ||
    !coverage.incompleteReasons.every((reason) =>
      [
        "range-precedes-earliest-verified-retained",
        "backfill-in-progress",
        "source-page-cap",
        "thread-event-cap",
        "source-read-failure",
        "reconciliation-pending",
        "retention-boundary-unknown",
      ].includes(reason)
    )
  ) return false;
  return true;
}
function isRetention(value) {
  return exactKeys(value, [
    "startInclusiveMs",
    "earliestVerifiedRetainedInclusiveMs",
    "endExclusiveMs",
    "policyDays",
  ]) &&
    optionalInteger(value.startInclusiveMs, 0, Number.MAX_SAFE_INTEGER) &&
    optionalInteger(
      value.earliestVerifiedRetainedInclusiveMs,
      0,
      Number.MAX_SAFE_INTEGER,
    ) &&
    integer(value.endExclusiveMs, 0, Number.MAX_SAFE_INTEGER) &&
    value.policyDays === 90;
}
function isObserved(value) {
  return exactKeys(value, [
    "earliestFactMs",
    "latestFactMs",
    "asOfMs",
    "projectionGeneration",
    "projectionRevision",
  ]) &&
    optionalInteger(value.earliestFactMs, 0, Number.MAX_SAFE_INTEGER) &&
    optionalInteger(value.latestFactMs, 0, Number.MAX_SAFE_INTEGER) &&
    integer(value.asOfMs, 0, Number.MAX_SAFE_INTEGER) &&
    integer(value.projectionGeneration, 0, Number.MAX_SAFE_INTEGER) &&
    typeof value.projectionRevision === "string" &&
    /^[0-9a-f]{64}$/.test(value.projectionRevision);
}
function isPopulation(value) {
  const keys = [
    "candidateThreads",
    "selectedThreads",
    "loadedThreads",
    "retainedFacts",
    "cappedThreads",
    "listPages",
    "eventPages",
    "eventBytes",
    "safeFailureCount",
    "lastSafeFailureAtMs",
    "candidateThreadLimit",
    "threadPageLimit",
    "eventPageLimit",
    "maxEventsPerThread",
    "maxEventBytes",
  ];
  return exactKeys(value, keys) &&
    keys.filter((key) => key !== "lastSafeFailureAtMs").every((key) =>
      integer(value[key], 0, Number.MAX_SAFE_INTEGER)
    ) &&
    optionalInteger(value.lastSafeFailureAtMs, 0, Number.MAX_SAFE_INTEGER) &&
    value.candidateThreadLimit > 0 && value.threadPageLimit > 0 &&
    value.eventPageLimit > 0 && value.maxEventsPerThread > 0 &&
    value.maxEventBytes > 0;
}
function isBackfill(value) {
  return exactKeys(value, [
    "state",
    "direction",
    "completeRange",
    "resumable",
  ]) &&
    ["not-requested", "running", "partial", "complete", "failed"].includes(
      value.state,
    ) &&
    value.direction === "newest-to-oldest" &&
    (value.completeRange === null || range(value.completeRange)) &&
    typeof value.resumable === "boolean";
}
function isReconciliation(value) {
  return exactKeys(value, [
    "observedAsOfMs",
    "lastFullReconciliationAtMs",
    "deletionConfirmation",
    "sourceSemantics",
  ]) &&
    integer(value.observedAsOfMs, 0, Number.MAX_SAFE_INTEGER) &&
    optionalInteger(
      value.lastFullReconciliationAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
    ) &&
    ["none", "confirmed", "pending-retry"].includes(
      value.deletionConfirmation,
    ) &&
    value.sourceSemantics === "eventually-reconciled-observed-as-of";
}
function isParameter(value) {
  if (
    !exactKeys(value, ["name", "logicalType", "value"]) ||
    !parameterName(value.name)
  ) return false;
  if (
    value.logicalType === "integer" || value.logicalType === "timestamp_utc_ms"
  ) return Number.isSafeInteger(value.value);
  if (value.logicalType === "float64") {
    return typeof value.value === "number" && Number.isFinite(value.value);
  }
  if (value.logicalType === "boolean") return typeof value.value === "boolean";
  if (value.logicalType === "utf8") {
    return typeof value.value === "string" &&
      Buffer.byteLength(value.value) <= 2_000;
  }
  if (value.logicalType === "date_utc") {
    return typeof value.value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value.value);
  }
  if (value.logicalType === "decimal") {
    return typeof value.value === "string" &&
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.value);
  }
  return value.logicalType === "null" && value.value === null;
}
function isAdmission(value, maxAstNodes) {
  return exactKeys(value, [
    "astPolicyRevision",
    "astNodeCount",
    "sqlSha256",
    "parameterDeclarationDigest",
    "cacheability",
  ]) &&
    typeof value.astPolicyRevision === "string" &&
    /^[0-9a-f]{64}$/.test(value.astPolicyRevision) &&
    integer(value.astNodeCount, 1, maxAstNodes) &&
    typeof value.sqlSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sqlSha256) &&
    typeof value.parameterDeclarationDigest === "string" &&
    /^[0-9a-f]{64}$/.test(value.parameterDeclarationDigest) &&
    (value.cacheability === "stable" ||
      value.cacheability === "volatile-uncacheable");
}
function isLimits(value) {
  return exactKeys(value, [
    "maxAstNodes",
    "maxColumns",
    "maxRows",
    "maxCells",
    "maxCellStringBytes",
    "maxCanonicalResultBytes",
    "maxTransferChunkBytes",
    "maxTransferRowsPerChunk",
    "materializationDeadlineMs",
  ]) &&
    integer(value.maxAstNodes, 1, 4_096) && integer(value.maxColumns, 1, 64) &&
    integer(value.maxRows, 1, 500) && integer(value.maxCells, 1, 32_000) &&
    integer(value.maxCellStringBytes, 1, 2_000) &&
    integer(value.maxCanonicalResultBytes, 1, 4 * 1024 * 1024) &&
    integer(value.maxTransferChunkBytes, 1, 256 * 1024) &&
    integer(value.maxTransferRowsPerChunk, 1, 1_000) &&
    integer(value.materializationDeadlineMs, 1, 5_000);
}
function isBootstrap(value) {
  return exactKeys(value, [
    "kind",
    "databaseMemoryLimitBytes",
    "maxResultBytes",
  ]) && value.kind === "bootstrap" &&
    integer(value.databaseMemoryLimitBytes, 1, 256 * 1024 * 1024) &&
    integer(value.maxResultBytes, 1, 4 * 1024 * 1024);
}
function isPrepare(value) {
  return exactKeys(value, [
    "kind",
    "token",
    "source",
    "snapshot",
    "sql",
    "parameters",
    "cacheability",
    "maxRows",
    "limits",
    "testMaterializationCheckpoint",
    "admission",
  ]) && value.kind === "prepare" && token(value.token) &&
    typeof value.sql === "string" && Buffer.byteLength(value.sql) > 0 &&
    Buffer.byteLength(value.sql) <= 16_384 &&
    Array.isArray(value.parameters) && value.parameters.length <= 32 &&
    value.parameters.every(isParameter) &&
    new Set(value.parameters.map((parameter) => parameter.name)).size ===
      value.parameters.length &&
    Buffer.byteLength(canonicalJson(value.parameters)) <= 32 * 1024 &&
    isSource(value.source) && isSnapshot(value.snapshot) &&
    isLimits(value.limits) &&
    integer(value.maxRows, 1, 500) &&
    value.maxRows <= value.limits.maxRows &&
    value.source.maxChunkBytes <= value.limits.maxTransferChunkBytes &&
    value.source.maxRowsPerChunk <= value.limits.maxTransferRowsPerChunk &&
    bootstrapMaxResultBytes != null &&
    value.limits.maxCanonicalResultBytes <= bootstrapMaxResultBytes &&
    isAdmission(value.admission, value.limits.maxAstNodes) &&
    typeof value.testMaterializationCheckpoint === "boolean" &&
    (value.cacheability === "stable" ||
      value.cacheability === "volatile-uncacheable");
}
function isAdmit(value) {
  return exactKeys(value, [
    "kind",
    "token",
    "sql",
    "parameters",
    "cacheability",
    "maxAstNodes",
  ]) && value.kind === "admit" && token(value.token) &&
    typeof value.sql === "string" && Buffer.byteLength(value.sql) > 0 &&
    Buffer.byteLength(value.sql) <= 16_384 &&
    Array.isArray(value.parameters) && value.parameters.length <= 32 &&
    value.parameters.every(isParameter) &&
    new Set(value.parameters.map((parameter) => parameter.name)).size ===
      value.parameters.length &&
    Buffer.byteLength(canonicalJson(value.parameters)) <= 32 * 1024 &&
    integer(value.maxAstNodes, 1, 4_096) &&
    (value.cacheability === "stable" ||
      value.cacheability === "volatile-uncacheable");
}
function isContinue(value) {
  return exactKeys(value, ["kind", "token"]) && value.kind === "continue" &&
    token(value.token);
}
function isCommitMaterialization(value) {
  return exactKeys(value, ["kind", "token"]) &&
    value.kind === "commit-materialization" && token(value.token);
}
function isClose(value) {
  return exactKeys(value, ["kind"]) && value.kind === "close";
}
