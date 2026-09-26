import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import type { ProjectedSkillObservation } from "../../../../skill-fact-projection.ts";
import { analyticsMigrations, AnalyticsStore } from "../../../../store.ts";
import { SkillQueryService } from "../../../../skill-query-service.ts";

const revision = (index: number) => ({ skillId: `qualification-skill-${index % 3}`, name: `qualification-${index % 3}`, skillMarkdownPath: `/skills/qualification-${index % 3}/SKILL.md`, sourceKind: "project" as const, sourceId: "qualification", pluginId: null, catalogRevision: `${index % 3}`.repeat(64), skillMarkdownRevision: `${(index % 3) + 3}`.repeat(64), treeRevision: `${(index % 3) + 6}`.repeat(64) });
const digest = (id: string) => createHash("sha256").update(id).digest("hex");
const now = () => performance.now();

function lifecycle(
  index: number,
  evidenceKind: NonNullable<ProjectedSkillObservation["lifecycle"]>["evidenceKind"],
  providerId = "claude-code",
): ProjectedSkillObservation {
  const id = `qualification-lifecycle-${index}`;
  const at = 1_000 + index;
  return {
    sourceEventId: id, sourceSequence: index, sourceDigest: digest(id), sourceEventJson: JSON.stringify({ threadId: `qualification-thread-${index % 3}` }),
    lifecycle: { factId: `fact-${id}`, observationId: `observation-${id}`, sourceEventId: id, coverageEpochId: "coverage-observed", observedAtMs: at, sessionId: `qualification-session-${index % 3}`, threadId: `qualification-thread-${index % 3}`, providerTurnId: `qualification-turn-${index}`, principalId: "qualification-principal", projectId: "qualification-project", environmentId: "qualification", providerId, providerModel: providerId === "codex" ? "gpt-5" : "claude-sonnet", revision: revision(index), evidenceKind, status: "supported", activationObservability: providerId === "codex" ? "unsupported" : "observed", captureTrigger: "qualification", providerEventId: id, failure: null },
    measurement: null,
  };
}

function measurement(
  index: number,
  family: "content-footprint" | "context-occupancy" | "attributable-consumption",
  method: "local-content-estimate" | "provider-reported-named-context-estimate" | "provider-attributable-consumption",
  tokenizer: string,
): ProjectedSkillObservation {
  const id = `qualification-measurement-${index}`;
  const at = 2_000 + index;
  return {
    sourceEventId: id, sourceSequence: 100 + index, sourceDigest: digest(id), sourceEventJson: JSON.stringify({ threadId: `qualification-thread-${index % 3}` }), lifecycle: null,
    measurement: { factId: `fact-${id}`, observationId: `observation-${id}`, sourceEventId: id, coverageEpochId: "coverage-observed", observedAtMs: at, sessionId: `qualification-session-${index % 3}`, threadId: `qualification-thread-${index % 3}`, providerTurnId: `qualification-turn-${index}`, principalId: "qualification-principal", projectId: "qualification-project", environmentId: "qualification", providerId: "claude-code", providerModel: "claude-sonnet", revision: revision(index), family, method, serializer: `${method}-serializer`, tokenizer, contentComponent: family === "content-footprint" ? "catalog-entry" : null, bytes: family === "content-footprint" ? 100 + index : null, tokens: family === "content-footprint" ? 25 + index : 20 + index, status: "supported", estimated: family !== "attributable-consumption", rawObservationId: `observation-${id}` },
  };
}

function count(db: Database.Database, table: string) { return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE active_generation > 0`).get() as { count: number }).count); }

const sample = (fn: () => void) => { const started = now(); fn(); return now() - started; };

function main() {
  const directory = mkdtempSync(join(tmpdir(), "analytics-skills-performance-"));
  const db = new Database(join(directory, "analytics.sqlite"));
  try {
    for (const migration of analyticsMigrations) db.exec(migration);
    const store = new AnalyticsStore(db);
    store.initializeSkillProjectionCoverage(900, "coverage-prospective");
    store.openSkillCoverageEpoch({ id: "coverage-observed", startedAtMs: 1_000, lifecycle: "observed", activation: "unsupported" });
    const observations = [
      lifecycle(0, "resolved"), lifecycle(1, "active-staged"), lifecycle(2, "bridge-acknowledged"), lifecycle(3, "provider-observed"),
      lifecycle(4, "registered-skill-md-read"), lifecycle(5, "subtree-read"), lifecycle(6, "active-staged"), lifecycle(7, "registered-skill-md-read"), lifecycle(8, "active-staged", "codex"), lifecycle(9, "provider-observed"),
      measurement(0, "content-footprint", "local-content-estimate", "none"), measurement(1, "context-occupancy", "provider-reported-named-context-estimate", "provider-undisclosed"), measurement(2, "attributable-consumption", "provider-attributable-consumption", "claude-tokenizer-v1"), measurement(3, "attributable-consumption", "provider-attributable-consumption", "custom-tokenizer-v2"),
    ];
    const input = { completedAtMs: 3_000, projectionVersion: 1, sourceDigest: digest("qualification-source"), coverageEpochs: store.listSkillCoverageEpochs(), observations };
    const extractionMs = sample(() => store.commitSkillProjection(input));
    const replayMs = sample(() => store.commitSkillProjection({ ...input, completedAtMs: 3_001 }));
    const service = new SkillQueryService(db);
    const filters = { startMs: 900, endMs: 4_000, projectId: "qualification-project" };
    const queryMs = sample(() => service.query(filters));
    const result = service.query(filters);
    const drilldownMs = sample(() => service.rawContributors(filters, result.rawRows.slice(0, 1).map((row) => row.factId)));
    const counts = { lifecycle: count(db, "analytics_skill_lifecycle_facts_v1"), measurement: count(db, "analytics_skill_measurement_facts_v1"), source: count(db, "analytics_skill_source_events_v1") };
    if (counts.lifecycle !== 10 || counts.measurement !== 4 || counts.source !== 14) throw new Error(`unexpected active store growth ${JSON.stringify(counts)}`);
    process.stdout.write(JSON.stringify({ status: "pass", timings: { extractionMs, replayMs, queryMs, drilldownMs }, counts }) + "\n");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

main();
