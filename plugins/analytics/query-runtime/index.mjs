import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  canonicalPhysicalCacheKeyInput,
  canonicalResultWireBytes,
  deriveExecutionDatumKeys,
  EXECUTION_LIMITS,
  executionErrorSchema,
  executionResultSchema,
  parameterDeclarationDigestInput,
  queryAdmissionAttestationSchema,
  queryAdmissionRequestSchema,
  queuedResolvedDescriptorBytes,
  resolvedExecutionSchema,
  SELECTED_EXECUTION_RUNTIME,
  sourceScopeSchema,
} from "../execution-contract.ts";

const CHILD_ENTRY = fileURLToPath(new URL("./worker.cjs", import.meta.url));
const RUNTIME_ID = "analytics-exec_runtime_shutdown";
const HASH = /^[a-f0-9]{64}$/;
const SAFE_MESSAGES = Object.freeze({
  "invalid-request": "The request is outside the supported query contract.",
  "stale-snapshot": "The retained source no longer matches this snapshot.",
  "identity-mismatch": "The source does not match the host-owned snapshot.",
  "queue-full": "The bounded execution queue is full.",
  "cancelled": "The execution subscription was cancelled.",
  "worker-startup-timeout": "The isolated worker did not become ready in time.",
  "materialization-limit":
    "Source materialization exceeded its bounded policy.",
  "materialization-timeout": "Source materialization did not complete in time.",
  "query-timeout": "The isolated query exceeded its deadline.",
  "result-limit": "The result does not meet the bounded canonical contract.",
  "worker-crashed": "The isolated worker could not complete the operation.",
});

/**
 * Host-internal construction, not an RPC surface. A runtime is bound to one
 * trusted source generation; reconstruct it for a different host handoff.
 * Only descriptors cross IPC. The owned child reads and materializes facts.
 */
export async function createQueryRuntime({
  trustedSource,
  resourceLimits,
  observer,
  testControl = {},
} = {}) {
  const source = parseTrustedSource(trustedSource);
  const limits = reducedLimits(resourceLimits);
  const workerSha256 = sha256(await readFile(CHILD_ENTRY));
  const state = {
    closed: false,
    fatal: null,
    closePromise: null,
    running: null,
    session: null,
    retiring: null,
    lastPid: null,
    active: null,
    idleTimer: null,
    queue: [],
    queueBytes: 0,
    flights: new Map(),
    cache: new Map(),
    sqlExecutions: 0,
  };
  // Process-monotonic time is comparable across runtime instances.
  const emit = (event) => {
    try {
      observer?.(Object.freeze({ ...event, monotonicMs: performance.now() }));
    } catch { /* Observational only; cannot change execution. */ }
  };
  function clearIdle() {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  async function retire(session, reason, executionId = RUNTIME_ID) {
    if (!session) return;
    try {
      await session.stop(reason, executionId);
      if (state.session === session) state.session = null;
    } catch (cause) {
      // Unconfirmed exit permanently prevents replacement admission.
      state.fatal = asFault(cause);
      throw state.fatal;
    }
  }
  function armIdle() {
    clearIdle();
    if (state.closed || state.fatal || state.queue.length || !state.session) {
      return;
    }
    const session = state.session;
    state.idleTimer = setTimeout(() => {
      if (state.active || state.queue.length || state.session !== session) {
        return;
      }
      state.retiring = retire(session, "idle-expired");
      state.retiring.catch(() => {});
    }, limits.idleWorkerTtlMs);
    state.idleTimer.unref();
  }
  function checkJob(job) {
    if (state.fatal) throw state.fatal;
    if (state.closed || job.controller.signal.aborted) {
      throw new RuntimeFault("cancelled");
    }
  }
  async function getSession(job) {
    if (state.retiring) {
      await state.retiring;
      state.retiring = null;
    }
    checkJob(job);
    if (state.session?.closed) {
      await retire(state.session, "worker-crash", job.executionId);
    }
    checkJob(job);
    if (!state.session) {
      // close() waits for this task, including scratch setup. Check immediately
      // before spawn, so a cancelled setup cannot create a child after close.
      state.session = await ChildSession.create({
        limits,
        emit,
        workerSha256,
        checkAdmission: () => checkJob(job),
      });
      state.lastPid = state.session.pid ?? state.lastPid;
    }
    const session = state.session;
    await phase(
      () => session.ready.promise,
      job.controller.signal,
      limits.workerStartupDeadlineMs,
      "worker-startup-timeout",
    );
    checkJob(job);
    return session;
  }
  async function runJob(job) {
    let session;
    try {
      if (job.kind === "execute") {
        await phase(
          () => testControl.beforeDispatch?.(),
          job.controller.signal,
        );
      }
      checkJob(job);
      session = await getSession(job);
      checkJob(job);
      const token = randomUUID();
      if (job.kind === "admit") {
        const request = session.beginAdmission(token, job.executionId);
        const reply = await phase(
          () => {
            session.send({
              kind: "admit",
              token,
              ...job.request,
              maxAstNodes: limits.maxAstNodes,
            });
            return request.result.promise;
          },
          job.controller.signal,
          limits.queryDeadlineMs,
          "query-timeout",
        );
        checkJob(job);
        const admission = queryAdmissionAttestationSchema.parse(
          reply.admission,
        );
        if (
          admission.sqlSha256 !== sha256(job.request.sql) ||
          admission.parameterDeclarationDigest !==
            declarationDigest(job.request.parameters) ||
          admission.cacheability !== job.request.cacheability ||
          admission.astNodeCount > limits.maxAstNodes
        ) {
          throw new RuntimeFault("invalid-request");
        }
        session.finish(request);
        return { kind: "admitted", admission };
      }
      const request = session.begin(
        token,
        job.resolved.executionId,
        testControl.testMaterializationCheckpoint === true,
      );
      const prepared = await phase(
        async (signal) => {
          request.onCheckpoint = () => {
            phase(() => testControl.beforeMaterializationCommit?.(), signal)
              .then(() => {
                checkJob(job);
                session.commitMaterialization(request);
              })
              .catch((cause) => request.prepared.reject(asFault(cause)));
          };
          session.send({
            kind: "prepare",
            token,
            source,
            snapshot: job.resolved.snapshot,
            sql: job.resolved.query.sql,
            parameters: job.resolved.query.parameters,
            cacheability: job.resolved.query.cacheability,
            maxRows: job.resolved.query.maxRows,
            admission: queryAdmission(job.resolved.query),
            // Only child-owned execution/materialization bounds cross IPC.
            // Scheduler/cache/retention policy is private to this process.
            limits: {
              maxAstNodes: limits.maxAstNodes,
              maxColumns: limits.maxColumns,
              maxRows: limits.maxRows,
              maxCells: limits.maxCells,
              maxCellStringBytes: limits.maxCellStringBytes,
              maxCanonicalResultBytes: limits.maxCanonicalResultBytes,
              maxTransferChunkBytes: limits.maxTransferChunkBytes,
              maxTransferRowsPerChunk: limits.maxTransferRowsPerChunk,
              materializationDeadlineMs: limits.materializationDeadlineMs,
            },
            testMaterializationCheckpoint: request.checkpointEnabled,
          });
          return request.prepared.promise;
        },
        job.controller.signal,
        limits.materializationDeadlineMs,
        "materialization-timeout",
      );
      checkJob(job);
      emit({
        kind: "source-materialized",
        pid: session.pid,
        executionId: job.resolved.executionId,
        materializationId: prepared.materializationId,
        childReadCount: prepared.childReadCount,
        reused: prepared.reused,
      });
      let startedAtMs;
      const message = await phase(
        async (signal) => {
          await phase(() => testControl.beforeChildExecution?.(), signal);
          checkJob(job);
          startedAtMs = Date.now();
          session.continue(request);
          emit({
            kind: "dispatch",
            pid: session.pid,
            executionId: job.resolved.executionId,
            physicalKey: job.physicalKey ?? "analytics-physical_uncacheable",
            queued: state.queue.length,
            queuedBytes: state.queueBytes,
            sqlExecutionCount: ++state.sqlExecutions,
          });
          const result = await phase(() => request.result.promise, signal);
          await phase(() => testControl.beforeChildResult?.(), signal);
          checkJob(job);
          return result;
        },
        job.controller.signal,
        limits.queryDeadlineMs,
        "query-timeout",
      );
      session.finish(request);
      return makeOutcome(
        job.resolved,
        job.physicalKey,
        message,
        limits,
        startedAtMs,
      );
    } catch (cause) {
      const fault = asFault(cause);
      // Includes a created child whose readiness failed. Never operate on a
      // later job/child from a stale timer or event callback.
      const owned = session ?? state.session;
      if (owned) {
        await retire(
          owned,
          killReason(fault, state.closed),
          job.executionId,
        );
      }
      return failure(fault.code);
    }
  }
  function completeSubscriber(job, subscriber, outcome) {
    if (subscriber.done) return;
    subscriber.done = true;
    subscriber.signal?.removeEventListener("abort", subscriber.abort);
    job.subscribers.delete(subscriber);
    subscriber.resolve(outcome);
  }
  function settle(job, outcome) {
    if (state.flights.get(job.physicalKey) === job) {
      state.flights.delete(job.physicalKey);
    }
    if (
      !state.closed && !state.fatal && job.share && job.physicalKey &&
      outcome.kind === "success" && job.subscribers.size > 0
    ) {
      const size = outcome.result.result.encodedBytes;
      // Valid results larger than a reduced cache budget are returned uncached.
      if (size <= limits.cacheMaxBytes) {
        state.cache.delete(job.physicalKey);
        while (
          state.cache.size && (state.cache.size >= limits.cacheMaxEntries ||
            cacheBytes(state.cache) + size > limits.cacheMaxBytes)
        ) {
          state.cache.delete(state.cache.keys().next().value);
        }
        state.cache.set(job.physicalKey, {
          outcome,
          size,
          expires: Date.now() + limits.cacheTtlMs,
        });
        emit({
          kind: "cache",
          physicalKey: job.physicalKey,
          hit: false,
          entries: state.cache.size,
          bytes: cacheBytes(state.cache),
        });
      }
    }
    for (const subscriber of [...job.subscribers]) {
      const reply = state.closed || subscriber.signal?.aborted
        ? failure("cancelled")
        : outcome.kind === "success"
        ? rebind(
          outcome,
          subscriber.resolved,
          limits,
          subscriber.resolved.executionId !== job.resolved.executionId,
        )
        : structuredClone(outcome);
      completeSubscriber(job, subscriber, reply);
      emit({
        kind: "completion",
        executionId: subscriber.resolved?.executionId ?? job.executionId,
        outcome: reply.kind === "error" ? "error" : "success",
        ...(reply.kind === "error" ? { code: reply.error.code } : {}),
        resultBytes: reply.kind === "success"
          ? reply.result.result.encodedBytes
          : 0,
      });
    }
  }
  function attach(job, resolved, signal) {
    return new Promise((resolve) => {
      const subscriber = {
        resolved,
        signal,
        resolve,
        done: false,
        abort: null,
      };
      subscriber.abort = () => {
        completeSubscriber(job, subscriber, failure("cancelled"));
        if (job.subscribers.size) return;
        job.controller.abort(new RuntimeFault("cancelled"));
        if (state.flights.get(job.physicalKey) === job) {
          state.flights.delete(job.physicalKey);
        }
        const index = state.queue.indexOf(job);
        if (index >= 0) {
          state.queue.splice(index, 1);
          state.queueBytes -= job.bytes;
        }
      };
      job.subscribers.add(subscriber);
      signal?.addEventListener("abort", subscriber.abort, { once: true });
      if (signal?.aborted) subscriber.abort();
    });
  }
  async function drain() {
    while (!state.closed && !state.fatal && state.queue.length) {
      const job = state.queue.shift();
      state.queueBytes -= job.bytes;
      if (!job.subscribers.size) continue;
      state.active = job;
      let outcome;
      try {
        outcome = await runJob(job);
      } catch (cause) {
        state.fatal = asFault(cause);
        outcome = failure(state.fatal.code);
      }
      settle(job, outcome);
      state.active = null;
    }
    if (state.fatal) {
      for (const job of state.queue.splice(0)) {
        settle(job, failure(state.fatal.code));
      }
      state.queueBytes = 0;
    }
  }
  function kick() {
    if (state.running || state.closed || state.fatal) return;
    clearIdle();
    state.running = Promise.resolve().then(drain).finally(() => {
      state.running = null;
      if (!state.closed && !state.fatal && state.queue.length) kick();
      else armIdle();
    });
    state.running.catch(() => {});
  }
  function enqueue(input, signal, share) {
    if (state.closed) return Promise.resolve(failure("cancelled"));
    if (state.fatal) return Promise.resolve(failure(state.fatal.code));
    if (signal?.aborted) return Promise.resolve(failure("cancelled"));
    let resolved, physicalKey, bytes;
    try {
      resolved = resolvedExecutionSchema.parse(input?.resolved);
      if (
        canonicalJson(parseTrustedSource(input?.source)) !==
          canonicalJson(source) ||
        resolved.snapshot.snapshotId !== source.snapshotId ||
        resolved.snapshot.coverage.observed.projectionGeneration !==
          source.sourceGeneration ||
        canonicalJson(resolved.snapshot.sourceScope) !==
          canonicalJson(source.sourceScope)
      ) {
        return Promise.resolve(failure("identity-mismatch"));
      }
      if (
        Buffer.byteLength(resolved.query.sql) > limits.maxSqlBytes ||
        resolved.query.maxRows > limits.maxRows
      ) return Promise.resolve(failure("invalid-request"));
      const identity = canonicalPhysicalCacheKeyInput(resolved);
      const admission = queryAdmission(resolved.query);
      if (
        admission.sqlSha256 !== sha256(resolved.query.sql) ||
        admission.parameterDeclarationDigest !==
          declarationDigest(resolved.query.parameters) ||
        admission.astNodeCount > limits.maxAstNodes
      ) {
        return Promise.resolve(failure("invalid-request"));
      }
      physicalKey = identity == null
        ? null
        : "analytics-physical_" + sha256(identity);
      bytes = queuedResolvedDescriptorBytes(resolved);
    } catch {
      return Promise.resolve(failure("invalid-request"));
    }
    if (share && physicalKey) {
      const entry = state.cache.get(physicalKey);
      if (entry) {
        state.cache.delete(physicalKey);
        if (entry.expires > Date.now()) {
          if (
            canonicalJson(
              queryAdmission(entry.outcome.result.resolved.query),
            ) !==
              canonicalJson(queryAdmission(resolved.query))
          ) {
            return Promise.resolve(failure("invalid-request"));
          }
          state.cache.set(physicalKey, entry);
          emit({
            kind: "cache",
            physicalKey,
            hit: true,
            entries: state.cache.size,
            bytes: cacheBytes(state.cache),
          });
          return Promise.resolve(rebind(entry.outcome, resolved, limits, true));
        }
      }
      const flight = state.flights.get(physicalKey);
      if (flight && !flight.controller.signal.aborted) {
        if (
          canonicalJson(queryAdmission(flight.resolved.query)) !==
            canonicalJson(queryAdmission(resolved.query))
        ) {
          return Promise.resolve(failure("invalid-request"));
        }
        // Bound subscriber descriptors/listeners as well as physical jobs.
        const attached = [...flight.subscribers].reduce(
          (sum, item) => sum + queuedResolvedDescriptorBytes(item.resolved),
          0,
        );
        if (
          flight.subscribers.size >= limits.maxQueuedExecutions + 1 ||
          attached + bytes > limits.maxQueuedBytes
        ) return Promise.resolve(failure("queue-full"));
        return attach(flight, resolved, signal);
      }
    }
    if (
      state.queue.length >= limits.maxQueuedExecutions ||
      state.queueBytes + bytes > limits.maxQueuedBytes
    ) return Promise.resolve(failure("queue-full"));
    const job = {
      kind: "execute",
      executionId: resolved.executionId,
      resolved,
      physicalKey,
      bytes,
      share,
      controller: new AbortController(),
      subscribers: new Set(),
    };
    state.queue.push(job);
    state.queueBytes += bytes;
    if (share && physicalKey) state.flights.set(physicalKey, job);
    const reply = attach(job, resolved, signal);
    kick();
    return reply;
  }
  function admitQuery(input, signal) {
    if (state.closed) return Promise.resolve(failure("cancelled"));
    if (state.fatal) return Promise.resolve(failure(state.fatal.code));
    if (signal?.aborted) return Promise.resolve(failure("cancelled"));
    const parsed = queryAdmissionRequestSchema.safeParse(input);
    if (
      !parsed.success || Buffer.byteLength(parsed.data.sql) > limits.maxSqlBytes
    ) {
      return Promise.resolve(failure("invalid-request"));
    }
    const bytes = Buffer.byteLength(canonicalJson(parsed.data));
    if (
      state.queue.length >= limits.maxQueuedExecutions ||
      state.queueBytes + bytes > limits.maxQueuedBytes
    ) {
      return Promise.resolve(failure("queue-full"));
    }
    const job = {
      kind: "admit",
      executionId: "analytics-exec_admission_" + randomUUID(),
      request: parsed.data,
      resolved: null,
      physicalKey: null,
      share: false,
      bytes,
      controller: new AbortController(),
      subscribers: new Set(),
    };
    state.queue.push(job);
    state.queueBytes += bytes;
    const reply = attach(job, null, signal);
    kick();
    return reply;
  }
  function close() {
    if (state.closePromise) return state.closePromise;
    state.closed = true;
    clearIdle();
    for (const job of state.queue.splice(0)) {
      job.controller.abort(new RuntimeFault("cancelled"));
      settle(job, failure("cancelled"));
    }
    state.queueBytes = 0;
    state.active?.controller.abort(new RuntimeFault("cancelled"));
    state.closePromise = (async () => {
      // Await the owner of every startup/gate continuation before cleanup.
      await state.running;
      if (state.retiring) await state.retiring;
      if (state.session) await retire(state.session, "parent-close");
      if (state.fatal) throw state.fatal;
      state.flights.clear();
      state.cache.clear();
      if (state.lastPid != null) {
        emit({
          kind: "close-confirmed",
          pid: state.lastPid,
          queued: state.queue.length,
          entries: state.cache.size,
          bytes: cacheBytes(state.cache),
        });
      }
    })();
    return state.closePromise;
  }
  return {
    admitQuery,
    worker: {
      execute: (input, signal) => enqueue(input, signal, false),
      close,
    },
    coordinator: { subscribe: (input, signal) => enqueue(input, signal, true) },
    close,
  };
}

/** One session owns its PID, pending token, close proof, and scratch lifetime. */
class ChildSession {
  static async create({ limits, emit, workerSha256, checkAdmission }) {
    const directory = await mkdtemp(join(tmpdir(), "analytics-query-child-"));
    try {
      const paths = Object.fromEntries(
        ["home", "cache", "config", "data", "tmp", "extensions"]
          .map((name) => [name, join(directory, name)]),
      );
      await Promise.all(Object.values(paths).map((path) => mkdir(path)));
      checkAdmission();
      const child = spawn(process.execPath, [CHILD_ENTRY], {
        cwd: directory,
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          LANG: "C",
          HOME: paths.home,
          XDG_CACHE_HOME: paths.cache,
          XDG_CONFIG_HOME: paths.config,
          XDG_DATA_HOME: paths.data,
          TMPDIR: paths.tmp,
          DUCKDB_EXTENSION_DIRECTORY: paths.extensions,
        },
      });
      return new ChildSession(child, directory, limits, emit, workerSha256);
    } catch (cause) {
      await rm(directory, { recursive: true, force: true });
      throw cause;
    }
  }
  constructor(child, directory, limits, emit, workerSha256) {
    this.child = child;
    this.directory = directory;
    this.limits = limits;
    this.emit = emit;
    this.pid = child.pid;
    this.ready = deferred();
    this.exit = deferred();
    this.closed = false;
    this.stopping = false;
    this.pending = null;
    this.lastExecutionId = RUNTIME_ID;
    this.phase = "booting";
    this.stopPromise = null;
    this.cleanupPromise = null;
    this.onMessage = (message) => this.receive(message);
    this.onError = () => this.fail(new RuntimeFault("worker-crashed"));
    child.on("message", this.onMessage);
    child.on("error", this.onError);
    child.once("spawn", () => {
      this.pid = child.pid;
      emit({ kind: "child-spawn", pid: this.pid, entrySha256: workerSha256 });
      if (this.stopping) return;
      try {
        this.send({
          kind: "bootstrap",
          databaseMemoryLimitBytes: limits.databaseMemoryLimitBytes,
          maxResultBytes: limits.maxCanonicalResultBytes,
        });
      } catch (cause) {
        this.fail(asFault(cause));
        this.stop("startup-failure").catch(() => {});
      }
    });
    child.once("close", (code, signal) => {
      this.closed = true;
      this.phase = "closed";
      this.fail(new RuntimeFault("worker-crashed"));
      child.removeListener("message", this.onMessage);
      child.removeListener("error", this.onError);
      if (this.pid != null) {
        emit({
          kind: "child-exit",
          pid: this.pid,
          executionId: this.lastExecutionId,
          code,
          signal,
        });
      }
      this.exit.resolve();
      // Late confirmed close still owns cleanup after an unconfirmed-exit fault.
      this.cleanup().catch(() => {});
    });
  }
  fail(fault) {
    this.ready.reject(fault);
    this.pending?.prepared.reject(fault);
    this.pending?.result.reject(fault);
  }
  send(message) {
    if (this.closed || this.stopping || !this.child.connected) {
      throw new RuntimeFault("worker-crashed");
    }
    this.child.send(message, (cause) => {
      if (cause) this.fail(new RuntimeFault("worker-crashed"));
    });
  }
  begin(token, executionId, checkpointEnabled) {
    if (this.phase !== "idle" || this.pending) {
      throw new RuntimeFault("worker-crashed");
    }
    this.lastExecutionId = executionId;
    this.phase = "preparing";
    this.pending = {
      token,
      checkpointEnabled,
      prepared: deferred(),
      result: deferred(),
      onCheckpoint: null,
    };
    return this.pending;
  }
  commitMaterialization(request) {
    if (this.pending !== request || this.phase !== "checkpoint") {
      throw new RuntimeFault("worker-crashed");
    }
    this.phase = "preparing-after-checkpoint";
    this.send({ kind: "commit-materialization", token: request.token });
  }
  beginAdmission(token, executionId) {
    const request = this.begin(token, executionId, false);
    this.phase = "admitting";
    return this.pending;
  }
  continue(request) {
    if (this.pending !== request || this.phase !== "prepared") {
      throw new RuntimeFault("worker-crashed");
    }
    this.phase = "executing";
    this.send({ kind: "continue", token: request.token });
  }
  finish(request) {
    if (this.pending !== request || this.phase !== "result") {
      throw new RuntimeFault("worker-crashed");
    }
    this.pending = null;
    this.phase = "idle";
  }
  receive(message) {
    if (this.closed || this.stopping) return;
    try {
      if (
        this.phase === "booting" &&
        exactKeys(message, ["kind", "bootstrapFingerprint"]) &&
        message.kind === "ready" &&
        message.bootstrapFingerprint === bootstrapFingerprint()
      ) {
        this.phase = "idle";
        this.emit({
          kind: "bootstrap-ready",
          pid: this.pid,
          bootstrapFingerprint: message.bootstrapFingerprint,
        });
        this.ready.resolve();
        return;
      }
      const request = this.pending;
      if (!request || message?.token !== request.token) {
        throw new RuntimeFault("worker-crashed");
      }
      if (
        this.phase === "admitting" && message.kind === "admitted" &&
        exactKeys(message, ["kind", "token", "admission"]) &&
        queryAdmissionAttestationSchema.safeParse(message.admission).success
      ) {
        this.phase = "result";
        request.result.resolve(message);
        return;
      }
      if (
        message.kind === "materialization-checkpoint" &&
        this.phase === "preparing" &&
        request.checkpointEnabled && exactKeys(message, ["kind", "token"])
      ) {
        this.phase = "checkpoint";
        request.onCheckpoint();
        return;
      }
      if (
        message.kind === "started" &&
        ["preparing", "preparing-after-checkpoint"].includes(this.phase) &&
        exactKeys(message, [
          "kind",
          "token",
          "materializationId",
          "childReadCount",
          "reused",
        ]) &&
        typeof message.materializationId === "string" &&
        HASH.test(message.materializationId) &&
        typeof message.reused === "boolean" &&
        Number.isSafeInteger(message.childReadCount) &&
        message.childReadCount >= 0
      ) {
        this.phase = "prepared";
        request.prepared.resolve(message);
        return;
      }
      if (
        message.kind === "result" &&
        exactKeys(message, ["kind", "token", "error"]) &&
        [
          "admitting",
          "preparing",
          "preparing-after-checkpoint",
          "checkpoint",
          "executing",
        ]
          .includes(this.phase) &&
        exactKeys(message.error, ["code", "message"]) &&
        executionErrorSchema.safeParse({ ...message.error, retryable: false })
          .success
      ) {
        // No engine-controlled text crosses the public boundary.
        const fault = new RuntimeFault(message.error.code);
        request.prepared.reject(fault);
        request.result.reject(fault);
        this.phase = "failed";
        return;
      }
      if (
        message.kind === "result" && this.phase === "executing" &&
        exactKeys(message, [
          "kind",
          "token",
          "columns",
          "rows",
          "truncated",
          "elapsedMs",
        ]) &&
        Array.isArray(message.columns) &&
        message.columns.length <= this.limits.maxColumns &&
        Array.isArray(message.rows) &&
        message.rows.length <= this.limits.maxRows &&
        typeof message.truncated === "boolean" &&
        Number.isFinite(message.elapsedMs) &&
        message.elapsedMs >= 0 &&
        message.elapsedMs <= this.limits.queryDeadlineMs &&
        Buffer.byteLength(JSON.stringify(message)) <=
          this.limits.maxCanonicalResultBytes + 4096
      ) {
        this.phase = "result";
        request.result.resolve(message);
        return;
      }
      throw new RuntimeFault("worker-crashed");
    } catch (cause) {
      this.phase = "failed";
      this.fail(asFault(cause));
      this.stop("worker-crash").catch(() => {});
    }
  }
  cleanup() {
    if (!this.closed) return Promise.reject(new RuntimeFault("worker-crashed"));
    this.cleanupPromise ??= rm(this.directory, {
      recursive: true,
      force: true,
    });
    return this.cleanupPromise;
  }
  stop(reason, executionId = this.lastExecutionId) {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.lastExecutionId = executionId;
    this.fail(new RuntimeFault("worker-crashed"));
    this.stopPromise = (async () => {
      if (!this.closed) {
        if (this.pid != null) {
          this.emit({
            kind: "kill-requested",
            pid: this.pid,
            executionId,
            reason,
          });
          try {
            if (process.platform === "win32") this.child.kill("SIGKILL");
            else process.kill(-this.pid, "SIGKILL");
          } catch (cause) {
            if (cause?.code !== "ESRCH") {
              throw new RuntimeFault("worker-crashed");
            }
          }
        }
        try {
          await phase(
            () => this.exit.promise,
            undefined,
            this.limits.parentKillGraceMs,
            "worker-crashed",
          );
        } catch (cause) {
          // No fabricated close, no deletion, and no replacement on this path.
          this.child.removeListener("message", this.onMessage);
          try {
            this.child.disconnect();
          } catch { /* already disconnected */ }
          this.child.unref();
          throw cause;
        }
      }
      await this.cleanup();
    })();
    return this.stopPromise;
  }
}

class RuntimeFault extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code] ?? SAFE_MESSAGES["worker-crashed"]);
    this.code = code;
  }
}
function asFault(cause) {
  return cause instanceof RuntimeFault
    ? cause
    : new RuntimeFault("worker-crashed");
}
function failure(code) {
  const safeCode = Object.hasOwn(SAFE_MESSAGES, code) ? code : "worker-crashed";
  return {
    kind: "error",
    error: {
      code: safeCode,
      retryable: [
        "queue-full",
        "worker-crashed",
        "worker-startup-timeout",
        "stale-snapshot",
      ].includes(safeCode),
      message: SAFE_MESSAGES[safeCode],
    },
  };
}
function killReason(fault, closed) {
  if (closed) return "parent-close";
  if (fault.code === "cancelled") return "subscriber-cancelled";
  if (fault.code === "query-timeout") return "deadline";
  if (fault.code === "materialization-timeout") {
    return "materialization-timeout";
  }
  if (fault.code === "worker-startup-timeout") return "startup-failure";
  return "worker-crash";
}

/** Await a phase with owned timers/listeners; abort invalidates late gates. */
function phase(operation, parentSignal, milliseconds, timeoutCode) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let done = false, timer;
    const finish = (cause, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
      controller.abort(cause ?? new RuntimeFault("cancelled"));
      if (cause) reject(cause);
      else resolve(value);
    };
    const abort = () => finish(asFault(parentSignal.reason));
    parentSignal?.addEventListener("abort", abort, { once: true });
    if (parentSignal?.aborted) {
      abort();
      return;
    }
    if (milliseconds != null) {
      timer = setTimeout(
        () => finish(new RuntimeFault(timeoutCode)),
        milliseconds,
      );
    }
    Promise.resolve().then(() => {
      if (done) throw new RuntimeFault("cancelled");
      return operation(controller.signal);
    }).then((value) => finish(null, value), (cause) => finish(asFault(cause)));
  });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
function exactKeys(value, keys) {
  return value != null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
function parseTrustedSource(source) {
  const keys = [
    "kind",
    "sourceScope",
    "snapshotId",
    "sourceGeneration",
    "factProjectionVersion",
    "maxChunkBytes",
    "maxRowsPerChunk",
  ];
  if (source?.kind === "node-sqlite-readonly") {
    keys.push("readonlyDatabasePath");
  }
  if (
    !exactKeys(source, keys) ||
    !["node-sqlite-readonly", "generation-checked-stream"].includes(
      source.kind,
    ) ||
    !/^analytics-snapshot_[A-Za-z0-9_-]{8,180}$/.test(source.snapshotId) ||
    !Number.isSafeInteger(source.sourceGeneration) ||
    source.sourceGeneration < 0 ||
    !Number.isSafeInteger(source.factProjectionVersion) ||
    source.factProjectionVersion < 1 ||
    !Number.isSafeInteger(source.maxChunkBytes) || source.maxChunkBytes < 1 ||
    source.maxChunkBytes > EXECUTION_LIMITS.maxTransferChunkBytes ||
    !Number.isSafeInteger(source.maxRowsPerChunk) ||
    source.maxRowsPerChunk < 1 ||
    source.maxRowsPerChunk > EXECUTION_LIMITS.maxTransferRowsPerChunk ||
    !sourceScopeSchema.safeParse(source.sourceScope).success
  ) throw new RuntimeFault("invalid-request");
  if (
    source.kind === "node-sqlite-readonly" &&
    (typeof source.readonlyDatabasePath !== "string" ||
      !isAbsolute(source.readonlyDatabasePath) ||
      source.readonlyDatabasePath.includes("\0") ||
      source.readonlyDatabasePath.length > 4096 ||
      normalize(source.readonlyDatabasePath) !== source.readonlyDatabasePath)
  ) throw new RuntimeFault("invalid-request");
  return structuredClone(source);
}
function reducedLimits(overrides = {}) {
  const result = { ...EXECUTION_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (
      !Object.hasOwn(result, key) || !Number.isSafeInteger(value) ||
      value < 1 || value > result[key]
    ) {
      throw new RuntimeFault("invalid-request");
    }
    result[key] = value;
  }
  return Object.freeze(result);
}
function resultBytes(result) {
  return canonicalResultWireBytes({
    columns: result.columns,
    rows: result.rows,
    datumKeys: result.datumKeys,
    resultExtent: result.resultExtent,
    resultTruncated: result.resultTruncated,
  });
}
function makeOutcome(resolved, physicalKey, message, limits, startedAtMs) {
  const { columns, rows } = message;
  const result = {
    columns,
    rows,
    datumKeys: deriveExecutionDatumKeys(resolved.executionId, rows),
    resultExtent: message.truncated
      ? { kind: "lower-bound", rows: rows.length + 1 }
      : { kind: "exact", rows: rows.length },
    resultTruncated: message.truncated,
  };
  result.encodedBytes = resultBytes(result);
  const candidate = {
    version: 2,
    executionId: resolved.executionId,
    resolved,
    coverage: resolved.snapshot.coverage,
    result,
    startedAtMs,
    completedAtMs: Math.max(startedAtMs, Date.now()),
    elapsedMs: message.elapsedMs,
    cache: {
      status: physicalKey == null ? "uncacheable" : "miss",
      physicalExecutionKey: physicalKey,
    },
  };
  const parsed = executionResultSchema.safeParse(candidate);
  return parsed.success && result.encodedBytes <= limits.maxCanonicalResultBytes
    ? { kind: "success", result: parsed.data }
    : failure("result-limit");
}
function rebind(outcome, resolved, limits, reused) {
  const candidate = {
    ...outcome.result,
    executionId: resolved.executionId,
    resolved,
    coverage: resolved.snapshot.coverage,
    result: {
      ...outcome.result.result,
      datumKeys: deriveExecutionDatumKeys(
        resolved.executionId,
        outcome.result.result.rows,
      ),
    },
    cache: {
      ...outcome.result.cache,
      status: reused ? "physical-reuse" : outcome.result.cache.status,
    },
  };
  candidate.result.encodedBytes = resultBytes(candidate.result);
  const parsed = executionResultSchema.safeParse(candidate);
  // Parsing also gives each subscriber independent row/column arrays.
  return parsed.success &&
      parsed.data.result.encodedBytes <= limits.maxCanonicalResultBytes
    ? { kind: "success", result: parsed.data }
    : failure("result-limit");
}
function canonicalJson(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  return "{" +
    Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ":" + canonicalJson(value[key])
    ).join(",") + "}";
}
function bootstrapFingerprint() {
  return sha256(
    canonicalJson({
      packageName: SELECTED_EXECUTION_RUNTIME.packageName,
      packageVersion: SELECTED_EXECUTION_RUNTIME.packageVersion,
      bootstrap: SELECTED_EXECUTION_RUNTIME.bootstrap,
    }),
  );
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function declarationDigest(parameters) {
  return sha256(parameterDeclarationDigestInput(parameters));
}
function queryAdmission(query) {
  return queryAdmissionAttestationSchema.parse({
    astPolicyRevision: query.astPolicyRevision,
    astNodeCount: query.astNodeCount,
    sqlSha256: query.sqlSha256,
    parameterDeclarationDigest: query.parameterDeclarationDigest,
    cacheability: query.cacheability,
  });
}
function cacheBytes(cache) {
  let bytes = 0;
  for (const entry of cache.values()) bytes += entry.size;
  return bytes;
}
