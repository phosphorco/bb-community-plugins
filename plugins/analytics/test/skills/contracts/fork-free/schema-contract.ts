import assert from "node:assert/strict";
import { activeCapture, catalogSnapshot, probeEvents } from "../../fixtures/fork-free/thr-tn5pxvdf7j.mjs";
import { publicSkillCatalogCaptureSchema, publicSkillCatalogSnapshotSchema } from "../../../../skill-fact-schema.ts";
import { replayPublicSkillEvidence, validatePublicSkillCatalogCapture, validatePublicSkillCatalogSnapshot } from "../../../../skill-observation-contract.ts";

assert.equal(publicSkillCatalogSnapshotSchema.safeParse(catalogSnapshot).success, true, "only an explicit public SDK snapshot is accepted");
validatePublicSkillCatalogSnapshot(catalogSnapshot);
assert.deepEqual(catalogSnapshot.entries.map(({ name, provider }) => ({ name, provider })), [
  { name: "bb-performant-react", provider: "codex" },
  { name: "provider-neutral-fixture", provider: null },
], "the public provider field preserves Codex and provider-neutral catalog entries distinctly");
assert.equal(publicSkillCatalogCaptureSchema.safeParse(activeCapture).success, true, "post-transition capture carries exact current completeness");
validatePublicSkillCatalogCapture(activeCapture);

const replay = replayPublicSkillEvidence(catalogSnapshot, probeEvents);
assert.deepEqual(replay.mentions.map(({ seq, skillId, mention }) => ({ seq, skillId, mention })), [{ seq: 1, skillId: "skill_9abda8e8ba47ab3ce5e3de59fcd54476b9c02ce801d3519f2a2aedcbbd30df52", mention: "bb-performant-react" }]);
assert.ok(replay.mentions.every((mention) => mention.historicalRevision === null), "prompt-to-current-catalog matching keeps historical revision unknown");
assert.equal(replay.candidates.length, 2, "seq 32/33 produces one lexical candidate for each registered path");
for (const candidate of replay.candidates) {
  assert.equal(candidate.startSeq, 32);
  assert.equal(candidate.completedSeq, 33);
  assert.equal(candidate.executionStatus, "completed");
  assert.equal(candidate.exitCode, 0);
  assert.equal(candidate.outputBytes, 17283);
  assert.equal(candidate.commandShellWrapped, true);
  assert.equal(candidate.commandJoined, true);
  assert.equal(candidate.historicalRevision, null);
  assert.equal("read" in candidate, false, "a command candidate never upgrades to an individual read");
}
assert.deepEqual(replay.coverage, { catalog: "current-snapshot", providerAccess: "observed-candidates-only", historicalCatalog: "revision-unknown" });
const startedOnly = replayPublicSkillEvidence(catalogSnapshot, [probeEvents[1]!]);
assert.equal(startedOnly.candidates.length, 2, "an unmatched command start remains a pending lexical candidate");
assert.ok(startedOnly.candidates.every((candidate) => candidate.completedSeq === null && candidate.executionStatus === "pending" && candidate.historicalRevision === null));

assert.throws(() => replayPublicSkillEvidence(catalogSnapshot, [probeEvents[0]!, { ...probeEvents[0]!, data: { ...probeEvents[0]!.data, requestId: "conflict" } }]), /conflicting public event replay/);
assert.throws(() => validatePublicSkillCatalogSnapshot({ ...catalogSnapshot, entries: [{ ...catalogSnapshot.entries[0], registeredPaths: ["/home/ubuntu/escape"] }] }), /escapes/);
assert.equal(publicSkillCatalogSnapshotSchema.safeParse({ ...catalogSnapshot, entries: [{ ...catalogSnapshot.entries[0], filesTruncated: true }] }).success, false, "truncated files cannot be an exact complete snapshot");
const providerElided = { ...catalogSnapshot.entries[0] } as Record<string, unknown>;
delete providerElided.provider;
assert.equal(publicSkillCatalogSnapshotSchema.safeParse({ ...catalogSnapshot, entries: [providerElided] }).success, false, "provider elision is rejected rather than coerced to provider-neutral");
assert.throws(() => validatePublicSkillCatalogCapture({ ...activeCapture, completeness: "failed", error: "SDK unavailable" }), /failed catalog capture/);
assert.deepEqual(replayPublicSkillEvidence(null, probeEvents).coverage, { catalog: "missing", providerAccess: "incomplete-or-unsupported", historicalCatalog: "revision-unknown" });
const aggregate = replayPublicSkillEvidence(catalogSnapshot, [{ id: "evt-token", scope: { kind: "thread" }, threadId: "thr-token", seq: 1, createdAt: 1, type: "thread/tokenUsage/updated", data: { totalTokens: 99 } }]);
assert.deepEqual(aggregate.aggregateTokens, [{ kind: "aggregate-token", sourceEventId: "evt-token", threadId: "thr-token", seq: 1, aggregateTokens: 99 }]);
assert.equal("skillId" in aggregate.aggregateTokens[0]!, false, "aggregate tokens are never apportioned");
process.stdout.write(JSON.stringify({ status: "pass", checks: 16 }));
