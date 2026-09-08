import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EXECUTION_LIMITS, SELECTED_EXECUTION_RUNTIME, assertAdmittedQueryAttestation, deriveExecutionDatumKeys, queuedResolvedDescriptorBytes, resolvedExecutionSchema } from "../../../execution-contract.ts";
import { isAllowedObserverEvent, loadProductionRuntimeBinding } from "./query-runtime/binding.mjs";
import { createOwnStoreFixture } from "./query-runtime/fixture.mjs";
import { runParameterBridgeControls } from "./query-runtime/parameter-bridge-controls.mjs";
import { runSchedulerControls } from "./query-runtime/scheduler-controls.mjs";

const revision = "a".repeat(64);

/**
 * Production acceptance uses only the real constructor imported by binding.mjs.
 * The self-test controls below deliberately exercise the assertions, never an
 * SQL engine or an emulated production runtime.
 */
export async function runSuite(options = {}) {
  if ((options.mode ?? "acceptance") === "instrument-self-test")
    return runInstrumentSelfTest();

  const binding = await loadProductionRuntimeBinding();
  if (binding.kind === "missing-boundary")
    return blocked("production-runtime-boundary", binding.details, binding.entryPath);
  if (binding.kind !== "ready") return failed("production-runtime-import", binding.details, binding.entryPath);

  const fixtureResult = await createOwnStoreFixture();
  if (fixtureResult.kind === "missing-boundary") return blocked("production-own-store-fixture", fixtureResult.details, binding.entryPath);
  if (fixtureResult.kind !== "ready") return failed("production-own-store-fixture", fixtureResult.details, binding.entryPath);
  const fixture = fixtureResult.fixture;
  try {
    const created = await binding.create({ trustedSource: fixture.handoff });
    if (created.kind !== "ready")
      return created.kind === "missing-boundary"
        ? blocked("production-runtime-constructor", created.details, created.entryPath)
        : failed("production-runtime-constructor", created.details, created.entryPath);
    let result;
    try {
      result = await exerciseRealRuntime(created.runtime, created.events, fixture, created.waitForEvent);
    } finally {
      try {
        await created.runtime.close();
      } finally {
        created.dispose();
      }
    }
    result.push(await exerciseQueueCountScenario(binding, fixture));
    result.push(await exerciseQueueAggregateByteScenario(binding, fixture));
    result.push(await exerciseQueueOversizedDescriptorScenario(binding, fixture));
    result.push(await exerciseAdmissionAttestationTampering(binding, fixture));
    result.push(await exerciseOversizedCacheNoLoopScenario(binding, fixture));
    result.push(await exerciseResultLimitRecovery(binding, fixture));
    result.push(await exerciseMaterializationDeadlineRecovery(binding, fixture));
    result.push(await exerciseSameGenerationChildReuse(binding, fixture));
    result.push(await exerciseSubscriberExecutionIdentityScenario(binding, fixture));
    result.push(await exerciseSubscriberIsolationScenario(binding, fixture));
    result.push(await exerciseDeadlineRecoveryScenario(binding, fixture));
    result.push(await exerciseCacheIdentityVariants(binding, fixture));
    result.push(await exerciseActiveChildCloseScenario(binding, fixture));
    result.push(await exerciseCloseBeforeDispatchNoSpawnScenario(binding, fixture));
    // These direct-import controls are pure and engine-free, but are normal
    // acceptance evidence for the actual strict bridge used by this runtime.
    result.push(...runParameterBridgeControls());
    result.push(assertObserverEvidence(created.observationFailure));
    const contractPath = fileURLToPath(new URL("../../../execution-contract.ts", import.meta.url));
    const contractSha256 = createHash("sha256").update(await readFile(contractPath)).digest("hex");
    return {
      suite: "query-runtime",
      status: result.every((check) => check.status === "pass") ? "pass" : "fail",
      checks: [
        {
          id: "production-source-identity",
          status: "pass",
          details: `Real runtime entry ${created.entryPath} sha256=${created.entrySha256}; accepted contract source sha256=${contractSha256}.`,
        },
        ...result,
      ],
      limits: runtimeLimits(),
    };
  } catch (cause) {
    return positiveAdmissionStageFailureOrThrow(cause);
  } finally {
    await fixture.cleanup();
  }
}

async function exerciseRealRuntime(runtime, events, fixture, waitForEvent) {
  const checks = [];
  const denial = await denyAtAdmission(runtime, events, "SELECT coalesce((SELECT count(*) FROM information_schema.tables), 0) AS n");
  const deniedChildRetired = events.some((event) => event?.kind === "kill-requested")
    && events.filter((event) => event?.kind === "kill-requested").every((kill) =>
      events.some((event) => event?.kind === "child-exit" && event.pid === kill.pid),
    );
  checks.push({
    id: "parser-denies-nested-catalog-path",
    status: isError(denial.outcome, "invalid-request") && denial.noSpawnAfterAdmission && deniedChildRetired ? "pass" : "fail",
    details: isError(denial.outcome, "invalid-request") && denial.noSpawnAfterAdmission && deniedChildRetired
      ? "Real parser/admission rejected the historical nested catalog path, confirmed retirement of its denied child, and started no later child after the denial returned."
      : "Expected admission invalid-request, pid-correlated retirement of the denied child, and no later child spawn after denial return.",
  });

  const parserMatrix = await exerciseParserMatrix(runtime, fixture, events);
  checks.push(...parserMatrix);

  const accepted = await runtime.worker.execute(
    await makeInput(runtime, "SELECT CAST($value AS INTEGER) AS bound_value", [{ name: "value", logicalType: "integer", value: 7 }], fixture, "bound-worker"),
    new AbortController().signal,
  );
  checks.push(assertBoundResult(accepted));
  checks.push(assertResultBytes(accepted));
  checks.push(...await exerciseCuratedFactQueries(runtime, fixture));
  checks.push(await exerciseAllBuiltinQueries(runtime, events, fixture));
  checks.push(...await exerciseParameterLexing(runtime, fixture, events));
  checks.push(await exerciseNamedParameterBoundary(runtime, fixture));
  checks.push(await exerciseCanonicalScalarBoundaries(runtime, fixture));
  checks.push(await exercisePhysicalCacheReuse(runtime, events, fixture));

  checks.push(assertLifecycleEvidence(events));
  checks.push(assertQueueEvidence(events));
  return checks;
}

async function exerciseCuratedFactQueries(runtime, fixture) {
  const parameter = [{ name: "capability", logicalType: "utf8", value: "bb:read_file" }];
  const cases = [
    ["curated-fact-aggregate", "SELECT capability_key, CAST(count(*) AS INTEGER) AS executions, CAST(sum(duration_ms) AS INTEGER) AS total_duration_ms FROM tool_execution_fact_v1 WHERE capability_key = $capability GROUP BY capability_key", { capability_key: "bb:read_file", executions: 1, total_duration_ms: 1500 }],
    ["curated-fact-cte", "WITH curated AS (SELECT capability_key, duration_ms FROM tool_execution_fact_v1 WHERE capability_key = $capability) SELECT capability_key, CAST(count(*) AS INTEGER) AS executions, CAST(sum(duration_ms) AS INTEGER) AS total_duration_ms FROM curated GROUP BY capability_key", { capability_key: "bb:read_file", executions: 1, total_duration_ms: 1500 }],
    ["curated-fact-window", "WITH curated AS (SELECT capability_key, duration_ms FROM tool_execution_fact_v1 WHERE capability_key = $capability) SELECT capability_key, duration_ms, row_number() OVER (ORDER BY duration_ms) AS ordinal FROM curated", { capability_key: "bb:read_file", duration_ms: 1500, ordinal: 1 }],
  ];
  const checks = [];
  for (const [id, sql, expected] of cases) {
    const outcome = await runtime.worker.execute(await makeInput(runtime, sql, parameter, fixture, id), new AbortController().signal);
    const row = outcome?.kind === "success" ? outcome.result?.result?.rows?.[0] : null;
    const exact = row != null && Object.entries(expected).every(([key, value]) => row[key] === value);
    checks.push({ id, status: exact ? "pass" : "fail", details: exact ? "Real worker queried the committed curated fact and returned exact expected capability/count/duration values." : "Expected exact values from the committed curated AnalyticsStore fact, not a scalar-only result." });
  }
  return checks;
}

async function exerciseAllBuiltinQueries(runtime, events, fixture) {
  let bundles;
  try {
    ({ BUILTIN_BUNDLES: bundles } = await import("../../../builtin-bundles.ts"));
  } catch (cause) {
    return { id: "all-builtin-queries-admitted-and-executed", status: "fail", details: "Could not load the actual builtin SQL inputs: " + errorText(cause) };
  }
  const queries = Array.isArray(bundles) ? bundles.flatMap((bundle) => Array.isArray(bundle?.queries) ? bundle.queries : []) : [];
  if (queries.length !== 11 || queries.some((query) => typeof query?.sql !== "string" || typeof query?.id !== "string" || !Number.isInteger(query?.maxRows)))
    return { id: "all-builtin-queries-admitted-and-executed", status: "fail", details: "Expected exactly the 11 actual typed builtin query definitions as runtime inputs." };
  const before = highestSqlExecutionCount(events);
  const outcomes = [];
  for (const query of queries) {
    const outcome = await runtime.worker.execute(await makeInput(runtime, query.sql, [], fixture, "builtin-" + query.id, { query }), new AbortController().signal);
    outcomes.push(outcome);
  }
  const after = highestSqlExecutionCount(events);
  const executed = outcomes.every((outcome) => outcome?.kind === "success" && outcome.result?.result != null);
  const dispatches = after - before;
  return {
    id: "all-builtin-queries-admitted-and-executed",
    status: executed && dispatches === queries.length ? "pass" : "fail",
    details: executed && dispatches === queries.length
      ? "All 11 actual builtin SQL definitions were separately admitted and executed by the real worker."
      : `Expected all 11 actual builtin queries to return real results with 11 real dispatches (results=${outcomes.filter((outcome) => outcome?.kind === "success").length}, dispatches=${dispatches}).`,
  };
}

async function exerciseParameterLexing(runtime, fixture, events) {
  const repeated = await runtime.worker.execute(
    await makeInput(runtime, "SELECT CAST($value AS INTEGER) AS first_value, CAST($value AS INTEGER) AS second_value", integerParameter(7), fixture, "parameter-repeat"),
    new AbortController().signal,
  );
  const quoted = await runtime.worker.execute(
    await makeInput(runtime, "SELECT CAST($value AS INTEGER) AS bound_value, '$value' AS literal_value", integerParameter(7), fixture, "parameter-single-quote"),
    new AbortController().signal,
  );
  const comment = await runtime.worker.execute(
    await makeInput(runtime, "SELECT CAST($value AS INTEGER) AS bound_value /* $value is comment text, not a second marker */", integerParameter(7), fixture, "parameter-comment"),
    new AbortController().signal,
  );
  const dollarQuotedUnused = await denyAtAdmission(runtime, events, "SELECT $$ $value $$ AS literal_value", integerParameter(7));
  const dollarQuotedLiteral = await runtime.worker.execute(
    await makeInput(runtime, "SELECT $$dollar_literal$$ AS literal_value", [], fixture, "parameter-dollar-quote-literal"),
    new AbortController().signal,
  );
  const repeatRow = repeated?.kind === "success" ? repeated.result?.result?.rows?.[0] : null;
  const quoteRow = quoted?.kind === "success" ? quoted.result?.result?.rows?.[0] : null;
  const commentRow = comment?.kind === "success" ? comment.result?.result?.rows?.[0] : null;
  const dollarLiteralRow = dollarQuotedLiteral?.kind === "success" ? dollarQuotedLiteral.result?.result?.rows?.[0] : null;
  return [
    {
      id: "parameter-repeated-binding",
      status: repeatRow?.first_value === 7 && repeatRow?.second_value === 7 ? "pass" : "fail",
      details: repeatRow?.first_value === 7 && repeatRow?.second_value === 7 ? "Repeated named parameter placeholders bound the same typed value exactly." : "Expected both repeated named placeholders to return the independently expected typed value.",
    },
    {
      id: "parameter-single-quote-lexing",
      status: quoteRow?.bound_value === 7 && quoteRow?.literal_value === "$value" ? "pass" : "fail",
      details: quoteRow?.bound_value === 7 && quoteRow?.literal_value === "$value" ? "A parameter marker inside a SQL string literal remained literal while the real marker bound." : "Expected a literal $value string plus one independently bound parameter.",
    },
    {
      id: "parameter-comment-real-parser-binding",
      status: commentRow?.bound_value === 7 ? "pass" : "fail",
      details: commentRow?.bound_value === 7 ? "The parser ignored parameter-like comment text while preserving the real declared named binding." : "Expected the real declared named parameter to bind despite parameter-like comment text.",
    },
    {
      id: "parameter-dollar-quote-unused-declaration-denial",
      status: isError(dollarQuotedUnused.outcome, "invalid-request") && dollarQuotedUnused.noSpawnAfterAdmission ? "pass" : "fail",
      details: isError(dollarQuotedUnused.outcome, "invalid-request") && dollarQuotedUnused.noSpawnAfterAdmission ? "A dollar-quoted marker did not consume an unused declared parameter; admission denied it without a later child spawn." : "Expected admission invalid-request for an unused declaration next to a dollar-quoted marker, with no later child spawn.",
    },
    {
      id: "parameter-dollar-quote-literal-positive",
      status: dollarLiteralRow?.literal_value === "dollar_literal" ? "pass" : "fail",
      details: dollarLiteralRow?.literal_value === "dollar_literal" ? "A parameter-free dollar-quoted literal executed as the parser-admitted literal form." : "Expected the parameter-free dollar-quoted literal to execute unchanged.",
    },
  ];
}

// This narrow control intentionally uses the ordinary two-phase boundary:
// makeInput first asks the real runtime to admit the draft and then constructs
// the immutable resolved request from that returned attestation.  Execution
// receives the original SQL text in the resolved request; the assertion only
// records bounded boolean/numeric outcomes, never SQL or parameter values.
async function exerciseNamedParameterBoundary(runtime, fixture) {
  const reversedDeclaration = [
    { name: "a_2", logicalType: "integer", value: 9 },
    { name: "a1", logicalType: "integer", value: 2 },
  ];
  const reversed = await runtime.worker.execute(
    await makeInput(
      runtime,
      "SELECT CAST($a_2 AS INTEGER) AS second, CAST($a1 AS INTEGER) AS first",
      reversedDeclaration,
      fixture,
      "named-parameter-lexical-order",
    ),
    new AbortController().signal,
  );
  const repeated = await runtime.worker.execute(
    await makeInput(
      runtime,
      "SELECT CAST($value AS INTEGER) AS first, CAST($value AS INTEGER) AS second",
      [{ name: "value", logicalType: "integer", value: 7 }],
      fixture,
      "named-parameter-repeated-marker",
    ),
    new AbortController().signal,
  );
  const reversedRow = reversed?.kind === "success" ? reversed.result?.result?.rows?.[0] : null;
  const repeatedRow = repeated?.kind === "success" ? repeated.result?.result?.rows?.[0] : null;
  const exact = reversedRow?.second === 9 && reversedRow?.first === 2
    && repeatedRow?.first === 7 && repeatedRow?.second === 7;
  return {
    id: "named-parameter-attested-boundary",
    status: exact ? "pass" : "fail",
    details: exact
      ? "Two real admitted named-parameter requests returned their exact bounded scalar pairs."
      : "Expected exact scalar pairs from the reversed declaration and repeated-marker admitted requests.",
  };
}

async function exerciseCanonicalScalarBoundaries(runtime, fixture) {
  const parameters = [
    { name: "decimal", logicalType: "decimal", value: "9007199254740991.125" },
    { name: "date", logicalType: "date_utc", value: "2024-02-29" },
    { name: "integer", logicalType: "integer", value: Number.MAX_SAFE_INTEGER },
  ];
  const outcome = await runtime.worker.execute(
    await makeInput(runtime,
      "SELECT CAST($decimal AS DECIMAL(19,3)) AS decimal_value, CAST($date AS DATE) AS date_value, CAST($integer AS BIGINT) AS integer_value",
      parameters,
      fixture,
      "canonical-scalar-boundaries",
    ),
    new AbortController().signal,
  );
  const row = outcome?.kind === "success" ? outcome.result?.result?.rows?.[0] : null;
  const columns = outcome?.kind === "success" ? outcome.result?.result?.columns : null;
  const exact = row?.decimal_value === "9007199254740991.125" && row?.date_value === "2024-02-29" && row?.integer_value === Number.MAX_SAFE_INTEGER
    && Array.isArray(columns)
    && columns.some((column) => column?.name === "decimal_value" && column.logicalType === "decimal")
    && columns.some((column) => column?.name === "date_value" && column.logicalType === "date_utc")
    && columns.some((column) => column?.name === "integer_value" && column.logicalType === "integer");
  return {
    id: "canonical-decimal-date-integer-boundaries",
    status: exact ? "pass" : "fail",
    details: exact
      ? "Real named prepared binding preserved the exact decimal text, leap-day date, and maximum safe integer with matching canonical logical types."
      : "Expected exact canonical decimal/date/integer boundary values and logical types from the real prepared statement.",
  };
}

async function exerciseParserMatrix(runtime, fixture, events) {
  const accepted = [
    ["parser-accepts-cte", "WITH acceptance_cte AS (SELECT CAST($value AS INTEGER) AS n) SELECT n FROM acceptance_cte", { n: 9 }],
    ["parser-accepts-window", "SELECT CAST($value AS INTEGER) AS n, row_number() OVER (ORDER BY CAST($value AS INTEGER)) AS row_number", { n: 9, row_number: 1 }],
  ];
  const denied = [
    ["parser-denies-direct-table-function", "SELECT count(*) AS n FROM range(10)"],
    ["parser-denies-quoted-external-path", "SELECT count(*) AS n FROM \"information_schema\".\"tables\""],
    ["parser-denies-nested-table-function", "SELECT coalesce((SELECT count(*) FROM range(10)), 0) AS n"],
    ["parser-denies-leaked-cte-alias", "SELECT CAST(count(*) AS INTEGER) AS n FROM acceptance_cte"],
    ["parser-denies-unsupported-function-operator-spelling", "SELECT 5 % 2 AS n"],
    ["parser-denies-unary-function-operator-arity", "SELECT -CAST($value AS INTEGER) AS n", integerParameter(7)],
  ];
  const checks = [];
  for (const [id, sql, expected] of accepted) {
    const outcome = await runtime.worker.execute(await makeInput(runtime, sql, integerParameter(9), fixture, id), new AbortController().signal);
    const row = outcome?.kind === "success" ? outcome.result?.result?.rows?.[0] : null;
    const matches = row != null && Object.entries(expected).every(([key, value]) => row[key] === value);
    checks.push({ id, status: outcome?.kind === "success" && matches ? "pass" : "fail", details: outcome?.kind === "success" && matches ? "Real worker accepted required grammar and produced the exact expected scalar row." : "Expected real worker success and the exact CTE/window scalar row." });
  }
  for (const [id, sql, parameters = []] of denied) {
    const denial = await denyAtAdmission(runtime, events, sql, parameters);
    checks.push({ id, status: isError(denial.outcome, "invalid-request") && denial.noSpawnAfterAdmission ? "pass" : "fail", details: isError(denial.outcome, "invalid-request") && denial.noSpawnAfterAdmission ? "Real parser/admission rejected the external relation/function path and did not start a child after the denial returned." : "Expected admission invalid-request denial and no child spawn after the denial returned." });
  }
  return checks;
}

async function denyAtAdmission(runtime, events, sql, parameters = []) {
  const outcome = await runtime.admitQuery({ sql, parameters, cacheability: "stable" });
  const spawnsAtAdmissionReturn = events.filter((event) => event?.kind === "child-spawn").length;
  await new Promise((resolve) => setImmediate(resolve));
  return {
    outcome,
    noSpawnAfterAdmission: events.filter((event) => event?.kind === "child-spawn").length === spawnsAtAdmissionReturn,
  };
}

async function exercisePhysicalCacheReuse(runtime, events, fixture) {
  const before = highestSqlExecutionCount(events);
  const first = await runtime.coordinator.subscribe(await makeInput(runtime, boundSql(), integerParameter(21), fixture, "cache-first"), new AbortController().signal);
  const second = await runtime.coordinator.subscribe(await makeInput(runtime, boundSql(), integerParameter(21), fixture, "cache-second"), new AbortController().signal);
  const after = highestSqlExecutionCount(events);
  const cacheHit = events.some((event) => event?.kind === "cache" && event.hit === true && typeof event.physicalKey === "string");
  const exactRows = first?.kind === "success" && second?.kind === "success" && first.result?.result?.rows?.[0]?.bound_value === 21 && second.result?.result?.rows?.[0]?.bound_value === 21;
  return { id: "physical-cache-reuse-real-dispatch", status: exactRows && after - before === 1 && cacheHit ? "pass" : "fail", details: exactRows && after - before === 1 && cacheHit ? "Two lineages with identical physical inputs caused exactly one real SQL execution, a recorded physical cache hit, and exact cached scalar rows." : "Expected exact rows from identical physical inputs, one actual SQL execution, and one actual cache-hit observation." };
}

function highestSqlExecutionCount(events) {
  return events.reduce((maximum, event) => Number.isInteger(event?.sqlExecutionCount) ? Math.max(maximum, event.sqlExecutionCount) : maximum, 0);
}

export async function makeInput(runtime, sql, parameters = [], fixture, label = "input", options = {}) {
  const queryDefinition = options.query ?? null;
  const cacheability = queryDefinition?.cacheability ?? "stable";
  const admission = await runtime.admitQuery({
    sql,
    parameters,
    cacheability,
  });
  if (admission?.kind !== "admitted")
    throw new PositiveAdmissionFailure(label, admission?.kind === "error" ? admission.error?.code : null);
  return makeInputFromAdmission(sql, parameters, fixture, label, admission.admission, options);
}

const admissionOutcomeCodes = new Set([
  "invalid-request", "stale-snapshot", "admission-denied", "identity-unavailable",
  "identity-mismatch", "queue-full", "queue-timeout", "cancelled",
  "worker-startup-timeout", "materialization-limit", "materialization-timeout",
  "query-timeout", "result-limit", "worker-crashed", "record-expired",
]);
const positiveScenarioId = /^[a-z][a-z0-9-]{0,79}$/;

class PositiveAdmissionFailure extends Error {
  constructor(label, code) {
    super("Positive admission draft was not admitted.");
    this.name = "PositiveAdmissionFailure";
    this.scenario = typeof label === "string" && positiveScenarioId.test(label)
      ? label : "unknown-positive-draft";
    this.outcome = typeof code === "string" && admissionOutcomeCodes.has(code)
      ? code : "unrecognized";
  }
}

function positiveAdmissionStageFailure(cause) {
  if (!(cause instanceof PositiveAdmissionFailure)) return null;
  return failed(
    "positive-admission-stage",
    `scenario=${cause.scenario}; outcome=${cause.outcome}.`,
  );
}

function positiveAdmissionStageFailureOrThrow(cause) {
  const stageFailure = positiveAdmissionStageFailure(cause);
  if (stageFailure != null) return stageFailure;
  throw cause;
}

function makeInputFromAdmission(sql, parameters = [], fixture, label = "input", admission, { allowMismatchedSourceScope = false, query: queryDefinition = null } = {}) {
  const snapshot = structuredClone(fixture.snapshot);
  if (!allowMismatchedSourceScope && (snapshot?.snapshotId !== fixture.handoff?.snapshotId
    || snapshot?.coverage?.observed?.projectionGeneration !== fixture.handoff?.sourceGeneration
    || canonicalJson(snapshot?.sourceScope) !== canonicalJson(fixture.handoff?.sourceScope)
    || !Number.isSafeInteger(fixture.handoff?.factProjectionVersion)
    || fixture.handoff.factProjectionVersion < 1))
    throw new Error("Production own-store fixture snapshot/handoff lineage is inconsistent.");
  const executionId = "analytics-exec_acceptance_runtime_" + label;
  const resolved = resolvedExecutionSchema.parse({
      version: 2,
      executionId,
      snapshot,
      bundleId: "acceptance-runtime",
      bundleRevision: revision,
      query: {
        id: queryDefinition?.id ?? "bound-query",
        revision,
        title: queryDefinition?.title ?? "Acceptance bound query",
        sql,
        maxRows: queryDefinition?.maxRows ?? 5,
        astNodeCount: admission.astNodeCount,
        astPolicyRevision: admission.astPolicyRevision,
        resultContractRevision: revision,
        sqlSha256: admission.sqlSha256,
        parameterDeclarationDigest: admission.parameterDeclarationDigest,
        cacheability: admission.cacheability,
        parameters,
      },
  });
  assertAdmittedQueryAttestation(resolved.query, admission);
  return Object.freeze({ resolved, source: fixture.handoff });
}

async function exerciseCacheIdentityVariants(binding, fixture) {
  if (typeof fixture.makeSnapshot !== "function") return { id: "physical-cache-endpoint-and-scope-identity", status: "blocked", details: "Test-owned own-store fixture lacks ordinary makeSnapshot(range) adaptation." };
  const baseRange = fixture.snapshot.frozenRange;
  // The fixture deliberately commits a read_file fact at now-1s and a
  // write_file fact at now-12s.  These ranges must expose 1/0/1 respectively;
  // a scalar-only endpoint probe could pass while ignoring frozen filtering.
  const recentRange = { startInclusiveMs: baseRange.endExclusiveMs - 2_000, endExclusiveMs: baseRange.endExclusiveMs };
  const olderRange = { startInclusiveMs: baseRange.endExclusiveMs - 20_000, endExclusiveMs: baseRange.endExclusiveMs - 2_000 };
  if (recentRange.endExclusiveMs <= recentRange.startInclusiveMs || olderRange.endExclusiveMs <= olderRange.startInclusiveMs)
    return { id: "physical-cache-endpoint-and-scope-identity", status: "fail", details: "Fixture range cannot form distinct valid frozen intervals." };
  const recent = await fixture.makeSnapshot(recentRange);
  const older = await fixture.makeSnapshot(olderRange);
  const recentFixture = { ...fixture, snapshot: recent.snapshot, handoff: recent.handoff };
  const olderFixture = { ...fixture, snapshot: older.snapshot, handoff: older.handoff };
  const created = await binding.create({ trustedSource: fixture.handoff });
  if (created.kind !== "ready") return { id: "physical-cache-endpoint-and-scope-identity", status: created.kind === "missing-boundary" ? "blocked" : "fail", details: created.details };
  try {
    const before = highestSqlExecutionCount(created.events);
    const countSql = "SELECT CAST(count(*) AS INTEGER) AS executions FROM tool_execution_fact_v1 WHERE capability_key = $capability";
    const recentRead = await created.runtime.coordinator.subscribe(await makeInput(created.runtime, countSql, [{ name: "capability", logicalType: "utf8", value: "bb:read_file" }], recentFixture, "range-recent-read"), new AbortController().signal);
    const olderRead = await created.runtime.coordinator.subscribe(await makeInput(created.runtime, countSql, [{ name: "capability", logicalType: "utf8", value: "bb:read_file" }], olderFixture, "range-older-read"), new AbortController().signal);
    const olderWrite = await created.runtime.coordinator.subscribe(await makeInput(created.runtime, countSql, [{ name: "capability", logicalType: "utf8", value: "bb:write_file" }], olderFixture, "range-older-write"), new AbortController().signal);
    const after = highestSqlExecutionCount(created.events);
    const mismatchFixture = { ...fixture, snapshot: structuredClone(fixture.snapshot) };
    mismatchFixture.snapshot.sourceScope = { ...mismatchFixture.snapshot.sourceScope, scopeKey: fixture.snapshot.sourceScope.scopeKey + "x" };
    const mismatch = await created.runtime.worker.execute(await makeInput(created.runtime, "SELECT capability_key, CAST(count(*) AS INTEGER) AS executions FROM tool_execution_fact_v1 WHERE capability_key = $capability GROUP BY capability_key", [{ name: "capability", logicalType: "utf8", value: "bb:read_file" }], mismatchFixture, "scope-mismatch", { allowMismatchedSourceScope: true }), new AbortController().signal);
    const exactRows = recentRead?.kind === "success" && olderRead?.kind === "success" && olderWrite?.kind === "success"
      && recentRead.result?.result?.rows?.[0]?.executions === 1
      && olderRead.result?.result?.rows?.[0]?.executions === 0
      && olderWrite.result?.result?.rows?.[0]?.executions === 1;
    const deniedBeforeFact = isError(mismatch, "identity-mismatch") && mismatch?.result == null;
    return { id: "physical-cache-endpoint-and-scope-identity", status: exactRows && after - before === 3 && deniedBeforeFact ? "pass" : "fail", details: exactRows && after - before === 3 && deniedBeforeFact ? "Recent and older frozen ranges produced exact 1/0/1 curated-fact results and separate real dispatches; mismatched trusted scope was rejected before fact exposure." : "Expected actual frozen-range 1/0/1 fact filtering, three distinct physical dispatches, and identity-mismatch before fact SQL/cache result exposure." };
  } finally {
    try { await created.runtime.close(); } finally { created.dispose(); }
  }
}


async function exerciseQueueCountScenario(binding, fixture) {
  const limit = { maxQueuedExecutions: 2, maxQueuedBytes: EXECUTION_LIMITS.maxQueuedBytes };
  return withDispatchGate(binding, fixture, limit, async ({ runtime, gate, track }) => {
    // Admission shares the serial locked-child scheduler.  Finish every
    // admission before the test-only post-admission gate holds active work.
    const activeInput = await makeInput(runtime, boundSql(), integerParameter(1), fixture, "queue-count-active");
    const queuedInputs = await Promise.all([2, 3].map((value) => makeInput(runtime, boundSql(), integerParameter(value), fixture, "queue-count-" + value)));
    const overflowInput = await makeInput(runtime, boundSql(), integerParameter(4), fixture, "queue-count-overflow");
    const active = track(runtime.coordinator.subscribe(activeInput, new AbortController().signal));
    const entered = await gate.entered();
    const queued = queuedInputs.map((input) => track(runtime.coordinator.subscribe(input, new AbortController().signal)));
    const overflow = await track(runtime.coordinator.subscribe(overflowInput, new AbortController().signal));
    gate.release();
    const settled = await Promise.allSettled([active, ...queued]);
    const allSucceeded = settled.every((item) => item.status === "fulfilled" && item.value?.kind === "success");
    return { id: "queue-count-bound-overflow", status: entered && isError(overflow, "queue-full") && allSucceeded ? "pass" : "fail", details: entered && isError(overflow, "queue-full") && allSucceeded ? "One real gated dispatch plus exactly two queued descriptors accepted; the later valid descriptor returned queue-full and all accepted work settled." : "Expected deterministic active-versus-queued count accounting and a typed queue-full overflow." };
  });
}

async function exerciseQueueAggregateByteScenario(binding, fixture) {
  const measured = await binding.create({ trustedSource: fixture.handoff });
  if (measured.kind !== "ready") return { id: "queue-aggregate-byte-overflow", status: measured.kind === "missing-boundary" ? "blocked" : "fail", details: measured.details };
  let firstBytes, secondBytes;
  try {
    firstBytes = queuedResolvedDescriptorBytes((await makeInput(measured.runtime, textSql(), textParameter("a".repeat(1_500)), fixture, "queue-byte-first")).resolved);
    secondBytes = queuedResolvedDescriptorBytes((await makeInput(measured.runtime, textSql(), textParameter("b".repeat(1_500)), fixture, "queue-byte-second")).resolved);
  } finally {
    try { await measured.runtime.close(); } finally { measured.dispose(); }
  }
  const limit = { maxQueuedExecutions: 4, maxQueuedBytes: firstBytes + secondBytes - 1 };
  if (firstBytes > limit.maxQueuedBytes || secondBytes > limit.maxQueuedBytes || limit.maxQueuedBytes > EXECUTION_LIMITS.maxQueuedBytes)
    return { id: "queue-aggregate-byte-overflow", status: "fail", details: "Test descriptors could not form a valid reduced aggregate-byte scenario." };
  return withDispatchGate(binding, fixture, limit, async ({ runtime, gate, track }) => {
    const first = await makeInput(runtime, textSql(), textParameter("a".repeat(1_500)), fixture, "queue-byte-first");
    const second = await makeInput(runtime, textSql(), textParameter("b".repeat(1_500)), fixture, "queue-byte-second");
    const activeInput = await makeInput(runtime, boundSql(), integerParameter(5), fixture, "queue-byte-active");
    if (queuedResolvedDescriptorBytes(first.resolved) !== firstBytes || queuedResolvedDescriptorBytes(second.resolved) !== secondBytes)
      return { id: "queue-aggregate-byte-overflow", status: "fail", details: "Real admission changed a measured descriptor after reduced queue budget selection." };
    const active = track(runtime.coordinator.subscribe(activeInput, new AbortController().signal));
    const entered = await gate.entered();
    const heldFirst = track(runtime.coordinator.subscribe(first, new AbortController().signal));
    const later = await track(runtime.coordinator.subscribe(second, new AbortController().signal));
    gate.release();
    const [activeSettled, firstSettled] = await Promise.all([active, heldFirst]);
    return { id: "queue-aggregate-byte-overflow", status: entered && isError(later, "queue-full") && activeSettled?.kind === "success" && firstSettled?.kind === "success" ? "pass" : "fail", details: entered && isError(later, "queue-full") && activeSettled?.kind === "success" && firstSettled?.kind === "success" ? "The later valid descriptor specifically returned queue-full from aggregate bytes while the first stayed queued, then all retained work settled." : "Expected first valid descriptor held, second valid descriptor queue-full by aggregate bytes, and deterministic cleanup." };
  });
}

async function exerciseQueueOversizedDescriptorScenario(binding, fixture) {
  const measured = await binding.create({ trustedSource: fixture.handoff });
  if (measured.kind !== "ready") return { id: "queue-individual-byte-overflow", status: measured.kind === "missing-boundary" ? "blocked" : "fail", details: measured.details };
  let descriptorBytes;
  try { descriptorBytes = queuedResolvedDescriptorBytes((await makeInput(measured.runtime, textSql(), textParameter("x".repeat(1_500)), fixture, "queue-byte-oversized")).resolved); }
  finally { try { await measured.runtime.close(); } finally { measured.dispose(); } }
  const limit = { maxQueuedExecutions: 2, maxQueuedBytes: descriptorBytes - 1 };
  if (limit.maxQueuedBytes < 1 || limit.maxQueuedBytes > EXECUTION_LIMITS.maxQueuedBytes)
    return { id: "queue-individual-byte-overflow", status: "fail", details: "Test descriptor could not form a valid reduced individual-byte scenario." };
  return withDispatchGate(binding, fixture, limit, async ({ runtime, gate, track }) => {
    const input = await makeInput(runtime, textSql(), textParameter("x".repeat(1_500)), fixture, "queue-byte-oversized");
    const activeInput = await makeInput(runtime, boundSql(), integerParameter(6), fixture, "queue-oversized-active");
    if (queuedResolvedDescriptorBytes(input.resolved) !== descriptorBytes)
      return { id: "queue-individual-byte-overflow", status: "fail", details: "Real admission changed a measured descriptor after reduced queue budget selection." };
    const active = track(runtime.coordinator.subscribe(activeInput, new AbortController().signal));
    const entered = await gate.entered();
    const overflow = await track(runtime.coordinator.subscribe(input, new AbortController().signal));
    gate.release();
    const activeSettled = await active;
    return { id: "queue-individual-byte-overflow", status: entered && isError(overflow, "queue-full") && activeSettled?.kind === "success" ? "pass" : "fail", details: entered && isError(overflow, "queue-full") && activeSettled?.kind === "success" ? "A valid descriptor larger than the reduced byte budget returned queue-full before retention; active work then settled." : "Expected a pre-admission individual-byte queue-full result and active-work cleanup." };
  });
}

async function exerciseAdmissionAttestationTampering(binding, fixture) {
  const fields = ["astPolicyRevision", "astNodeCount", "sqlSha256", "parameterDeclarationDigest", "cacheability"];
  const results = [];
  for (const field of fields) {
    const created = await binding.create({ trustedSource: fixture.handoff });
    if (created.kind !== "ready") return { id: "admission-attestation-tampering-denied", status: created.kind === "missing-boundary" ? "blocked" : "fail", details: created.details };
    try {
      const admitted = await makeInput(created.runtime, boundSql(), integerParameter(54), fixture, "attestation-" + field);
      const mutated = structuredClone(admitted);
      mutated.resolved.query[field] = mutateAttestationField(field, admitted.resolved.query[field]);
      const outcome = await created.runtime.worker.execute(mutated, new AbortController().signal);
      const materialized = created.events.some((event) => event?.kind === "source-materialized" && event.executionId === admitted.resolved.executionId);
      results.push({ field, denied: isError(outcome, "invalid-request") && !materialized });
    } finally {
      try { await created.runtime.close(); } finally { created.dispose(); }
    }
  }
  const denied = results.every((result) => result.denied);
  return {
    id: "admission-attestation-tampering-denied",
    status: denied ? "pass" : "fail",
    details: denied
      ? "Each individual post-admission attestation mutation was rejected as invalid-request before source materialization."
      : "Expected pre-materialization invalid-request for every independent attestation mutation: " + results.filter((result) => !result.denied).map((result) => result.field).join(", ") + ".",
  };
}

function mutateAttestationField(field, value) {
  if (field === "astNodeCount") return value === EXECUTION_LIMITS.maxAstNodes ? value - 1 : value + 1;
  if (field === "cacheability") return value === "stable" ? "volatile-uncacheable" : "stable";
  return differentHash(value);
}

function differentHash(value) {
  return value === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
}

async function exerciseOversizedCacheNoLoopScenario(binding, fixture) {
  const created = await binding.create({ trustedSource: fixture.handoff, resourceLimits: { cacheMaxBytes: 1 } });
  if (created.kind !== "ready") return { id: "oversized-reduced-cache-budget-no-loop", status: created.kind === "missing-boundary" ? "blocked" : "fail", details: created.details };
  try {
    const before = highestSqlExecutionCount(created.events);
    const first = await created.runtime.coordinator.subscribe(await makeInput(created.runtime, boundSql(), integerParameter(52), fixture, "cache-oversized-first"), new AbortController().signal);
    const second = await created.runtime.coordinator.subscribe(await makeInput(created.runtime, boundSql(), integerParameter(52), fixture, "cache-oversized-second"), new AbortController().signal);
    const after = highestSqlExecutionCount(created.events);
    const cacheEvents = created.events.filter((event) => event?.kind === "cache");
    const exact = first?.kind === "success" && second?.kind === "success"
      && first.result?.result?.rows?.[0]?.bound_value === 52 && second.result?.result?.rows?.[0]?.bound_value === 52;
    return {
      id: "oversized-reduced-cache-budget-no-loop",
      status: exact && after - before === 2 && cacheEvents.length === 0 ? "pass" : "fail",
      details: exact && after - before === 2 && cacheEvents.length === 0
        ? "A valid result larger than the reduced cache budget was returned uncached twice with exactly two dispatches and no eviction/retry loop."
        : "Expected two exact uncached results, exactly two dispatches, and no cache event under the reduced one-byte cache budget.",
    };
  } finally {
    try { await created.runtime.close(); } finally { created.dispose(); }
  }
}

async function exerciseResultLimitRecovery(binding, fixture) {
  const created = await binding.create({ trustedSource: fixture.handoff, resourceLimits: { maxCanonicalResultBytes: 2_048 } });
  if (created.kind !== "ready") return { id: "result-limit-and-same-runtime-recovery", status: created.kind === "missing-boundary" ? "blocked" : "fail", details: created.details };
  try {
    // This is exactly maxCellStringBytes ASCII text: valid input whose
    // canonical result envelope necessarily exceeds the reduced 2KiB cap.
    const overflowInput = await makeInput(created.runtime, textSql(), textParameter("x".repeat(2_000)), fixture, "result-limit-text");
    const recoveryInput = await makeInput(created.runtime, boundSql(), integerParameter(59), fixture, "result-limit-recovery");
    const before = created.events.length;
    const overflow = await created.runtime.worker.execute(overflowInput, new AbortController().signal);
    const recovery = await created.runtime.worker.execute(recoveryInput, new AbortController().signal);
    const events = created.events.slice(before);
    const overflowDispatch = events.findIndex((event) => event?.kind === "dispatch" && event.executionId === overflowInput.resolved.executionId);
    const recoveryDispatch = events.findIndex((event) => event?.kind === "dispatch" && event.executionId === recoveryInput.resolved.executionId);
    const overflowBound = isError(overflow, "result-limit") && overflow?.result == null && overflowDispatch >= 0;
    const recovered = recovery?.kind === "success" && recovery.result?.result?.rows?.[0]?.bound_value === 59 && recoveryDispatch > overflowDispatch;
    return {
      id: "result-limit-and-same-runtime-recovery",
      status: overflowBound && recovered ? "pass" : "fail",
      details: overflowBound && recovered
        ? "A dispatched valid text result exceeded the reduced canonical cap without a payload; the same runtime then dispatched and returned the exact bounded integer recovery result."
        : "Expected dispatched result-limit without a result payload, followed by a later same-runtime dispatch with the exact integer recovery result.",
    };
  } finally {
    try { await created.runtime.close(); } finally { created.dispose(); }
  }
}

async function exerciseMaterializationDeadlineRecovery(binding, fixture) {
  const gate = createDispatchGate();
  const timedRuntime = await binding.create({
    trustedSource: fixture.handoff,
    resourceLimits: { materializationDeadlineMs: 100, parentKillGraceMs: 50 },
    testControl: { testMaterializationCheckpoint: true, beforeMaterializationCommit: gate.wait },
  });
  if (timedRuntime.kind !== "ready") return { id: "materialization-whole-phase-timeout-and-fresh-recovery", status: timedRuntime.kind === "missing-boundary" ? "blocked" : "fail", details: timedRuntime.details };
  let timedExit;
  try {
    const executionId = "analytics-exec_acceptance_runtime_materialization-timeout";
    const pending = timedRuntime.runtime.worker.execute(await makeInput(timedRuntime.runtime, boundSql(), integerParameter(51), fixture, "materialization-timeout"), new AbortController().signal);
    const checkpoint = await settleWithin(gate.entered(), 1_000);
    const timed = checkpoint.kind === "fulfilled" ? await settleWithin(pending, 1_000) : { kind: "timeout" };
    const requested = timedRuntime.events.find((event) => event?.kind === "kill-requested" && event.executionId === executionId);
    timedExit = timedRuntime.events.find((event) => event?.kind === "child-exit" && event.pid === requested?.pid);
    const committedMaterialization = timedRuntime.events.some((event) => event?.kind === "source-materialized" && event.executionId === executionId);
    const timedOut = checkpoint.kind === "fulfilled" && timed.kind === "fulfilled" && isError(timed.value, "materialization-timeout")
      && requested != null && timedExit != null && !committedMaterialization;
    if (!timedOut)
      return { id: "materialization-whole-phase-timeout-and-fresh-recovery", status: "fail", details: "Expected the actual child prepare/source+insert checkpoint to time out before commit, with pid-correlated kill/exit and no successful materialization identity." };
  } finally {
    gate.release();
    try { await timedRuntime.runtime.close(); } finally { timedRuntime.dispose(); }
  }
  const recovery = await binding.create({ trustedSource: fixture.handoff });
  if (recovery.kind !== "ready") return { id: "materialization-whole-phase-timeout-and-fresh-recovery", status: recovery.kind === "missing-boundary" ? "blocked" : "fail", details: recovery.details };
  try {
    const countSql = "SELECT CAST(count(*) AS INTEGER) AS executions FROM tool_execution_fact_v1 WHERE capability_key = $capability";
    const outcome = await recovery.runtime.worker.execute(await makeInput(recovery.runtime, countSql, [{ name: "capability", logicalType: "utf8", value: "bb:read_file" }], fixture, "materialization-recovery"), new AbortController().signal);
    const recoveredMaterialization = recovery.events.find((event) => event?.kind === "source-materialized");
    const spawned = recovery.events.find((event) => event?.kind === "child-spawn");
    const exact = outcome?.kind === "success" && outcome.result?.result?.rows?.[0]?.executions === 1;
    const fresh = recoveredMaterialization?.reused === false && recoveredMaterialization?.childReadCount > 0
      && spawned?.pid === recoveredMaterialization?.pid && spawned?.monotonicMs >= timedExit?.monotonicMs;
    return {
      id: "materialization-whole-phase-timeout-and-fresh-recovery",
      status: exact && fresh ? "pass" : "fail",
      details: exact && fresh
        ? "After whole-phase materialization timeout and child exit, a later child created a fresh completed materialization before returning the exact curated result."
        : "Expected a fresh child/materialization identity after the failed replacement, never partial-table reuse.",
    };
  } finally {
    try { await recovery.runtime.close(); } finally { recovery.dispose(); }
  }
}

async function exerciseSameGenerationChildReuse(binding, fixture) {
  const created = await binding.create({ trustedSource: fixture.handoff });
  if (created.kind !== "ready") return { id: "same-generation-child-local-materialization-reuse", status: created.kind === "missing-boundary" ? "blocked" : "fail", details: created.details };
  try {
    const firstId = "reuse-read";
    const secondId = "reuse-write";
    const countSql = "SELECT CAST(count(*) AS INTEGER) AS executions FROM tool_execution_fact_v1 WHERE capability_key = $capability";
    const first = await created.runtime.worker.execute(await makeInput(created.runtime, countSql, [{ name: "capability", logicalType: "utf8", value: "bb:read_file" }], fixture, firstId), new AbortController().signal);
    const second = await created.runtime.worker.execute(await makeInput(created.runtime, countSql, [{ name: "capability", logicalType: "utf8", value: "bb:write_file" }], fixture, secondId), new AbortController().signal);
    const firstExecutionId = "analytics-exec_acceptance_runtime_" + firstId;
    const secondExecutionId = "analytics-exec_acceptance_runtime_" + secondId;
    const firstDispatch = created.events.find((event) => event?.kind === "dispatch" && event.executionId === firstExecutionId);
    const secondDispatch = created.events.find((event) => event?.kind === "dispatch" && event.executionId === secondExecutionId);
    const materializations = created.events.filter((event) => event?.kind === "source-materialized" && (event.executionId === firstExecutionId || event.executionId === secondExecutionId));
    const firstMaterialized = materializations.find((event) => event.executionId === firstExecutionId);
    const secondMaterialized = materializations.find((event) => event.executionId === secondExecutionId);
    const exactResults = first?.kind === "success" && second?.kind === "success"
      && first.result?.result?.rows?.[0]?.executions === 1 && second.result?.result?.rows?.[0]?.executions === 1;
    const sameChild = firstDispatch?.pid != null && firstDispatch.pid === secondDispatch?.pid
      && firstMaterialized?.pid === firstDispatch.pid && secondMaterialized?.pid === firstDispatch.pid;
    const fixtureRetainedFacts = fixture.snapshot?.coverage?.population?.retainedFacts;
    const oneMaterialization = fixtureRetainedFacts === 2 && materializations.length === 2 && firstMaterialized?.reused === false
      && secondMaterialized?.reused === true && firstMaterialized?.materializationId === secondMaterialized?.materializationId
      && firstMaterialized?.childReadCount === fixtureRetainedFacts && secondMaterialized?.childReadCount === 0;
    return {
      id: "same-generation-child-local-materialization-reuse",
      status: exactResults && sameChild && oneMaterialization ? "pass" : "fail",
      details: exactResults && sameChild && oneMaterialization
        ? "Two distinct same-generation queries received matching started acknowledgements from one child PID; the first read the fixture's retained two facts and the second reused the committed materialization without a new source read."
        : "Expected same-PID/materialization identity, first non-reused childReadCount equal to the fixture's retainedFacts=2, and second reused childReadCount=0 for two exact source-backed queries.",
    };
  } finally {
    try { await created.runtime.close(); } finally { created.dispose(); }
  }
}

async function exerciseSubscriberExecutionIdentityScenario(binding, fixture) {
  const gate = createDispatchGate();
  const created = await binding.create({ trustedSource: fixture.handoff, testControl: { beforeChildExecution: gate.wait } });
  if (created.kind !== "ready") return { id: "subscriber-execution-id-and-datum-key-isolation", status: created.kind === "missing-boundary" ? "blocked" : "fail", details: created.details };
  const pending = [];
  const track = (promise) => { pending.push(Promise.resolve(promise)); return promise; };
  try {
    const firstInput = await makeInput(created.runtime, boundSql(), integerParameter(53), fixture, "subscriber-identity-first");
    const secondInput = await makeInput(created.runtime, boundSql(), integerParameter(53), fixture, "subscriber-identity-second");
    const first = track(created.runtime.coordinator.subscribe(firstInput, new AbortController().signal));
    const entered = await gate.entered();
    const started = created.events.find((event) => event?.kind === "source-materialized" && event.executionId === firstInput.resolved.executionId);
    const second = track(created.runtime.coordinator.subscribe(secondInput, new AbortController().signal));
    gate.release();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    const firstResult = firstOutcome?.kind === "success" ? firstOutcome.result : null;
    const secondResult = secondOutcome?.kind === "success" ? secondOutcome.result : null;
    const dispatches = created.events.filter((event) => event?.kind === "dispatch");
    const resultIdentity = firstResult?.executionId === firstInput.resolved.executionId
      && secondResult?.executionId === secondInput.resolved.executionId
      && firstResult?.cache?.physicalExecutionKey != null
      && firstResult.cache.physicalExecutionKey === secondResult?.cache?.physicalExecutionKey
      && canonicalJson(firstResult?.result?.datumKeys) === canonicalJson(deriveExecutionDatumKeys(firstInput.resolved.executionId, firstResult?.result?.rows ?? []))
      && canonicalJson(secondResult?.result?.datumKeys) === canonicalJson(deriveExecutionDatumKeys(secondInput.resolved.executionId, secondResult?.result?.rows ?? []))
      && canonicalJson(firstResult?.result?.datumKeys) !== canonicalJson(secondResult?.result?.datumKeys);
    const oneChild = entered && started?.pid != null && dispatches.length === 1 && dispatches[0]?.pid === started.pid;
    return {
      id: "subscriber-execution-id-and-datum-key-isolation",
      status: resultIdentity && oneChild ? "pass" : "fail",
      details: resultIdentity && oneChild
        ? "Two subscribers shared one actual physical dispatch while retaining distinct execution IDs and deterministic execution-scoped datum keys."
        : "Expected two distinct subscriber execution IDs/datum-key sets on one physical key and one started child PID/dispatch.",
    };
  } finally {
    gate.release();
    try { await Promise.allSettled(pending); } finally {
      try { await created.runtime.close(); } finally { created.dispose(); }
    }
  }
}

async function exerciseSubscriberIsolationScenario(binding, fixture) {
  const gate = createDispatchGate();
  const created = await binding.create({ trustedSource: fixture.handoff, testControl: { beforeChildExecution: gate.wait } });
  if (created.kind !== "ready") return { id: "subscriber-isolation-shared-work", status: created.kind === "missing-boundary" ? "blocked" : "fail", details: created.details };
  const pending = [];
  const track = (promise) => { pending.push(Promise.resolve(promise)); return promise; };
  try {
    const input = await makeInput(created.runtime, boundSql(), integerParameter(31), fixture, "subscriber-shared");
    const firstController = new AbortController();
    const first = track(created.runtime.coordinator.subscribe(input, firstController.signal));
    const entered = await gate.entered();
    const childStarted = created.events.find((event) => event?.kind === "source-materialized" && event.executionId === input.resolved.executionId);
    const second = track(created.runtime.coordinator.subscribe(input, new AbortController().signal));
    firstController.abort();
    gate.release();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    const dispatches = created.events.filter((event) => event?.kind === "dispatch" && event.executionId === input.resolved.executionId);
    const sameActiveChild = childStarted?.pid != null && dispatches.length === 1 && dispatches[0]?.pid === childStarted.pid;
    return { id: "subscriber-isolation-shared-work", status: entered && sameActiveChild && isError(firstOutcome, "cancelled") && secondOutcome?.kind === "success" ? "pass" : "fail", details: entered && sameActiveChild && isError(firstOutcome, "cancelled") && secondOutcome?.kind === "success" ? "After the actual child started, one subscriber detached while a second joined the same active physical execution and received its exact result." : "Expected post-child-start cancellation, a second subscriber on the same active PID, one dispatch, and second-subscriber success." };
  } finally {
    gate.release();
    try { await Promise.allSettled(pending); } finally {
      try { await created.runtime.close(); } finally { created.dispose(); }
    }
  }
}

async function exerciseDeadlineRecoveryScenario(binding, fixture) {
  const gate = createDispatchGate();
  const timedRuntime = await binding.create({ trustedSource: fixture.handoff, testControl: { beforeChildExecution: gate.wait } });
  if (timedRuntime.kind !== "ready") return { id: "deadline-termination-and-next-query-recovery", status: timedRuntime.kind === "missing-boundary" ? "blocked" : "fail", details: timedRuntime.details };
  let timed;
  try {
    const pending = timedRuntime.runtime.worker.execute(await makeInput(timedRuntime.runtime, boundSql(), integerParameter(41), fixture, "deadline"), new AbortController().signal);
    const entered = await gate.entered();
    timed = await pending;
    const executionId = "analytics-exec_acceptance_runtime_deadline";
    const requested = timedRuntime.events.find((event) => event?.kind === "kill-requested" && event.executionId === executionId);
    const exited = timedRuntime.events.find((event) => event?.kind === "child-exit" && event.pid === requested?.pid);
    const dispatchedBeforeContinue = timedRuntime.events.some((event) => event?.kind === "dispatch" && event.executionId === executionId);
    if (!entered || !isError(timed, "query-timeout") || requested == null || exited == null || dispatchedBeforeContinue)
      return { id: "deadline-termination-and-next-query-recovery", status: "fail", details: `Expected pre-continue child stall, typed timeout, no dispatch, and pid-correlated kill-requested then child-exit (entered=${entered}, timed=${timed?.kind}/${timed?.error?.code}, dispatched=${dispatchedBeforeContinue}, requested=${requested != null}, exited=${exited != null}).` };
  } finally {
    gate.release();
    await timedRuntime.runtime.close();
    timedRuntime.dispose();
  }
  const recoveryRuntime = await binding.create({ trustedSource: fixture.handoff });
  if (recoveryRuntime.kind !== "ready") return { id: "deadline-termination-and-next-query-recovery", status: recoveryRuntime.kind === "missing-boundary" ? "blocked" : "fail", details: recoveryRuntime.details };
  try {
    const recovery = await recoveryRuntime.runtime.worker.execute(await makeInput(recoveryRuntime.runtime, boundSql(), integerParameter(42), fixture, "deadline-recovery"), new AbortController().signal);
    return { id: "deadline-termination-and-next-query-recovery", status: recovery?.kind === "success" && recovery.result?.result?.rows?.[0]?.bound_value === 42 ? "pass" : "fail", details: recovery?.kind === "success" && recovery.result?.result?.rows?.[0]?.bound_value === 42 ? "A fixed scalar query recovered in a fresh real child after confirmed deadline termination." : "Expected correct result from a fresh real runtime after deadline termination." };
  } finally {
    await recoveryRuntime.runtime.close();
    recoveryRuntime.dispose();
  }
}

async function exerciseActiveChildCloseScenario(binding, fixture) {
  const gate = createDispatchGate();
  const created = await binding.create({ trustedSource: fixture.handoff, testControl: { beforeChildExecution: gate.wait } });
  if (created.kind !== "ready") return { id: "active-child-close-drain-and-no-overlap", status: created.kind === "missing-boundary" ? "blocked" : "fail", details: created.details };
  let closeFinished = false;
  try {
    const executionId = "analytics-exec_acceptance_runtime_close-active";
    const pending = created.runtime.worker.execute(await makeInput(created.runtime, boundSql(), integerParameter(71), fixture, "close-active"), new AbortController().signal);
    const active = await gate.entered();
    const started = created.events.find((event) => event?.kind === "source-materialized" && event.executionId === executionId);
    const closeOutcome = await settleWithin(created.runtime.close(), 1_000);
    closeFinished = closeOutcome.kind === "fulfilled";
    if (!closeFinished)
      return { id: "active-child-close-drain-and-no-overlap", status: "fail", details: "close() did not settle within the bounded active-child drain window." };
    const pendingOutcome = await settleWithin(pending, 1_000);
    const exitIndex = created.events.findIndex((event) => event?.kind === "child-exit" && event.pid === started?.pid);
    const closeIndex = created.events.findIndex((event) => event?.kind === "close-confirmed" && event.pid === started?.pid);
    const closeEvent = created.events[closeIndex];
    const dispatchedBeforeClose = created.events.some((event) => event?.kind === "dispatch" && event.executionId === executionId);
    const closedActiveChild = active && closeOutcome.kind === "fulfilled" && started?.pid != null && !dispatchedBeforeClose
      && exitIndex >= 0 && closeIndex > exitIndex
      && closeEvent?.queued === 0 && closeEvent?.entries === 0 && closeEvent?.bytes === 0
      && pendingOutcome.kind === "fulfilled" && pendingOutcome.value?.kind !== "success";
    const recovery = await binding.create({ trustedSource: fixture.handoff });
    if (recovery.kind !== "ready") return { id: "active-child-close-drain-and-no-overlap", status: recovery.kind === "missing-boundary" ? "blocked" : "fail", details: recovery.details };
    try {
      const recovered = await recovery.runtime.worker.execute(await makeInput(recovery.runtime, boundSql(), integerParameter(72), fixture, "close-recovery"), new AbortController().signal);
      const priorExit = created.events[exitIndex];
      const nextSpawn = recovery.events.find((event) => event?.kind === "child-spawn");
      const noOverlap = priorExit?.monotonicMs != null && nextSpawn?.monotonicMs != null && nextSpawn.monotonicMs >= priorExit.monotonicMs;
      const recoveredExact = recovered?.kind === "success" && recovered.result?.result?.rows?.[0]?.bound_value === 72;
      return {
        id: "active-child-close-drain-and-no-overlap",
        status: closedActiveChild && noOverlap && recoveredExact ? "pass" : "fail",
        details: closedActiveChild && noOverlap && recoveredExact
          ? "close() resolved only after its actual active child PID exited and tracked queue/cache state drained; a later child began no earlier than that exit."
          : "Expected active-PID exit before close-confirmed/close resolution, exact zero tracked queue/cache state, settled active work, and recovery child spawn after the old exit.",
      };
    } finally {
      try { await recovery.runtime.close(); } finally { recovery.dispose(); }
    }
  } finally {
    gate.release();
    try {
      if (!closeFinished) await created.runtime.close();
    } finally {
      created.dispose();
    }
  }
}

async function exerciseCloseBeforeDispatchNoSpawnScenario(binding, fixture) {
  const gate = createDispatchGate();
  const created = await binding.create({ trustedSource: fixture.handoff, testControl: { beforeDispatch: gate.wait } });
  if (created.kind !== "ready") return { id: "close-before-dispatch-does-not-spawn", status: created.kind === "missing-boundary" ? "blocked" : "fail", details: created.details };
  let closeFinished = false;
  try {
    // Real two-phase admission may legitimately start the locked child. Only
    // operations after this baseline are subject to the no-work oracle.
    const input = await makeInput(created.runtime, boundSql(), integerParameter(73), fixture, "close-before-dispatch");
    const admissionActivity = workerActivityCounts(created.events);
    const admittedPids = new Set(created.events.filter((event) => event?.kind === "child-spawn").map((event) => event.pid));
    const pending = created.runtime.worker.execute(input, new AbortController().signal);
    const entered = await settleWithin(gate.entered(), 1_000);
    const closed = await settleWithin(created.runtime.close(), 1_000);
    closeFinished = closed.kind === "fulfilled";
    const outcome = await settleWithin(pending, 1_000);
    const afterCloseActivity = workerActivityCounts(created.events);
    const noNewExecutionWork = afterCloseActivity.childSpawns === admissionActivity.childSpawns
      && afterCloseActivity.materializations === admissionActivity.materializations
      && afterCloseActivity.dispatches === admissionActivity.dispatches;
    const admittedChildCleaned = admittedPids.size > 0 && [...admittedPids].every((pid) =>
      created.events.some((event) => event?.kind === "child-exit" && event.pid === pid)
      && created.events.some((event) => event?.kind === "close-confirmed" && event.pid === pid),
    );
    return {
      id: "close-before-dispatch-does-not-spawn",
      status: entered.kind === "fulfilled" && closeFinished && outcome.kind === "fulfilled" && isError(outcome.value, "cancelled") && noNewExecutionWork && admittedChildCleaned ? "pass" : "fail",
      details: entered.kind === "fulfilled" && closeFinished && outcome.kind === "fulfilled" && isError(outcome.value, "cancelled") && noNewExecutionWork && admittedChildCleaned
        ? "Closing an admitted job held before dispatch settled it as cancelled, added no post-admission worker activity, and confirmed cleanup of the admitted child."
        : "Expected close while beforeDispatch is held to settle cancellation, add no post-admission spawn/materialization/dispatch, and clean up the admitted child.",
    };
  } finally {
    gate.release();
    try {
      if (!closeFinished) await created.runtime.close();
    } finally {
      created.dispose();
    }
  }
}

function workerActivityCounts(events) {
  return {
    childSpawns: events.filter((event) => event?.kind === "child-spawn").length,
    materializations: events.filter((event) => event?.kind === "source-materialized").length,
    dispatches: events.filter((event) => event?.kind === "dispatch").length,
  };
}

async function withDispatchGate(binding, fixture, resourceLimits, operation) {
  const gate = createDispatchGate();
  const created = await binding.create({ trustedSource: fixture.handoff, resourceLimits, testControl: { beforeDispatch: gate.wait } });
  if (created.kind !== "ready") return { id: "queue-runtime-boundary", status: created.kind === "missing-boundary" ? "blocked" : "fail", details: created.details };
  const pending = [];
  const track = (promise) => { pending.push(Promise.resolve(promise)); return promise; };
  try {
    const result = await operation({ runtime: created.runtime, gate, events: created.events, track });
    return created.observationFailure == null ? result : { id: result.id, status: "fail", details: created.observationFailure };
  } finally {
    gate.release();
    try {
      await Promise.allSettled(pending);
    } finally {
      try {
        await created.runtime.close();
      } finally {
        created.dispose();
      }
    }
  }
}

function createDispatchGate() {
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  return { wait: async () => { enter(true); await held; }, entered: () => entered, release: () => release() };
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then((value) => ({ kind: "fulfilled", value }), (reason) => ({ kind: "rejected", reason })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function boundSql() { return "SELECT CAST($value AS INTEGER) AS bound_value"; }
function textSql() { return "SELECT CAST($value AS VARCHAR) AS bound_value"; }
function integerParameter(value) { return [{ name: "value", logicalType: "integer", value }]; }
function textParameter(value) { return [{ name: "value", logicalType: "utf8", value }]; }


function assertBoundResult(outcome) {
  const value = outcome?.kind === "success" ? outcome.result?.result?.rows?.[0]?.bound_value : undefined;
  return {
    id: "parameter-binding-real-worker-result",
    status: value === 7 ? "pass" : "fail",
    details: value === 7
      ? "Real worker returned the bound integer value, rather than interpolated assertion data."
      : "Expected real worker result bound_value=7; wrong or missing result is nonpassing.",
  };
}

function assertResultBytes(outcome) {
  const result = outcome?.kind === "success" ? outcome.result?.result : null;
  if (result == null)
    return { id: "canonical-result-byte-bound", status: "fail", details: "No real successful result exists to independently measure canonical result bytes." };
  const measured = new TextEncoder().encode(canonicalJson({ columns: result.columns, rows: result.rows, datumKeys: result.datumKeys, resultExtent: result.resultExtent, resultTruncated: result.resultTruncated })).byteLength;
  const valid = result.encodedBytes === measured && measured <= EXECUTION_LIMITS.maxCanonicalResultBytes;
  return { id: "canonical-result-byte-bound", status: valid ? "pass" : "fail", details: valid ? `Independently measured canonical result bytes=${measured}, within ${EXECUTION_LIMITS.maxCanonicalResultBytes}.` : `Result byte evidence is invalid: reported=${result.encodedBytes}, measured=${measured}, limit=${EXECUTION_LIMITS.maxCanonicalResultBytes}.` };
}

function assertLifecycleEvidence(events) {
  if (!Array.isArray(events) || events.some((event) => !validEvent(event)))
    return { id: "trusted-bootstrap-before-real-dispatch", status: "fail", details: "Observer was silent or emitted malformed lifecycle data; missing observability is nonpassing." };
  const dispatches = events.map((event, index) => ({ event, index })).filter(({ event }) => event.kind === "dispatch");
  const chains = dispatches.map(({ event: dispatch, index }) => lifecycleChainForDispatch(events, dispatch, index));
  const kills = events.map((event, index) => ({ event, index })).filter(({ event }) => event.kind === "kill-requested");
  const diagnostics = {
    dispatches: dispatches.length,
    chains: chains.filter((chain) => chain.complete).length,
    pid: chains.every((chain) => chain.pid),
    fingerprint: chains.every((chain) => chain.fingerprint),
    source: chains.every((chain) => chain.source),
    uninterrupted: chains.every((chain) => chain.uninterrupted),
    initialRead: chains.some((chain) => chain.initialRead),
    monotonic: events.every((event, index) => index === 0 || event.monotonicMs >= events[index - 1].monotonicMs),
    killExit: kills.every(({ event: kill, index }) => events.slice(index + 1).some((event) => event.kind === "child-exit" && event.pid === kill.pid)),
    noDispatchAfterKill: kills.every(({ event: kill, index }) => !events.slice(index + 1).some((event) => event.kind === "dispatch" && event.pid === kill.pid)),
  };
  const ordered = diagnostics.dispatches > 0 && diagnostics.chains === diagnostics.dispatches
    && diagnostics.pid && diagnostics.fingerprint && diagnostics.source
    && diagnostics.uninterrupted && diagnostics.initialRead && diagnostics.monotonic && diagnostics.killExit && diagnostics.noDispatchAfterKill;
  return {
    id: "trusted-bootstrap-before-real-dispatch",
    status: ordered ? "pass" : "fail",
    details: ordered
      ? "Every real dispatch was preceded on its own uninterrupted child PID by locked bootstrap and matching execution source materialization; reused sources retained zero new reads only after a committed same-PID materialization."
      : "Lifecycle predicate failure=" + JSON.stringify(diagnostics) + ".",
  };
}

function lifecycleChainForDispatch(events, dispatch, dispatchIndex) {
  const sourceIndex = findLastIndex(events, dispatchIndex - 1, (event) => event.kind === "source-materialized" && event.pid === dispatch?.pid && event.executionId === dispatch?.executionId);
  const source = sourceIndex < 0 ? null : events[sourceIndex];
  const readyIndex = sourceIndex < 0 ? -1 : findLastIndex(events, sourceIndex - 1, (event) => event.kind === "bootstrap-ready" && event.pid === dispatch?.pid);
  const ready = readyIndex < 0 ? null : events[readyIndex];
  const spawnIndex = readyIndex < 0 ? -1 : findLastIndex(events, readyIndex - 1, (event) => event.kind === "child-spawn" && event.pid === dispatch?.pid);
  const interrupted = spawnIndex < 0 ? true : events.slice(spawnIndex + 1, dispatchIndex).some((event) =>
    event.pid === dispatch?.pid && (event.kind === "kill-requested" || event.kind === "child-exit"),
  );
  const sourceRead = source?.reused === false && Number.isInteger(source.childReadCount) && source.childReadCount > 0;
  const priorCommitted = source?.reused === true && source.childReadCount === 0
    && events.slice(0, sourceIndex).some((event) => event.kind === "source-materialized"
      && event.pid === dispatch?.pid && event.reused === false && event.childReadCount > 0
      && event.materializationId === source.materializationId);
  return {
    complete: spawnIndex >= 0 && readyIndex > spawnIndex && sourceIndex > readyIndex && dispatchIndex > sourceIndex,
    pid: dispatch?.pid != null && source?.pid === dispatch.pid && ready?.pid === dispatch.pid && events[spawnIndex]?.pid === dispatch.pid,
    fingerprint: ready?.bootstrapFingerprint === expectedBootstrapFingerprint(),
    source: sourceRead || priorCommitted,
    uninterrupted: !interrupted,
    initialRead: sourceRead,
  };
}

function findLastIndex(values, from, predicate) {
  for (let index = from; index >= 0; index -= 1) if (predicate(values[index])) return index;
  return -1;
}

function assertQueueEvidence(events) {
  const dispatches = events.filter((event) => event?.kind === "dispatch");
  if (dispatches.length === 0)
    return { id: "queue-and-cache-observability", status: "fail", details: "No actual dispatch observation; cache and queue claims cannot pass." };
  const boundedCounts = dispatches.every((event) => Number.isInteger(event.queued) && event.queued >= 0 && event.queued <= EXECUTION_LIMITS.maxQueuedExecutions && Number.isInteger(event.queuedBytes) && event.queuedBytes >= 0 && event.queuedBytes <= EXECUTION_LIMITS.maxQueuedBytes && Number.isInteger(event.sqlExecutionCount) && event.sqlExecutionCount >= 0);
  const cacheEvents = events.filter((event) => event?.kind === "cache");
  if (!boundedCounts || cacheEvents.length === 0)
    return { id: "queue-and-cache-observability", status: "fail", details: "Dispatch/cache observations lack bounded aggregate queue counts or cache events." };
  return { id: "queue-and-cache-observability", status: "pass", details: "Actual dispatch/cache observations expose bounded aggregate count/bytes and SQL execution counts; scenario checks independently verify overflow behavior." };
}

function expectedBootstrapFingerprint() {
  return createHash("sha256").update(canonicalJson({
    packageName: SELECTED_EXECUTION_RUNTIME.packageName,
    packageVersion: SELECTED_EXECUTION_RUNTIME.packageVersion,
    bootstrap: SELECTED_EXECUTION_RUNTIME.bootstrap,
  })).digest("hex");
}

function assertObserverEvidence(failure) {
  return {
    id: "bounded-well-formed-observer",
    status: failure == null ? "pass" : "fail",
    details: failure == null ? "Observer remained within the test-owned bounded lifecycle capture." : failure,
  };
}

function validEvent(event) {
  return event != null && typeof event === "object" && typeof event.kind === "string"
    && typeof event.monotonicMs === "number" && Number.isFinite(event.monotonicMs);
}

function canonicalJson(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}


function isError(outcome, code) {
  return outcome?.kind === "error" && outcome.error?.code === code;
}

function blocked(id, details, entryPath) {
  return {
    suite: "query-runtime",
    status: "blocked",
    checks: [{ id, status: "blocked", details: entryPath ? `${details} (${entryPath})` : details }],
    limits: runtimeLimits(),
  };
}

function failed(id, details, entryPath) {
  return {
    suite: "query-runtime",
    status: "fail",
    checks: [{ id, status: "fail", details: entryPath ? `${details} (${entryPath})` : details }],
    limits: runtimeLimits(),
  };
}

function runtimeLimits() {
  return [
    `SQL ${EXECUTION_LIMITS.maxSqlBytes} bytes; AST ${EXECUTION_LIMITS.maxAstNodes}; deadline ${EXECUTION_LIMITS.queryDeadlineMs}ms.`,
    `Queue ${EXECUTION_LIMITS.maxQueuedExecutions}; canonical result/cache ${EXECUTION_LIMITS.maxCanonicalResultBytes} bytes.`,
    "Normal mode requires real isolated-worker/coordinator operations and actual lifecycle observations; instrument-self-test is not acceptance evidence.",
  ];
}

async function runInstrumentSelfTest() {
  const wrong = assertBoundResult({ kind: "success", result: { result: { rows: [{ bound_value: 8 }] } } });
  const overlap = assertLifecycleEvidence([{ kind: "child-spawn", monotonicMs: 1 }, { kind: "dispatch", monotonicMs: 2 }, { kind: "bootstrap-ready", monotonicMs: 3 }]);
  const silent = assertLifecycleEvidence([]);
  const malformed = assertLifecycleEvidence([{ kind: "child-spawn" }]);
  const lifecycleControls = selfLifecycleControls();
  const failedControl = isError({ kind: "success" }, "invalid-request");
  const rawObserverRejected = !isAllowedObserverEvent({ kind: "kill-requested", monotonicMs: 1, executionId: "analytics-exec_selftest_id", pid: 7, reason: "SELECT private" });
  const fixture = selfScenarioFixture();
  const binding = selfScenarioBinding();
  const admissionDiagnostics = await selfPositiveAdmissionDiagnostics(fixture);
  const parameterBridgeControls = runParameterBridgeControls();
  const schedulerControls = await runSchedulerControls({ fixture, makeInput, canonicalJson });
  const scenarioResults = [];
  for (const [index, makeScenario] of [
    () => exerciseQueueCountScenario(binding, fixture),
    () => exerciseQueueAggregateByteScenario(binding, fixture),
    () => exerciseQueueOversizedDescriptorScenario(binding, fixture),
    () => exerciseResultLimitRecovery(binding, fixture),
    () => exerciseMaterializationDeadlineRecovery(binding, fixture),
    () => exerciseSubscriberIsolationScenario(binding, fixture),
    () => exerciseDeadlineRecoveryScenario(binding, fixture),
  ].entries()) scenarioResults.push(await Promise.race([makeScenario(), new Promise((resolve) => setTimeout(() => resolve({ id: "scenario-" + index, status: "fail", details: "scenario self-control timeout" }), 500))]));
  const checks = [
    { id: "self-test-wrong-result-detected", status: wrong.status === "fail" ? "pass" : "fail", details: "Deliberately wrong bound result (8) must fail assertion logic." },
    { id: "self-test-overlap-order-detected", status: overlap.status === "fail" ? "pass" : "fail", details: "Deliberately dispatch-before-lock lifecycle must fail assertion logic." },
    { id: "self-test-failed-control-detected", status: failedControl === false ? "pass" : "fail", details: "A success outcome must not satisfy the required parser-denial control." },
    { id: "self-test-silent-observer-detected", status: silent.status === "fail" ? "pass" : "fail", details: "A silent lifecycle observer cannot pass acceptance." },
    { id: "self-test-malformed-observer-detected", status: malformed.status === "fail" ? "pass" : "fail", details: "A malformed lifecycle observer cannot pass acceptance." },
    { id: "self-test-per-dispatch-lifecycle-chain-controls", status: lifecycleControls.pass ? "pass" : "fail", details: lifecycleControls.pass ? "A retired denied-admission PID before a valid replacement chain passes; wrong PID/fingerprint, missing source, intervening exit, and reused-read mutations each fail." : "Per-dispatch lifecycle chain assertion controls failed." },
    { id: "self-test-raw-observer-value-detected", status: rawObserverRejected ? "pass" : "fail", details: "Raw SQL in an allowed reason field is rejected by the closed observer value schema." },
    admissionDiagnostics,
    { id: "self-test-operation-scenarios", status: scenarioResults.every((result) => result.status === "pass") ? "pass" : "fail", details: scenarioResults.every((result) => result.status === "pass") ? "Controlled self-test binding called each queue/subscriber/deadline scenario; this proves assertion wiring only, never production behavior." : scenarioResults.filter((result) => result.status !== "pass").map((result) => `${result.id ?? "timeout"}:${result.details}`).join(",") },
    ...parameterBridgeControls,
    ...schedulerControls,
  ];
  return { suite: "query-runtime", status: checks.every((check) => check.status === "pass") ? "pass" : "fail", checks, limits: ["Instrument-self-test only: controlled values prove assertion logic, not production runtime behavior."] };
}

function selfLifecycleControls() {
  const baseline = selfLifecycleEvents();
  const wrongPid = structuredClone(baseline);
  wrongPid.find((event) => event.kind === "source-materialized" && event.executionId.endsWith("first")).pid = 23;
  const wrongFingerprint = structuredClone(baseline);
  wrongFingerprint.find((event) => event.kind === "bootstrap-ready" && event.pid === 22).bootstrapFingerprint = "b".repeat(64);
  const missingSource = baseline.filter((event) => !(event.kind === "source-materialized" && event.executionId.endsWith("first")));
  const interveningExit = structuredClone(baseline);
  const firstSource = interveningExit.findIndex((event) => event.kind === "source-materialized" && event.executionId.endsWith("first"));
  interveningExit.splice(firstSource + 1, 0, { kind: "child-exit", monotonicMs: 7.5, pid: 22, executionId: "analytics-exec_selftest_lifecycle_first" });
  const reusedRead = structuredClone(baseline);
  reusedRead.find((event) => event.kind === "source-materialized" && event.executionId.endsWith("second")).childReadCount = 1;
  return {
    pass: assertLifecycleEvidence(baseline).status === "pass"
      && assertLifecycleEvidence(wrongPid).status === "fail"
      && assertLifecycleEvidence(wrongFingerprint).status === "fail"
      && assertLifecycleEvidence(missingSource).status === "fail"
      && assertLifecycleEvidence(interveningExit).status === "fail"
      && assertLifecycleEvidence(reusedRead).status === "fail",
  };
}

function selfLifecycleEvents() {
  const fingerprint = expectedBootstrapFingerprint();
  return [
    { kind: "child-spawn", monotonicMs: 1, pid: 21 },
    { kind: "bootstrap-ready", monotonicMs: 2, pid: 21, bootstrapFingerprint: fingerprint },
    { kind: "kill-requested", monotonicMs: 3, pid: 21, executionId: "analytics-exec_selftest_lifecycle_denied" },
    { kind: "child-exit", monotonicMs: 4, pid: 21, executionId: "analytics-exec_selftest_lifecycle_denied" },
    { kind: "child-spawn", monotonicMs: 5, pid: 22 },
    { kind: "bootstrap-ready", monotonicMs: 6, pid: 22, bootstrapFingerprint: fingerprint },
    { kind: "source-materialized", monotonicMs: 7, pid: 22, executionId: "analytics-exec_selftest_lifecycle_first", materializationId: "a".repeat(64), childReadCount: 2, reused: false },
    { kind: "dispatch", monotonicMs: 8, pid: 22, executionId: "analytics-exec_selftest_lifecycle_first" },
    { kind: "source-materialized", monotonicMs: 9, pid: 22, executionId: "analytics-exec_selftest_lifecycle_second", materializationId: "a".repeat(64), childReadCount: 0, reused: true },
    { kind: "dispatch", monotonicMs: 10, pid: 22, executionId: "analytics-exec_selftest_lifecycle_second" },
  ];
}

async function selfPositiveAdmissionDiagnostics(fixture) {
  const capture = async (label, code) => {
    try {
      await makeInput({ admitQuery: async () => ({ kind: "error", error: { code } }) }, "", [], fixture, label);
    } catch (cause) {
      return cause;
    }
    return null;
  };
  const known = await capture("known-admission", "result-limit");
  const unknownCode = await capture("unknown-code-admission", "not-a-whitelisted-outcome");
  const unsafeLabel = await capture("unsafe label", "result-limit");
  let unrelatedRethrown = false;
  const unrelated = new TypeError("self-test unrelated failure");
  try {
    positiveAdmissionStageFailureOrThrow(unrelated);
  } catch (cause) {
    unrelatedRethrown = cause === unrelated;
  }
  const knownStage = positiveAdmissionStageFailure(known);
  const unknownStage = positiveAdmissionStageFailure(unknownCode);
  const unsafeLabelStage = positiveAdmissionStageFailure(unsafeLabel);
  const sanitized = knownStage?.checks?.[0]?.details === "scenario=known-admission; outcome=result-limit."
    && unknownStage?.checks?.[0]?.details === "scenario=unknown-code-admission; outcome=unrecognized."
    && unsafeLabelStage?.checks?.[0]?.details === "scenario=unknown-positive-draft; outcome=result-limit.";
  return {
    id: "self-test-positive-admission-diagnostic-sanitization",
    status: sanitized && unrelatedRethrown ? "pass" : "fail",
    details: sanitized && unrelatedRethrown
      ? "Known/unknown admission outcomes and unsafe labels are closed-sanitized; unrelated failures still throw."
      : "Positive-admission diagnostic sanitization or unrelated-error rethrow behavior failed.",
  };
}

function selfScenarioFixture() {
  const now = 1_728_000_000_000;
  const sourceScope = { scopeKey: "analytics-scope_selftest_runtime", projection: "tool_execution_fact_v1", storage: "plugin-owned-sqlite" };
  const coverage = { coverageRevision: 1, retention: { startInclusiveMs: now - 86_400_000, earliestVerifiedRetainedInclusiveMs: now - 86_400_000, endExclusiveMs: now, policyDays: 90 }, observed: { earliestFactMs: now - 1, latestFactMs: now - 1, asOfMs: now, projectionGeneration: 1, projectionRevision: revision }, population: { candidateThreads: 1, selectedThreads: 1, loadedThreads: 1, retainedFacts: 1, cappedThreads: 0, listPages: 1, eventPages: 1, eventBytes: 1, safeFailureCount: 0, lastSafeFailureAtMs: null, candidateThreadLimit: 1, threadPageLimit: 1, eventPageLimit: 1, maxEventsPerThread: 1, maxEventBytes: 1 }, mode: "complete-retained-projection", incompleteReasons: [], backfill: { state: "complete", direction: "newest-to-oldest", completeRange: { startInclusiveMs: now - 86_400_000, endExclusiveMs: now }, resumable: true }, reconciliation: { observedAsOfMs: now, lastFullReconciliationAtMs: now, deletionConfirmation: "confirmed", sourceSemantics: "eventually-reconciled-observed-as-of" }, degraded: false };
  return { snapshot: { version: 2, snapshotId: "analytics-snapshot_selftest_runtime", sourceScope, frozenRange: { startInclusiveMs: now - 1, endExclusiveMs: now }, capturedAtMs: now, coverage }, handoff: { kind: "generation-checked-stream", sourceScope, snapshotId: "analytics-snapshot_selftest_runtime", sourceGeneration: 1, factProjectionVersion: 4, maxChunkBytes: EXECUTION_LIMITS.maxTransferChunkBytes, maxRowsPerChunk: EXECUTION_LIMITS.maxTransferRowsPerChunk } };
}

function selfScenarioBinding() {
  return {
    async create({ testControl } = {}) {
      const events = [];
      let sharedGateUsed = false;
      const outcome = (input, signal, child = false) => {
        const id = input.resolved.executionId;
        if (id.endsWith("_result-limit-text")) return (async () => {
          events.push({ kind: "dispatch", monotonicMs: 1, pid: 7, executionId: id, queued: 0, queuedBytes: 0, sqlExecutionCount: 1 });
          return { kind: "error", error: { code: "result-limit" } };
        })();
        if (id.includes("overflow") || (id.includes("oversized") && !id.endsWith("active")) || id.includes("byte-second")) return Promise.resolve({ kind: "error", error: { code: "queue-full" } });
        if (child && id.endsWith("_materialization-timeout")) return (async () => { void testControl?.beforeMaterializationCommit?.("selftest-checkpoint"); events.push({ kind: "kill-requested", monotonicMs: 2, pid: 7, executionId: id }); events.push({ kind: "child-exit", monotonicMs: 3, pid: 7, executionId: id }); return { kind: "error", error: { code: "materialization-timeout" } }; })();
        if (child && id.endsWith("_deadline")) return (async () => { void testControl?.beforeChildExecution?.(); events.push({ kind: "kill-requested", monotonicMs: 2, pid: 7, executionId: id }); events.push({ kind: "child-exit", monotonicMs: 3, pid: 7, executionId: id }); return { kind: "error", error: { code: "query-timeout" } }; })();
        return (async () => {
          const shared = id.includes("subscriber-shared");
          if (shared && !sharedGateUsed) {
            sharedGateUsed = true;
            events.push({ kind: "source-materialized", monotonicMs: 1, pid: 7, executionId: id, materializationId: "c".repeat(64), childReadCount: 1, reused: false });
            await testControl?.beforeChildExecution?.();
            events.push({ kind: "dispatch", monotonicMs: 2, pid: 7, executionId: id, queued: 0, queuedBytes: 0, sqlExecutionCount: 1 });
          } else if (!shared) {
            // The controlled self-test double only holds the one active queue
            // operation.  The scenario deliberately constructs its later
            // descriptors before releasing that gate, so holding every fake
            // subscription here would deadlock the assertion harness rather
            // than exercise its active-versus-queued assertions.
            const activeQueueOperation = id.endsWith("_queue-count-active")
              || id.endsWith("_queue-byte-active")
              || id.endsWith("_queue-oversized-active");
            if (activeQueueOperation) await testControl?.beforeDispatch?.();
            events.push({ kind: "dispatch", monotonicMs: 1, pid: 7, executionId: id, queued: 0, queuedBytes: 0, sqlExecutionCount: 1 });
          }
          if (signal?.aborted) return { kind: "error", error: { code: "cancelled" } };
          if (child && id.endsWith("_materialization-recovery")) {
            events.push({ kind: "child-spawn", monotonicMs: 4, pid: 8, entrySha256: "a".repeat(64) });
            events.push({ kind: "source-materialized", monotonicMs: 5, pid: 8, executionId: id, materializationId: "b".repeat(64), childReadCount: 1, reused: false });
            return { kind: "success", result: { result: { rows: [{ executions: 1 }] } } };
          }
          const value = input.resolved.query.parameters[0]?.value;
          return { kind: "success", result: { result: { rows: [{ bound_value: value }] } } };
        })();
      };
      const runtime = {
        admitQuery: async ({ cacheability }) => ({ kind: "admitted", admission: { astPolicyRevision: revision, astNodeCount: 12, sqlSha256: revision, parameterDeclarationDigest: revision, cacheability } }),
        worker: { execute: (input, signal) => outcome(input, signal, true), close: async () => {} },
        coordinator: { subscribe: (input, signal) => outcome(input, signal) },
        close: async () => {},
      };
      return { kind: "ready", runtime, events, observationFailure: null, dispose() {} };
    },
  };
}
