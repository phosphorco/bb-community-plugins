import { loadProductionRuntimeBinding } from "./binding.mjs";
import { createOwnStoreFixture } from "./fixture.mjs";
import { makeInput } from "../query-runtime.mjs";

/**
 * A deliberately narrow real-boundary control, kept separate from the full
 * runtime suite so its single production execution may be explicitly
 * authorized and supervised. It does not contain a DuckDB harness, parser,
 * worker, or parameter emulation: each input is admitted through the real
 * runtime and then executed by that same factory.
 */
export async function runSuite(options = {}) {
  if ((options.mode ?? "acceptance") !== "acceptance") {
    return {
      suite: "query-runtime-named-binding",
      status: "blocked",
      checks: [{ id: "named-binding-real-boundary", status: "blocked", details: "This control has no synthetic success mode; it requires the real runtime boundary." }],
      limits: ["Run only after explicit execution clearance; one synthetic own-store fixture, one runtime, two fixed scalar executions."],
    };
  }

  const binding = await loadProductionRuntimeBinding();
  if (binding.kind === "missing-boundary") return blocked("production-runtime-boundary", "The production runtime boundary is unavailable.");
  if (binding.kind !== "ready") return failed("production-runtime-import", "The production runtime boundary could not be imported.");

  const fixtureResult = await createOwnStoreFixture();
  if (fixtureResult.kind === "missing-boundary") return blocked("production-own-store-fixture", "The test-owned synthetic AnalyticsStore fixture boundary is unavailable.");
  if (fixtureResult.kind !== "ready") return failed("production-own-store-fixture", "The test-owned synthetic AnalyticsStore fixture could not be prepared.");
  const fixture = fixtureResult.fixture;
  try {
    const created = await binding.create({ trustedSource: fixture.handoff });
    if (created.kind === "missing-boundary") return blocked("production-runtime-constructor", "The production runtime constructor boundary is unavailable.");
    if (created.kind !== "ready") return failed("production-runtime-constructor", "The production runtime constructor could not be created.");
    try {
      // a1 sorts before a_2 by strict code-unit ordering. Supplying the
      // declarations in the reverse order proves the real admission digest
      // and driver binding do not rely on locale ordering or caller order.
      const reversed = await makeInput(
        created.runtime,
        "SELECT CAST($a_2 AS INTEGER) AS second, CAST($a1 AS INTEGER) AS first",
        [
          { name: "a_2", logicalType: "integer", value: 9 },
          { name: "a1", logicalType: "integer", value: 2 },
        ],
        fixture,
        "named-binding-lexical-order",
      );
      const repeated = await makeInput(
        created.runtime,
        "SELECT CAST($value AS INTEGER) AS first, CAST($value AS INTEGER) AS second",
        [{ name: "value", logicalType: "integer", value: 7 }],
        fixture,
        "named-binding-repeated-marker",
      );
      const reversedBefore = resolvedQueryProvenance(reversed);
      const repeatedBefore = resolvedQueryProvenance(repeated);
      const first = await created.runtime.worker.execute(reversed, new AbortController().signal);
      const second = await created.runtime.worker.execute(repeated, new AbortController().signal);
      const reversedUnchanged = sameResolvedQueryProvenance(reversedBefore, resolvedQueryProvenance(reversed));
      const repeatedUnchanged = sameResolvedQueryProvenance(repeatedBefore, resolvedQueryProvenance(repeated));
      const reversedLineage = returnedLineageMatches(first, reversed);
      const repeatedLineage = returnedLineageMatches(second, repeated);
      const reversedCheck = inspectExecution(first, reversed.resolved.executionId, ["second", "first"], { second: 9, first: 2 }, created.events);
      const repeatedCheck = inspectExecution(second, repeated.resolved.executionId, ["first", "second"], { first: 7, second: 7 }, created.events);
      const exact = reversedCheck.pass && repeatedCheck.pass;
      const provenanceIntact = reversedUnchanged && repeatedUnchanged && reversedLineage && repeatedLineage;
      return {
        suite: "query-runtime-named-binding",
        status: exact && provenanceIntact && created.observationFailure == null ? "pass" : "fail",
        checks: [
          {
            id: "named-parameter-lexical-order-real-admit-and-execute",
            status: reversedCheck.pass ? "pass" : "fail",
            details: reversedCheck.details,
          },
          {
            id: "named-parameter-repeated-marker-real-admit-and-execute",
            status: repeatedCheck.pass ? "pass" : "fail",
            details: repeatedCheck.details,
          },
          {
            id: "named-parameter-original-query-and-attestation-immutable",
            status: provenanceIntact ? "pass" : "fail",
            details: `reversed-sql-and-five-fields-unchanged=${reversedUnchanged}; repeated-sql-and-five-fields-unchanged=${repeatedUnchanged}; reversed-result-lineage=${reversedLineage}; repeated-result-lineage=${repeatedLineage}.`,
          },
          {
            id: "named-parameter-bounded-observation",
            status: created.observationFailure == null ? "pass" : "fail",
            details: created.observationFailure == null
              ? "The real-boundary control retained only bounded closed-schema lifecycle observations."
              : "The real-boundary observer violated its bounded closed-schema capture.",
          },
        ],
        limits: ["One runtime; two real parser/admission calls and two fixed scalar executions; no raw SQL, parameters, paths, rows, or AST are emitted."],
      };
    } finally {
      try {
        await created.runtime.close();
      } finally {
        created.dispose();
      }
    }
  } catch {
    return failed("named-binding-boundary-error", "The real boundary threw before the named-parameter control completed.");
  } finally {
    await fixture.cleanup();
  }
}

function blocked(id, details) {
  return { suite: "query-runtime-named-binding", status: "blocked", checks: [{ id, status: "blocked", details }], limits: [] };
}

function failed(id, details) {
  return { suite: "query-runtime-named-binding", status: "fail", checks: [{ id, status: "fail", details }], limits: [] };
}

const closedErrorCodes = new Set([
  "invalid-request", "stale-snapshot", "admission-denied", "identity-unavailable",
  "identity-mismatch", "queue-full", "queue-timeout", "cancelled",
  "worker-startup-timeout", "materialization-limit", "materialization-timeout",
  "query-timeout", "result-limit", "worker-crashed", "record-expired",
]);

function inspectExecution(outcome, executionId, names, expectedRow, events) {
  const kind = outcome?.kind === "success" || outcome?.kind === "error" ? outcome.kind : "invalid";
  const candidateErrorCode = typeof outcome?.error?.code === "string" ? outcome.error.code : null;
  const errorCodeState = kind === "success" && outcome?.error == null
    ? "none"
    : kind === "error" && closedErrorCodes.has(candidateErrorCode) ? "closed" : "invalid";
  // A value is surfaced only after membership in the small fixed taxonomy;
  // unknown product data is represented solely by the literal "invalid".
  const safeErrorCode = errorCodeState === "closed" ? candidateErrorCode : errorCodeState;
  const result = kind === "success" ? outcome.result?.result : null;
  const rows = result?.rows;
  const columns = result?.columns;
  const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  const exactRowCount = Array.isArray(rows) && rows.length === 1;
  const exactColumnTypes = Array.isArray(columns) && columns.length === names.length
    && names.every((name, index) => columns[index]?.name === name && columns[index]?.logicalType === "integer");
  const exactValues = row != null && Object.keys(row).length === names.length
    && names.every((name) => row[name] === expectedRow[name]);
  const materialized = events.some((event) => event?.kind === "source-materialized" && event.executionId === executionId);
  const dispatched = events.some((event) => event?.kind === "dispatch" && event.executionId === executionId);
  const pass = kind === "success" && errorCodeState === "none" && exactRowCount && exactColumnTypes && exactValues && materialized && dispatched;
  return {
    pass,
    details: `kind=${kind}; error-code=${safeErrorCode}; row-count-one=${exactRowCount}; column-types-match=${exactColumnTypes}; values-match=${exactValues}; materialized=${materialized}; dispatched=${dispatched}.`,
  };
}

function resolvedQueryProvenance(input) {
  const query = input?.resolved?.query;
  return {
    sql: query?.sql,
    astPolicyRevision: query?.astPolicyRevision,
    astNodeCount: query?.astNodeCount,
    sqlSha256: query?.sqlSha256,
    parameterDeclarationDigest: query?.parameterDeclarationDigest,
    cacheability: query?.cacheability,
  };
}

function sameResolvedQueryProvenance(before, after) {
  return before?.sql === after?.sql
    && before?.astPolicyRevision === after?.astPolicyRevision
    && before?.astNodeCount === after?.astNodeCount
    && before?.sqlSha256 === after?.sqlSha256
    && before?.parameterDeclarationDigest === after?.parameterDeclarationDigest
    && before?.cacheability === after?.cacheability;
}

function returnedLineageMatches(outcome, input) {
  if (outcome?.kind !== "success") return false;
  const lineage = outcome.result;
  if (lineage == null || typeof lineage !== "object") return false;
  if (lineage?.executionId !== input?.resolved?.executionId) return false;
  // These optional result-lineage fields, if the runtime supplies them, must
  // still point at the immutable resolved input. Their values are never output.
  if (Object.hasOwn(lineage, "snapshotId") && lineage.snapshotId !== input.resolved.snapshot.snapshotId) return false;
  if (Object.hasOwn(lineage, "sourceScope") && canonicalJson(lineage.sourceScope) !== canonicalJson(input.resolved.snapshot.sourceScope)) return false;
  return true;
}

function canonicalJson(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}
