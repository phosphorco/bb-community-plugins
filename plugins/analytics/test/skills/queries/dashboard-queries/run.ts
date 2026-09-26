import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { analyticsMigrations } from "../../../../store.ts";
import { SkillQueryService } from "../../../../skill-query-service.ts";

const hash = (character: string) => character.repeat(64);
const revisionA = { skillId: "release-notes-project", name: "release-notes", skillMarkdownPath: "/work/skills/release-notes/SKILL.md", sourceKind: "project", sourceId: "alpha", pluginId: null, catalogRevision: hash("a"), skillMarkdownRevision: hash("b"), treeRevision: hash("c") };
const revisionB = { skillId: "release-notes-user", name: "release-notes", skillMarkdownPath: "/home/principal/.agents/skills/release-notes/SKILL.md", sourceKind: "shared-user", sourceId: "principal", pluginId: null, catalogRevision: hash("d"), skillMarkdownRevision: hash("e"), treeRevision: hash("f") };
const revisionC = { skillId: "incident-response", name: "incident-response", skillMarkdownPath: "/work/skills/incident-response/SKILL.md", sourceKind: "project", sourceId: "alpha", pluginId: null, catalogRevision: hash("1"), skillMarkdownRevision: hash("2"), treeRevision: hash("3") };

function openFixture(): { db: Database.Database; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "analytics-skills-query-"));
  const db = new Database(join(directory, "analytics.sqlite"));
  for (const migration of analyticsMigrations) db.exec(migration);
  const coverageEpoch = db.prepare("INSERT INTO analytics_skill_coverage_epochs_v1 (epoch_id,started_at_ms,ended_at_ms,lifecycle_coverage,activation_coverage) VALUES (?,?,?,?,?)");
  coverageEpoch.run("coverage-pre-instrumentation", 0, 90, "pre-instrumentation", "pre-instrumentation");
  coverageEpoch.run("coverage-prospective-unknown", 90, 100, "unknown", "unknown");
  coverageEpoch.run("coverage-observed-100", 100, null, "observed", "unsupported");
  const source = db.prepare("INSERT INTO analytics_skill_source_events_v1 (source_event_id,source_sequence,source_digest,source_event_json,active_generation,first_seen_at_ms) VALUES (?,?,?,?,?,?)");
  const lifecycle = db.prepare(`INSERT INTO analytics_skill_lifecycle_facts_v1 (fact_id,observation_id,source_event_id,coverage_epoch_id,observed_at_ms,session_id,thread_id,provider_turn_id,principal_id,project_id,environment_id,provider_id,provider_model,evidence_kind,status,activation_observability,capture_trigger,provider_event_id,failure,revision_json,active_generation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const measurement = db.prepare(`INSERT INTO analytics_skill_measurement_facts_v1 (fact_id,observation_id,source_event_id,coverage_epoch_id,observed_at_ms,session_id,thread_id,provider_turn_id,principal_id,project_id,environment_id,provider_id,provider_model,family,method,serializer,tokenizer,content_component,bytes,tokens,status,estimated,raw_observation_id,revision_json,active_generation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let sequence = 0;
  const insertSource = (id: string, observedAtMs: number) => source.run(id, sequence++, hash("9"), JSON.stringify({ id, observedAtMs }), 1, observedAtMs);
  const insertLifecycle = (id: string, evidence: string, currentRevision: typeof revisionA, observedAtMs: number, turn: string | null, provider = "claude-code", observability = "observed", session = provider === "claude-code" ? "claude-session-a" : "codex-session", thread = provider === "claude-code" ? "claude-thread-a" : "codex-thread") => {
    insertSource(id, observedAtMs);
    lifecycle.run(`life-${id}`, `observation-${id}`, id, "coverage-observed-100", observedAtMs, session, thread, turn, "actor-principal-opaque", "alpha", "preview", provider, provider === "claude-code" ? "claude-sonnet" : "gpt-5", evidence, "supported", observability, `fixture-${evidence}`, null, null, JSON.stringify(currentRevision), 1);
  };
  insertLifecycle("resolved-a", "resolved", revisionA, 100, "turn-a");
  insertLifecycle("active-a", "active-staged", revisionA, 101, "stage-turn-a");
  insertLifecycle("bridge-a", "bridge-acknowledged", revisionA, 102, "turn-a");
  insertLifecycle("provider-a", "provider-observed", revisionA, 103, "turn-a");
  // A Read arrives on a later provider turn, but belongs to the same staged
  // revision/session delivery and therefore cancels no-read-observed for A.
  insertLifecycle("registered-read-a", "registered-skill-md-read", revisionA, 104, "read-turn-a");
  insertLifecycle("subtree-read-a", "subtree-read", revisionA, 105, "subtree-turn-a");
  insertLifecycle("active-b", "active-staged", revisionB, 106, "stage-turn-b", "claude-code", "observed", "claude-session-b", "claude-thread-b");
  // This is a Read in B's session, but it is for a different revision. It must
  // not erase B's exact-revision no-read-observed result.
  insertLifecycle("different-revision-read-b", "registered-skill-md-read", revisionA, 107, "read-turn-b", "claude-code", "observed", "claude-session-b", "claude-thread-b");
  insertLifecycle("active-codex", "active-staged", revisionC, 108, "turn-c", "codex", "unsupported");
  const insertMeasurement = (id: string, family: string, method: string, serializer: string, tokenizer: string, bytes: number | null, tokens: number | null) => {
    insertSource(id, 110 + sequence);
    measurement.run(`measurement-${id}`, `observation-${id}`, id, "coverage-observed-100", 110 + sequence, "claude-session", "claude-thread", "turn-a", "actor-principal-opaque", "alpha", "preview", "claude-code", "claude-sonnet", family, method, serializer, tokenizer, family === "content-footprint" ? "catalog-entry" : null, bytes, tokens, "supported", family === "content-footprint" ? 1 : 0, `observation-${id}`, JSON.stringify(revisionA), 1);
  };
  insertMeasurement("content", "content-footprint", "local-content-estimate", "utf8-frontmatter", "none", 100, 40);
  insertMeasurement("context", "context-occupancy", "provider-reported-named-context-estimate", "ClaudeContextUsageCollector skills.skillFrontmatter", "provider-undisclosed", null, 22);
  insertMeasurement("consumption-one", "attributable-consumption", "provider-attributable-consumption", "claude-usage-v1", "claude-tokenizer-v1", null, 8);
  insertMeasurement("consumption-two", "attributable-consumption", "provider-attributable-consumption", "claude-usage-v1", "custom-tokenizer-v2", null, 13);
  return { db, directory };
}

function assertAggregateRawReconciliation(result: ReturnType<SkillQueryService["query"]>, service: SkillQueryService): void {
  for (const cohort of result.cohorts) {
    const raw = service.rawContributors(result.filters, cohort.contributingFactIds);
    assert.equal(raw.length, cohort.count, "lifecycle cohort count must reconstruct from identical filtered raw rows");
    assert.ok(raw.every((row) => row.lifecycle?.evidenceKind === cohort.evidenceKind), "lifecycle cohort raw contributors must retain the evidence kind");
  }
  for (const aggregate of result.measurements) {
    const raw = service.rawContributors(result.filters, aggregate.contributingFactIds);
    assert.equal(raw.filter((row) => row.measurement?.tokens !== null).reduce((total, row) => total + (row.measurement?.tokens ?? 0), 0), aggregate.tokenTotal ?? 0, "token total must reconstruct from identical filtered raw rows");
    assert.equal(raw.filter((row) => row.measurement?.tokens !== null).length, aggregate.tokenSampleCount, "token sample count must reconstruct from identical filtered raw rows");
    assert.equal(new Set(raw.map((row) => `${row.providerId}|${row.providerModel}|${row.measurement?.method}|${row.measurement?.serializer}|${row.measurement?.tokenizer}`)).size, 1, "an aggregate must never pool measurement partitions");
  }
}

function falseActivationNegative(result: ReturnType<SkillQueryService["query"]>): void {
  assert.equal(result.nativeActivation.status, "unsupported", "registered-SKILL.md and subtree reads must not fabricate native activation");
  const falseNativeActivation = result.rawRows.some((row) => row.lifecycle?.evidenceKind === "registered-skill-md-read" || row.lifecycle?.evidenceKind === "subtree-read") ? "supported" : "unsupported";
  assert.equal(falseNativeActivation, "supported", "the controlled false implementation must mistake retained Read evidence for activation");
  assert.throws(() => assert.equal(result.nativeActivation.status, falseNativeActivation), /Expected values to be strictly equal/u, "the controlled false-activation claim must actually fail");
}

function falseUnusedNegative(result: ReturnType<SkillQueryService["query"]>): void {
  assert.equal(result.noReadObserved.observableActiveUnits, 2, "only supported active Claude delivery units enter the explicit Read-observable cohort");
  assert.equal(result.noReadObserved.noReadObservedUnits, 1, "a turn-scoped Read clears its matching session delivery while a different revision does not");
  const falseTurnScopedNoRead = result.rawRows
    .filter((row) => row.providerId === "claude-code" && row.lifecycle?.evidenceKind === "active-staged")
    .filter((active) => !result.rawRows.some((read) => (read.lifecycle?.evidenceKind === "registered-skill-md-read" || read.lifecycle?.evidenceKind === "subtree-read")
      && read.revision.skillMarkdownRevision === active.revision.skillMarkdownRevision
      && read.sessionId === active.sessionId && read.threadId === active.threadId && read.providerTurnId === active.providerTurnId))
    .map((row) => row.factId).sort();
  assert.deepEqual(falseTurnScopedNoRead, ["life-active-a", "life-active-b"], "the controlled false implementation must call a later-turn Read delivery unused");
  assert.throws(() => assert.deepEqual([...result.noReadObserved.contributingFactIds].sort(), falseTurnScopedNoRead), /Expected values to be strictly deep-equal/u, "the false-unused result must not reconcile to the exact delivery-unit query");
}

function main(): void {
  const { db, directory } = openFixture();
  try {
    const service = new SkillQueryService(db);
    const filters = { startMs: 90, endMs: 200, projectId: "alpha" };
    const result = service.query(filters);
    assert.deepEqual(result.cohorts.map((row) => row.evidenceKind).sort(), ["active-staged", "active-staged", "active-staged", "bridge-acknowledged", "provider-observed", "registered-skill-md-read", "resolved", "subtree-read"], "resolved, active, bridge, provider-observed, registered read, and subtree-read remain distinct cohorts");
    assert.equal(result.cohorts.find((row) => row.evidenceKind === "registered-skill-md-read")?.count, 2, "same-filter registered reads retain their exact raw sample count");
    assert.equal(result.cohorts.some((row) => row.providerId === "codex"), true, "provider partitions remain visible in the retained SQLite result");
    assert.equal(result.measurements.length, 4, "content, context, and tokenizer-separated consumption stay distinct");
    assert.deepEqual(result.measurements.filter((row) => row.family === "attributable-consumption").map((row) => row.tokenizer).sort(), ["claude-tokenizer-v1", "custom-tokenizer-v2"]);
    assertAggregateRawReconciliation(result, service);
    assert.ok(result.measurements.every((row) => row.tokenMean === (row.tokenTotal === null ? null : row.tokenTotal / row.tokenSampleCount)), "per-skill token mean remains directly derivable inside the exact measurement partition");
    assert.deepEqual(result.coverageEpochs.map((epoch) => [epoch.epochId, epoch.lifecycleCoverage, epoch.activationCoverage]), [
      ["coverage-pre-instrumentation", "pre-instrumentation", "pre-instrumentation"],
      ["coverage-prospective-unknown", "unknown", "unknown"],
      ["coverage-observed-100", "observed", "unsupported"],
    ], "bounded overlapping coverage epochs distinguish history, prospective unknown, observed lifecycle, and unsupported native activation");
    assert.match(result.coverageEpochs[2]?.reason ?? "", /native per-skill activation remains unsupported/u);
    falseActivationNegative(result);
    falseUnusedNegative(result);
    assert.throws(() => service.query({ startMs: 0, endMs: 91 * 24 * 60 * 60 * 1_000 }), /bounded maximum/u, "unbounded query windows must fail closed");
    assert.throws(() => service.rawContributors(filters, ["not-a-result"]), /outside its exact filtered result/u, "raw drilldown cannot escape identical query filters");
    process.stdout.write(JSON.stringify({ status: "pass", checks: ["sqlite-retained-query", "raw-reconciliation", "distinct-measurement-partitions", "coverage-epochs-and-token-mean", "false-activation-negative", "false-unused-negative", "bounded-query-and-detail"] }) + "\n");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

main();
