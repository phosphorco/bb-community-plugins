import { randomUUID } from "node:crypto";
import { parseFixture } from "../contracts/fixture.ts";
import { fingerprint } from "../contracts/hash.ts";
import { normalizeAdvice, VERSION } from "../contracts/model.ts";
import { evaluate } from "../evaluation/evaluator.ts";
import { evaluateScoped } from "../evaluation/scoped.ts";
import type { Transport, TokenCounter } from "../evaluation/evaluator.ts";
import { TransportError } from "../evaluation/transport.ts";
import { plannedBatch } from "../admission/policy.ts";
import { Conflict } from "../state/store.ts";
import type { Store, Run, FrozenSuite, TestResult } from "../state/store.ts";
export function assertResult(
  f: ReturnType<typeof parseFixture>,
  e: Awaited<ReturnType<typeof evaluate>>,
): Omit<TestResult, "occurrenceId" | "path" | "evaluation"> {
  if (e.policy === "unknown")
    return {
      status: "unknown",
      reason:
        e.errors.join("; ") ||
        e.rules.find((x) => x.status === "unknown")?.reason ||
        "Mandatory checks are unresolved.",
    };
  const actual = e.rules
      .filter((x) => x.status === "reject")
      .map((x) => x.id)
      .sort(),
    expected = f.meta.expected_rules && [...f.meta.expected_rules].sort();
  if (f.meta.expect !== e.policy)
    return {
      status: "fail",
      reason: `Expected ${f.meta.expect}; message was ${e.policy === "allow" ? "allowed" : "rejected"}.`,
    };
  if (expected && JSON.stringify(actual) !== JSON.stringify(expected))
    return {
      status: "fail",
      reason:
        "Rejecting rules differ. Expected " +
        expected.join(", ") +
        "; got " +
        actual.join(", ") +
        ".",
    };
  if (
    f.meta.expected_batch !== undefined &&
    JSON.stringify(f.meta.expected_batch) !==
      JSON.stringify(e.plannedBatch ?? [])
  )
    return {
      status: "fail",
      reason:
        "Planned eligible batch membership differs; this is not native delivery proof.",
    };
  if (
    f.expectedAdvice !== undefined &&
    JSON.stringify(f.expectedAdvice.map(normalizeAdvice)) !==
      JSON.stringify(e.advice.map((x) => normalizeAdvice(x.text)))
  )
    return {
      status: "fail",
      reason: "Expected advice differs from the exact ordered advice.",
    };
  return {
    status: "pass",
    reason:
      e.policy === "reject"
        ? "Expected rejection and assertions matched."
        : "Expected outcome and assertions matched.",
  };
}
export function savedBasis(p: NonNullable<ReturnType<Store["get"]>>) {
  return fingerprint({
    version: VERSION,
    config: p.config,
    rules: p.rules,
    groups: p.groups,
    occurrences: p.occurrences,
  });
}
export function createSuiteService(
  store: Store,
  transportFor: (run: Run) => Transport,
  countTokens?: TokenCounter,
) {
  const owner = randomUUID(),
    workers = new Map<
      string,
      { abort: AbortController; promise: Promise<void> }
    >();
  let disposed = false;
  store.recover(owner);
  const notify = new Set<(projectId: string, discoverFiles: boolean) => void>();
  const emit = (projectId: string, discoverFiles = false) => {
    for (const fn of notify) fn(projectId, discoverFiles);
  };
  async function execute(run: Run, abort: AbortController) {
    let unknown = false;
    try {
      for (const o of run.frozen.occurrences) {
        if (abort.signal.aborted) break;
        if (o.error || !o.source) {
          store.append(run.id, owner, {
            occurrenceId: o.occurrenceId,
            path: o.path,
            status: "error",
            reason: o.error ?? "Missing source.",
          });
          emit(run.frozen.projectId);
          continue;
        }
        let fixture;
        try {
          fixture = parseFixture(o.source);
          const unknownIds = fixture.meta.expected_rules?.filter(
            (id) => !run.frozen.rules.some((r) => r.id === id),
          );
          if (unknownIds?.length)
            throw Error("Unknown expected rule IDs: " + unknownIds.join(", "));
        } catch (e) {
          store.append(run.id, owner, {
            occurrenceId: o.occurrenceId,
            path: o.path,
            status: "error",
            reason: e instanceof Error ? e.message : String(e),
          });
          emit(run.frozen.projectId);
          continue;
        }
        const inner = transportFor(run);
        const transport: Transport = (wire, signal, dispatch) => {
          const attempt = store.attempt(
            run.id,
            owner,
            fingerprint(wire),
            wire,
            {
              occurrenceId: o.occurrenceId,
              path: o.path,
              sourceHash: o.hash,
              savedBasis: run.frozen.basis,
              dispatch,
            },
          );
          store.invoke(attempt, owner);
          let pending: Promise<unknown>;
          // No await or owner transfer between permit commit and synchronous initiation.
          try {
            pending = inner(wire, signal, dispatch);
          } catch (e) {
            store.observe(attempt, "unknown", { error: String(e) });
            unknown = true;
            throw e;
          }
          return pending.then(
            (raw) => {
              store.observe(attempt, "observed", raw);
              return raw;
            },
            (e) => {
              const sent = !(e instanceof TransportError) || e.invoked;
              store.observe(attempt, sent ? "unknown" : "not-sent", {
                error: e instanceof Error ? e.message : String(e),
                invoked: sent,
                observation: e instanceof TransportError ? e.observation : null,
              });
              unknown ||= sent;
              throw e;
            },
          );
        };
        const evaluation = await evaluateScoped(
          { ...fixture.capture, projectId: run.frozen.projectId },
          run.frozen.groups ?? [],
          run.frozen.rules,
          run.frozen.config.connection,
          async () => ({ ...fixture.capture, projectId: run.frozen.projectId }),
          transport,
          abort.signal,
          countTokens,
        );
        if (
          fixture.queued &&
          evaluation.rules.some(
            (result) =>
              result.status === "allow" &&
              run.frozen.rules.some(
                (r) => r.id === result.id && r.action === "batch",
              ),
          )
        )
          evaluation.plannedBatch = plannedBatch(fixture.queued).included;
        store.append(run.id, owner, {
          occurrenceId: o.occurrenceId,
          path: o.path,
          evaluation,
          ...assertResult(fixture, evaluation),
        });
        emit(run.frozen.projectId);
        if (unknown) break;
      }
      if (unknown)
        store.finish(
          run.id,
          owner,
          "stopped-unknown",
          "An invoked transport outcome is unknown. No automatic replay; unresolved spend retained.",
        );
      else
        store.finish(
          run.id,
          owner,
          abort.signal.aborted ? "cancelled" : "complete",
        );
    } catch (e) {
      store.finish(
        run.id,
        owner,
        "stopped-unknown",
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      store.quiesce(run.id, owner);
      workers.delete(run.id);
      emit(run.frozen.projectId, true);
    }
  }
  return {
    owner,
    subscribe(fn: (projectId: string, discoverFiles: boolean) => void) {
      notify.add(fn);
      return () => notify.delete(fn);
    },
    start(
      projectId: string,
      requestId: string,
      expectedBasis: string,
      actor: unknown,
    ) {
      if (disposed) throw Error("Message Rules is stopping.");
      const existing = store.db
        .prepare("SELECT id FROM mr_runs WHERE project_id=? AND request_id=?")
        .get(projectId, requestId) as { id: string } | undefined;
      if (existing) {
        const old = store.run(existing.id)!;
        if (old.frozen.basis !== expectedBasis)
          throw new Conflict("Request ID was used with different inputs.");
        return old;
      }
      const p = store.get(projectId);
      if (!p || savedBasis(p) !== expectedBasis) throw new Conflict();
      const frozen: FrozenSuite = {
        version: VERSION,
        projectId,
        config: structuredClone(p.config),
        rules: structuredClone(p.rules),
        groups: structuredClone(p.groups),
        occurrences: structuredClone(p.occurrences.filter((o) => o.enabled)),
        denominator: p.occurrences.filter((o) => o.enabled).length,
        basis: expectedBasis,
        actor,
      };
      const run = store.start(requestId, frozen, owner);
      const abort = new AbortController();
      const promise = Promise.resolve().then(() => execute(run, abort));
      workers.set(run.id, { abort, promise });
      emit(projectId);
      return run;
    },
    cancel(id: string) {
      store.cancel(id);
      workers.get(id)?.abort.abort();
      const run = store.run(id);
      if (run) emit(run.frozen.projectId);
    },
    async dispose() {
      disposed = true;
      for (const [id, w] of workers) {
        store.cancel(id);
        w.abort.abort();
      }
      await Promise.all([...workers.values()].map((w) => w.promise));
      notify.clear();
    },
  };
}
