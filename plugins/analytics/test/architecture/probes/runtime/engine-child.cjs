"use strict";

// Invoked only by probe.mjs. It never reads Analytics data: every fact is
// generated inside the engine and every result is aggregate-only.
const { performance } = require("node:perf_hooks");
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");

const engine = process.env.ANALYTICS_RUNTIME_PROBE_ENGINE;
const mode = process.env.ANALYTICS_RUNTIME_PROBE_MODE || "measure";
const wasmModule = process.env.ANALYTICS_RUNTIME_PROBE_WASM_MODULE;
const wasmMvp = process.env.ANALYTICS_RUNTIME_PROBE_WASM_MVP;
const wasmEh = process.env.ANALYTICS_RUNTIME_PROBE_WASM_EH;
const nativeModule = process.env.ANALYTICS_RUNTIME_PROBE_NATIVE_MODULE;
const nodeApiModule = process.env.ANALYTICS_RUNTIME_PROBE_NODE_API_MODULE;
const factCount = Number(process.env.ANALYTICS_RUNTIME_PROBE_FACTS || "25000");
const bootstrapRepository = process.env.ANALYTICS_RUNTIME_PROBE_BOOTSTRAP_REPOSITORY ?? null;

function serializableError(error) {
  return error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 400) : String(error).slice(0, 400);
}
function procLines(path, names) {
  const wanted = new Set(names);
  return Object.fromEntries(readFileSync(path, "utf8").split("\n").map((line) => line.split(/:\s+|\s{2,}/)).filter(([key]) => wanted.has(key)).map(([key, value]) => [key, value]));
}
function procLimits() {
  const wanted = new Set(["Max cpu time", "Max address space"]);
  return Object.fromEntries(readFileSync("/proc/self/limits", "utf8").split("\n").map((line) => {
    const match = line.match(/^(.{25})\s+(\S+)\s+(\S+)\s+(\S.*)$/);
    return match == null ? null : [match[1].trim(), { soft: match[2], hard: match[3], units: match[4].trim() }];
  }).filter((entry) => entry != null && wanted.has(entry[0])));
}
function processEnvelope() {
  return { memory: procLines("/proc/self/status", ["VmSize", "VmRSS"]), limits: procLimits() };
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? null;
}

async function wasm() {
  const duckdb = require(wasmModule);
  const mappingCapture = [];
  const mappingSentinel = "ANALYTICS_RUNTIME_PROBE_TWO_ARGUMENT_CAPTURE_DENY";
  const mappingMode = mode === "wasm-url-mapping";
  const runtime = mappingMode ? {
    ...duckdb.NODE_RUNTIME,
    whereToLoad(filename, url) {
      mappingCapture.push({
        filename: String(filename).slice(0, 256),
        url: String(url).slice(0, 2_048),
      });
      throw new Error(mappingSentinel);
    },
  } : duckdb.NODE_RUNTIME;
  const database = await duckdb.createDuckDB({
    mvp: { mainModule: wasmMvp },
    eh: { mainModule: wasmEh },
  }, new duckdb.VoidLogger(), runtime);
  const startupStarted = performance.now();
  await database.instantiate();
  database.open({ path: ":memory:", maximumThreads: 1, allowUnsignedExtensions: false });
  const connection = database.connect();
  const loopbackBootstrap = mode === "wasm-json-bootstrap";
  const directTrustedBootstrap = mode === "wasm-trusted-json-bootstrap";
  const trustedExternalAccessBeforeLoad = process.env.ANALYTICS_RUNTIME_PROBE_TRUSTED_EXTERNAL_BEFORE_LOAD === "true";
  const trustedBootstrap = loopbackBootstrap || directTrustedBootstrap;
  if (loopbackBootstrap) {
    if (bootstrapRepository == null || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(bootstrapRepository)) {
      throw new Error("Trusted bootstrap requires a loopback-only repository URL.");
    }
    // These are set before the sole future trusted core-extension load. The
    // repository is still needed for that load, so external access is disabled
    // only after it; no authored statement is present at either point.
    await connection.query("SET autoinstall_known_extensions = false");
    await connection.query("SET autoload_known_extensions = false");
    await connection.query("SET allow_community_extensions = false");
    // This is probe-owned trusted bootstrap SQL. No bundle SQL is present or
    // interpolated here; the only variable is the parent-created loopback URL.
    await connection.query(`SET custom_extension_repository = '${bootstrapRepository.replace(/'/g, "''")}'`);
    await connection.query("LOAD json");
    await connection.query("SET enable_external_access = false");
    await connection.query("SET lock_configuration = true");
  }
  // These controls are deliberately set before any authored query. They are
  // defense-in-depth and scratch hygiene, not a claim of OS containment.
  if (!loopbackBootstrap) {
    await connection.query("SET autoinstall_known_extensions = false");
    await connection.query("SET autoload_known_extensions = false");
    await connection.query("SET allow_community_extensions = false");
    // The fixed URL-mapping diagnostic throws before the generated loader's
    // cache/fetch callback. External access stays at its default only there so
    // the engine reaches that pre-I/O hook; it is not an externally enabled
    // runtime configuration.
    if (!mappingMode && (!directTrustedBootstrap || !trustedExternalAccessBeforeLoad)) await connection.query("SET enable_external_access = false");
  }
  return {
    close() {
      connection.close();
      database.reset();
    },
    execute(sql, parameters = []) {
      if (parameters.length === 0) return connection.query(sql);
      const statement = connection.prepare(sql);
      try {
        return statement.query(...parameters);
      } finally {
        statement.close();
      }
    },
    startupMs: performance.now() - startupStarted,
    parserTree: {
      status: "unsupported",
      reason: "No direct JavaScript parse method was found. Static artifacts contain json_serialize_sql, but that fixed-query function has not been executed in the approved batch.",
    },
    packageVersion: duckdb.PACKAGE_VERSION,
    trustedBootstrap,
    mappingCapture,
    mappingSentinel,
    mappingMode,
  };
}

async function native() {
  const duckdb = require(nativeModule);
  const startupStarted = performance.now();
  const database = new duckdb.Database(":memory:", {
    threads: "1",
    extension_directory: process.env.ANALYTICS_RUNTIME_PROBE_EXTENSION_DIR,
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
    enable_external_access: "false",
  });
  const run = (sql, parameters = []) => new Promise((resolve, reject) => {
    database.all(sql, ...parameters, (error, rows) => error == null ? resolve(rows) : reject(error));
  });
  // The constructor returns before the binding is necessarily ready; a fixed
  // harmless query makes this a usable-ready timing rather than constructor
  // allocation timing.
  await run("SELECT 1");
  return {
    close() {
      database.close();
    },
    execute: run,
    startupMs: performance.now() - startupStarted,
    parserTree: {
      status: "unsupported",
      reason: "No direct JavaScript parse method was found. Installed native source includes json_serialize_sql, but that fixed-query function has not been executed in the approved batch.",
    },
    packageVersion: require(`${nativeModule}/package.json`).version,
  };
}

async function nodeApi() {
  const duckdb = require(nodeApiModule);
  const startupStarted = performance.now();
  const instance = await duckdb.DuckDBInstance.create(":memory:", {
    threads: "1", extension_directory: process.env.ANALYTICS_RUNTIME_PROBE_EXTENSION_DIR,
    autoinstall_known_extensions: "false", autoload_known_extensions: "false", enable_external_access: "false",
  });
  const connection = await instance.connect();
  await connection.run("SELECT 1");
  return {
    close() { connection.closeSync(); instance.closeSync(); },
    async execute(sql, parameters = []) {
      const reader = await connection.runAndReadAll(sql, parameters);
      return reader.getRowObjectsJS();
    },
    async extractFixedSelect() { return (await connection.extractStatements("SELECT 1")).count; },
    startupMs: performance.now() - startupStarted,
    parserTree: { status: "unsupported", reason: "Node API exposes extracted-statement count; AST tree requires the fixed JSON serialization control." },
    packageVersion: require(`${nodeApiModule}/package.json`).version,
  };
}

async function expectAllowed(engineHandle, capability, sql) {
  try {
    await engineHandle.execute(sql);
    return { capability, status: "observed", detail: "accepted" };
  } catch (error) {
    return { capability, status: "failure", detail: serializableError(error) };
  }
}

function rowCount(result) {
  if (Array.isArray(result)) return result.length;
  if (result != null && typeof result.numRows === "number") return result.numRows;
  if (result != null && typeof result.numRows === "bigint") return Number(result.numRows);
  return null;
}

function firstField(result, name) {
  const rows = objectRows(result);
  const value = rows[0]?.[name];
  return typeof value === "string" ? value : value?.toString?.();
}
function objectRows(result) {
  return Array.isArray(result) ? result : typeof result?.toArray === "function" ? result.toArray() : [];
}

async function verifyFixedSerializedSelect(engineHandle) {
  try {
    const result = await engineHandle.execute("SELECT json_serialize_sql('SELECT 1') AS serialized");
    const serialized = firstField(result, "serialized");
    const tree = typeof serialized === "string" ? JSON.parse(serialized) : null;
    const valid = tree?.error === false
      && Array.isArray(tree.statements)
      && tree.statements.length === 1
      && tree.statements[0] != null
      && tree.statements[0].node?.type === "SELECT_NODE";
    return {
      capability: "json-serialize-fixed-select",
      status: valid ? "observed" : "failure",
      detail: valid ? "error=false with one SELECT_NODE statement" : "returned JSON did not match the expected non-error single-SELECT_NODE tree shape",
    };
  } catch (error) {
    const detail = serializableError(error);
    return { capability: "json-serialize-fixed-select", status: /not in the catalog.*json extension/i.test(detail) ? "unsupported" : "failure", detail };
  }
}

function compatibilityInputs(builtins) {
  return [
    ...builtins.map((sql, index) => [`builtin-${index + 1}`, sql]),
    ["nested-catalog", "SELECT coalesce((SELECT count(*) FROM information_schema.tables), 0) AS n FROM tool_execution_fact_v1"],
    ["range-table-function", "SELECT count(*) AS n FROM range(10)"],
    ["comma-join", "SELECT count(*) AS n FROM tool_execution_fact_v1, range(1) AS r(i)"],
    ["cte", "WITH x AS (SELECT 1 AS n) SELECT n FROM x"],
    ["named-parameter", "SELECT $range_days AS n"],
  ];
}

async function serializeCompatibilityInputs(engineHandle, builtins) {
  const metadata = [];
  for (const [id, sql] of compatibilityInputs(builtins)) {
    const result = await engineHandle.execute("SELECT json_serialize_sql(CAST(? AS VARCHAR)) AS serialized", [sql]);
    const serialized = firstField(result, "serialized");
    const tree = typeof serialized === "string" ? JSON.parse(serialized) : null;
    const statement = tree?.statements?.[0];
    const families = new Set(); const relationNodes = []; const parameterNodes = []; const cteDeclarations = [];
    const declarationName = (key) => typeof key === "string" ? key : key?.alias ?? key?.cte_name ?? key?.name ?? null;
    const walk = (value, path = "$") => { if (value != null && typeof value === "object") { if (typeof value.type === "string") { families.add(value.type); if (["BASE_TABLE", "TABLE_FUNCTION"].includes(value.type)) relationNodes.push({ type: value.type, schema_name: value.schema_name ?? null, table_name: value.table_name ?? null, function_name: value.function_name ?? value.function?.name ?? value.function?.function_name ?? value.name ?? null, fields: Object.keys(value).sort().slice(0, 16) }); if (value.type === "VALUE_PARAMETER") parameterNodes.push({ type: value.type, identifier: value.identifier ?? value.parameter_name ?? value.name ?? null }); } if (Array.isArray(value.map) && path.endsWith(".cte_map")) { value.map.forEach((entry, index) => { const queryNode = entry?.value?.query?.node ?? entry?.value?.query?.query?.node ?? null; cteDeclarations.push({ path: `${path}.map[${index}]`, entryFields: entry != null && typeof entry === "object" ? Object.keys(entry).sort() : [], keyFields: entry?.key != null && typeof entry.key === "object" ? Object.keys(entry.key).sort() : [], valueFields: entry?.value != null && typeof entry.value === "object" ? Object.keys(entry.value).sort() : [], name: declarationName(entry?.key), queryNodeType: queryNode?.type ?? null }); }); } for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`); } };
    walk(statement);
    const catalog = relationNodes.some((node) => node.type === "BASE_TABLE" && node.schema_name === "information_schema" && node.table_name === "tables");
    const range = relationNodes.some((node) => node.type === "TABLE_FUNCTION" && node.function_name === "range");
    const baseFact = relationNodes.some((node) => node.type === "BASE_TABLE" && node.table_name === "tool_execution_fact_v1");
    const parameter = parameterNodes.some((node) => node.identifier === "range_days");
    const cte = cteDeclarations.some((declaration) => declaration.name === "x" && declaration.queryNodeType === "SELECT_NODE")
      && relationNodes.some((node) => node.type === "BASE_TABLE" && node.table_name === "x");
    const valid = tree?.error === false && tree.statements?.length === 1 && statement?.node?.type === "SELECT_NODE";
    metadata.push({ id, sha256: createHash("sha256").update(sql).digest("hex"), length: sql.length, status: valid ? "observed" : "failure", statementCount: Array.isArray(tree?.statements) ? tree.statements.length : null, nodeType: statement?.node?.type ?? null, nodeFamilies: [...families].sort(), relationNodes: relationNodes.slice(0, 8), parameterNodes: parameterNodes.slice(0, 4), cteDeclarations: id === "cte" ? cteDeclarations.slice(0, 4) : undefined, hasCatalogRelation: id === "nested-catalog" ? catalog : undefined, hasRangeFunction: id === "range-table-function" ? range : undefined, hasCommaJoinBoth: id === "comma-join" ? baseFact && range : undefined, hasCte: id === "cte" ? cte : undefined, hasNamedParameter: id === "named-parameter" ? parameter : undefined });
  }
  return metadata;
}

async function main() {
  if (!["wasm", "native", "node-api"].includes(engine)) throw new Error("Unknown runtime probe engine.");
  const runtime = engine === "wasm" ? await wasm() : engine === "native" ? await native() : await nodeApi();
  try {
    const readyEnvelope = processEnvelope();
    if (mode === "wasm-metadata") {
      if (engine !== "wasm") throw new Error("Wasm metadata mode requires the Wasm engine.");
      const [versionRows, pragmaVersionRows, platformRows] = await Promise.all([
        runtime.execute("SELECT version() AS library_version"),
        runtime.execute("SELECT * FROM pragma_version()"),
        runtime.execute("SELECT * FROM pragma_platform()"),
      ]);
      process.stdout.write(`${JSON.stringify({
        engine,
        packageVersion: runtime.packageVersion,
        metadata: {
          version: objectRows(versionRows)[0] ?? null,
          pragmaVersion: objectRows(pragmaVersionRows)[0] ?? null,
          platform: objectRows(platformRows)[0] ?? null,
        },
        readyEnvelope,
      })}\n`);
      return;
    }
    if (mode === "wasm-extension-metadata") {
      if (engine !== "wasm") throw new Error("Wasm extension metadata mode requires the Wasm engine.");
      const rows = await runtime.execute("SELECT extension_name, install_path FROM duckdb_extensions() WHERE extension_name = 'json'");
      const json = objectRows(rows)[0] ?? null;
      const valid = json != null && json.extension_name === "json" && (typeof json.install_path === "string" || json.install_path == null);
      process.stdout.write(`${JSON.stringify({
        engine,
        packageVersion: runtime.packageVersion,
        extension: valid ? { extensionName: json.extension_name, installPath: json.install_path ?? null } : null,
        rowCount: objectRows(rows).length,
        readyEnvelope,
      })}\n`);
      return;
    }
    if (mode === "wasm-url-mapping") {
      if (engine !== "wasm") throw new Error("Wasm URL mapping mode requires the Wasm engine.");
      const settingsRows = await runtime.execute("SELECT current_setting('autoinstall_known_extensions') AS autoinstall, current_setting('autoload_known_extensions') AS autoload, current_setting('allow_community_extensions') AS community, current_setting('enable_external_access') AS external_access");
      const settings = objectRows(settingsRows)[0] ?? null;
      const controlsValid = settings?.autoinstall === false
        && settings.autoload === false
        && settings.community === false
        && settings.external_access === true;
      if (!controlsValid) {
        process.stdout.write(`${JSON.stringify({ engine, packageVersion: runtime.packageVersion, capture: { status: "failure", reason: "Required pre-I/O mapping controls were not effective.", settings } })}\n`);
        process.exitCode = 1;
        return;
      }
      let loadError = null;
      try {
        // The scratch-cloned loader passes both fixed engine strings to the
        // hook, which throws before its cache and worker_threads/fetch code.
        await runtime.execute("LOAD json");
      } catch (error) {
        loadError = serializableError(error);
      }
      const hookObserved = runtime.mappingCapture.length === 1;
      const sentinelObserved = loadError != null && loadError.includes(runtime.mappingSentinel);
      const values = hookObserved ? runtime.mappingCapture[0] : null;
      const urlMatch = typeof values?.url === "string"
        ? values.url.match(/^https:\/\/extensions\.duckdb\.org\/duckdb-wasm\/([^/]+)\/([^/]+)\/json\.duckdb_extension\.wasm$/)
        : null;
      process.stdout.write(`${JSON.stringify({
        engine,
        packageVersion: runtime.packageVersion,
        capture: {
          status: hookObserved && sentinelObserved ? "observed" : "failure",
          hookCalls: runtime.mappingCapture.length,
          filename: values?.filename ?? null,
          url: values?.url ?? null,
          filenameShape: values?.filename === "json" ? "extension-name" : values?.filename == null ? "missing" : "other",
          urlShape: urlMatch == null ? values?.url == null ? "missing" : "other" : "full-wasm-extension-url",
          resolvedDirectory: urlMatch?.[1] ?? null,
          resolvedPlatform: urlMatch?.[2] ?? null,
          sentinelObserved,
          loadReturned: loadError == null,
          loadError,
          settings,
        },
        readyEnvelope,
      })}\n`);
      if (!hookObserved || !sentinelObserved) process.exitCode = 1;
      return;
    }
    if (mode === "wasm-trusted-json-bootstrap") {
      if (engine !== "wasm") throw new Error("Trusted JSON bootstrap mode requires the Wasm engine.");
      const externalBeforeLoad = process.env.ANALYTICS_RUNTIME_PROBE_TRUSTED_EXTERNAL_BEFORE_LOAD === "true";
      const readSettings = async () => {
        const rows = await runtime.execute("SELECT current_setting('autoinstall_known_extensions') AS autoinstall, current_setting('autoload_known_extensions') AS autoload, current_setting('allow_community_extensions') AS community, current_setting('allow_unsigned_extensions') AS unsigned, current_setting('enable_external_access') AS external_access, current_setting('lock_configuration') AS locked");
        return objectRows(rows)[0] ?? null;
      };
      const readJsonExtension = async () => {
        const rows = await runtime.execute("SELECT * FROM duckdb_extensions() WHERE extension_name = 'json'");
        const row = objectRows(rows)[0] ?? null;
        return row;
      };
      const beforeSettings = await readSettings();
      const beforeExtension = await readJsonExtension();
      const beforeValid = beforeSettings?.autoinstall === false
        && beforeSettings.autoload === false
        && beforeSettings.community === false
        && beforeSettings.unsigned === false
        && beforeSettings.external_access === externalBeforeLoad;
      if (!beforeValid) {
        process.stdout.write(`${JSON.stringify({ engine, packageVersion: runtime.packageVersion, bootstrap: { status: "failure", reason: "Required trusted-bootstrap controls were not effective before LOAD.", beforeSettings, beforeExtension } })}\n`);
        process.exitCode = 1;
        return;
      }
      let loadReturn = null;
      let loadError = null;
      try {
        const result = await runtime.execute("LOAD json");
        loadReturn = { status: "returned", rowCount: rowCount(result) };
      } catch (error) {
        loadError = serializableError(error);
      }
      let lockdownError = null;
      try {
        await runtime.execute("SET enable_external_access = false");
        await runtime.execute("SET lock_configuration = true");
      } catch (error) {
        lockdownError = serializableError(error);
      }
      const afterSettings = await readSettings();
      const afterExtension = await readJsonExtension();
      const lockdownValid = lockdownError == null
        && afterSettings?.autoinstall === false
        && afterSettings.autoload === false
        && afterSettings.community === false
        && afterSettings.unsigned === false
        && afterSettings.external_access === false
        && afterSettings.locked === true;
      let parser = { status: "not-run", detail: "LOAD or post-LOAD lockdown did not complete." };
      if (loadError == null && lockdownValid) {
        try {
          const result = await runtime.execute("SELECT json_serialize_sql(CAST(? AS VARCHAR)) AS serialized", ["SELECT 1"]);
          const serialized = firstField(result, "serialized");
          const tree = typeof serialized === "string" ? JSON.parse(serialized) : null;
          const valid = tree?.error === false
            && Array.isArray(tree.statements)
            && tree.statements.length === 1
            && tree.statements[0]?.node?.type === "SELECT_NODE";
          parser = { status: valid ? "observed" : "failure", detail: valid ? "error=false with one SELECT_NODE statement" : "returned JSON did not match the expected non-error single-SELECT_NODE tree shape" };
        } catch (error) {
          parser = { status: "failure", detail: serializableError(error) };
        }
      }
      const builtins = JSON.parse(process.env.ANALYTICS_RUNTIME_PROBE_BUILTIN_SQL ?? "[]");
      let parserCompatibility = { status: "not-run", detail: "LOAD or post-LOAD lockdown did not complete." };
      if (loadError == null && lockdownValid) {
        if (builtins.length !== 11 || builtins.some((sql) => typeof sql !== "string" || sql.length > 16_384 || sql.includes("${"))) {
          parserCompatibility = { status: "failure", detail: "Expected 11 bounded non-interpolated built-in SQL strings." };
        } else {
          try {
            const inputs = await serializeCompatibilityInputs(runtime, builtins);
            parserCompatibility = { status: inputs.every((input) => input.status === "observed") ? "observed" : "failure", inputs };
          } catch (error) {
            parserCompatibility = { status: "failure", detail: serializableError(error) };
          }
        }
      }
      const bootstrapObserved = loadError == null && lockdownValid && parser.status === "observed" && parserCompatibility.status === "observed";
      process.stdout.write(`${JSON.stringify({
        engine,
        packageVersion: runtime.packageVersion,
        bootstrap: {
          status: bootstrapObserved ? "observed" : "failure",
          beforeSettings,
          trustedExternalAccessBeforeLoad: externalBeforeLoad,
          beforeExtension,
          loadReturn,
          loadError,
          lockdownError,
          afterSettings,
          afterExtension,
          lockdownValid,
          parser,
          parserCompatibility,
        },
        readyEnvelope,
      })}\n`);
      if (!bootstrapObserved) process.exitCode = 1;
      return;
    }
    if (mode === "parser-only" || mode === "wasm-json-bootstrap") {
      const bootstrapSettings = mode === "wasm-json-bootstrap"
        ? await runtime.execute("SELECT current_setting('autoinstall_known_extensions') AS autoinstall, current_setting('autoload_known_extensions') AS autoload, current_setting('allow_community_extensions') AS community, current_setting('enable_external_access') AS external_access, current_setting('lock_configuration') AS locked")
        : null;
      const bootstrapValues = bootstrapSettings == null ? null : objectRows(bootstrapSettings)[0] ?? null;
      const bootstrap = bootstrapValues == null ? null : {
        status: bootstrapValues.autoinstall === "false"
          && bootstrapValues.autoload === "false"
          && bootstrapValues.community === "false"
          && bootstrapValues.external_access === "false"
          && bootstrapValues.locked === "true" ? "observed" : "failure",
        settings: {
          autoinstallDisabled: bootstrapValues.autoinstall === "false",
          autoloadDisabled: bootstrapValues.autoload === "false",
          communityDisabled: bootstrapValues.community === "false",
          externalAccessDisabled: bootstrapValues.external_access === "false",
          configurationLocked: bootstrapValues.locked === "true",
        },
      };
      const fixedSerializedSelect = mode === "wasm-json-bootstrap" ? await verifyFixedSerializedSelect(runtime) : null;
      const builtins = JSON.parse(process.env.ANALYTICS_RUNTIME_PROBE_BUILTIN_SQL ?? "[]");
      const metadata = await serializeCompatibilityInputs(runtime, builtins);
      process.stdout.write(`${JSON.stringify({ engine, packageVersion: runtime.packageVersion, parserOnly: metadata, fixedSerializedSelect, bootstrap, readyEnvelope })}\n`);
      return;
    }
    if (mode === "hang") {
      process.stdout.write(`${JSON.stringify({ phase: "ready", engine, packageVersion: runtime.packageVersion })}\n`);
      // The parent arms its query deadline only after this dispatch handshake,
      // while preserving startup time separately. It must not report this as
      // cooperative engine cancellation.
      process.stdout.write(`${JSON.stringify({ phase: "query-dispatched" })}\n`);
      await runtime.execute("SELECT sum(random()) FROM range(1000000000)");
      process.stdout.write(`${JSON.stringify({ phase: "unexpected-completion" })}\n`);
      return;
    }

    const setupStarted = performance.now();
    await runtime.execute(`CREATE TABLE facts AS SELECT i AS id, 'cap-' || CAST(i % 8 AS VARCHAR) AS capability, i % 17 AS duration_ms, i % 5 = 0 AS failed FROM range(${factCount}) AS t(i)`);
    const setupMs = performance.now() - setupStarted;
    const setupEnvelope = processEnvelope();
    const warmSamples = [];
    let preparedRows = null;
    for (let index = 0; index < 7; index += 1) {
      const queryStarted = performance.now();
      const rows = await runtime.execute("SELECT capability, count(*) AS n, avg(duration_ms) AS average_duration FROM facts WHERE id >= ? GROUP BY capability ORDER BY capability", [100]);
      warmSamples.push(performance.now() - queryStarted);
        preparedRows = rowCount(rows);
    }
    const cteWindow = await runtime.execute("WITH counts AS (SELECT capability, count(*) AS n FROM facts GROUP BY capability) SELECT capability, n, row_number() OVER (ORDER BY n DESC, capability) AS rank FROM counts ORDER BY rank");

    const memoryLimit = await expectAllowed(runtime, "engine-memory-limit-setting", "SET memory_limit = '16MB'");
    // Do not wrap this with other JSON functions: a no-autoload configuration
    // may deliberately leave those extension functions unavailable. The result
    // itself is never emitted; successful execution is the fixed control.
    const parserSerialization = await verifyFixedSerializedSelect(runtime);
    const parserExtraction = typeof runtime.extractFixedSelect === "function"
      ? await runtime.extractFixedSelect().then((count) => ({ status: count === 1 ? "observed" : "failure", count })).catch((error) => ({ status: "failure", detail: serializableError(error) }))
      : { status: "unsupported" };
    const parserTree = parserSerialization.status === "observed"
      ? { status: "observed", reason: "Fixed json_serialize_sql control returned a non-error tree with one SELECT statement node." }
      : {
        ...runtime.parserTree,
        reason: `Fixed json_serialize_sql control is ${parserSerialization.status}: ${parserSerialization.detail}`,
      };

    process.stdout.write(`${JSON.stringify({
      engine,
      packageVersion: runtime.packageVersion,
      startupMs: runtime.startupMs,
      setupMs,
      facts: factCount,
      preparedSql: { status: preparedRows === 8 ? "observed" : "failure", rows: preparedRows },
      warmQueryMs: { samples: warmSamples, median: median(warmSamples) },
      executionGrammarControl: { status: rowCount(cteWindow) === 8 ? "observed" : "failure", construct: "CTE plus window expression; this is not an AST availability claim" },
      parserTree,
      parserSerialization,
      parserExtraction,
      memoryLimit,
      rssAtMeasurementBytes: process.memoryUsage().rss,
      readyEnvelope,
      setupEnvelope,
    })}\n`);
  } finally {
    runtime.close();
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ status: "failure", error: serializableError(error) })}\n`);
  process.exitCode = 1;
});
