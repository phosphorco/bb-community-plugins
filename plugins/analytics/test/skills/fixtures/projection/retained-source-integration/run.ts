import assert from "node:assert/strict";

import Database from "better-sqlite3";

import { RetainedSkillObservationProjector } from "../../../../../extraction/skill-observation-projector.ts";
import type { RetainedSourceSdk } from "../../../../../extraction/source-adapter.ts";
import { analyticsMigrations, AnalyticsStore } from "../../../../../store.ts";

const hash = (character: string) => character.repeat(64);

function observedEvent(id: string, sequence: number, createdAt: number, turnId: string | null = null) {
  return {
    id,
    threadId: "thread-authoritative",
    seq: sequence,
    createdAt,
    type: "skill/observed",
    data: { observation: {
      schemaVersion: 1 as const,
      observationId: `skillobs_v1_${hash(sequence % 2 === 0 ? "a" : "b")}`,
      dedupeKey: `skillobs_dedupe_v1_${hash(sequence % 2 === 0 ? "c" : "d")}`,
      evidenceKind: "active-staged" as const,
      status: "supported" as const,
      captureTrigger: "active-staging",
      actor: { principalId: "principal-that-is-not-a-project" },
      threadId: "thread-authoritative",
      providerSessionId: "session-authoritative",
      // Deliberately stale: the thread metadata is the source of truth.
      providerId: "provider-from-event-only",
      providerModel: "model-a",
      providerTurnId: turnId,
      providerEventId: `provider-${id}`,
      skill: {
        skillId: "skill-a",
        name: "Skill A",
        skillMarkdownPath: "/work/skills/a/SKILL.md",
        sourceKind: "project",
        sourceId: "source-a",
        pluginId: null,
        catalogRevision: hash("e"),
        skillMarkdownRevision: hash("f"),
        treeRevision: hash("0"),
      },
      measurement: null,
      failure: null,
    } },
  };
}

type SourceState = {
  listed: boolean;
  missing: boolean;
  projectId?: string;
  environmentId?: string | null;
  providerId?: string;
  events: unknown[];
};

function publicSdk(state: SourceState): RetainedSourceSdk {
  return {
    threads: {
      async list({ limit = 200, offset = 0 }: { limit?: number; offset?: number }) {
        if (!state.listed) return [];
        // These values are deliberately wrong. Production must ignore them.
        return [{ id: "thread-authoritative", projectId: "project-from-list", environmentId: "environment-from-list", providerId: "provider-from-list" }].slice(offset, offset + limit);
      },
      async get() {
        if (state.missing) {
          const error = Object.assign(new Error("gone"), { name: "BbHttpError", status: 404, code: "thread_not_found" });
          throw error;
        }
        return {
          id: "thread-authoritative",
          projectId: state.projectId,
          environmentId: state.environmentId,
          providerId: state.providerId,
        };
      },
      events: {
        async list({ afterSeq, limit = "100", types }: { afterSeq?: string; limit?: string; types?: readonly string[] }) {
          assert.deepEqual(types, ["skill/observed"], "skill source traversal must request the public server-side skill/observed filter");
          const cursor = afterSeq == null ? -1 : Number(afterSeq);
          return state.events.filter((event) => (event as { seq: number }).seq > cursor).slice(0, Number(limit));
        },
      },
    },
  } as unknown as RetainedSourceSdk;
}

function store(): AnalyticsStore {
  const db = new Database(":memory:");
  for (const migration of analyticsMigrations) db.exec(migration);
  const result = new AnalyticsStore(db);
  result.initializeSkillProjectionCoverage(1_000);
  return result;
}

async function positivePath(): Promise<void> {
  const target = store();
  const state: SourceState = {
    listed: true, missing: false, projectId: "project-authoritative", environmentId: "environment-authoritative", providerId: "provider-authoritative",
    events: [observedEvent("event-pre-instrumentation", 1, 900, null), observedEvent("event-observed", 2, 1_200, null)],
  };
  const projector = new RetainedSkillObservationProjector({
    sdk: publicSdk(state), store: target, clock: () => 1_300, coverageStart: { startedAtMs: 1_000 },
    limits: { listPageSize: 1, eventPageSize: 1, maxCalls: 20, maxListPages: 4, maxEventPages: 8, maxRows: 100, maxResponseBytes: 100_000 },
  });
  const first = await projector.reconcile();
  assert.equal(first.observationCount, 2, "all paged durable skill observations were projected");
  const active = target.listActiveSkillLifecycleFacts();
  assert.equal(active.length, 2);
  assert.deepEqual(active.map((fact) => ({ projectId: fact.projectId, environmentId: fact.environmentId, providerId: fact.providerId })), [
    { projectId: "project-authoritative", environmentId: "environment-authoritative", providerId: "provider-authoritative" },
    { projectId: "project-authoritative", environmentId: "environment-authoritative", providerId: "provider-authoritative" },
  ]);
  assert.equal(active.find((fact) => fact.sourceEventId === "event-observed")?.providerTurnId, null, "nullable turn identity survives publication");
  assert.equal(active.find((fact) => fact.sourceEventId === "event-pre-instrumentation")?.coverageEpochId, "coverage-pre-instrumentation");
  assert.equal(active.find((fact) => fact.sourceEventId === "event-observed")?.coverageEpochId, "coverage-lifecycle-observed-1000");
  assert.equal(target.listSkillCoverageEpochs().find((epoch) => epoch.endedAtMs === null)?.lifecycle, "observed");
  assert.equal(target.listSkillCoverageEpochs().find((epoch) => epoch.endedAtMs === null)?.activation, "unsupported");

  // History changes are a new exact source event: the old active generation
  // retracts and the rewritten source remains available in raw storage.
  state.events = [observedEvent("event-history-rewrite", 3, 1_250, "turn-after-rewrite")];
  await projector.reconcile();
  assert.deepEqual(target.listActiveSkillLifecycleFacts().map((fact) => fact.sourceEventId), ["event-history-rewrite"]);

  // Omission from list is not enough to retract; the retained source thread is
  // re-read. An exact public 404 then retracts the whole thread atomically.
  state.listed = false;
  await projector.reconcile();
  assert.equal(target.listActiveSkillLifecycleFacts().length, 1, "list omission was not treated as deletion");
  state.missing = true;
  await projector.reconcile();
  assert.equal(target.listActiveSkillLifecycleFacts().length, 0, "only exact public not-found retracts a retained source thread");
}

async function missingProjectNegative(): Promise<void> {
  const target = store();
  const state: SourceState = { listed: true, missing: false, environmentId: null, providerId: "provider", events: [observedEvent("missing-project", 2, 1_200)] };
  const projector = new RetainedSkillObservationProjector({ sdk: publicSdk(state), store: target, clock: () => 1_300 });
  await assert.rejects(projector.reconcile(), /authoritative projectId/u);
  assert.equal(target.readSkillProjectionState().generationId, 0, "missing dimensions cannot publish a partial generation");
}

async function flattenedObservationNegative(): Promise<void> {
  const target = store();
  const actual = observedEvent("flattened", 2, 1_200);
  const flattened = { ...actual, observation: actual.data.observation };
  delete (flattened as { data?: unknown }).data;
  const state: SourceState = { listed: true, missing: false, projectId: "project", environmentId: null, providerId: "provider", events: [flattened] };
  const projector = new RetainedSkillObservationProjector({ sdk: publicSdk(state), store: target, clock: () => 1_300 });
  await assert.rejects(projector.reconcile(), /data\.observation/u);
  assert.equal(target.readSkillProjectionState().generationId, 0, "fixture-only flattened events cannot reach publication");
}

async function wrongEnvironmentNegative(): Promise<void> {
  const target = store();
  const state: SourceState = { listed: true, missing: false, projectId: "project", environmentId: "wrong-environment", providerId: "provider", events: [observedEvent("wrong-environment", 2, 1_200)] };
  const projector = new RetainedSkillObservationProjector({ sdk: publicSdk(state), store: target, clock: () => 1_300 });
  await projector.reconcile();
  assert.throws(
    () => assert.equal(target.listActiveSkillLifecycleFacts()[0]?.environmentId, "environment-expected"),
    /Expected values to be strictly equal/u,
    "the production-bound assertion detects an environment substituted from any non-authoritative source",
  );
}

async function unwiredCommitNegative(): Promise<void> {
  const target = store();
  const state: SourceState = { listed: true, missing: false, projectId: "project", environmentId: null, providerId: "provider", events: [observedEvent("unwired", 2, 1_200)] };
  target.commitSkillProjection = () => undefined;
  const projector = new RetainedSkillObservationProjector({ sdk: publicSdk(state), store: target, clock: () => 1_300 });
  await projector.reconcile();
  assert.throws(
    () => assert.equal(target.listActiveSkillLifecycleFacts().length, 1),
    /Expected values to be strictly equal/u,
    "the production-bound assertion detects an unwired commit path",
  );
}

async function main(): Promise<void> {
  await positivePath();
  await missingProjectNegative();
  await flattenedObservationNegative();
  await wrongEnvironmentNegative();
  await unwiredCommitNegative();
  process.stdout.write(`${JSON.stringify({ status: "pass", checks: ["public-sdk-pagination", "authoritative-thread-dimensions", "pre-instrumentation-and-observed-coverage", "history-rewrite-and-exact-deletion", "missing-project-negative", "flattened-observation-negative", "wrong-environment-negative", "unwired-commit-negative"] })}\n`);
}

await main();
