import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { canonical } from "../../contracts/hash.ts";
import { recentDecisionsSchema, DECISION_PAGE_BYTES } from "../../admission/decisions-contract.ts";
import { decisionsFixture } from "./decisions.fixture.ts";

test("actual factory/RPC reads native accepted, rejected and unresolved with all causes/advice, identities and feedback; feature evaluation is separate", async () => {
  const app = await decisionsFixture();
  try {
    const discovery = app.fake.harness.inspection.registrations.experimental_publishedRpcMethods.find(method => method.method === "listRecentDecisions")!;
    assert.ok(discovery);
    assert.match(JSON.stringify(discovery.inputSchema), /assessmentId/);
    assert.match(JSON.stringify(discovery.outputSchema), /frozenPublication/);
    assert.match(JSON.stringify(discovery.outputSchema), /Feedback|obligationId/);
    const accepted = await app.capture("z-old", "accepted");
    const rejected = await app.capture("a-middle", "rejected");
    const unresolved = await app.capture("m-newest", "unresolved");
    const before = app.dump(), counters = { ...app.counters };
    app.db.pragma("query_only = ON");
    const page = recentDecisionsSchema.parse(await app.read({ limit: 3 }));
    assert.deepEqual(page.rows.map(row => row.assessmentId), ["m-newest", "a-middle", "z-old"]);
    assert.deepEqual(page.rows.map(row => row.native.record?.status), ["unresolved", "rejected", "accepted"]);
    for (const [index, expected] of [unresolved, rejected, accepted].entries()) {
      const row = page.rows[index]!;
      assert.deepEqual(row.native.record!.assessments, expected.record.assessments);
      assert.deepEqual(row.native.record!.feedback, expected.record.feedback);
      assert.deepEqual(row.native.record!.delivery, expected.record.delivery);
      assert.deepEqual(row.operation, expected.submission.operation);
      assert.equal(row.submission!.source.senderThreadId, "sender-id");
      assert.equal(row.submission!.threadId, "destination-id");
      assert.equal(row.submission!.policyContext.senderTitle, "Sender name");
      assert.deepEqual(row.submission!.source.author, { kind: "machine", machineId: "machine-id" });
      assert.deepEqual(row.submission!.source.editor, { kind: "user", userId: "user-id" });
      assert.equal(row.frozenPublication!.publicationId, "frozen-publication");
      assert.equal(row.frozenPolicy!.catalogRevision, 17);
      assert.equal(row.frozenPolicy!.groups[0]!.match.kind, "condition");
      assert.equal(row.native.record!.publication!.configurationVersion, "17");
      assert.match(row.rawOriginal!.text, /10.20.30.40/);
    }
    assert.equal(page.rows[0]!.local.evaluation!.policy, "reject");
    assert.equal(page.rows[0]!.native.record!.status, "unresolved", "local rejection never replaces native unresolved");
    assert.equal(page.rows[1]!.native.record!.assessments[0]!.causes.length, 2);
    assert.deepEqual(page.rows[1]!.native.record!.assessments[0]!.advice, ["All advice 1", "All advice 2"]);
    assert.doesNotMatch(JSON.stringify(page), new RegExp(app.secret + "|snapshotBytes|policyBytes|apiKey"));
    assert.equal(app.dump(), before);
    assert.equal(app.counters.evaluate, counters.evaluate);
    assert.equal(app.counters.capture, counters.capture);
    assert.equal(app.counters.lookup - counters.lookup, 3);
    assert.equal(app.counters.paid, 0); assert.equal(app.counters.writes, 0);
    app.db.pragma("query_only = OFF");
  } finally { app.db.pragma("query_only = OFF"); await app.close(); }
});

test("rowid keyset is exact despite unsorted assessment IDs and newer inserts; exact ID lookup is indexed and strict", async () => {
  const queries: string[] = [], db = new Database(":memory:", { verbose: value => queries.push(String(value)) });
  const app = await decisionsFixture(db);
  try {
    for (const id of ["z-old", "a-middle", "m-newest"]) await app.capture(id);
    const first = await app.read({ limit: 2 });
    assert.deepEqual(first.rows.map((row: any) => row.assessmentId), ["m-newest", "a-middle"]);
    assert.equal(first.nextCursor, "2");
    await app.capture("b-new-arrival");
    const older = await app.read({ limit: 2, before: first.nextCursor });
    assert.deepEqual(older.rows.map((row: any) => row.assessmentId), ["z-old"]);
    assert.equal(older.nextCursor, null);
    const exact = await app.read({ limit: 1, assessmentId: "a-middle" });
    assert.deepEqual(exact.rows.map((row: any) => row.assessmentId), ["a-middle"]);
    assert.equal(exact.nextCursor, null);
    assert.ok(queries.some(sql => /WHERE rowid<CAST\('2' AS INTEGER\) ORDER BY rowid DESC LIMIT 3/.test(sql)));
    assert.ok(queries.some(sql => /WHERE id='a-middle' LIMIT 1/.test(sql)));
    assert.match(JSON.stringify(db.prepare("EXPLAIN QUERY PLAN SELECT id FROM mr_admissions WHERE id=? LIMIT 1").all("a-middle")), /INDEX/);
    assert.match(JSON.stringify(db.prepare("EXPLAIN QUERY PLAN SELECT id FROM mr_admissions WHERE rowid<CAST(? AS INTEGER) ORDER BY rowid DESC LIMIT 26").all("4")), /INTEGER PRIMARY KEY/);
    const before = app.counters.lookup;
    for (const input of [{ limit: 26 }, { limit: 0 }, { limit: 1.5 }, { before: "0" }, { before: "-1" }, { before: "9223372036854775808" },
      { before: "01" }, { before: "1 OR 1=1" }, { assessmentId: "a-middle" }, { assessmentId: "a-middle", limit: 1, before: "2" }, { projectId: "any" }])
      await assert.rejects(() => app.read(input));
    assert.equal(app.counters.lookup, before);
    const counts = { ...app.counters };
    for (let i = 0; i < 25; i++) await app.capture("many-" + i, "accepted");
    const large = await app.read({ limit: 25 });
    assert.equal(large.rows.length, 25);
    assert.ok(Buffer.byteLength(JSON.stringify(large)) <= DECISION_PAGE_BYTES);
    assert.equal(app.counters.lookup - counts.lookup, 25);
    assert.equal(app.counters.peak, 4);
    assert.ok(queries.some(sql => /ORDER BY rowid DESC LIMIT 26/.test(sql)));
  } finally { await app.close(); }
});

test("reload reads before ledger initialization, never fences old running owners/attempts, and missing table means no retained callbacks", async () => {
  const first = await decisionsFixture();
  await first.capture("retained"); await first.close(false);
  // Historical invoking work must stay exactly as retained, even on a new generation.
  first.db.prepare("UPDATE mr_admissions SET owner='old-generation',state='running'").run();
  first.db.prepare("INSERT INTO mr_admission_attempts VALUES('attempt','retained','old-generation','partition','{}','invoking',NULL)").run();
  const app = await decisionsFixture(first.db);
  try {
    const before = app.dump(), attempts = app.db.prepare("SELECT * FROM mr_admission_attempts").all();
    assert.equal(app.product.admission.ledger, null);
    app.db.pragma("query_only = ON");
    const page = await app.read();
    assert.equal(page.rows[0].assessmentId, "retained");
    assert.equal(page.rows[0].local.state, "running");
    assert.equal(page.rows[0].native.state, "missing");
    assert.equal(app.product.admission.ledger, null);
    assert.equal(app.dump(), before);
    assert.deepEqual(app.db.prepare("SELECT * FROM mr_admission_attempts").all(), attempts);
  } finally { app.db.pragma("query_only = OFF"); await app.close(); }
  const empty = await decisionsFixture(undefined, false);
  try {
    assert.deepEqual(await empty.read(), { coverage: "MR evaluator callbacks retained here", retention: "no-retained-callbacks", rows: [], nextCursor: null });
    assert.equal(empty.db.prepare("SELECT 1 FROM sqlite_master WHERE name='mr_admissions'").get(), undefined);
    assert.equal(empty.product.admission.ledger, null);
  } finally { await empty.close(); }
});

test("malformed/legacy/oversize bindings stay inspectable without guessed native identity; capability and read failures are explicit unknowns", async () => {
  const app = await decisionsFixture();
  try {
    await app.capture("valid");
    const insert = app.db.prepare("INSERT INTO mr_admissions(id,basis,owner,state,frozen) VALUES(?,'basis','old','complete',?)");
    insert.run("legacy", canonical({ policyBytes: "{}", binding: null }));
    insert.run("malformed", "{bad json");
    insert.run("oversize", "x".repeat(1024*1024 + 1));
    const calls = app.counters.lookup, page = await app.read({ limit: 3 });
    assert.equal(app.counters.lookup, calls);
    for (const row of page.rows) {
      assert.equal(row.operation, null); assert.equal(row.native.state, "unknown");
      assert.match(row.diagnostics.join(" "), /malformed frozen binding/);
    }
    insert.run("malformed-secret", '{"connection":{"apiKey":"' + app.secret + '"},"bad":');
    const secretRow = await app.read({ limit: 1, assessmentId: "malformed-secret" });
    assert.match(secretRow.rows[0].diagnostics.join(" "), /Frozen journal is invalid JSON/);
    assert.doesNotMatch(JSON.stringify(secretRow), new RegExp(app.secret));
    const stored = JSON.parse((app.db.prepare("SELECT frozen FROM mr_admissions WHERE id='valid'").get() as any).frozen);
    stored.policyBytes = '{"connection":{"apiKey":"' + app.secret + '"},"bad":';
    app.db.prepare("UPDATE mr_admissions SET frozen=?,evaluation=? WHERE id='valid'").run(canonical(stored), '{"connection":{"apiKey":"' + app.secret + '"},"bad":');
    const malformedPolicy = await app.read({ limit: 1, assessmentId: "valid" });
    assert.match(malformedPolicy.rows[0].diagnostics.join(" "), /Frozen policy is invalid JSON/);
    assert.match(malformedPolicy.rows[0].diagnostics.join(" "), /Local evaluation is invalid JSON/);
    assert.doesNotMatch(JSON.stringify(malformedPolicy), new RegExp(app.secret));
    // Restore feature evaluation for the following unknown-native comparison.
    app.db.prepare("UPDATE mr_admissions SET evaluation=? WHERE id='valid'").run(canonical({ version: "fixture-local", inputHash: "basis", policy: "reject", rules: [], advice: [], errors: [] }));
    app.setMissing(true);
    const missing = await app.read({ limit: 1, assessmentId: "valid" });
    assert.equal(missing.rows[0].native.state, "missing");
    assert.equal(missing.rows[0].native.record, null);
    app.setMissing(false); app.setOffline(true);
    const offline = await app.read({ limit: 1, assessmentId: "valid" });
    assert.equal(offline.rows[0].native.state, "unavailable");
    assert.match(offline.rows[0].native.reason, /fixture native read offline/);
    assert.equal(offline.rows[0].local.evaluation.policy, "reject");
    app.setOffline(false);
    assert.equal((await app.read({ limit: 1, assessmentId: "valid" })).rows[0].native.state, "found");
    const stale = await app.snapshot();
    assert.equal(stale.delivery.activeKnown, true); assert.equal(stale.delivery.generationReady, false); assert.equal(stale.delivery.state, "unavailable");
    assert.equal(Object.hasOwn(stale.delivery.activePublication, "snapshotBytes"), false);
    app.setActive(null);
    const inactive = await app.snapshot();
    assert.equal(inactive.delivery.activeKnown, true); assert.equal(inactive.delivery.activePublication, null);
    app.setOffline(true);
    assert.equal((await app.snapshot()).delivery.activeKnown, false);
    assert.equal(app.counters.paid, 0); assert.equal(app.counters.writes, 0);
    await app.close(false);
    const unsupported = await decisionsFixture(app.db, false);
    try {
      const page = await unsupported.read({ limit: 1, assessmentId: "valid" });
      assert.equal(page.rows[0].native.state, "unavailable");
      assert.match(page.rows[0].native.reason, /absent/);
      assert.equal((await unsupported.snapshot()).delivery.activeKnown, false);
    } finally { await unsupported.close(); }
  } finally { if (app.db.open) await app.close(); }
});

test("large native records use exact detail or explicit refusal; trimmed originals still enforce the private binding witness", async () => {
  const app = await decisionsFixture();
  try {
    const { record } = await app.capture("large");
    record.reasons = [{ code: "large-diagnostic", message: "x".repeat(70000) }];
    let page = await app.read({ limit: 10 });
    assert.equal(page.rows[0].native.state, "unavailable"); assert.match(page.rows[0].native.reason, /assessmentId and limit:1/);
    page = await app.read({ limit: 1, assessmentId: "large" });
    assert.equal(page.rows[0].native.state, "found");
    assert.equal(page.rows[0].native.record.reasons[0].message.length, 70000);
    assert.deepEqual(page.rows[0].native.record.assessments[0].advice, ["All advice 1", "All advice 2"]);
    record.reasons[0]!.message = "x".repeat(300000);
    page = await app.read({ limit: 1, assessmentId: "large" });
    assert.equal(page.rows[0].native.state, "unavailable"); assert.match(page.rows[0].native.reason, /256 KiB/);
    record.reasons = [];
    const frozen = JSON.parse((app.db.prepare("SELECT frozen FROM mr_admissions WHERE id='large'").get() as any).frozen);
    frozen.binding.submission.policyContext.messageText = "long original ".repeat(12000);
    app.db.prepare("UPDATE mr_admissions SET frozen=? WHERE id='large'").run(canonical(frozen));
    record.requestFingerprint = "sha256:" + "f".repeat(64);
    page = await app.read({ limit: 25 });
    assert.equal(page.rows[0].submission, null);
    assert.equal(page.rows[0].native.state, "unavailable"); assert.match(page.rows[0].native.reason, /frozen submission identity/);
    record.requestFingerprint = frozen.binding.submission.requestFingerprint;
    record.original = { originalId: "another-original", revision: 1 };
    page = await app.read({ limit: 25 });
    assert.match(page.rows[0].native.reason, /frozen submission identity/);
    assert.equal(app.counters.writes, 0); assert.equal(app.counters.paid, 0);
  } finally { await app.close(); }
});

test("native missing/invalid status never promotes local allow; official public codec rejects fabricated acceptance and wrong operations", async () => {
  const app = await decisionsFixture();
  try {
    const { record } = await app.capture("local-allow", "accepted");
    app.setMissing(true);
    let row = (await app.read({ limit: 1, assessmentId: "local-allow" })).rows[0];
    assert.equal(row.local.evaluation.policy, "allow");
    assert.equal(row.native.state, "missing"); assert.equal(row.native.record, null);
    app.setMissing(false);
    record.acceptedOriginal = null;
    row = (await app.read({ limit: 1, assessmentId: "local-allow" })).rows[0];
    assert.equal(row.native.state, "unavailable");
    assert.match(row.native.reason, /immutable accepted original/);
    record.status = "evaluating";
    record.delivery = { state: "none", queueId: null, requestId: null, groupIndex: null, details: null };
    record.operation = { namespace: "another-native", operationId: "same-looking-id" };
    row = (await app.read({ limit: 1, assessmentId: "local-allow" })).rows[0];
    assert.equal(row.native.state, "unavailable"); assert.match(row.native.reason, /another operation/);
    assert.equal(app.counters.paid, 0); assert.equal(app.counters.writes, 0);
  } finally { await app.close(); }
});
