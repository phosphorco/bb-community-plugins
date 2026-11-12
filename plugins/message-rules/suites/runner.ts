import { randomUUID } from "node:crypto";
import { parseFixture } from "../contracts/fixture.ts";
import { fingerprint } from "../contracts/hash.ts";
import { normalizeAdvice, VERSION, actionOf } from "../contracts/model.ts";
import { evaluate } from "../evaluation/evaluator.ts";
import { evaluateScoped } from "../evaluation/scoped.ts";
import type { Transport, TokenCounter } from "../evaluation/evaluator.ts";
import { TransportError } from "../evaluation/transport.ts";
import { previewFixturePlacement } from "../evaluation/placement.ts";
import type { PlacementPort } from "../contracts/placement.ts";
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
  if(f.nativePlacement) {
    const observation=e.nativePlacement;
    if(!observation||observation.state!=="simulated")return {
      status:"unknown",reason:observation&&"reason" in observation?observation.reason:"Native placement assertion has no public-port result.",
    };
    const expected=f.nativePlacement.expect,actual=observation.result;
    if(actual.status!==expected.status||actual.targetGroupId!==expected.targetGroupId||
      JSON.stringify(actual.orderedOriginalIds)!==JSON.stringify(expected.orderedOriginalIds)||
      (expected.reasonCodes&&JSON.stringify(actual.reasons.map(reason=>reason.code).sort())!==JSON.stringify([...expected.reasonCodes].sort())))
      return {status:"fail",reason:"Native placement differs from the expected status, exact target, ordered originals or reason codes. This was a nonmutating simulation."};
  }
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
  if (f.meta.expected_route !== undefined && f.meta.expected_route !== e.route?.action)
    return { status: "fail" as const, reason: "Routing preference differs from expected_route." };
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
  placementPort?: PlacementPort,
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
    const deadlineAt =
      run.frozen.projectId === "message-rules-global"
        ? run.createdAt + run.frozen.config.connection.timeoutMs
        : Infinity;
    const deadline =
      run.frozen.projectId === "message-rules-global"
        ? setTimeout(
            () => abort.abort(),
            run.frozen.config.connection.timeoutMs,
          )
        : null;
    try {
      for (const o of run.frozen.occurrences) {
        // Promise-only deterministic fixtures can starve a timer's task queue.
        // Check the same run deadline at each fixture boundary as well.
        if (Date.now() >= deadlineAt) abort.abort();
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
          // Legacy fixture bytes stay untouched; collisions resolve in the frozen source mapping.
          if (
            fixture.meta.expected_rules &&
            o.ruleAliases &&
            fixture.meta.rule_catalog !== "global"
          )
            fixture.meta.expected_rules = fixture.meta.expected_rules.map(
              (id) => o.ruleAliases![id] ?? id,
            );
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
          // Immediate promises can cross the deadline before its timer runs.
          // Deny a fresh permit at every partition, before any reservation.
          if (Date.now() >= deadlineAt) abort.abort();
          if (signal.aborted) throw Error("Test all cancelled or time budget exhausted.");
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
          let receipt:unknown=null;
          // No await or owner transfer between permit commit and synchronous initiation.
          try {
            pending = inner(wire, signal, dispatch,{operation:{namespace:'message-rules.suite',operationId:attempt},deadlineAt:Math.min(deadlineAt,Date.now()+run.frozen.config.connection.timeoutMs),kind:'message-rules.suite',attribution:{runId:run.id,requestId:run.requestId,attemptId:attempt,occurrenceId:o.occurrenceId,sourceHash:o.hash,partitionHash:dispatch?.partitionHash??fingerprint(wire)},observe:value=>{receipt=value;}});
          } catch (e) {
            store.observe(attempt, "unknown", { error: String(e) });
            unknown = true;
            throw e;
          }
          return pending.then(
            (raw) => {
              store.observe(attempt, "observed", receipt===null?raw:{response:raw,transport:receipt});
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
          {
            ...fixture.capture,
            projectId:
              fixture.meta.project_id !== undefined
                ? fixture.meta.project_id
                : o.projectId !== undefined
                  ? o.projectId
                  : run.frozen.projectId,
          },
          run.frozen.groups ?? [],
          run.frozen.rules,
          run.frozen.config.connection,
          async () => ({
            ...fixture.capture,
            projectId:
              fixture.meta.project_id !== undefined
                ? fixture.meta.project_id
                : o.projectId !== undefined
                  ? o.projectId
                  : run.frozen.projectId,
          }),
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
                (r) => r.id === result.id && actionOf(r) === "queue-batched",
              ),
          )
        )
          evaluation.plannedBatch = plannedBatch(fixture.queued).included;
        if(fixture.nativePlacement) {
          if(Date.now()>=deadlineAt)abort.abort();
          evaluation.nativePlacement=await previewFixturePlacement(fixture,evaluation,
            fixture.meta.project_id!==undefined?fixture.meta.project_id:o.projectId!==undefined?o.projectId:run.frozen.projectId,
            placementPort,abort.signal);
        }
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
          Date.now() >= deadlineAt
            ? "Test all time budget exhausted; unfinished fixtures remain in the frozen denominator."
            : null,
        );
    } catch (e) {
      store.finish(
        run.id,
        owner,
        "stopped-unknown",
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      if (deadline) clearTimeout(deadline);
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
      selectedOccurrenceIds?: string[],
    ) {
      if (disposed) throw Error("Message Rules is stopping.");
      if (selectedOccurrenceIds !== undefined &&
          (!Array.isArray(selectedOccurrenceIds) || selectedOccurrenceIds.length < 1 || selectedOccurrenceIds.length > 100 ||
           selectedOccurrenceIds.some(id => typeof id !== "string" || !id.length || id.length > 200)))
        throw Error("Select 1..100 saved enabled test identities.");
      const selection = selectedOccurrenceIds === undefined ? undefined : [...new Set(selectedOccurrenceIds)].sort();
      const existing = store.db
        .prepare("SELECT id FROM mr_runs WHERE project_id=? AND request_id=?")
        .get(projectId, requestId) as { id: string } | undefined;
      if (existing) {
        const old = store.run(existing.id)!;
        if (old.frozen.basis !== expectedBasis || JSON.stringify(old.frozen.selectedOccurrenceIds) !== JSON.stringify(selection))
          throw new Conflict("Request ID was used with different inputs.");
        return old;
      }
      const p = store.get(projectId);
      if (!p || savedBasis(p) !== expectedBasis) throw new Conflict();
      if (selection?.some(id => !p.occurrences.some(o => o.occurrenceId === id && o.enabled && !o.missing && !o.error && !!o.source)))
        throw Error("Selected test is missing, disabled, invalid or no longer saved. Refresh before Test.");
      const occurrences = p.occurrences.filter(o => o.enabled && (!selection || selection.includes(o.occurrenceId)));
      const frozen: FrozenSuite = {
        ...(selection ? { selectedOccurrenceIds: selection } : {}),
        version: VERSION,
        projectId,
        config: structuredClone(p.config),
        rules: structuredClone(p.rules),
        groups: structuredClone(p.groups),
        occurrences: structuredClone(occurrences),
        denominator: occurrences.length,
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
