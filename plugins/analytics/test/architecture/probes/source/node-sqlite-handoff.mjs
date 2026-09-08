import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const requireHere = createRequire(import.meta.url);
const PROBE_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE_ROOT = resolve(PROBE_ROOT, "../../../../../../..");
const CHILD_DEADLINE_MS = 10_000;
const KILL_SETTLEMENT_GRACE_MS = 2_000;
const STDOUT_CAP_BYTES = 8_192;
const STDERR_CAP_BYTES = 4_096;

const SOURCE_FILES = {
  pluginStorageContract: "community-plugins/plugins/analytics/types/bb-plugin-sdk.d.ts",
  pluginApi: "fork/build/bb/apps/server/src/services/plugins/plugin-api.ts",
  analyticsServer: "community-plugins/plugins/analytics/server.ts",
  analyticsStore: "community-plugins/plugins/analytics/store.ts",
  betterSqliteTypes: "community-plugins/node_modules/@types/better-sqlite3/index.d.ts",
  betterSqliteRuntime: "community-plugins/node_modules/better-sqlite3/lib/methods/wrappers.js",
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function gitRevision(root) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], {
      timeout: 2_000,
      maxBuffer: 1_024,
    });
    return stdout.trim() || "unavailable";
  } catch {
    return "unavailable";
  }
}

async function sourceIdentity(workspaceRoot) {
  const files = {};
  const missing = [];
  await Promise.all(Object.entries(SOURCE_FILES).map(async ([name, relativePath]) => {
    try {
      const text = await readFile(resolve(workspaceRoot, relativePath), "utf8");
      files[name] = { path: relativePath, sha256: sha256(text), text };
    } catch {
      missing.push(name);
    }
  }));
  return {
    files,
    missing: missing.sort(),
    revisions: {
      workspace: await gitRevision(workspaceRoot),
      fork: await gitRevision(resolve(workspaceRoot, "fork")),
      communityPlugins: await gitRevision(resolve(workspaceRoot, "community-plugins")),
    },
  };
}

function staticChecks(identity) {
  const source = identity.files;
  if (identity.missing.length > 0) return [{
    id: "required-source-identities-available",
    status: "failure",
    detail: `Missing required static source evidence: ${identity.missing.join(", ")}.`,
  }];
  const check = (id, passed, detail) => ({ id, status: passed ? "observed" : "failure", detail });
  return [
    check(
      "public-plugin-storage-is-own-wal-database",
      /plugin's own SQLite database at <dataDir>\/plugins\/<id>\/data\.db[\s\S]*WAL mode, busy_timeout 5000/.test(source.pluginStorageContract.text),
      "The public SDK declaration describes storage.database() as the plugin's own WAL database.",
    ),
    check(
      "host-constructs-plugin-data-db-and-enables-wal",
      /new Database\(join\(dir, "data\.db"\)\)[\s\S]*pragma\("journal_mode = WAL"\)[\s\S]*pragma\("busy_timeout = 5000"\)/.test(source.pluginApi.text),
      "Current host source constructs the plugin data.db path and enables WAL plus a busy timeout.",
    ),
    check(
      "analytics-owns-input-database",
      /const db = bb\.storage\.database\(\)/.test(source.analyticsServer.text)
        && /commitSnapshot\(input: AnalyticsSnapshotCommit\)[\s\S]*this\.db\.transaction/.test(source.analyticsStore.text),
      "Analytics obtains its own SDK database and commits snapshot facts/state in a store transaction.",
    ),
    check(
      "better-sqlite-name-is-publicly-typed",
      /interface Database \{[\s\S]*name: string;/.test(source.betterSqliteTypes.text)
        && /get: function name\(\) \{ return this\[cppdb\]\.name; \}/.test(source.betterSqliteRuntime.text),
      "The returned better-sqlite3 handle exposes a string name property backed by its database handle.",
    ),
  ];
}

function fixtureChild() {
  const nodeSqlite = (() => {
    try { return requireHere("node:sqlite"); } catch { return null; }
  })();
  if (nodeSqlite?.DatabaseSync == null) {
    return { status: "unsupported", reason: "node:sqlite DatabaseSync is unavailable in this Node runtime." };
  }
  const parentScratch = process.env.ANALYTICS_NODE_SQLITE_HANDOFF_SCRATCH ?? null;
  let scratch = null;
  let writer = null;
  let reader = null;
  let nameDb = null;
  let result = null;
  let cleanup = "not-created";
  try {
    scratch = parentScratch ?? mkdtempSync(join(tmpdir(), "analytics-node-sqlite-handoff-"));
    const databasePath = join(scratch, "analytics-own-plugin-fixture.db");
    const { DatabaseSync } = nodeSqlite;
    writer = new DatabaseSync(databasePath);
    writer.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE analytics_index_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation_id INTEGER NOT NULL,
        fact_count INTEGER NOT NULL,
        degraded INTEGER NOT NULL CHECK (degraded IN (0, 1))
      ) STRICT;
      CREATE TABLE tool_execution_facts_v1 (
        source_event_id TEXT PRIMARY KEY NOT NULL,
        sequence INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        capability_key TEXT NOT NULL,
        failed INTEGER NOT NULL CHECK (failed IN (0, 1))
      ) STRICT;
      INSERT INTO analytics_index_state VALUES (1, 7, 2, 0);
      INSERT INTO tool_execution_facts_v1 VALUES
        ('synthetic-one', 1, 1000, 'synthetic', 0),
        ('synthetic-two', 2, 2000, 'synthetic', 1);
    `);
    reader = new DatabaseSync(databasePath, { readOnly: true });
    const readState = reader.prepare("SELECT generation_id, fact_count, degraded FROM analytics_index_state WHERE singleton = 1");
    const readFacts = reader.prepare("SELECT source_event_id, sequence, created_at_ms, capability_key, failed FROM tool_execution_facts_v1 ORDER BY sequence");
    const summarize = () => {
      const state = readState.get();
      const facts = readFacts.all();
      return {
        generation: state?.generation_id ?? null,
        factCount: state?.fact_count ?? null,
        degraded: state?.degraded ?? null,
        rows: facts.length,
        typedColumns: facts.length === 0 ? [] : Object.entries(facts[0]).map(([name, value]) => [name, typeof value]),
      };
    };
    reader.exec("BEGIN");
    const beforeWriterCommit = summarize();
    writer.exec(`
      BEGIN IMMEDIATE;
      UPDATE analytics_index_state SET generation_id = 8, fact_count = 3, degraded = 1 WHERE singleton = 1;
      INSERT INTO tool_execution_facts_v1 VALUES ('synthetic-three', 3, 3000, 'synthetic', 0);
      COMMIT;
    `);
    const whileWriterIsGenerationEight = summarize();
    reader.exec("COMMIT");
    const afterReaderCommit = summarize();
    let readOnlyWriteDenied = false;
    let readOnlyWriteErrorClass = null;
    try {
      reader.exec("INSERT INTO tool_execution_facts_v1 VALUES ('forbidden', 4, 4000, 'synthetic', 0)");
    } catch (error) {
      readOnlyWriteDenied = true;
      readOnlyWriteErrorClass = error?.code ?? error?.name ?? "unknown";
    }
    const betterSqlite3 = requireHere("better-sqlite3");
    const relativeInput = relative(process.cwd(), databasePath);
    nameDb = new betterSqlite3(relativeInput, { readonly: true, fileMustExist: true });
    const resolvedName = resolve(nameDb.name);
    result = {
      status: "observed",
      controls: {
        fixture: "synthetic-own-plugin-shape-only",
        timeoutBudgetMs: CHILD_DEADLINE_MS,
        writerJournal: "wal",
        readerOption: "readOnly:true",
        readerTransaction: "BEGIN then static state SELECT before static fact SELECT",
        output: "generation/count/type summaries only; no database path or row values",
      },
      snapshot: {
        beforeWriterCommit,
        whileWriterIsGenerationEight,
        afterReaderCommit,
        writerCommittedWhileReaderOpen: true,
        exactExpected: {
          generationSequence: [7, 7, 8],
          rowSequence: [2, 2, 3],
        },
      },
      readOnlyNegative: { writeDenied: readOnlyWriteDenied, errorClass: readOnlyWriteErrorClass },
      namePath: {
        betterSqliteNameWasRelative: !nameDb.name.startsWith("/"),
        resolveMatchesCreatedFixture: resolvedName === databasePath,
        inputKind: "ordinary-relative-filesystem-path",
      },
      node: { version: process.version, sqliteVersion: process.versions.sqlite ?? null },
    };
  } catch (error) {
    result = { status: "failure", errorClass: error?.code ?? error?.name ?? "unknown" };
  } finally {
    try { nameDb?.close(); } catch {}
    try { reader?.close(); } catch {}
    try { writer?.close(); } catch {}
    if (parentScratch != null) {
      cleanup = "parent-owned";
    } else if (scratch != null) {
      try {
        rmSync(scratch, { recursive: true, force: true });
        cleanup = existsSync(scratch) ? "failed" : "removed";
      } catch { cleanup = "failed"; }
    }
  }
  return { ...result, cleanup };
}

function runFixtureWithCaps() {
  return new Promise((resolveFixture) => {
    const scratch = mkdtempSync(join(tmpdir(), "analytics-node-sqlite-handoff-"));
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--fixture-child"], {
      cwd: PROBE_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        LANG: "C",
        ANALYTICS_NODE_SQLITE_HANDOFF_SCRATCH: scratch,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killedFor = null;
    let settled = false;
    let settlementGrace = null;
    const append = (current, chunk, limit) => `${current}${chunk}`.slice(0, limit);
    const cleanParentScratch = () => {
      try {
        rmSync(scratch, { recursive: true, force: true });
        return existsSync(scratch) ? "failed" : "removed";
      } catch {
        return "failed";
      }
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (settlementGrace != null) clearTimeout(settlementGrace);
      resolveFixture({ ...value, parentScratchCleanup: cleanParentScratch() });
    };
    const terminate = (reason) => {
      if (killedFor != null) return;
      killedFor = reason;
      child.kill("SIGKILL");
      settlementGrace = setTimeout(() => finish({
        status: "failure",
        errorClass: "child-exit-not-confirmed",
        killedFor,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
      }), KILL_SETTLEMENT_GRACE_MS);
    };
    const deadline = setTimeout(() => terminate("deadline"), CHILD_DEADLINE_MS);
    child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(stdout) + chunk.length > STDOUT_CAP_BYTES) terminate("stdout-cap");
      stdout = append(stdout, chunk, STDOUT_CAP_BYTES);
    });
    child.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr) + chunk.length > STDERR_CAP_BYTES) terminate("stderr-cap");
      stderr = append(stderr, chunk, STDERR_CAP_BYTES);
    });
    child.on("error", (error) => finish({ status: "failure", errorClass: error.name, killedFor, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) }));
    child.on("close", (exitCode, signal) => {
      let payload = null;
      try { payload = JSON.parse(stdout); } catch {}
      finish({
        status: killedFor == null && exitCode === 0 && payload != null ? payload.status : "failure",
        payload,
        exitCode,
        signal,
        killedFor,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        experimentalWarningObserved: /ExperimentalWarning/.test(stderr),
      });
    });
  });
}

function validFixture(result) {
  const payload = result.payload;
  return result.status === "observed"
    && result.killedFor == null
    && result.stdoutBytes <= STDOUT_CAP_BYTES
    && result.stderrBytes <= STDERR_CAP_BYTES
    && result.parentScratchCleanup === "removed"
    && payload?.cleanup === "parent-owned"
    && JSON.stringify(payload.snapshot?.beforeWriterCommit?.generation) === "7"
    && JSON.stringify(payload.snapshot?.whileWriterIsGenerationEight?.generation) === "7"
    && JSON.stringify(payload.snapshot?.afterReaderCommit?.generation) === "8"
    && JSON.stringify(payload.snapshot?.beforeWriterCommit?.rows) === "2"
    && JSON.stringify(payload.snapshot?.whileWriterIsGenerationEight?.rows) === "2"
    && JSON.stringify(payload.snapshot?.afterReaderCommit?.rows) === "3"
    && payload.readOnlyNegative?.writeDenied === true
    && payload.namePath?.resolveMatchesCreatedFixture === true;
}

/**
 * Runs only a generated scratch database. It never opens bb.storage, any real
 * Analytics database, operational storage, Wasm, a network socket, or a child
 * query engine. The fixture witnesses SQLite handoff mechanics, not throughput.
 */
export async function runProbe({ workspaceRoot = DEFAULT_WORKSPACE_ROOT } = {}) {
  const identity = await sourceIdentity(workspaceRoot);
  const checks = staticChecks(identity);
  const fixture = await runFixtureWithCaps();
  const staticPassed = checks.every((check) => check.status === "observed");
  const revisionUnavailable = Object.values(identity.revisions).some((revision) => revision === "unavailable");
  if (revisionUnavailable) checks.push({ id: "git-revision-evidence", status: "failure", detail: "One or more required source revisions are unavailable." });
  const unsupported = fixture.status === "unsupported";
  checks.push({
    id: "scratch-wal-snapshot-readonly-and-name-path-controls",
    status: unsupported ? "unsupported" : validFixture(fixture) ? "observed" : "failure",
    detail: unsupported
      ? "node:sqlite DatabaseSync is not available in this runtime."
      : "The synthetic fixture must hold generation 7/facts 2 through a writer generation 8 commit, then see 8/facts 3 after reader commit, reject a reader write, and resolve a better-sqlite3 name path.",
  });
  const failures = checks.filter((check) => check.status === "failure").map((check) => check.id);
  return {
    schemaVersion: 1,
    probe: "analytics-node-sqlite-handoff",
    status: failures.length > 0 ? "failure" : unsupported ? "unsupported" : "observed",
    safeScope: {
      actualPluginDatabase: "not-opened",
      operationalDatabase: "not-opened",
      network: "not-used",
      wasmOrQueryEngine: "not-started",
      fixture: "generated-scratch-only",
      timingClaim: "none",
    },
    node: { version: process.version, sqliteVersion: process.versions.sqlite ?? null, nodeSqliteExperimental: true },
    revisions: identity.revisions,
    sourceFiles: Object.fromEntries(Object.entries(identity.files).map(([name, file]) => [name, { path: file.path, sha256: file.sha256 }])),
    checks,
    fixture,
    constraints: [
      "Feature-gate node:sqlite DatabaseSync and pin/test the supported Node line; this host emits ExperimentalWarning.",
      "Use only the SDK-provided own-plugin database name after accepting an ordinary filesystem path; reject :memory:, file: URIs, and caller-supplied paths.",
      "Open DatabaseSync with readOnly:true, begin the read transaction, read index state before facts to establish the snapshot, transfer only static typed fact columns, then commit/close before query work.",
      "A reader snapshot is not a performance or Wasm proof; cap rows/bytes and child lifetime so a stuck WAL reader cannot indefinitely delay checkpoints.",
    ],
  };
}

if (process.argv[2] === "--fixture-child") {
  process.stdout.write(`${JSON.stringify(fixtureChild())}\n`);
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runProbe();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === "failure" ? 1 : 0;
}
