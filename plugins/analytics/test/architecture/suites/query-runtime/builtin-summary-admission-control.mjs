import { createHash, randomUUID } from "node:crypto";
import childProcess from "node:child_process";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { TOOL_RELIABILITY_BUNDLE } from "../../../../builtin-bundles.ts";
import { isAllowedObserverEvent } from "./binding.mjs";
import { createOwnStoreFixture } from "./fixture.mjs";

/**
 * A deliberately narrow real-boundary diagnostic for the fixed builtin
 * summary admission only.  The spawn tap forwards every original spawn
 * argument to Node unchanged and never changes IPC, process.kill, the worker,
 * or the runtime.  Its listener immediately reduces a worker error message to
 * one closed enum; neither the message nor another IPC field is retained.
 *
 * This is not normal acceptance.  A denied admission remains a failing result
 * even when the stage pinpoints a closed worker phase.
 */
const suite = "builtin-summary-admission-control";
const expectedBuiltinSourceSha256 = "041f5ce4fbd0dd2edba12baaefd080367ea1fc83b88fc17b35f69d87a88fae5f";
const expectedSummarySqlSha256 = "63d15ed9386c445df2636db609693133939e8709e016a83ee3f13b89fc1b2a27";
const builtinSourceUrl = new URL("../../../../builtin-bundles.ts", import.meta.url);
const runtimeEntryUrl = new URL("../../../../query-runtime/index.mjs", import.meta.url);
const workerSourceUrl = new URL("../../../../query-runtime/worker.cjs", import.meta.url);

// Each literal is taken from the current worker's static admitTree returns.
// Values are read only long enough to select a closed diagnostic enum.
const workerErrorStages = new Map([
  ["Parser policy identity is unavailable before trusted bootstrap.", "policy-unavailable"],
  ["Parser did not return a valid SQL tree.", "parser-valid-sql-tree"],
  ["Parser did not return a lossless SQL tree.", "bridge-parse-lossless-sql-tree"],
  ["SQL parameters cannot be safely bridged to the selected runtime.", "bridge-transform-safely-bridged"],
  ["SQL parameter bridge could not establish parser equivalence.", "bridge-equivalence-parser-equivalence"],
  ["Only one SELECT statement is allowed.", "policy-single-select"],
  ["SQL tree exceeds its AST node limit.", "policy-ast-limit"],
  ["SQL contains an unsupported parse-tree feature.", "policy-node-type"],
  ["SQL has an unsupported CTE declaration.", "policy-cte-declaration"],
  ["Table functions and unsupported relation sources are denied.", "policy-relation-shape"],
  ["Only the curated fact relation and lexically declared CTEs may be read.", "policy-relation-scope"],
  ["Qualified functions are denied.", "policy-qualified-function"],
  ["SQL calls an operator outside the vetted analytics policy.", "policy-operator"],
  ["SQL has an unsupported function operator flag.", "policy-operator-flag"],
  ["SQL calls a function outside the vetted analytics policy.", "policy-function"],
  ["Requested cacheability does not match the admitted SQL.", "policy-cacheability"],
  ["SQL parameters do not match the admitted bound values.", "policy-parameters"],
]);

export async function runSuite(options = {}) {
  if ((options.mode ?? "acceptance") !== "acceptance") {
    return blocked("builtin-summary-admit-only", "This diagnostic has no synthetic-success mode; it requires the actual isolated runtime boundary.");
  }

  const reviewed = await reviewedBuiltinAndWorker();
  if (!reviewed.inputPinned) {
    return failed("builtin-summary-input-identity", "The fixed builtin summary source identity or SQL digest differs from the reviewed diagnostic input.");
  }
  if (!reviewed.workerWhitelist) {
    return failed("builtin-summary-worker-stage-whitelist", "The current worker no longer contains the reviewed static admission-stage literal set; this diagnostic must be reviewed before it runs.");
  }
  const summary = reviewed.summary;

  const fixtureResult = await createOwnStoreFixture();
  if (fixtureResult.kind === "missing-boundary") {
    return blocked("builtin-summary-own-store-fixture", "The test-owned synthetic AnalyticsStore fixture boundary is unavailable.");
  }
  if (fixtureResult.kind !== "ready") {
    return failed("builtin-summary-own-store-fixture", "The test-owned synthetic AnalyticsStore fixture could not be prepared.");
  }

  const fixture = fixtureResult.fixture;
  try {
    return await withForwardedSpawnTap(async (tap) => {
      let runtime;
      let observationFailure = false;
      let materializations = 0;
      let dispatches = 0;
      let admitted = false;
      let outcome = "unclassified";
      let constructionFailure = false;
      try {
        const production = await import(`${runtimeEntryUrl.href}?builtin-summary-admit=${randomUUID()}`);
        if (typeof production?.createQueryRuntime !== "function") {
          constructionFailure = true;
        } else {
          runtime = await production.createQueryRuntime({
            trustedSource: fixture.handoff,
            observer(event) {
              if (!isAllowedObserverEvent(event)) {
                observationFailure = true;
                return;
              }
              if (event.kind === "source-materialized") materializations += 1;
              if (event.kind === "dispatch") dispatches += 1;
            },
          });
          if (typeof runtime?.admitQuery !== "function" || typeof runtime?.close !== "function") {
            constructionFailure = true;
          } else {
            try {
              const reply = await runtime.admitQuery({ sql: summary.sql, parameters: [], cacheability: "stable" });
              admitted = reply?.kind === "admitted";
              outcome = admitted ? "admitted" : "denied";
            } catch {
              outcome = "threw";
            }
          }
        }
      } catch {
        constructionFailure = true;
      }

      let closeSucceeded = typeof runtime?.close === "function";
      if (closeSucceeded) {
        try {
          // The child must close before the mocked spawn export is restored.
          await runtime.close();
        } catch {
          closeSucceeded = false;
        }
      }
      const stage = admitted ? "none" : tap.stage ?? "unclassified";
      const executionClean = tap.spawnCount === 1 && materializations === 0 && dispatches === 0 && !observationFailure;
      const cleanupClean = closeSucceeded && tap.closedChildren === tap.spawnCount;
      return {
        suite,
        status: !constructionFailure && admitted && executionClean && cleanupClean ? "pass" : "fail",
        checks: [
          {
            id: "builtin-summary-admit-only-input-identity",
            status: "pass",
            details: "The fixed builtin summary source identity and SQL digest match the reviewed input pin.",
          },
          {
            id: "builtin-summary-admit-only-worker-stage",
            status: !constructionFailure && admitted ? "pass" : "fail",
            details: !constructionFailure && admitted
              ? "The fixed builtin summary was admitted through the actual locked-child boundary."
              : `The fixed builtin summary admission did not succeed (outcome=${outcome}; stage=${stage}).`,
          },
          {
            id: "builtin-summary-admit-only-no-execution",
            status: executionClean ? "pass" : "fail",
            details: executionClean
              ? "The tap observed exactly one actual child and no source materialization or SQL dispatch."
              : "Admission-only control observed an unexpected child count, materialization, dispatch, or malformed lifecycle evidence.",
          },
          {
            id: "builtin-summary-admit-only-cleanup",
            status: cleanupClean ? "pass" : "fail",
            details: cleanupClean
              ? "The real runtime close completed and the tapped child close was observed before this report was derived."
              : "The real runtime close failed or an observed child had not closed before this report was derived.",
          },
        ],
        limits: ["One synthetic own-store fixture; one actual runtime; one fixed admitQuery only; no execute or resolved request construction.", "The bounded tap retains only one closed stage enum and no child IPC payloads or worker text."],
      };
    });
  } finally {
    await fixture.cleanup();
  }
}

async function reviewedBuiltinAndWorker() {
  const summary = TOOL_RELIABILITY_BUNDLE?.queries?.find((query) => query?.id === "summary");
  try {
    const [builtinSource, workerSource] = await Promise.all([
      readFile(builtinSourceUrl),
      readFile(workerSourceUrl, "utf8"),
    ]);
    return {
      summary,
      inputPinned: summary?.id === "summary"
      && summary?.maxRows === 1
      && typeof summary?.sql === "string"
      && sha256(builtinSource) === expectedBuiltinSourceSha256
      && sha256(summary.sql) === expectedSummarySqlSha256,
      workerWhitelist: [...workerErrorStages.keys()].every((literal) => workerSource.includes(JSON.stringify(literal))),
    };
  } catch {
    return { summary, inputPinned: false, workerWhitelist: false };
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function withForwardedSpawnTap(run) {
  const savedSpawn = childProcess.spawn;
  const listeners = new Map();
  let spawnCount = 0;
  let closedChildren = 0;
  let stage = null;
  const spawn = (...args) => {
    const child = savedSpawn(...args);
    spawnCount += 1;
    if (child?.on && child?.removeListener) {
      const listener = (message) => {
        if (message?.kind !== "result" || message?.error == null) return;
        // This lookup consumes the static text synchronously and stores only
        // its closed enum. A second error is deliberately unclassified.
        stage = stage == null
          ? (workerErrorStages.get(message.error.message) ?? "unclassified")
          : "unclassified";
      };
      child.on("message", listener);
      const closeListener = () => { closedChildren += 1; };
      child.once("close", closeListener);
      listeners.set(child, { listener, closeListener });
    } else {
      stage = "unclassified";
    }
    return child;
  };
  const spawnMock = mock.method(childProcess, "spawn", spawn);
  syncBuiltinESMExports();
  try {
    return await run({
      get spawnCount() { return spawnCount; },
      get closedChildren() { return closedChildren; },
      get stage() { return stage; },
    });
  } finally {
    for (const [child, handlers] of listeners) {
      child.removeListener("message", handlers.listener);
      child.removeListener("close", handlers.closeListener);
    }
    // Do not restore until the caller's real runtime has closed.
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
}

function blocked(id, details) {
  return { suite, status: "blocked", checks: [{ id, status: "blocked", details }], limits: [] };
}

function failed(id, details) {
  return { suite, status: "fail", checks: [{ id, status: "fail", details }], limits: [] };
}
