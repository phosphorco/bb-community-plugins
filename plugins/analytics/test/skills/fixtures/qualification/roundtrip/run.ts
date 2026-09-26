import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { skillsDashboardData } from "../../../../../analytics-model.ts";
import { projectSkillObservation, type RetainedSkillObservationEvent } from "../../../../../skill-fact-projection.ts";
import { skillQueryResultSchema } from "../../../../../skill-query-schema.ts";
import { SkillQueryService } from "../../../../../skill-query-service.ts";
import { analyticsMigrations, AnalyticsStore } from "../../../../../store.ts";

type Control = "missing-restart" | "missing-resolved-only" | "missing-resume" | "missing-compaction" | "missing-nullable-turn" | "wrong-post-reopen" | null;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const revision = (id: string, name: string, marker: string) => ({
  skillId: id, name, skillMarkdownPath: `/controlled/skills/${id}/SKILL.md`, sourceKind: "project" as const,
  sourceId: "controlled-production-path", pluginId: null, catalogRevision: hash(`catalog:${marker}`),
  skillMarkdownRevision: hash(`skill-md:${marker}`), treeRevision: hash(`tree:${marker}`),
});

const RESOLVED_ONLY = revision("resolved-only", "resolved-only", "resolved-only-v1");
const CLAUDE_A = revision("release-notes", "release-notes", "claude-v1");
const CLAUDE_B = revision("release-notes", "release-notes", "claude-v2");
const CODEX = revision("incident-response", "incident-response", "codex-v1");
const filters = { startMs: 100, endMs: 300, projectId: "controlled-project" };

function observation(
  id: string, sequence: number, at: number, evidenceKind: RetainedSkillObservationEvent["observation"]["evidenceKind"],
  skill: ReturnType<typeof revision>, options: Partial<RetainedSkillObservationEvent["observation"]> = {},
): RetainedSkillObservationEvent {
  const providerId = options.providerId ?? "claude-code";
  return {
    id: `roundtrip-${id}`, threadId: options.threadId ?? "thread-claude-main", seq: sequence, createdAt: at, type: "skill/observed",
    observation: {
      schemaVersion: 1, observationId: `skillobs_v1_${hash(id)}`, dedupeKey: `skillobs_dedupe_v1_${hash(`dedupe:${id}`)}`,
      evidenceKind, status: options.status ?? "supported", captureTrigger: options.captureTrigger ?? "controlled-catalog-delivery",
      actor: { principalId: "controlled-principal" }, threadId: options.threadId ?? "thread-claude-main",
      providerSessionId: options.providerSessionId ?? "session-claude-main", providerId,
      providerModel: options.providerModel ?? (providerId === "codex" ? "gpt-5" : "claude-sonnet"),
      providerTurnId: options.providerTurnId === undefined ? `turn-${id}` : options.providerTurnId,
      providerEventId: `provider-${id}`, skill, measurement: options.measurement ?? null, failure: null,
    },
  };
}

function controlledEvents(control: Control): RetainedSkillObservationEvent[] {
  const events = [
    observation("resolved-only", 1, 100, "resolved", RESOLVED_ONLY, { providerSessionId: "session-resolved-only", threadId: "thread-resolved-only", providerTurnId: null, captureTrigger: "catalog-resolution" }),
    observation("claude-resolved", 2, 101, "resolved", CLAUDE_A),
    observation("claude-active", 3, 102, "active-staged", CLAUDE_A),
    observation("claude-bridge", 4, 103, "bridge-acknowledged", CLAUDE_A),
    observation("claude-provider", 5, 104, "provider-observed", CLAUDE_A),
    observation("claude-skill-md", 6, 105, "registered-skill-md-read", CLAUDE_A, { providerTurnId: "turn-read-skill-md", captureTrigger: "claude-registered-skill-md-read" }),
    observation("claude-subtree", 7, 106, "subtree-read", CLAUDE_A, { providerTurnId: "turn-read-subtree", captureTrigger: "claude-subtree-read" }),
    observation("claude-compaction", 8, 107, "provider-observed", CLAUDE_A, { providerTurnId: null, captureTrigger: "compaction-boundary" }),
    observation("claude-resumed", 9, 108, "provider-observed", CLAUDE_A, { providerTurnId: "turn-resumed", captureTrigger: "session-resumed" }),
    observation("claude-b-active", 10, 109, "active-staged", CLAUDE_B, { providerSessionId: "session-claude-b", threadId: "thread-claude-b", providerTurnId: "turn-b-stage" }),
    observation("codex-active", 11, 110, "active-staged", CODEX, { providerId: "codex", providerSessionId: "session-codex", threadId: "thread-codex", providerTurnId: "turn-codex", status: "unsupported", captureTrigger: "codex-native-attribution-unsupported" }),
    observation("context-one", 12, 111, "named-token-measurement", CLAUDE_A, { providerTurnId: null, captureTrigger: "claude-context-snapshot", measurement: { method: "provider-reported-named-context-estimate", serializer: "ClaudeContextUsageCollector skills.skillFrontmatter", tokenizer: "provider-undisclosed", estimated: true, attribution: "per-skill", bytes: null, tokens: 21 } }),
    observation("context-two", 13, 112, "named-token-measurement", CLAUDE_A, { providerTurnId: null, captureTrigger: "claude-context-snapshot", measurement: { method: "provider-reported-named-context-estimate", serializer: "ClaudeContextUsageCollector skills.skillFrontmatter", tokenizer: "provider-undisclosed", estimated: true, attribution: "per-skill", bytes: null, tokens: 25 } }),
  ];
  if (control === "missing-resolved-only") return events.filter((event) => event.id !== "roundtrip-resolved-only");
  if (control === "missing-resume") return events.filter((event) => event.id !== "roundtrip-claude-resumed");
  if (control === "missing-compaction") return events.filter((event) => event.id !== "roundtrip-claude-compaction");
  if (control === "missing-nullable-turn") return events.map((event) => event.id === "roundtrip-context-one"
    ? { ...event, observation: { ...event.observation, providerTurnId: "incorrectly-turn-scoped" } } : event);
  return events;
}

function publish(store: AnalyticsStore, events: readonly RetainedSkillObservationEvent[]): void {
  store.initializeSkillProjectionCoverage(100, "coverage-prospective-100");
  store.openSkillCoverageEpoch({ id: "coverage-observed-100", startedAtMs: 100, lifecycle: "observed", activation: "unsupported" });
  const epochs = store.listSkillCoverageEpochs();
  const observations = events.map((event) => projectSkillObservation(event, epochs, { projectId: "controlled-project", environmentId: "controlled-preview", providerId: event.observation.providerId }));
  store.commitSkillProjection({ observations, coverageEpochs: epochs, completedAtMs: 200, sourceDigest: hash(JSON.stringify(events)), projectionVersion: 1 });
}

function lifecycleCount(result: ReturnType<SkillQueryService["query"]>, evidenceKind: string): number {
  return result.cohorts.filter((cohort) => cohort.evidenceKind === evidenceKind).reduce((total, cohort) => total + cohort.count, 0);
}

/** Independently specified post-reopen oracle. All controls alter persisted input before this runs. */
function assertRoundtrip(result: ReturnType<SkillQueryService["query"]>, store: AnalyticsStore, service: SkillQueryService): void {
  assert.equal(lifecycleCount(result, "resolved"), 2, "exact catalog delivery must retain the resolved-only and delivered revisions");
  assert.equal(lifecycleCount(result, "active-staged"), 3, "exact catalog delivery must retain Claude revisions and Codex unsupported attribution");
  assert.equal(lifecycleCount(result, "bridge-acknowledged"), 1, "exact catalog delivery must retain bridge acknowledgement");
  assert.equal(lifecycleCount(result, "provider-observed"), 3, "compaction-boundary and resumed-session observations must survive reopen");
  assert.equal(lifecycleCount(result, "registered-skill-md-read"), 1, "Claude registered SKILL.md Read must survive reopen");
  assert.equal(lifecycleCount(result, "subtree-read"), 1, "Claude subtree Read must survive reopen");
  assert.equal(result.nativeActivation.status, "unsupported", "native activation must remain unsupported without a native event");
  assert.equal(result.noReadObserved.observableActiveUnits, 2, "only Claude active delivery units form the qualified no-read cohort");
  assert.equal(result.noReadObserved.noReadObservedUnits, 1, "the second Claude revision has qualified no-read observed");

  const context = result.measurements.filter((entry) => entry.family === "context-occupancy");
  assert.equal(context.length, 1, "identical named-token measurements must remain one exact partition");
  assert.deepEqual([context[0]?.tokenTotal, context[0]?.tokenSampleCount, context[0]?.tokenMean], [46, 2, 23], "post-reopen token total/N/mean must be reconstructed inside its exact partition");
  const measurementRaw = service.rawContributors(filters, context[0]!.contributingFactIds);
  assert.deepEqual(measurementRaw.map((row) => [row.sessionId, row.threadId, row.providerTurnId]).sort(), [
    ["session-claude-main", "thread-claude-main", null], ["session-claude-main", "thread-claude-main", null],
  ], "raw contributors must preserve exact session/thread and nullable provider-turn identity");

  const activeRaw = result.rawRows.filter((row) => row.lifecycle?.evidenceKind === "active-staged");
  assert.ok(activeRaw.some((row) => row.revision.skillId === "incident-response" && row.providerId === "codex" && row.lifecycle?.status === "unsupported"), "Codex per-skill attribution must remain explicitly unsupported in the raw contributor");
  assert.ok(result.rawRows.some((row) => row.revision.skillId === "resolved-only" && row.lifecycle?.evidenceKind === "resolved"), "the genuinely resolved-only skill must not disappear from retained lifecycle facts");
  assert.equal(result.rawRows.find((row) => row.revision.skillId === "release-notes" && row.revision.skillMarkdownRevision === CLAUDE_A.skillMarkdownRevision)?.revision.catalogRevision, CLAUDE_A.catalogRevision, "raw delivery must retain the exact resolved catalog revision");
  const lifecycle = store.listActiveSkillLifecycleFacts();
  assert.ok(lifecycle.some((fact) => fact.captureTrigger === "compaction-boundary" && fact.providerTurnId === null), "compaction boundary must retain its nullable-turn capture");
  assert.ok(lifecycle.some((fact) => fact.captureTrigger === "session-resumed" && fact.sessionId === "session-claude-main"), "resumed observation must stay in the original session after reopen");
  assert.equal(new Set(result.rawRows.map((row) => row.revision.skillMarkdownRevision)).size, 4, "multiple immutable skill revisions must be retained");

  const dashboard = skillsDashboardData(skillQueryResultSchema.parse(result));
  assert.equal(dashboard.nativeActivation.id, "native-activation", "dashboard transformation must retain unsupported native activation");
  assert.equal(dashboard.noReadObserved.count, 1, "dashboard transformation must retain the qualified Claude no-read count");
  assert.ok(dashboard.revisions.some((row) => row.skillId === "resolved-only" && row.resolved === 1 && row.active === 0), "dashboard transformation must keep the resolved-only revision");
  assert.deepEqual(dashboard.measurements.find((row) => row.family === "context" && row.total === 46), {
    id: context[0]!.key,
    label: `release-notes · ${CLAUDE_A.skillMarkdownRevision.slice(0, 12)}`,
    count: 2,
    method: "provider-reported-named-context-estimate",
    coverage: dashboard.measurements.find((row) => row.family === "context" && row.total === 46)!.coverage,
    contributingFactIds: context[0]!.contributingFactIds,
    family: "context",
    total: 46,
    average: 23,
    unit: "tokens",
    provider: "claude-code",
    model: "claude-sonnet",
    serializer: "ClaudeContextUsageCollector skills.skillFrontmatter",
    tokenizer: "provider-undisclosed",
  }, "dashboard transformation must preserve exact post-reopen token total/N/mean and provider/model/method/serializer/tokenizer partition");
}

function execute(control: Control): void {
  const directory = mkdtempSync(join(tmpdir(), "analytics-skills-roundtrip-"));
  const databasePath = join(directory, "analytics.sqlite");
  let db = new Database(databasePath);
  try {
    for (const migration of analyticsMigrations) db.exec(migration);
    publish(new AnalyticsStore(db), controlledEvents(control));
    let reopened = false;
    if (control !== "missing-restart") {
      db.close();
      db = new Database(databasePath);
      reopened = true;
    }
    if (control === "wrong-post-reopen") db.prepare("DELETE FROM analytics_skill_lifecycle_facts_v1 WHERE evidence_kind='resolved' AND active_generation > 0").run();
    assert.equal(reopened, true, "the controlled production-path roundtrip must close and reopen SQLite before post-reopen reconstruction");
    const store = new AnalyticsStore(db);
    const service = new SkillQueryService(db);
    const result = service.query(filters);
    assertRoundtrip(result, store, service);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
    assert.equal(existsSync(directory), false, "roundtrip scratch storage must be removed");
  }
}

function controlFromArgs(): Control {
  const index = process.argv.indexOf("--negative-control");
  if (index === -1) return null;
  const value = process.argv[index + 1] as Control | undefined;
  if (!["missing-restart", "missing-resolved-only", "missing-resume", "missing-compaction", "missing-nullable-turn", "wrong-post-reopen"].includes(value ?? "")) throw new Error("unknown roundtrip negative control");
  return value ?? null;
}

execute(controlFromArgs());
process.stdout.write(`${JSON.stringify({ status: "pass", kind: "controlled-production-path-roundtrip" })}\n`);
