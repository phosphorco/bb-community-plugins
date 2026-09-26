import assert from "node:assert/strict";

import { queryForkFreeSkillEvidence, SkillQueryService, type ForkFreeSkillQueryInput } from "../../../../skill-query-service.ts";
import { MAX_SKILL_QUERY_CATALOG_ROWS, MAX_SKILL_QUERY_RAW_ROWS } from "../../../../skill-query-schema.ts";

const hash = (letter: string) => letter.repeat(64);
const base = { projectId: "proj-a", environmentId: "env-a" };
const catalog = [
  { snapshotId: "snapshot-early", capturedAtMs: 10, providerId: "codex", ...base, skillId: "skill-a", name: "alpha", scope: "provider-project", pluginId: null, filePath: "/skills/alpha/SKILL.md", contentRevision: hash("a"), contentBytes: 100, registeredPathCount: 2 },
  { snapshotId: "snapshot-latest", capturedAtMs: 20, providerId: "codex", ...base, skillId: "skill-a", name: "alpha", scope: "provider-project", pluginId: null, filePath: "/skills/alpha/SKILL.md", contentRevision: hash("b"), contentBytes: 120, registeredPathCount: 2 },
  // Repeated membership from a second trigger in the same snapshot remains one entry.
  { snapshotId: "snapshot-latest", capturedAtMs: 20, providerId: "codex", ...base, skillId: "skill-a", name: "alpha", scope: "provider-project", pluginId: null, filePath: "/skills/alpha/SKILL.md", contentRevision: hash("b"), contentBytes: 120, registeredPathCount: 2 },
  { snapshotId: "snapshot-latest", capturedAtMs: 20, providerId: "codex", ...base, skillId: "skill-b", name: "bravo", scope: "provider-project", pluginId: null, filePath: "/skills/bravo/SKILL.md", contentRevision: hash("c"), contentBytes: 81, registeredPathCount: 1 },
  { snapshotId: "snapshot-latest", capturedAtMs: 20, providerId: null, ...base, skillId: "skill-neutral", name: "neutral", scope: "bb-project", pluginId: null, filePath: "/skills/neutral/SKILL.md", contentRevision: hash("d"), contentBytes: 41, registeredPathCount: 1 },
] as const;
const event = (id: string, observedAtMs: number, providerId: string | null, skillId: string | null, contentRevision: string | null) => ({ id, observedAtMs, providerId, ...base, sessionId: "session-a", threadId: "thread-a", eventId: `event-${id}`, eventSeq: observedAtMs, skillId, contentRevision });
const rawRows = [
  { ...event("catalog-a", 20, "codex", "skill-a", hash("b")), kind: "catalog-snapshot" as const, snapshotId: "snapshot-latest", completeness: "complete" as const },
  { ...event("catalog-b", 20, "codex", "skill-b", hash("c")), kind: "catalog-snapshot" as const, snapshotId: "snapshot-latest", completeness: "complete" as const },
  { ...event("mention-a", 21, "codex", "skill-a", null), kind: "prompt-mention" as const, mention: "alpha", historicalRevision: null },
  { ...event("candidate-pending", 22, "codex", "skill-a", null), kind: "registered-path-command-candidate" as const, registeredPath: "/skills/alpha/SKILL.md", itemId: "item-pending", startEventId: "event-candidate-pending", completedEventId: null, executionStatus: "pending" as const, exitCode: null, outputBytes: null, outputTruncated: null, shellWrapped: false, joinedCommand: false, historicalRevision: null },
  { ...event("candidate-complete", 23, "codex", "skill-a", null), kind: "registered-path-command-candidate" as const, registeredPath: "/skills/alpha/SKILL.md", itemId: "item-complete", startEventId: "event-candidate-complete", completedEventId: "event-finished", executionStatus: "completed" as const, exitCode: 0, outputBytes: 17, outputTruncated: false, shellWrapped: true, joinedCommand: true, historicalRevision: null },
  { ...event("neutral-mention", 24, null, "skill-neutral", null), kind: "prompt-mention" as const, mention: "neutral", historicalRevision: null },
] as const;
const input: ForkFreeSkillQueryInput = { currentCatalog: catalog, rawRows, snapshotComplete: true, snapshotExplanation: "Latest complete BB-visible current catalog snapshot retained." };
const filters = { startMs: 0, endMs: 30, projectId: "proj-a", environmentId: "env-a", providerId: "codex" };
const result = queryForkFreeSkillEvidence(input, filters);

assert.equal(result.currentCatalog.length, 2, "latest snapshot excludes older and provider-neutral entries under exact Codex filter");
assert.equal(result.promptMentions.count, 1, "raw evidence uses the same exact provider/project/environment filters");
assert.equal(result.commandCandidates.count, 2, "pending and completed command candidates are both retained");
assert.equal(result.commandOutcomes.length, 1, "only an enclosing completion supplies an outcome");
assert.equal(result.currentFootprint?.byteTotal, 201, "unique latest entries form the byte total");
assert.equal(result.currentFootprint?.byteSampleN, 2, "repeated capture membership does not inflate N");
assert.equal(result.currentFootprint?.byteMean, 100.5);
assert.equal(result.currentFootprint?.estimatedTokenTotal, 51, "local estimate uses ceil(bytes/4) per unique entry");
assert.equal(result.currentFootprint?.tokenizer, "none");
assert.equal(result.unsupported.actualSkillUse.startsWith("Unsupported"), true);
assert.match(result.coverage.snapshotExplanation, /incomplete provider-access coverage/u);
const neutral = queryForkFreeSkillEvidence(input, { ...filters, providerId: null });
assert.equal(neutral.currentCatalog.length, 1, "explicit null selects provider-neutral catalog entries instead of collapsing them into Codex");
assert.equal(neutral.promptMentions.count, 1, "explicit null has matching raw evidence semantics");
const service = new SkillQueryService(() => input);
assert.deepEqual(service.rawContributors(filters, ["candidate-complete"]).map((row) => row.id), ["candidate-complete"], "aggregate drilldown resolves only exact bounded contributors");
assert.throws(() => service.rawContributors(filters, ["neutral-mention"]), /outside its exact filtered result/u);
const boundedEvidence = queryForkFreeSkillEvidence({ ...input, rawRows: Array.from({ length: 501 }, (_, index) => ({ ...rawRows[2]!, id: `row-${index}` })) }, filters);
assert.deepEqual(boundedEvidence.bounds.rawEvidence, { returned: MAX_SKILL_QUERY_RAW_ROWS, total: 501, truncated: true }, "summary remains available while raw evidence is deterministically bounded");
assert.equal(boundedEvidence.promptMentions.count, 501, "aggregate count remains exact above the detail preview bound");
const boundedCatalog = queryForkFreeSkillEvidence({ ...input, currentCatalog: Array.from({ length: 501 }, (_, index) => ({ ...catalog[1]!, skillId: `skill-${index}` })) }, filters);
assert.deepEqual(boundedCatalog.bounds.currentCatalog, { returned: MAX_SKILL_QUERY_CATALOG_ROWS, total: 501, truncated: true }, "catalog summary returns an explicit N-of-M preview instead of failing");
assert.equal(boundedCatalog.currentFootprint, null, "a truncated catalog preview never produces a partial footprint total");
process.stdout.write(JSON.stringify({ status: "pass", checks: ["latest-unique-footprint", "provider-null-filter", "pending-and-outcome", "raw-reconciliation", "bounded-summary-previews", "unsupported-no-apportionment"] }) + "\n");
