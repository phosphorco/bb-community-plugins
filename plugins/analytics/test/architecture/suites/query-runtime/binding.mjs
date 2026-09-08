import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * This is deliberately test-owned.  It contains no queue, cache, worker, or
 * SQL implementation: it only imports the eventual production constructor and
 * retains observations made by that constructor's real lifecycle hooks.
 *
 * The ordinary internal constructor expected by this binding is
 * createQueryRuntime({ observer? }), returning { admitQuery, worker,
 * coordinator, close }. `admitQuery({sql, parameters, cacheability})` is the
 * ordinary locked-child pre-resolution boundary; it returns the immutable
 * parser attestation used to construct a resolved input exactly once.
 * `observer` is optional and must not create periodic work. When present it
 * receives only actual child/IPC observations, each with monotonicMs: child
 * spawn; locked-child bootstrap acknowledgement; child-local materialization;
 * dispatch; completion/cache aggregate; kill-requested; child-exit; and
 * close-confirmed disposal. A kill-requested event is not termination evidence;
 * the same active child PID must exit before close resolves. Events may contain
 * bounded aggregate counts and opaque hashes/IDs, but never SQL, bound values,
 * rows, database paths, or raw source data.
 *
 * A production constructor may accept a trusted synthetic handoff for its own
 * test fixture, but it must validate that handoff against the accepted contract
 * and never accept an arbitrary caller-supplied path.
 * `testControl.beforeDispatch` is an internal test-only awaited hook after real
 * queue admission and before child dispatch; it permits deterministic active/
 * queued ordering without a synthetic load generator. `beforeChildExecution`
 * may run only after that child has completed source materialization and sent
 * its matching real dispatch acknowledgement; it supports bounded active-child
 * cancellation/close assertions, never a synthetic execution result.
 * `beforeMaterializationCommit` is active only with
 * `testMaterializationCheckpoint: true`; it may run only after the child has
 * completed its actual SQLite read/bounded inserts and sent an opaque
 * checkpoint token, but before the child commits its DuckDB transaction. The
 * parent resumes only by echoing that token on its closed IPC path; the test
 * hook receives no facts, SQL, paths, or callable child capability.
 */
const productionEntry = new URL("../../../../query-runtime/index.mjs", import.meta.url);
const maxObserverEvents = 512;
const maxObserverBytes = 128 * 1024;

export async function loadProductionRuntimeBinding() {
  const entryPath = fileURLToPath(productionEntry);
  try {
    await access(entryPath);
  } catch {
    return {
      kind: "missing-boundary",
      details:
        "Missing production boundary: query-runtime/index.mjs must export createQueryRuntime().",
      entryPath,
    };
  }

  let production;
  try {
    production = await import(pathToFileURL(entryPath).href);
  } catch (cause) {
    return {
      kind: "failure",
      details: "Production runtime entry exists but could not be imported: " + errorText(cause),
      entryPath,
    };
  }
  if (typeof production.createQueryRuntime !== "function") {
    return {
      kind: "missing-boundary",
      details:
        "Production runtime entry lacks createQueryRuntime(); the test binding will not emulate it.",
      entryPath,
    };
  }

  const source = await readFile(entryPath);
  return {
    kind: "ready",
    entryPath,
    entrySha256: createHash("sha256").update(source).digest("hex"),
    async create({ trustedSource, resourceLimits, testControl } = {}) {
      const events = [];
      const waiters = new Set();
      let observationFailure = null;
      const runtime = await production.createQueryRuntime({
        observer: (event) => {
          if (observationFailure != null) return;
          let copy;
          let bytes;
          try {
            copy = structuredClone(event);
            bytes = new TextEncoder().encode(JSON.stringify(copy)).byteLength;
          } catch (cause) {
            observationFailure = "Observer emitted non-cloneable/non-serializable data: " + errorText(cause);
            return;
          }
          if (events.length >= maxObserverEvents || bytes > maxObserverBytes || events.reduce((total, item) => total + item.capturedBytes, 0) + bytes > maxObserverBytes) {
            observationFailure = "Observer exceeded bounded event retention.";
            return;
          }
          if (!isAllowedObserverEvent(copy)) {
            observationFailure = "Observer emitted malformed, unrecognized, or sensitive lifecycle data.";
            return;
          }
          events.push({ ...copy, capturedBytes: bytes });
          for (const waiter of [...waiters]) {
            if (waiter.predicate(copy)) {
              waiters.delete(waiter);
              clearTimeout(waiter.timer);
              waiter.resolve(true);
            }
          }
        },
        trustedSource,
        resourceLimits,
        testControl,
      });
      const missing = [];
      if (runtime == null || typeof runtime !== "object") missing.push("runtime object");
      if (typeof runtime?.admitQuery !== "function") missing.push("runtime.admitQuery");
      if (typeof runtime?.worker?.execute !== "function") missing.push("worker.execute");
      if (typeof runtime?.worker?.close !== "function") missing.push("worker.close");
      if (typeof runtime?.coordinator?.subscribe !== "function") missing.push("coordinator.subscribe");
      if (typeof runtime?.close !== "function") missing.push("runtime.close");
      if (missing.length > 0) {
        try {
          await runtime?.close?.();
        } catch {
          // The missing-boundary finding is more actionable than cleanup noise.
        }
        return {
          kind: "missing-boundary",
          details: "Production constructor returned no " + missing.join(", ") + ".",
          entryPath,
          entrySha256: createHash("sha256").update(source).digest("hex"),
        };
      }
      return {
        kind: "ready", runtime, events, entryPath, entrySha256: createHash("sha256").update(source).digest("hex"),
        get observationFailure() { return observationFailure; },
        waitForEvent(predicate, timeoutMs = 1_000) {
          if (events.some(predicate)) return Promise.resolve(true);
          return new Promise((resolve) => {
            const waiter = { predicate, resolve, timer: setTimeout(() => { waiters.delete(waiter); resolve(false); }, timeoutMs) };
            waiters.add(waiter);
          });
        },
        dispose() {
          for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve(false);
          }
          waiters.clear();
        },
      };
    },
  };
}

function errorText(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

const eventFields = Object.freeze({
  "child-spawn": ["kind", "monotonicMs", "pid", "entrySha256"],
  "bootstrap-ready": ["kind", "monotonicMs", "pid", "bootstrapFingerprint"],
  "source-materialized": ["kind", "monotonicMs", "pid", "executionId", "materializationId", "childReadCount", "reused"],
  dispatch: ["kind", "monotonicMs", "pid", "executionId", "physicalKey", "queued", "queuedBytes", "sqlExecutionCount"],
  completion: ["kind", "monotonicMs", "executionId", "outcome", "resultBytes"],
  cache: ["kind", "monotonicMs", "physicalKey", "hit", "entries", "bytes"],
  "kill-requested": ["kind", "monotonicMs", "executionId", "pid", "reason"],
  "child-exit": ["kind", "monotonicMs", "executionId", "pid", "code", "signal"],
  "close-confirmed": ["kind", "monotonicMs", "pid", "queued", "entries", "bytes"],
});
const forbiddenEventFields = new Set(["sql", "query", "parameters", "rows", "row", "readonlyDatabasePath", "databasePath", "path", "source", "handoff"]);
const executionIdPattern = /^analytics-exec_[A-Za-z0-9_-]{8,180}$/;
const physicalKeyPattern = /^analytics-physical_[A-Za-z0-9_-]{8,180}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const safeReason = new Set(["deadline", "parent-close", "startup-failure", "worker-crash", "subscriber-cancelled", "materialization-timeout", "idle-expired"]);
const safeCode = new Set(["invalid-request", "stale-snapshot", "admission-denied", "identity-unavailable", "identity-mismatch", "queue-full", "queue-timeout", "cancelled", "worker-startup-timeout", "materialization-limit", "materialization-timeout", "query-timeout", "result-limit", "worker-crashed", "record-expired"]);
const safeSignal = new Set(Object.keys(osConstants.signals).filter((name) => /^SIG[A-Z0-9]+$/.test(name)));

export function isAllowedObserverEvent(event) {
  if (event == null || typeof event !== "object" || typeof event.kind !== "string" || !Number.isFinite(event.monotonicMs)) return false;
  const expected = expectedEventFields(event);
  if (expected == null) return false;
  const fields = Reflect.ownKeys(event);
  if (fields.length !== expected.length || !fields.every((field) => typeof field === "string" && expected.includes(field) && !forbiddenEventFields.has(field))) return false;
  if (!expected.every((field) => Object.hasOwn(event, field))) return false;
  // This is parent process performance.now(), so independent runtime instances
  // share one monotonic origin; process uptime is not artificially capped at a
  // day. A finite non-negative millisecond value remains bounded at capture and
  // retains performance.now() sub-millisecond resolution.
  if (!Number.isFinite(event.monotonicMs) || event.monotonicMs < 0) return false;
  if ("pid" in event && (!Number.isSafeInteger(event.pid) || event.pid < 1 || event.pid > 10_000_000)) return false;
  if ("executionId" in event && (typeof event.executionId !== "string" || !executionIdPattern.test(event.executionId))) return false;
  if ("physicalKey" in event && (typeof event.physicalKey !== "string" || !physicalKeyPattern.test(event.physicalKey))) return false;
  if ("materializationId" in event && (typeof event.materializationId !== "string" || !hashPattern.test(event.materializationId))) return false;
  if ("entrySha256" in event && (typeof event.entrySha256 !== "string" || !hashPattern.test(event.entrySha256))) return false;
  if ("bootstrapFingerprint" in event && (typeof event.bootstrapFingerprint !== "string" || !hashPattern.test(event.bootstrapFingerprint))) return false;
  if ("reason" in event && !safeReason.has(event.reason)) return false;
  if ("code" in event && event.kind !== "child-exit" && !safeCode.has(event.code)) return false;
  if ("outcome" in event && event.outcome !== "success" && event.outcome !== "error") return false;
  if ("signal" in event && event.signal !== null && !safeSignal.has(event.signal)) return false;
  if ("code" in event && event.kind === "child-exit" && event.code !== null && (!Number.isInteger(event.code) || event.code < 0 || event.code > 255)) return false;
  for (const field of ["queued", "queuedBytes", "sqlExecutionCount", "resultBytes", "entries", "bytes", "childReadCount"]) {
    if (field in event && (!Number.isSafeInteger(event[field]) || event[field] < 0 || event[field] > 4 * 1024 * 1024)) return false;
  }
  if ("queued" in event && event.queued > 32) return false;
  if ("entries" in event && event.entries > 24) return false;
  if ("hit" in event && typeof event.hit !== "boolean") return false;
  if ("reused" in event && typeof event.reused !== "boolean") return false;
  return true;
}

function expectedEventFields(event) {
  if (event?.kind !== "completion") return eventFields[event?.kind] ?? null;
  if (event.outcome === "success") return eventFields.completion;
  if (event.outcome === "error") return [...eventFields.completion, "code"];
  return null;
}
