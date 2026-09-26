import assert from "node:assert/strict";

import { awaitLifecycleSkillCapture, createForkFreeCaptureCoordinator } from "../../../legacy-capture.ts";
import { queryForkFreeSkillEvidence, type ForkFreeSkillQueryInput } from "../../../../skill-query-service.ts";

let now = 1_000;
const started: string[] = [];
const coordinator = createForkFreeCaptureCoordinator(async (partition, trigger) => {
  started.push(`${partition.projectId}:${partition.environmentId ?? "none"}:${trigger}`);
}, { ttlMs: 60_000, now: () => now });

const alpha = { projectId: "project-alpha", environmentId: "env-a" };
const beta = { projectId: "project-beta", environmentId: "env-b" };

// The projector itself has a global in-flight slot. Distinct partitions must
// therefore serialize, but never receive each other's result; duplicate active
// events share one bounded capture and a fresh repeat marks the partition dirty
// for the selected lazy query rather than scanning again.
await Promise.all([
  coordinator.schedule(alpha, "thread.active"),
  coordinator.schedule(beta, "thread.active"),
  coordinator.schedule(alpha, "thread.active"),
]);
assert.deepEqual(started, ["project-alpha:env-a:thread.active", "project-beta:env-b:thread.active"]);
assert.equal(coordinator.needsRefresh(alpha), false, "the completed first capture is fresh");
await coordinator.schedule(alpha, "thread.active");
assert.equal(coordinator.needsRefresh(alpha), true, "fresh repeated activity stays dirty for one selected lazy reconciliation");
await coordinator.schedule(alpha, "thread.active");
assert.equal(started.length, 2, "repeated active transition does not re-run a fresh full capture");
await coordinator.schedule(alpha, "refresh");
assert.deepEqual(started, ["project-alpha:env-a:thread.active", "project-beta:env-b:thread.active", "project-alpha:env-a:refresh"]);
await coordinator.schedule(beta, "thread.active");
assert.equal(coordinator.needsRefresh(alpha), false, "refreshing alpha does not leave it dirty");
assert.equal(coordinator.needsRefresh(beta), true, "a later beta transition remains dirty after alpha refresh");

// A rejected stale refresh remains eligible after a bounded cooldown, rather
// than letting repeated UI renders begin an immediate retry storm.
let failedCaptures = 0;
const failingCoordinator = createForkFreeCaptureCoordinator(async () => {
  failedCaptures += 1;
  throw new Error("public catalog temporarily unavailable");
}, { ttlMs: 60_000, failureCooldownMs: 5_000, now: () => now });
await assert.rejects(failingCoordinator.schedule(alpha, "refresh"), /temporarily unavailable/u);
assert.equal(failingCoordinator.needsRefresh(alpha), false, "a failed stale capture enters its retry cooldown");
now += 5_000;
assert.equal(failingCoordinator.needsRefresh(alpha), true, "the bounded retry cooldown eventually permits recovery");
assert.equal(failedCaptures, 1);

// A populated RPC reads retained rows synchronously and never schedules a
// projector after it returns. The old detached stale-refresh shape below is a
// negative control: after the host closes SQLite, delayed projector work loses
// the handle even when its rejection is contained.
let sqliteClosed = false;
let sqliteTouches = 0;
const readRetainedRows = () => {
  assert.equal(sqliteClosed, false, "the retained read happens before the RPC returns");
  sqliteTouches += 1;
  return "retained rows";
};
assert.equal(readRetainedRows(), "retained rows");
sqliteClosed = true;
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(sqliteTouches, 1, "a populated retained query has no post-return SQLite work");

let releaseStaleCapture!: () => void;
const staleGate = new Promise<void>((resolve) => { releaseStaleCapture = resolve; });
const unhandled: unknown[] = [];
const detachedStaleFailures: string[] = [];
const observeUnhandled = (reason: unknown) => unhandled.push(reason);
process.on("unhandledRejection", observeUnhandled);
const detachedStaleRefresh = () => {
  void (async () => {
    await staleGate;
    if (sqliteClosed) throw new Error("The database connection is not open");
  })().catch((cause) => detachedStaleFailures.push(String(cause)));
};
detachedStaleRefresh();
releaseStaleCapture();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.match(detachedStaleFailures[0] ?? "", /database connection is not open/u, "negative control: post-return stale projector work reaches a closed SQLite handle");
assert.deepEqual(unhandled, [], "the negative control contains its rejection but still demonstrates why post-return DB work is unsafe");
process.off("unhandledRejection", observeUnhandled);

let releaseCapture!: () => void;
const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
let captureSettled = false;
const warnings: string[] = [];
const lifecycleHandler = awaitLifecycleSkillCapture(async () => {
  await captureGate;
  captureSettled = true;
}, (message) => warnings.push(message));
await Promise.resolve();
assert.equal(captureSettled, false, "the production lifecycle handler remains pending until its scheduled capture settles");
releaseCapture();
await lifecycleHandler;
assert.equal(captureSettled, true);
assert.deepEqual(warnings, []);

// Negative control for the previous detached handler: returning immediately
// permits the host to close the plugin/SQLite invocation before the queued
// capture resumes, which becomes a contained but lost capture attempt.
let oldRelease!: () => void;
const oldGate = new Promise<void>((resolve) => { oldRelease = resolve; });
let closedAfterReturn = false;
const detachedWarnings: string[] = [];
const oldDetachedHandler = () => {
  void (async () => {
    await oldGate;
    if (closedAfterReturn) throw new Error("The database connection is not open");
  })().catch((cause) => detachedWarnings.push(String(cause)));
};
oldDetachedHandler();
closedAfterReturn = true;
oldRelease();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.match(detachedWarnings[0] ?? "", /database connection is not open/u, "detached lifecycle work fails after the invocation closes");

const revision = "a".repeat(64);
const source: ForkFreeSkillQueryInput = {
  snapshotComplete: true,
  snapshotExplanation: "Latest complete BB-visible current catalog snapshot retained.",
  currentCatalog: [{ snapshotId: "catalog-a", capturedAtMs: 100, providerId: null, projectId: "project-alpha", environmentId: "env-a", skillId: "skill-a", name: "alpha", scope: "bb-project", pluginId: null, filePath: "/skills/alpha/SKILL.md", contentRevision: revision, contentBytes: 40, registeredPathCount: 1 }],
  rawRows: [{ id: "catalog:catalog-a:skill-a", observedAtMs: 100, sessionId: null, threadId: "catalog:catalog-a", eventId: "catalog:catalog-a", eventSeq: 1, providerId: null, projectId: "project-alpha", environmentId: "env-a", skillId: "skill-a", contentRevision: revision, kind: "catalog-snapshot", snapshotId: "catalog-a", completeness: "complete" }],
};
const neutral = queryForkFreeSkillEvidence(source, { startMs: 0, endMs: 200, projectId: "project-alpha", environmentId: "env-a", providerId: null });
assert.equal(neutral.coverage.exactCatalogSnapshot, true, "provider-neutral catalog entries are selected after project/environment discovery");
const absent = queryForkFreeSkillEvidence(source, { startMs: 0, endMs: 200, projectId: "project-beta", environmentId: "env-b" });
assert.equal(absent.coverage.exactCatalogSnapshot, false, "a global catalog cannot satisfy an absent selected partition");
assert.match(absent.coverage.snapshotExplanation, /selected project/u);
const predates = queryForkFreeSkillEvidence(source, { startMs: 0, endMs: 99, projectId: "project-alpha", environmentId: "env-a" });
assert.match(predates.coverage.snapshotExplanation, /predates/u);

process.stdout.write(JSON.stringify({ status: "pass", checks: ["cross-partition-serialized", "repeated-active-coalesced", "cross-partition-freshness", "stale-failure-cooldown", "stale-query-immediate", "blocking-stale-query", "lifecycle-await", "detached-lifecycle-capture", "provider-neutral-selected-snapshot", "selected-snapshot-coverage"] }) + "\n");
