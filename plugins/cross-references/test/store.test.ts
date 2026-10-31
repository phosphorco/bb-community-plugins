import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalizeIdentity,
  canonicalizeResource,
  recognitionIdentity,
  verifiedFileIdentity,
  verifiedFileIdentityRecord,
  sha256Hex,
  projectionPayloadDigest,
  projectionPayloadJson,
  MAX_PROJECTION_PAYLOAD_BYTES,
  type ExcerptRecordV2,
  type Resource,
} from "../canonical.ts";
import {
  type ApplyProjectionInput,
  type ListBacklinksInput,
  type ListForwardReferencesInput,
} from "../model.ts";
import {
  CrossReferenceStore,
  crossReferencesMigrations,
  enableForeignKeys,
} from "../store.ts";

import type { MentionScan, ObservedMention } from "../mention-evidence.ts";

const targetId = "thr_target01";

function makeResource(source: string, label = source): Resource {
  return {
    provider: "test",
    keys: { source },
    presentation: { label },
  };
}

function makeThread(label = "Thread", thread = targetId): Resource {
  return {
    provider: "bb",
    keys: { project: "proj_12345678", thread },
    presentation: { label },
  };
}

function mutation(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function makeCommand(options: Partial<{
  producerPluginId: string;
  mutationId: string;
  source: Resource;
  targets: Resource[];
  revision: number;
  expectedRevision: number;
  tombstone: boolean;
}> = {}): ApplyProjectionInput {
  const producerPluginId = options.producerPluginId ?? "machine-monitor";
  const source = options.source ?? makeResource("machine", "Machine Monitor");
  const targets = options.targets ?? [makeThread()];
  const tombstone = options.tombstone ?? false;
  const canonicalSource = canonicalizeResource(source);
  const canonicalTargets = targets.map(canonicalizeResource);
  return {
    protocolVersion: 1,
    producerPluginId,
    mutationId: options.mutationId ?? mutation(options.revision ?? 1),
    source,
    revision: options.revision ?? 1,
    expectedRevision: options.expectedRevision ?? 0,
    payloadDigest: projectionPayloadDigest(producerPluginId, canonicalSource, tombstone, canonicalTargets),
    tombstone,
    targets,
  };
}

function makeStore(): { db: Database.Database; store: CrossReferenceStore } {
  const db = new Database(":memory:");
  enableForeignKeys(db);
  for (const migration of crossReferencesMigrations) db.exec(migration);
  return { db, store: new CrossReferenceStore(db) };
}

test("enables foreign keys and installs the constrained schema and indexes", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.deepEqual(
    (db.prepare("SELECT scope_kind, model_version FROM cross_reference_meta WHERE singleton = 1").get() as object),
    { scope_kind: "installation-local", model_version: 1 },
  );
  const indexNames = (table: string) => (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
  assert.ok(indexNames("resources").some((name) => name.includes("sqlite_autoindex_resources")));
  assert.ok(indexNames("source_projections").some((name) => name.includes("sqlite_autoindex_source_projections")));
  assert.ok(indexNames("source_projections").some((name) => name.includes("source_projections_source_idx")));
  assert.ok(indexNames("reference_occurrences").some((name) => name.includes("reference_occurrences_target_idx")));
  assert.ok(indexNames("resource_keys").some((name) => name.includes("resource_keys_match_idx")));
  assert.throws(() => db.prepare(
    "INSERT INTO resource_keys (resource_id, provider, key, value) VALUES (999, 'test', 'source', 'orphan')",
  ).run(), /FOREIGN KEY/);
  const targetIdentity = { provider: "bb", keys: { project: "proj_12345678", thread: targetId } };
  assert.equal(store.listBacklinks({ target: targetIdentity }).rows.length, 0);
});

test("deduplicates exact resources while retaining presentation snapshots", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  const first = makeCommand({
    source: makeResource("machine", "Monitor before"),
    targets: [makeThread("Thread before")],
    revision: 1,
  });
  assert.equal(store.applyProjection(first).outcome, "applied");
  const second = makeCommand({
    source: makeResource("machine", "Monitor after"),
    targets: [makeThread("Thread after")],
    revision: 2,
    expectedRevision: 1,
  });
  assert.equal(store.applyProjection(second).outcome, "applied");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM resources").get() as { count: number }).count, 2);
  const projection = store.getProjection({ producerPluginId: "machine-monitor", source: { provider: "test", keys: { source: "machine" } } }).projection;
  assert.equal(projection?.source.presentation.label, "Monitor after");
  assert.equal(projection?.targets[0]?.presentation.label, "Thread after");
});

test("prunes orphaned URL resources that no longer meet the receiver contract", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  db.prepare("INSERT INTO resources (provider, canonical_keys_json, key_count, created_at) VALUES (?, ?, ?, ?)")
    .run("url", '{"href":"https://example.test/private?access_token=secret"}', 1, Date.now());
  assert.equal(store.pruneUnsafeUrlResources(), 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM resources WHERE provider = 'url'").get() as { count: number }).count, 0);
});

test("enforces the revision CAS matrix and preserves empty and tombstone watermarks", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  const first = makeCommand({ revision: 2, expectedRevision: 0 });
  const applied = store.applyProjection(first);
  assert.equal(applied.outcome, "applied");
  assert.equal(applied.currentRevision, 2);
  assert.equal(applied.currentDigest, first.payloadDigest);
  assert.equal(applied.changed, true);
  assert.notEqual(applied.signal, null);
  const duplicate = store.applyProjection(first);
  assert.equal(duplicate.outcome, "duplicate");
  assert.equal(duplicate.changed, false);

  const equal = makeCommand({ revision: 2, expectedRevision: 0, mutationId: mutation(3) });
  assert.equal(store.applyProjection(equal).outcome, "equal");
  const conflict = makeCommand({ revision: 2, expectedRevision: 0, mutationId: mutation(4), targets: [makeThread("different snapshot")] });
  assert.equal(store.applyProjection(conflict).outcome, "conflict");
  const stale = makeCommand({ revision: 1, expectedRevision: 0, mutationId: mutation(5) });
  assert.equal(store.applyProjection(stale).outcome, "stale");
  const casMismatch = makeCommand({ revision: 3, expectedRevision: 0, mutationId: mutation(6) });
  assert.equal(store.applyProjection(casMismatch).outcome, "cas-mismatch");
  assert.equal(store.applyProjection(makeCommand({ revision: 3, expectedRevision: 2, mutationId: mutation(7) })).outcome, "applied");

  const empty = makeCommand({ revision: 4, expectedRevision: 3, mutationId: mutation(8), targets: [] });
  assert.equal(store.applyProjection(empty).outcome, "applied");
  let projection = store.getProjection({ producerPluginId: "machine-monitor", source: { provider: "test", keys: { source: "machine" } } }).projection;
  assert.equal(projection?.revision, 4);
  assert.equal(projection?.tombstone, false);
  assert.deepEqual(projection?.targets, []);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM reference_occurrences").get() as { count: number }).count, 0);

  const tombstone = makeCommand({ revision: 5, expectedRevision: 4, mutationId: mutation(9), targets: [], tombstone: true });
  assert.equal(store.applyProjection(tombstone).outcome, "applied");
  projection = store.getProjection({ producerPluginId: "machine-monitor", source: { provider: "test", keys: { source: "machine" } } }).projection;
  assert.equal(projection?.revision, 5);
  assert.equal(projection?.tombstone, true);
  assert.deepEqual(projection?.targets, []);
  assert.equal(store.applyProjection(makeCommand({ revision: 4, expectedRevision: 3, mutationId: mutation(10) })).outcome, "stale");
  assert.equal(store.getProjection({ producerPluginId: "machine-monitor", source: { provider: "test", keys: { source: "machine" } } }).projection?.tombstone, true);
});

test("cascades projection occurrences but restricts resource deletion", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  assert.equal(store.applyProjection(makeCommand()).outcome, "applied");
  const projectionId = (db.prepare("SELECT id FROM source_projections").get() as { id: number }).id;
  const targetResourceId = (db.prepare("SELECT id FROM resources WHERE provider = 'bb'").get() as { id: number }).id;
  assert.throws(() => db.prepare("DELETE FROM resources WHERE id = ?").run(targetResourceId), /FOREIGN KEY/);
  db.prepare("DELETE FROM source_projections WHERE id = ?").run(projectionId);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM reference_occurrences").get() as { count: number }).count, 0);
  assert.equal(db.prepare("DELETE FROM resources WHERE id = ?").run(targetResourceId).changes, 1);
});

test("deduplicates backlinks by exact source before counting and paginating", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  const target = makeThread("Shared target");
  for (const producerPluginId of ["producer-one", "producer-two", "producer-three"]) {
    for (const sourceId of ["source-one", "source-two", "source-three"]) {
      assert.equal(store.applyProjection(makeCommand({
        producerPluginId,
        source: makeResource(sourceId, "Shared source"),
        targets: [target],
        revision: 1,
      })).outcome, "applied");
    }
  }

  const targetIdentity = { provider: target.provider, keys: target.keys };
  const firstInput: ListBacklinksInput = { target: targetIdentity, pageSize: 1 };
  const first = store.listBacklinks(firstInput);
  assert.equal(first.rows.length, 1);
  assert.equal(first.total, 3);
  assert.notEqual(first.nextCursor, null);
  const second = store.listBacklinks({ target: targetIdentity, pageSize: 1, cursor: first.nextCursor! });
  const third = store.listBacklinks({ target: targetIdentity, pageSize: 1, cursor: second.nextCursor! });
  assert.equal(second.rows.length, 1);
  assert.equal(second.total, 3);
  assert.equal(third.rows.length, 1);
  assert.equal(third.total, 3);
  assert.equal(third.nextCursor, null);
  assert.deepEqual(
    [first.rows[0], second.rows[0], third.rows[0]].map((row) => ({
      source: row?.source.presentation.label,
      keys: row?.source.keys,
      producer: row?.producerPluginId,
      position: row?.position,
      target: row?.targetPresentation.label,
    })),
    [
      { source: "Shared source", keys: { source: "source-one" }, producer: "producer-one", position: 0, target: "Shared target" },
      { source: "Shared source", keys: { source: "source-two" }, producer: "producer-one", position: 0, target: "Shared target" },
      { source: "Shared source", keys: { source: "source-three" }, producer: "producer-one", position: 0, target: "Shared target" },
    ],
  );
  assert.throws(() => store.listBacklinks({ target: targetIdentity, pageSize: 0 }), /pageSize/);
  assert.throws(() => store.listBacklinks({ target: targetIdentity, pageSize: 101 }), /pageSize/);
  assert.throws(() => store.listBacklinks({ target: { provider: "test", keys: { source: "unrelated" } }, cursor: first.nextCursor! }), /target/);
  assert.throws(() => store.listBacklinks({ target: targetIdentity, cursor: "not-a-cursor" }), /cursor/);
  const decodedCursor = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")) as Record<string, unknown>;
  decodedCursor.upperId = Number.MAX_SAFE_INTEGER;
  const oversizedCursor = Buffer.from(JSON.stringify(decodedCursor), "utf8").toString("base64url");
  assert.throws(() => store.listBacklinks({ target: targetIdentity, cursor: oversizedCursor }), /bounds/);
  assert.deepEqual(store.listBacklinks({ target: { provider: "bb", keys: { project: "proj_12345678", thread: "thr_absent01" } }, pageSize: 100 }), { rows: [], total: 0, nextCursor: null });

});

test("reads one directed occurrence as a forward reference at its source and a backlink at a BB-thread target", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  const source = makeThread("Thread A", "thr_source01");
  const threadTarget = makeThread("Thread B", "thr_target02");
  const urlTarget: Resource = {
    provider: "url",
    keys: { href: "https://example.test/research" },
    presentation: { label: "Research", url: "https://example.test/research" },
  };
  assert.equal(store.applyProjection(makeCommand({
    producerPluginId: "thread-links",
    source,
    targets: [threadTarget, urlTarget],
    revision: 1,
  })).outcome, "applied");

  const sourceIdentity = { provider: source.provider, keys: source.keys };
  const firstInput: ListForwardReferencesInput = { source: sourceIdentity, pageSize: 1 };
  const first = store.listForwardReferences(firstInput);
  assert.equal(first.rows.length, 1);
  assert.equal(first.total, 2);
  assert.deepEqual(first.rows[0]?.target.keys, threadTarget.keys);
  assert.equal(first.rows[0]?.producerPluginId, "thread-links");
  assert.notEqual(first.nextCursor, null);
  const second = store.listForwardReferences({ source: sourceIdentity, pageSize: 1, cursor: first.nextCursor! });
  assert.equal(second.rows.length, 1);
  assert.equal(second.total, 2);
  assert.deepEqual(second.rows[0]?.target.keys, urlTarget.keys);
  assert.equal(second.nextCursor, null);

  const targetIdentity = { provider: threadTarget.provider, keys: threadTarget.keys };
  const backlinks = store.listBacklinks({ target: targetIdentity });
  assert.equal(backlinks.rows.length, 1);
  assert.equal(backlinks.total, 1);
  assert.deepEqual(backlinks.rows[0]?.source.keys, source.keys);
  assert.equal(backlinks.rows[0]?.producerPluginId, "thread-links");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM reference_occurrences").get() as { count: number }).count,
    2,
    "the two declared forward targets are the only stored edge occurrences",
  );

  assert.equal(store.applyProjection(makeCommand({
    producerPluginId: "thread-links",
    source,
    targets: [],
    revision: 2,
    expectedRevision: 1,
  })).outcome, "applied");
  assert.deepEqual(store.listForwardReferences({ source: sourceIdentity }), { rows: [], total: 0, nextCursor: null });
  assert.deepEqual(store.listBacklinks({ target: targetIdentity }), { rows: [], total: 0, nextCursor: null });
  assert.throws(
    () => store.listForwardReferences({ source: { provider: "test", keys: { source: "other" } }, cursor: first.nextCursor! }),
    /bounds|source/i,
  );
  assert.throws(
    () => store.listForwardReferences({ source: sourceIdentity, producerPluginId: "machine-monitor", cursor: first.nextCursor! }),
    /cursor/i,
  );
});

test("binds forward-reference pages to an optional producer filter", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  const source = makeThread("Thread A", "thr_filter_source01");
  const threadLinksTarget = makeThread("Thread Links target", "thr_filter_target01");
  const monitorTarget = makeThread("Monitor target", "thr_filter_target02");
  assert.equal(store.applyProjection(makeCommand({
    producerPluginId: "thread-links",
    source,
    targets: [threadLinksTarget],
    revision: 1,
  })).outcome, "applied");
  assert.equal(store.applyProjection(makeCommand({
    producerPluginId: "machine-monitor",
    source,
    targets: [monitorTarget],
    revision: 1,
  })).outcome, "applied");

  const page = store.listForwardReferences({
    source: { provider: source.provider, keys: source.keys },
    producerPluginId: "thread-links",
  });
  assert.deepEqual(page.rows.map((row) => row.target.keys), [threadLinksTarget.keys]);
  assert.equal(page.nextCursor, null);
});

test("deduplicates forward targets across producers before pagination and preserves exact URL identity", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  const source = makeThread("Source", "thr_dedup_source");
  const urls = ["https://example.test/doc?version=1", "https://example.test/doc?version=2", "https://example.test/doc?version=2#section"];
  const targets: Resource[] = urls.map((href) => ({
    provider: "url", keys: { href }, presentation: { label: "Same label", url: href },
  }));
  for (const producerPluginId of ["producer-one", "producer-two"]) {
    store.applyProjection(makeCommand({
      source, producerPluginId,
      targets: targets.map((target) => ({ ...target, presentation: { ...target.presentation, detail: producerPluginId } })),
    }));
  }
  const sourceIdentity = { provider: source.provider, keys: source.keys };
  const first = store.listForwardReferences({ source: sourceIdentity, pageSize: 1 });
  assert.equal(first.total, 3);
  assert.equal(first.rows[0]?.target.presentation.detail, "producer-one");
  assert.equal(first.rows[0]?.producerPluginId, "producer-one");
  // Neither a new unique target nor a duplicate asserted after capture enters this page set.
  store.applyProjection(makeCommand({
    source, producerPluginId: "producer-three", targets: [targets[0]!, makeThread("New target", "thr_new_target")],
  }));
  const second = store.listForwardReferences({ source: sourceIdentity, pageSize: 1, cursor: first.nextCursor! });
  const third = store.listForwardReferences({ source: sourceIdentity, pageSize: 1, cursor: second.nextCursor! });
  assert.deepEqual([first, second, third].flatMap((page) => page.rows.map((row) => row.target.keys.href)), urls);
  assert.deepEqual([first.total, second.total, third.total], [3, 3, 3]);
  assert.equal(third.nextCursor, null);
  assert.equal(store.listForwardReferences({ source: sourceIdentity }).total, 4);
  const filtered = store.listForwardReferences({ source: sourceIdentity, producerPluginId: "producer-two" });
  assert.equal(filtered.total, 3);
  assert.ok(filtered.rows.every((row) => row.producerPluginId === "producer-two"));
  assert.ok(filtered.rows.every((row) => row.target.presentation.detail === "producer-two"));
  assert.equal(store.getProjection({ source: sourceIdentity, producerPluginId: "producer-two" }).projection?.targets.length, 3);
});

test("removing one producer keeps the shared link until the final assertion is removed", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  const source = makeThread("First presentation", "thr_shared_source");
  const target = makeThread("First target", "thr_shared_target");
  store.applyProjection(makeCommand({ source, targets: [target], producerPluginId: "producer-one" }));
  const secondSource = { ...source, presentation: { label: "Second presentation" } };
  const secondTarget = { ...target, presentation: { label: "Second target", url: "/projects/proj_12345678/threads/thr_shared_target" } };
  store.applyProjection(makeCommand({ source: secondSource, targets: [secondTarget], producerPluginId: "producer-two" }));
  const sourceIdentity = { provider: source.provider, keys: source.keys };
  const targetIdentity = { provider: target.provider, keys: target.keys };
  assert.equal(store.listForwardReferences({ source: sourceIdentity }).total, 1);
  assert.equal(store.listBacklinks({ target: targetIdentity }).total, 1);
  assert.equal(store.listForwardReferences({ source: sourceIdentity }).rows[0]?.target.presentation.label, "First target");
  assert.equal(store.listForwardReferences({ source: sourceIdentity }).rows[0]?.target.presentation.url, undefined, "the first complete occurrence wins even without a URL");
  assert.equal(store.listBacklinks({ target: targetIdentity }).rows[0]?.source.presentation.label, "First presentation");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM reference_occurrences").get() as { count: number }).count, 2);
  store.applyProjection(makeCommand({ source, targets: [], producerPluginId: "producer-one", revision: 2, expectedRevision: 1, tombstone: true }));
  const forward = store.listForwardReferences({ source: sourceIdentity });
  const backward = store.listBacklinks({ target: targetIdentity });
  assert.equal(forward.total, 1);
  assert.equal(backward.total, 1);
  assert.equal(forward.rows[0]?.target.presentation.label, "Second target");
  assert.equal(forward.rows[0]?.target.presentation.url, secondTarget.presentation.url);
  assert.equal(backward.rows[0]?.source.presentation.label, "Second presentation");
  assert.equal(forward.rows[0]?.producerPluginId, "producer-two");
  assert.equal(backward.rows[0]?.producerPluginId, "producer-two");
  store.applyProjection(makeCommand({ source: secondSource, targets: [], producerPluginId: "producer-two", revision: 2, expectedRevision: 1 }));
  assert.deepEqual(store.listForwardReferences({ source: sourceIdentity }), { rows: [], total: 0, nextCursor: null });
  assert.deepEqual(store.listBacklinks({ target: targetIdentity }), { rows: [], total: 0, nextCursor: null });
});

test("captured cursors continue after representative deletion with coherent surviving rows", (t) => {
  for (const direction of ["forward", "backlink"] as const) {
    const { db, store } = makeStore();
    t.after(() => db.close());
    const source = makeResource("source-a");
    const target = makeThread("Target A", "thr_a");
    store.applyProjection(makeCommand({
      source, targets: direction === "forward" ? [target, makeThread("Target B", "thr_b")] : [target],
      producerPluginId: "producer-one",
    }));
    if (direction === "backlink") store.applyProjection(makeCommand({
      source: makeResource("source-b"), targets: [target], producerPluginId: "producer-one",
    }));
    const survivor = { ...target, presentation: { label: "Surviving target" } };
    store.applyProjection(makeCommand({
      source: { ...source, presentation: { label: "Surviving source" } },
      targets: [survivor], producerPluginId: "producer-two",
    }));
    const sourceIdentity = { provider: source.provider, keys: source.keys };
    const targetIdentity = { provider: target.provider, keys: target.keys };
    const read = (cursor?: string) => direction === "forward"
      ? store.listForwardReferences({ source: sourceIdentity, pageSize: 1, cursor })
      : store.listBacklinks({ target: targetIdentity, pageSize: 1, cursor });
    const first = read();
    assert.equal(first.total, 2);
    assert.equal(first.rows[0]?.producerPluginId, "producer-one");
    store.applyProjection(makeCommand({
      source, targets: direction === "forward" ? [makeThread("Target B", "thr_b")] : [],
      producerPluginId: "producer-one", revision: 2, expectedRevision: 1,
    }));
    // Replacement deletes IDs inside the capture and inserts IDs beyond it.
    // A surviving assertion can therefore reappear; the UI must merge identity.
    let page = read(first.nextCursor!);
    assert.equal(page.total, direction === "forward" ? 1 : 2);
    while (page.nextCursor !== null) page = read(page.nextCursor);
    assert.equal(page.rows[0]?.producerPluginId, "producer-two");
    if ("target" in page.rows[0]!) assert.equal(page.rows[0].target.presentation.label, "Surviving target");
    else assert.equal(page.rows[0]?.source.presentation.label, "Surviving source");
    assert.equal(read().total, 2);
  }
});

test("production grouped count and page queries use indexed occurrence access", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  const source = makeResource("plan-source");
  const targets = Array.from({ length: 32 }, (_, index) => makeThread(`Target ${index}`, `thr_plan_${index}`));
  for (let index = 0; index < 8; index++) store.applyProjection(makeCommand({ source, targets, producerPluginId: `producer-${index}` }));
  const prepare = db.prepare.bind(db);
  const plans: Array<{ sql: string; details: string[] }> = [];
  // Inspect the exact statements and parameters the store executes, so this
  // cannot silently keep testing a superseded query.
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes("MIN(reference_occurrences.id)")) return statement;
    return new Proxy(statement, {
      get(target, key) {
        const member = Reflect.get(target, key);
        if ((key === "get" || key === "all") && typeof member === "function") return (...parameters: unknown[]) => {
          const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as Array<{ detail: string }>;
          plans.push({ sql, details: plan.map((row) => row.detail) });
          return Reflect.apply(member, target, parameters);
        };
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  }) as typeof db.prepare;
  const sourceIdentity = { provider: source.provider, keys: source.keys };
  store.listBacklinks({ target: { provider: targets[0]!.provider, keys: targets[0]!.keys } });
  store.listForwardReferences({ source: sourceIdentity });
  store.listForwardReferences({ source: sourceIdentity, producerPluginId: "producer-3" });
  assert.equal(plans.length, 6, "count and page queries for all three views");
  for (const plan of plans) {
    assert.ok(plan.details.some((detail) => /SEARCH reference_occurrences USING.*INDEX/.test(detail)), JSON.stringify(plan));
    assert.ok(!plan.details.some((detail) => /^SCAN reference_occurrences\b/.test(detail)), JSON.stringify(plan));
  }
});

test("does not reuse occurrence ids after complete replacement", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  assert.equal(store.applyProjection(makeCommand({ revision: 1 })).outcome, "applied");
  const firstId = (db.prepare("SELECT id FROM reference_occurrences").get() as { id: number }).id;
  assert.equal(store.applyProjection(makeCommand({ revision: 2, expectedRevision: 1, targets: [] })).outcome, "applied");
  assert.equal(store.applyProjection(makeCommand({ revision: 3, expectedRevision: 2 })).outcome, "applied");
  const secondId = (db.prepare("SELECT id FROM reference_occurrences").get() as { id: number }).id;
  assert.ok(secondId > firstId);
});


test("conversation store persists typed PR/file Resources through strict identity boundaries", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  const source = makeThread("Mention source", "thr_source");
  const sourceIdentity = { provider: source.provider, keys: source.keys };
  const prSource = { provider: "github", id: "github.com/owner/repo#42", kind: "pull-request" };
  const fileSource = { provider: "plan-graph", id: "env_a:plans/example.plan.pkl", kind: "plan" };
  const occurrence = (recognized: typeof prSource, messageId: string, seq: number): ObservedMention => ({
    target: { ...recognitionIdentity(recognized), presentation: { label: messageId } },
    locator: { kind: "conversation", threadId: "thr_source", messageId, messageSeq: seq, anchorSeq: seq, role: "user" },
    sourceContentRevision: sha256Hex("authored mention"), span: { start: 0, end: 2 }, messageCreatedAt: seq,
    provenance: { pluginId: "supplier", origin: "contributed", confidence: "high",
      recognition: { basis: "explicit", explanation: "Typed source fixture." }, source: recognized },
  });
  const locations = [occurrence(prSource, "pr", 1), occurrence(fileSource, "file", 2)];
  const scan: MentionScan = { occurrences: locations, observedMessageIds: ["pr", "file"], scannedMessageIds: ["pr", "file"],
    failedSuppliers: [], discoveryIncomplete: false, coverage: { timelineComplete: true, reasons: [], retentionLimited: false } };

  store.replaceConversationMentions(source, scan);
  const initial = store.mentionState(sourceIdentity);
  assert.equal(initial.occurrences.length, 2);
  assert.equal(store.listForwardReferences({ source: sourceIdentity }).total, 2);
  for (const recognized of [prSource, fileSource]) {
    assert.equal(store.listBacklinks({ target: recognitionIdentity(recognized) }).total, 1);
  }
  assert.deepEqual((db.prepare("SELECT source_identity_json FROM recognized_resources").all() as Array<{ source_identity_json: string }>)
    .map(row => JSON.parse(row.source_identity_json)).sort((a, b) => a.provider.localeCompare(b.provider)),
    [prSource, fileSource].map(({ provider, id }) => ({ provider, id })).sort((a, b) => a.provider.localeCompare(b.provider)));

  // This takes the partial-scan prior-time path through identity-only v1 reads.
  store.replaceConversationMentions(source, { ...scan, coverage: { ...scan.coverage, timelineComplete: false, reasons: ["partial"] } });
  assert.equal(store.mentionState(sourceIdentity).occurrences.length, 2);
  assert.equal(store.listForwardReferences({ source: sourceIdentity }).rows.find(row => row.target.keys.provider === "github")?.lastSeenAt, 1);
});

test("conversation store rejects malformed or mismatched typed identities without weakening v1 or changing stored facts", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  const source = makeThread("Mention source", "thr_source");
  const sourceIdentity = { provider: source.provider, keys: source.keys };
  const recognized = { provider: "github", id: "github.com/owner/repo#42" };
  const target = { ...recognitionIdentity(recognized), presentation: { label: "PR" } };
  const location: ObservedMention = { target,
    locator: { kind: "conversation", threadId: "thr_source", messageId: "pr", messageSeq: 1, anchorSeq: 1, role: "assistant" },
    sourceContentRevision: sha256Hex("authored mention"), span: { start: 0, end: 2 }, messageCreatedAt: 1,
    provenance: { pluginId: "supplier", origin: "contributed", confidence: "high",
      recognition: { basis: "explicit", explanation: "Typed source fixture." }, source: recognized } };
  const scan: MentionScan = { occurrences: [location], observedMessageIds: ["pr"], scannedMessageIds: ["pr"], failedSuppliers: [],
    discoveryIncomplete: false, coverage: { timelineComplete: true, reasons: [], retentionLimited: false } };
  store.replaceConversationMentions(source, scan);
  const before = store.mentionState(sourceIdentity);
  const projection = store.getProjection({ producerPluginId: "cross-references", source: sourceIdentity });
  const keys = db.prepare("SELECT * FROM recognized_resources").all();

  // Full Resources remain invalid at identity-only v1 boundaries.
  assert.throws(() => canonicalizeIdentity(target), /unknown field presentation/);
  const malformed = { ...target, keys: { ...target.keys, identity: "x".repeat(513) } };
  assert.throws(() => store.replaceConversationMentions(source, { ...scan, occurrences: [{ ...location, target: malformed }] }));
  const wrongMapping = { ...recognitionIdentity({ ...recognized, id: "github.com/owner/repo#99" }), presentation: target.presentation };
  assert.throws(() => store.replaceConversationMentions(source, { ...scan, occurrences: [{ ...location, target: wrongMapping }] }), /mapping mismatch/);
  assert.throws(() => store.replaceConversationMentions(source, { ...scan, occurrences: [{ ...location, target: { ...target, unexpected: true } as Resource }] }), /unknown field unexpected/);
  assert.deepEqual(store.mentionState(sourceIdentity), before);
  assert.deepEqual(store.getProjection({ producerPluginId: "cross-references", source: sourceIdentity }), projection);
  assert.deepEqual(db.prepare("SELECT * FROM recognized_resources").all(), keys);
});


function capLocations(source: Resource, count: number, id = "github.com/owner/repo#42", start = 1): ObservedMention[] {
  const recognized = { provider: "github", id };
  const target = { ...recognitionIdentity(recognized), presentation: { label: id } };
  return Array.from({ length: count }, (_, index) => ({ target,
    locator: { kind: "conversation", threadId: source.keys.thread!, messageId: `cap-${start + index}`, messageSeq: start + index, anchorSeq: start + index, role: "user" },
    sourceContentRevision: sha256Hex("authored mention"), span: { start: 0, end: 2 }, messageCreatedAt: start + index,
    provenance: { pluginId: "supplier", origin: "contributed", confidence: "high",
      recognition: { basis: "explicit", explanation: "Typed source fixture." }, source: recognized } }));
}
function capScan(occurrences: ObservedMention[], complete = true): MentionScan {
  return { occurrences, observedMessageIds: occurrences.map(row => row.locator.messageId), scannedMessageIds: occurrences.map(row => row.locator.messageId),
    failedSuppliers: [], discoveryIncomplete: false, coverage: { timelineComplete: complete, reasons: complete ? [] : ["timeline-50-pages"], retentionLimited: false } };
}

test("per-edge cap truth survives unvisited scans/reopen, clears only on complete observation or producer tombstone, and invalidates evidence", t => {
  const dir = mkdtempSync(join(tmpdir(), "reference-cap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "caps.sqlite");
  let db = new Database(path); enableForeignKeys(db);
  for (const migration of crossReferencesMigrations) db.exec(migration);
  let store = new CrossReferenceStore(db);
  t.after(() => { if (db.open) db.close(); });
  const source = makeThread("Capped source", "thr_caps");
  const sourceIdentity = { provider: source.provider, keys: source.keys };
  const a = capLocations(source, 105), b = capLocations(source, 1, "github.com/owner/repo#99", 200);
  const graph = () => store.getProjection({ producerPluginId: "cross-references", source: sourceIdentity }).projection!;
  const statuses = () => store.mentionState(sourceIdentity).edgeCaps.map(cap => [cap.target.keys.identity, cap.state]).sort();
  const aKey = a[0]!.target.keys.identity!, bKey = b[0]!.target.keys.identity!;
  const expected = (aState: string) => [[aKey, aState], [bKey, "uncapped"]].sort();

  store.replaceConversationMentions(source, capScan([...a, ...b]));
  assert.deepEqual(statuses(), expected("capped"));
  assert.equal(store.mentionState(sourceIdentity).occurrences.length, 101);
  const initial = store.mentionState(sourceIdentity), originalGraph = graph();
  store.replaceConversationMentions(source, capScan([], false));
  const partial = store.mentionState(sourceIdentity);
  assert.equal(partial.coverage!.retentionLimited, true);
  assert.deepEqual(statuses(), expected("capped"));
  assert.equal(partial.occurrences.length, 101);
  assert.ok(partial.revision > initial.revision);
  assert.equal(graph().payloadDigest, originalGraph.payloadDigest);assert.equal(graph().revision, originalGraph.revision);
  db.close();db = new Database(path);enableForeignKeys(db);store = new CrossReferenceStore(db);
  assert.deepEqual(store.mentionState(sourceIdentity), partial);

  // Outer collector transactions can roll back cap facts along with evidence.
  assert.throws(() => db.transaction(() => { store.replaceConversationMentions(source, capScan([...a.slice(-100), ...b])); throw new Error("fenced rollback"); })(), /fenced rollback/);
  assert.deepEqual(store.mentionState(sourceIdentity), partial);
  const clearSignals = store.replaceConversationMentions(source, capScan([...a.slice(-100), ...b]));
  assert.deepEqual(statuses(), expected("uncapped"));
  const cleared = store.mentionState(sourceIdentity);
  assert.equal(cleared.coverage!.retentionLimited, false);assert.ok(cleared.revision > partial.revision);
  assert.notEqual(cleared.digest, partial.digest);assert.equal(clearSignals.length, 1);
  assert.equal(clearSignals[0]!.revision, originalGraph.revision);
  assert.equal(graph().payloadDigest, originalGraph.payloadDigest);assert.equal(graph().revision, originalGraph.revision);
  assert.deepEqual(store.replaceConversationMentions(source, capScan([...a.slice(-100), ...b])), []);
  assert.equal(store.mentionState(sourceIdentity).revision, cleared.revision);

  store.replaceConversationMentions(source, capScan([...a, ...b]));
  const otherSource = makeThread("Other capped source", "thr_other_caps");
  const otherIdentity = { provider: otherSource.provider, keys: otherSource.keys };
  store.replaceConversationMentions(otherSource, capScan(capLocations(otherSource, 105)));
  // Seed another producer's durable cap fact: v1 has no public evidence writer.
  const nativeStream = db.prepare("SELECT * FROM mention_streams WHERE source_resource_id = (SELECT id FROM resources WHERE canonical_keys_json = ?)").get(canonicalizeResource(source).canonicalKeysJson) as any;
  const nativeCap = db.prepare("SELECT * FROM mention_edge_caps WHERE source_resource_id = ?").get(nativeStream.source_resource_id) as any;
  db.prepare("INSERT INTO mention_streams (producer_plugin_id, source_resource_id, evidence_revision, evidence_digest, collector_version, coverage_json, last_successful_scan_at) SELECT 'external', source_resource_id, evidence_revision, evidence_digest, collector_version, coverage_json, last_successful_scan_at FROM mention_streams WHERE producer_plugin_id = 'cross-references' AND source_resource_id = ?").run(nativeStream.source_resource_id);
  db.prepare("INSERT INTO mention_edge_caps VALUES ('external', ?, ?, 'capped')").run(nativeCap.source_resource_id, nativeCap.target_resource_id);
  store.replaceConversationMentions(source, capScan([]), true);
  assert.deepEqual(store.mentionState(sourceIdentity).edgeCaps, []);
  assert.equal(store.mentionState(sourceIdentity).coverage!.retentionLimited, false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mention_edge_caps WHERE producer_plugin_id = 'external'").get() as any).n, 1);
  assert.equal(store.mentionState(otherIdentity).edgeCaps[0]!.state, "capped");
});

test("append-only cap migration preserves earlier unattributed global clipping as unknown until complete observation", t => {
  const db = new Database(":memory:");t.after(() => db.close());enableForeignKeys(db);
  const capMigration = crossReferencesMigrations.findIndex(sql => sql.includes("CREATE TABLE mention_edge_caps"));
  for (const migration of crossReferencesMigrations.slice(0, capMigration)) db.exec(migration);
  const store = new CrossReferenceStore(db), source = makeThread("Migrating caps", "thr_migrate_caps");
  const sourceIdentity = { provider: source.provider, keys: source.keys };
  const a = capLocations(source, 1), b = capLocations(source, 1, "github.com/owner/repo#99", 200);
  store.applyProjection(makeCommand({ producerPluginId: "cross-references", source, targets: [a[0]!.target, b[0]!.target] }));
  const sourceId = (db.prepare("SELECT source_resource_id FROM source_projections").get() as any).source_resource_id;
  db.prepare("INSERT INTO mention_streams VALUES ('cross-references', ?, 1, ?, 1, ?, 1)").run(sourceId, "a".repeat(64), JSON.stringify({ timelineComplete: true, reasons: [], retentionLimited: true }));
  for (const migration of crossReferencesMigrations.slice(capMigration)) db.exec(migration);
  assert.deepEqual(store.mentionState(sourceIdentity).edgeCaps.map(cap => cap.state), ["unknown", "unknown"]);
  store.replaceConversationMentions(source, capScan([], false));
  assert.equal(store.mentionState(sourceIdentity).coverage!.retentionLimited, true);
  assert.ok(store.mentionState(sourceIdentity).edgeCaps.every(cap => cap.state === "unknown"));
  store.replaceConversationMentions(source, capScan([...a, ...b]));
  assert.ok(store.mentionState(sourceIdentity).edgeCaps.every(cap => cap.state === "uncapped"));
  assert.equal(store.mentionState(sourceIdentity).coverage!.retentionLimited, false);
});


test("high-volume product-store grouping retains deterministic newest locations with linear membership work", t => {
  const { db, store } = makeStore();t.after(() => db.close());
  const source = makeThread("Volume source", "thr_volume");
  const rows = capLocations(source, 25_600);
  const originalSome = Array.prototype.some;
  let predicates = 0;
  Array.prototype.some = function(callback: any, thisArg?: any) {
    return originalSome.call(this, (value: any, index: number, array: any[]) => {
      predicates++;return callback.call(thisArg, value, index, array);
    });
  };
  try { store.replaceConversationMentions(source, capScan(rows)); }
  finally { Array.prototype.some = originalSome; }
  // Count actual callback evaluations, not elapsed wall time. A per-group
  // linear search for each of 25,600 rows would exceed 327 million probes.
  assert.ok(predicates < rows.length * 200, `membership probes: ${predicates}`);
  const state = store.mentionState({ provider: source.provider, keys: source.keys });
  assert.equal(state.occurrences.length, 100);
  assert.equal(state.edgeCaps[0]!.state, "capped");
  assert.deepEqual(state.occurrences.map(o => o.messageCreatedAt).sort((a,b)=>a-b), Array.from({ length: 100 }, (_,i)=>25_501+i));
});


test("rotating partial targets bound keyed caps, retain source uncertainty through reopen and conservatively classify returning targets", t => {
  const dir = mkdtempSync(join(tmpdir(), "reference-cap-rotation-"));t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "caps.sqlite");let db = new Database(path);enableForeignKeys(db);
  for (const migration of crossReferencesMigrations) db.exec(migration);
  let store = new CrossReferenceStore(db);t.after(() => { if(db.open)db.close(); });
  const source = makeThread("Rotation source", "thr_rotation"), sourceIdentity = { provider: source.provider, keys: source.keys };
  for (let batch = 0; batch < 6; batch++) {
    const rows = Array.from({ length: 64 }, (_, group) => capLocations(source, 101, `target-${batch*64+group}`, batch*10_000+group*101+1)).flat();
    store.replaceConversationMentions(source, capScan(rows, false));
    assert.ok((db.prepare("SELECT COUNT(*) AS n FROM mention_edge_caps").get() as any).n <= 256);
    assert.ok(store.mentionState(sourceIdentity).edgeCaps.length <= 256);
    assert.ok(store.listForwardReferences({ source: sourceIdentity }).total <= 256);
  }
  const prior = store.mentionState(sourceIdentity);
  assert.equal(prior.coverage!.capHistoryUnknown, true);assert.equal(prior.coverage!.retentionLimited, true);
  db.close();db = new Database(path);enableForeignKeys(db);store = new CrossReferenceStore(db);
  assert.deepEqual(store.mentionState(sourceIdentity), prior);
  // Target-0 was dropped from the retained graph and its exact cap history was
  // compressed into the source marker. A partial single sighting is unknown.
  const returning = capLocations(source, 1, "target-0", 100_000);
  store.replaceConversationMentions(source, capScan(returning, false));
  const returned = store.mentionState(sourceIdentity);
  assert.equal(returned.edgeCaps.find(cap => cap.target.keys.identity === returning[0]!.target.keys.identity)?.state, "unknown");
  assert.equal(returned.coverage!.capHistoryUnknown, true);assert.ok(returned.revision > prior.revision);
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM mention_edge_caps").get() as any).n <= 256);
  const graph = store.getProjection({ producerPluginId: "cross-references", source: sourceIdentity }).projection!;
  // A complete scan with exactly the retained observations resets uncertainty
  // without changing graph identity/digest/revision.
  const completeRows = returned.occurrences.map(({ occurrenceKey, observedAt, confirmed, ...row }) => row);
  store.replaceConversationMentions(source, capScan(completeRows));
  const complete = store.mentionState(sourceIdentity);
  assert.equal(complete.coverage!.capHistoryUnknown, false);assert.equal(complete.coverage!.retentionLimited, false);
  assert.ok(complete.edgeCaps.every(cap => cap.state === "uncapped"));assert.ok(complete.revision > returned.revision);
  assert.equal(store.getProjection({ producerPluginId: "cross-references", source: sourceIdentity }).projection!.payloadDigest, graph.payloadDigest);
  assert.equal(store.getProjection({ producerPluginId: "cross-references", source: sourceIdentity }).projection!.revision, graph.revision);
  store.replaceConversationMentions(source, capScan([]), true);
  assert.equal(store.mentionState(sourceIdentity).coverage!.capHistoryUnknown, false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mention_edge_caps").get() as any).n, 0);
});


test("verified workspace file claims coalesce across conversations and store full frame mapping with per-occurrence lexical provenance", t => {
  const { db, store } = makeStore();t.after(() => db.close());
  const a = makeThread("File A", "thr_file_a"), b = makeThread("File B", "thr_file_b"), c = makeThread("File C", "thr_file_c");
  const shared = { kind: "workspace" as const, environmentId: "env_shared", path: "notes/日本語.txt" };
  const location = (source: Resource, file: any, seq: number): ObservedMention => ({
    target: { ...verifiedFileIdentity(file), presentation: { label: file.path } },
    locator: { kind: "conversation", threadId: source.keys.thread!, messageId: `file-${seq}`, messageSeq: seq, anchorSeq: seq, role: "user" },
    sourceContentRevision: sha256Hex("authored file mention"), span: { start: 0, end: 2 }, messageCreatedAt: seq,
    provenance: { pluginId: "cross-references", origin: "builtin", confidence: "high", recognition: { basis: "explicit", explanation: "Native file." },
      source: { provider: "bb.file", id: `${source.keys.thread}:${file.path}` }, verifiedFile: file } });
  store.replaceConversationMentions(a, capScan([location(a, shared, 1), location(a, { kind: "thread-storage", threadId: a.keys.thread, path: shared.path }, 2)]));
  store.replaceConversationMentions(b, capScan([location(b, shared, 1), location(b, { kind: "thread-storage", threadId: b.keys.thread, path: shared.path }, 2)]));
  store.replaceConversationMentions(c, capScan([location(c, { ...shared, environmentId: "env_other" }, 1)]));
  assert.equal(store.listBacklinks({ target: verifiedFileIdentity(shared) }).total, 2);
  assert.equal(store.listBacklinks({ target: verifiedFileIdentity({ kind: "thread-storage", threadId: a.keys.thread!, path: shared.path }) }).total, 1);
  const mapping = db.prepare("SELECT m.source_identity_json FROM recognized_resources m JOIN resources r ON r.id = m.resource_id WHERE r.canonical_keys_json = ?").get(canonicalizeIdentity(verifiedFileIdentity(shared)).canonicalKeysJson) as any;
  assert.equal(mapping.source_identity_json, verifiedFileIdentityRecord(shared));
  assert.deepEqual(JSON.parse(mapping.source_identity_json), { provider: "bb.file", verifiedFile: shared });
  const stateA = store.mentionState({ provider: a.provider, keys: a.keys }), stateB = store.mentionState({ provider: b.provider, keys: b.keys });
  assert.ok(stateA.occurrences.every(row => row.provenance.source.id.startsWith("thr_file_a:")));
  assert.ok(stateB.occurrences.every(row => row.provenance.source.id.startsWith("thr_file_b:")));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM recognized_resources").get() as any).n, 4);
  const invalid = location(a, shared, 3);delete invalid.provenance.verifiedFile;
  assert.throws(() => store.replaceConversationMentions(a, capScan([invalid])), /requires verified frame/);
  assert.deepEqual(store.mentionState({ provider: a.provider, keys: a.keys }), stateA);
  // Existing public v1 producers still submit canonical Resources without any
  // occurrence/file verification metadata being added to their strict DTOs.
  assert.equal(store.applyProjection(makeCommand({ producerPluginId: "external", source: a, targets: [location(a, shared, 3).target] })).outcome, "applied");
});


test("source target admission honors exact aggregate v1 bytes as well as count without relaxing strict payload validation",t=>{
  const {db,store}=makeStore();t.after(()=>db.close());const source=makeThread("Payload source","thr_payload");
  const rows:ObservedMention[]=Array.from({length:256},(_,index)=>{
    const href=`https://example.test/${"a".repeat(480)}/${index}`;
    return {...capLocations(source,1,"fixture",index+1)[0]!,target:{provider:"url",keys:{href},presentation:{label:"link",url:href}},
      provenance:{pluginId:"cross-references",origin:"builtin",confidence:"high",recognition:{basis:"explicit",explanation:"Authored URL."},source:{provider:"bb.url",id:href}}};
  });
  store.replaceConversationMentions(source,capScan(rows));
  const projection=store.getProjection({producerPluginId:"cross-references",source:{provider:source.provider,keys:source.keys}}).projection!;
  assert.ok(projection.targets.length<256);
  const payload=projectionPayloadJson("cross-references",canonicalizeResource(source),false,projection.targets.map(canonicalizeResource));
  assert.ok(Buffer.byteLength(payload)<=MAX_PROJECTION_PAYLOAD_BYTES);
  const selected=new Set(projection.targets.map(target=>target.keys.href));
  const dropped=rows.find(row=>!selected.has(row.target.keys.href))!;
  assert.throws(()=>projectionPayloadJson("cross-references",canonicalizeResource(source),false,[...projection.targets,dropped.target].map(canonicalizeResource)),/payload exceeds/);
  assert.equal(store.mentionState({provider:source.provider,keys:source.keys}).occurrences.length,projection.targets.length);
});

test("append-only queue priority migration preserves legacy ready times and generations; durable default and rank constraint survive reopen", t => {
  const dir = mkdtempSync(join(tmpdir(), "cross-priority-migrate-"));t.after(() => rmSync(dir, {recursive: true, force: true}));
  const path = join(dir, "queue.sqlite"), db = new Database(path);
  // Fix this historical fixture to the pre-priority prefix even as newer
  // append-only migrations are added after the priority migration at index12.
  const prefix = crossReferencesMigrations.slice(0, 12);assert.equal(prefix.length, 12);
  for (const migration of prefix) db.exec(migration);
  db.prepare("INSERT INTO assistant_link_jobs(thread_id,project_id,version,deleted,retry_at,attempts) VALUES (?,?,?,?,?,?)")
    .run("thr_viewed", "proj_a", 7, 0, -1, 0);
  db.prepare("INSERT INTO assistant_link_jobs(thread_id,project_id,version,deleted,retry_at,attempts) VALUES (?,?,?,?,?,?)")
    .run("thr_failed", "proj_a", 9, 1, 900_000, 3);
  const before = db.prepare("SELECT * FROM assistant_link_jobs ORDER BY thread_id").all() as any[];
  db.exec(crossReferencesMigrations[12]!);
  assert.deepEqual(db.prepare("SELECT * FROM assistant_link_jobs ORDER BY thread_id").all(),
    before.map(row => ({...row, priority: row.thread_id === "thr_viewed" ? 2 : 0})));
  db.prepare("INSERT INTO assistant_link_jobs(thread_id,project_id,version) VALUES ('thr_cold','proj_a',1)").run();
  assert.equal((db.prepare("SELECT priority FROM assistant_link_jobs WHERE thread_id='thr_cold'").get() as any).priority, 0);
  assert.throws(() => db.prepare("UPDATE assistant_link_jobs SET priority=3").run(), /CHECK/);
  db.prepare("UPDATE assistant_link_jobs SET priority=1 WHERE thread_id='thr_failed'").run();
  const migrated = db.prepare("SELECT * FROM assistant_link_jobs ORDER BY thread_id").all();db.close();
  const reopened = new Database(path);t.after(() => reopened.close());
  assert.deepEqual(reopened.prepare("SELECT * FROM assistant_link_jobs ORDER BY thread_id").all(), migrated);
});

test('P2 append-only migration keeps the13 installed statements byte-identical',()=>{
 const expected=['bf1cb81627037b2c1fe7c98dce443d5cf88acd3c59e252acee6aef3f1b5b9df1','b7db6354d1f1a820ee30aa1498862959a8cbb2b6806b737d3f278c9880b623c4','d231ce8ecbd519e4e80141f4f2e4fec2d12d51b5d75c10cd4aaa684b1e598015','ccabcf7b3e4e3dbd154c363f057dcaccce38417ae0efedfe0d3586a989ea38e6','38c5d744ea2aa070c88e17668e0991cb6bd0bdf1fb0893f59716cf76fa79941e','90c7a229feb10b2f45ffd93e4945e48eb5679384c36bc2efc2de583fd363a375','3782bac555c15a6f30e8f177d7f6430c2b2cbdf1a5f7e72b4bbca103464777c0','86c6c9aa0e85869b42b843ef7d389a63266a5f16cd85f970e0141f74ca4e5977','72423d9d60e29e05fb0af01aa714ae74958b1312cb4fd152d4b87d0165ce1a95','d5291042ec5f0fc4b00d0774fd2b23070d10c9ff239493fc961b29ee312fe1a0','922e0c821b879add45246f79e05fa4322f7b2401bfdc9f161258a67d2cf9061c','8090f07ed4397c56148db5c69dfa8a3d3a097272cfbd8d7fdd4721bc4dbacdd3','01df6c07c9a78bb0c2c528ee4851a8e05e2615a3c30a64f4ef1421c0ed3abd45'];
 assert.deepEqual(crossReferencesMigrations.slice(0,13).map(sha256Hex),expected);
});

test('actual writer proves original evidence before mutation and SQLite ready numeric CHECKs reject NULL/fractions',async t=>{
 const {collectConversationMentions}=await import('../mention-collection.ts');const {db,store}=makeStore();t.after(()=>db.close());
 const source=makeThread('Source','thr_proof'),body='A sentence https://example.test/proof ends here.';
 const scan=await collectConversationMentions({messages:[{id:'msg_proof',text:body,messageSeq:7,anchorSeq:null,createdAt:10,role:'user'}],context:{consumer:{pluginId:'cross-references'},threadId:'thr_proof',links:[]},clients:[],getThread:async id=>({id,projectId:'proj_12345678'}),signal:new AbortController().signal});
 store.replaceConversationMentions(source,scan);const before=store.mentionState({provider:source.provider,keys:source.keys});assert.equal(before.occurrences[0]!.excerpt?.state,'ready');
 for(const field of ['excerpt_source_start','excerpt_source_end','match_start','match_end'])for(const value of [null,0.5,-1])assert.throws(()=>db.prepare(`UPDATE mention_excerpts SET ${field}=?`).run(value),/CHECK/);
 const tampered=structuredClone(scan);const ex=tampered.occurrences[0]!.excerpt!;if(ex.state==='ready')ex.text='x'.repeat(ex.text.length);assert.throws(()=>store.replaceConversationMentions(source,tampered),/original slice/);
 assert.equal(store.mentionState({provider:source.provider,keys:source.keys}).revision,before.revision);
 const missing={...scan,sourceBodies:undefined};assert.throws(()=>store.replaceConversationMentions(source,missing as any),/source body required/);
});

test('actual store rejects injected unsafe original-slice excerpts using the same cached privacy intervals as collection',async t=>{
 const {collectConversationMentions}=await import('../mention-collection.ts');const {db,store}=makeStore();t.after(()=>db.close());
 const source=makeThread('Source','thr_privacy'),body='Useful https://example.test/safe [PRIVATE_LABEL](https://example.test/?token=secret) after useful.';
 const scan=await collectConversationMentions({messages:[{id:'msg_privacy',text:body,messageSeq:7,anchorSeq:null,createdAt:10,role:'user'}],context:{consumer:{pluginId:'cross-references'},threadId:'thr_privacy',links:[]},clients:[],getThread:async id=>({id,projectId:'proj_12345678'}),signal:new AbortController().signal});
 store.replaceConversationMentions(source,scan);const before=store.mentionState({provider:source.provider,keys:source.keys});assert.equal(before.occurrences.length,1);
 assert.ok(!JSON.stringify(before).includes('token=secret'));assert.ok(!JSON.stringify(before).includes('PRIVATE_LABEL'));
 const location=scan.occurrences[0]!,injected=structuredClone(scan);
 injected.occurrences[0]!.excerpt={state:'ready',text:body,sourceSpan:{start:0,end:body.length},matchSpan:{start:location.span.start,end:location.span.end},clippedBefore:false,clippedAfter:false,matchClippedBefore:false,matchClippedAfter:false,codecVersion:1};
 assert.throws(()=>store.replaceConversationMentions(source,injected),/crosses excluded source/);
 const after=store.mentionState({provider:source.provider,keys:source.keys});assert.deepEqual(after,before);
});

test('actual store body admission rejects safe-destination excerpts that expose unsafe label/title URLs',async t=>{
 const {collectConversationMentions}=await import('../mention-collection.ts');const {db,store}=makeStore();t.after(()=>db.close());const source=makeThread('Source','thr_label_privacy'),safe='https://example.test/safe';
 const cases:{link:string;retained:boolean}[]=[{link:`[https://example.test/?token=secret](${safe})`,retained:false},{link:`[label](${safe} "https://user:secret@example.test/a")`,retained:true},{link:'[label][safe]',retained:true},{link:`[/other-route?token=secret](${safe})`,retained:false},{link:'[/other-route#token=secret][safe]',retained:false},{link:`[/other-route?to&#107;en=secret](${safe})`,retained:true},{link:'[/other-route?to&#107;en=secret][safe]',retained:true}];
 for(const {link,retained} of cases){
  const body=`Useful https://example.test/anchor ${link} after.\n\n[safe]: ${safe} "https://example.test/?%74oken=secret"`;
  const scan=await collectConversationMentions({messages:[{id:'msg_label',text:body,messageSeq:9,anchorSeq:null,createdAt:10,role:'assistant'}],context:{consumer:{pluginId:'cross-references'},threadId:'thr_label_privacy',links:[]},clients:[],getThread:async id=>({id,projectId:'proj_12345678'}),signal:new AbortController().signal});
  store.replaceConversationMentions(source,scan);const before=store.mentionState({provider:source.provider,keys:source.keys});assert.ok(!JSON.stringify(before).includes('secret'));
  assert.equal(before.occurrences.length,1+Number(retained));const outer=before.occurrences.find(o=>o.target.provider==='url'&&o.target.keys.href===safe);
  if(retained){assert.ok(outer);assert.equal(body.slice(outer.span.start,outer.span.end),link);if(link.startsWith('[/other-route'))assert.equal(outer.target.presentation.label,'Link');}else assert.equal(outer,undefined);
  const injected=structuredClone(scan),location=injected.occurrences.find(o=>o.target.provider==='url'&&o.target.keys.href==='https://example.test/anchor')!;
  const end=body.indexOf('\n\n');location.excerpt={state:'ready',text:body.slice(0,end),sourceSpan:{start:0,end},matchSpan:{start:location.span.start,end:location.span.end},clippedBefore:false,clippedAfter:false,matchClippedBefore:false,matchClippedAfter:false,codecVersion:1};
  assert.throws(()=>store.replaceConversationMentions(source,injected),/crosses excluded source/);assert.deepEqual(store.mentionState({provider:source.provider,keys:source.keys}),before);
 }
});

test('actual store and V2 reader preserve astral/U+FFFD source slices and atomically reject unsafe UTF16 excerpt coordinates',async t=>{
 const {collectConversationMentions}=await import('../mention-collection.ts');
 const {createMentionReader}=await import('../mention-query.ts');
 const {db,store}=makeStore();t.after(()=>db.close());const source=makeThread('Unicode','thr_unicode'),href='https://example.test/safe';
 const body=`😀 useful \uFFFD ${href} after. 😀`;
 const scan=await collectConversationMentions({messages:[{id:'msg_unicode',text:body,messageSeq:13,anchorSeq:null,createdAt:10,role:'user'}],context:{consumer:{pluginId:'cross-references'},threadId:'thr_unicode',links:[]},clients:[],getThread:async id=>({id,projectId:'proj_12345678'}),signal:new AbortController().signal});
 store.replaceConversationMentions(source,scan);assert.equal(scan.occurrences.length,1);const location=scan.occurrences[0]!;
 const reader=createMentionReader(db),query={version:2,query:{kind:'authored-url',href}} satisfies import('@phosphorco/bb-cross-references').ListMentionsInputV2;
 const page=reader.read(query);assert.equal(page.status,'page');assert.ok(page.status==='page');const item=page.items[0];assert.ok(item?.kind==='occurrence');assert.equal(item.confirmation,'observed');assert.equal(item.sourceContentRevision,sha256Hex(body));assert.equal(item.locator.messageSeq,13);
 assert.ok(item.excerpt.state==='ready');const ready=item.excerpt;assert.equal(ready.text,body.slice(ready.sourceSpan.start,ready.sourceSpan.end));assert.ok(ready.text.includes('😀'));assert.ok(ready.text.includes('\uFFFD'));
 db.prepare('INSERT INTO assistant_link_jobs(thread_id,project_id,version,deleted,retry_at,attempts,priority) VALUES (?,?,?,?,?,?,?)').run('thr_unicode','proj_12345678',7,0,900000,3,2);
 db.prepare('INSERT INTO assistant_link_sync(thread_id,synced_at) VALUES (?,?)').run('thr_unicode',123);
 // Include every durable graph/evidence/job/counter table, including SQLite's
 // AUTOINCREMENT sequence. Rejection must precede any mutation or allocation.
 const snapshot=()=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all().map(name=>{
  assert.ok(typeof name==='string');return {name,rows:db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'" ORDER BY rowid').all()};
 });
 const before=snapshot();
 const whole=(text:string,start:number,end:number,matchStart=location.span.start-start,matchEnd=location.span.end-start):ExcerptRecordV2=>({state:'ready',text,sourceSpan:{start,end},matchSpan:{start:matchStart,end:matchEnd},clippedBefore:false,clippedAfter:false,matchClippedBefore:false,matchClippedAfter:false,codecVersion:1});
 const replacementAt=body.indexOf('\uFFFD');
 const cases=[
  whole(body.slice(1),1,body.length),
  whole('\uFFFD'+body.slice(2),1,body.length),
  whole(body.slice(0,-1),0,body.length-1),
  whole(body.slice(0,-2)+'\uFFFD',0,body.length-1),
  whole(body.slice(0,replacementAt)+'\ud800'+body.slice(replacementAt+1),0,body.length),
  whole(body.slice(0,replacementAt)+'\udc00'+body.slice(replacementAt+1),0,body.length),
  whole(body,0,body.length,1,location.span.end),
  whole(body,0,body.length,0,1),
 ];
 for(const excerpt of cases){
  const rejected=structuredClone(scan);rejected.occurrences[0]!.excerpt=excerpt;
  assert.throws(()=>store.replaceConversationMentions(source,rejected),/UTF16|code-point/);
  assert.deepEqual(snapshot(),before);assert.deepEqual(reader.read(query),page);
 }
 // Persisted reading checks only stored Unicode/relative coordinates, with no
 // source-body port and no claim that it can reprove the historical body.
 const astral=ready.text.indexOf('😀');assert.ok(astral>=0);
 db.prepare('UPDATE mention_excerpts SET match_start=?').run(astral+1);
 assert.throws(()=>reader.read(query),/code-point/);
 db.prepare('UPDATE mention_excerpts SET match_start=?').run(ready.matchSpan.start);
 assert.deepEqual(snapshot(),before);assert.deepEqual(reader.read(query),page);
});

// P3 tests exercise the product store/transaction, never an alternate graph.
import {briefFixture,briefEmptyFixture,briefStatus,refreshBrief} from './brief-evidence.test.ts';
import {briefWithheldDigest,briefEvidenceDigest} from '@phosphorco/bb-cross-references';
function briefTables(db:Database.Database){const tables=['resources','resource_keys','source_projections','reference_occurrences','recognized_resources','brief_evidence_streams','brief_evidence_occurrences','brief_producer_status','assistant_link_jobs','sqlite_sequence'];return Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));}
test('producer G8/S10 high-water fences ALL state; exact replay preserves status;11 atomically supersedes',t=>{
 const {db,store}=makeStore();t.after(()=>db.close());const first=briefFixture();assert.equal(store.applyProducer(first).response.evidenceDisposition,'installed');
 const blocked=briefStatus(first);assert.equal(store.reportProducerStatus(blocked).response.outcome,'recorded');const before=briefTables(db);
 for(const revision of [9,10]){const r=store.applyProducer(briefFixture(revision,8));assert.equal(r.response.outcome,'stale');assert.equal(r.response.currentRevision,8);assert.equal(r.response.state.revisionHighWater,10);assert.equal(r.signal,null);assert.deepEqual(briefTables(db),before);}
 const replay=store.applyProducer({...first,projection:{...first.projection,expectedRevision:0}});assert.equal(replay.response.evidenceDisposition,'replayed');assert.equal(replay.response.state.status?.attemptRevision,10);assert.equal(replay.signal,null);assert.deepEqual(briefTables(db),before);
 const different=briefFixture();different.evidence.occurrences[0]!.authoredUrl={state:'unknown'};different.evidenceDigest=briefEvidenceDigest(different.evidence);assert.equal(store.applyProducer(different).response.evidenceDisposition,'conflict');assert.deepEqual(briefTables(db),before);
 assert.equal(store.applyProducer(briefFixture(11,7)).response.outcome,'cas-mismatch');assert.deepEqual(briefTables(db),before);
 const next=store.applyProducer(briefFixture(11,8));assert.equal(next.response.outcome,'applied');assert.equal(next.response.currentRevision,11);assert.equal(next.response.state.status,null);assert.equal(next.response.state.evidence?.state,'bound');assert.equal(next.response.state.revisionHighWater,11);assert.ok(next.signal);
});
test('status-only first intent creates NO resource/graph/evidence and precise replay/CAS ordering survives ordinary V1',t=>{
 const {db,store}=makeStore();t.after(()=>db.close());const first=briefFixture(),status=briefStatus(first,10,0);
 assert.equal(store.reportProducerStatus(status).response.outcome,'recorded');for(const table of ['resources','reference_occurrences','source_projections','brief_evidence_streams'])assert.equal((db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as {n:number}).n,0);
 const state=store.getProducerState({version:1,producerPluginId:'thread-brief',source:status.source});assert.equal(state.projection,null);assert.equal(state.status?.attemptRevision,10);
 assert.equal(store.applyProducer(first).response.outcome,'stale');
 // Plain V1 is deliberately compatible and is not subject to the new-family H.
 assert.equal(store.applyProjection({...first.projection,revision:11,expectedRevision:0}).outcome,'applied');
 const before=briefTables(db),duplicate=store.reportProducerStatus(status);assert.equal(duplicate.response.outcome,'duplicate');assert.equal(duplicate.response.state.projection?.revision,11);assert.equal(duplicate.response.state.status?.applicability,'superseded-by-graph');assert.deepEqual(briefTables(db),before);
 const changed=briefStatus(first,10,11);changed.status.limits=['target-count'];changed.statusDigest=briefStatusDigestForTest(changed);assert.equal(store.reportProducerStatus(changed).response.outcome,'stale');assert.deepEqual(briefTables(db),before);
});
import {briefStatusDigest as briefStatusDigestForValue,type ProducerReportStatusInput,type BriefEvidenceV1} from '@phosphorco/bb-cross-references';
function briefStatusDigestForTest(s:ProducerReportStatusInput){return briefStatusDigestForValue(s.producerPluginId,s.source,s.sourceFile,s.status);}
test('opposite arrival, conflicts and injected child failure preserve transaction and sequences',t=>{
 const {db,store}=makeStore();t.after(()=>db.close());const first=briefFixture();store.applyProducer(first);store.applyProducer(briefFixture(9,8));assert.equal(store.reportProducerStatus(briefStatus(first)).response.outcome,'cas-mismatch');
 const status=briefStatus(first,10,9);store.reportProducerStatus(status);const before=briefTables(db);
 const conflict=briefStatus(first,10,9);conflict.status.limits=['target-count'];conflict.statusDigest=briefStatusDigestForTest(conflict);assert.equal(store.reportProducerStatus(conflict).response.outcome,'conflict');assert.equal(store.reportProducerStatus(briefStatus(first,7,9)).response.outcome,'stale');assert.deepEqual(briefTables(db),before);
 db.exec("CREATE TEMP TRIGGER reject_brief_child BEFORE INSERT ON brief_evidence_occurrences BEGIN SELECT RAISE(ABORT,'injected child failure'); END");
 assert.throws(()=>store.applyProducer(briefFixture(11,9)),/injected child/);assert.deepEqual(briefTables(db),before);db.exec('DROP TRIGGER reject_brief_child');
 assert.equal(store.applyProducer(briefFixture(11,9)).response.outcome,'applied');
});
test('Brief metadata withheld preserves graph/count/location, safe injection rejects atomically, empty and absent are authoritative',t=>{
 const {db,store}=makeStore();t.after(()=>db.close());const input=briefFixture();const secret='https://example.test/?token=not-for-storage';
 input.evidence.occurrences[0]!.locator.section.heading={state:'withheld',digest:briefWithheldDigest('heading',secret),cause:'policy',display:'Heading withheld'};refreshBrief(input);store.applyProducer(input);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM reference_occurrences').get() as {n:number}).n,1);assert.equal(JSON.stringify(briefTables(db)).includes('not-for-storage'),false);
 const before=briefTables(db),bad=briefFixture(9,8,{heading:{state:'named',text:secret}});assert.throws(()=>store.applyProducer(bad));assert.deepEqual(briefTables(db),before);
 const empty=briefEmptyFixture(9,8);store.applyProducer(empty);assert.equal((db.prepare('SELECT COUNT(*) n FROM brief_evidence_occurrences').get() as {n:number}).n,0);
 const absent=briefFixture(10,9);absent.evidence.sourceState='absent';absent.evidence.sourceContentRevision=null;absent.evidence.frame=null;absent.evidence.occurrences=[];absent.evidence.targetDescriptors=[];absent.projection.tombstone=true;refreshBrief(absent);assert.equal(store.applyProducer(absent).response.state.evidence?.sourceState,'absent');
});
test('Brief durable binding/status reopen, ordinary V1 unconfirms without deleting primary evidence',t=>{
 const dir=mkdtempSync(join(tmpdir(),'bb-brief-reopen-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'evidence.db');let db=new Database(file);enableForeignKeys(db);for(const m of crossReferencesMigrations)db.exec(m);let store=new CrossReferenceStore(db);const first=briefFixture();store.applyProducer(first);store.reportProducerStatus(briefStatus(first));db.close();
 db=new Database(file);enableForeignKeys(db);store=new CrossReferenceStore(db);t.after(()=>db.close());const key={version:1 as const,producerPluginId:'thread-brief' as const,source:{provider:first.projection.source.provider,keys:first.projection.source.keys}};
 assert.equal(store.getProducerState(key).revisionHighWater,10);assert.equal(store.getProducerState(key).evidence?.state,'bound');store.applyProjection({...first.projection,revision:11,expectedRevision:8});const current=store.getProducerState(key);assert.equal(current.evidence?.state,'unconfirmed');assert.equal(current.status?.applicability,'superseded-by-graph');assert.equal(current.evidence?.occurrenceCount,1);
});

test('complete512-location snapshot uses bounded primary rows across edges;513 rejects whole state',t=>{
 const {db,store}=makeStore();t.after(()=>db.close());const input=briefFixture(8,0,{count:100});
 const template=input.evidence.occurrences[0]!;input.evidence.occurrences=[];input.evidence.targetDescriptors=[];
 for(let group=0;group<6;group++){const href=`https://example.test/group${group}`,target={provider:'url',keys:{href}};input.evidence.targetDescriptors.push({target,presentation:{label:{state:'safe',text:`Group ${group}`},detail:null,url:{state:'exact',href}},codec:{state:'available',value:{kind:'url',href}}});
  for(let j=0;j<100&&input.evidence.occurrences.length<512;j++){const n=input.evidence.occurrences.length;input.evidence.occurrences.push({...template,sourceOccurrenceId:`ref-${n}`,target,authoredUrl:{state:'exact',href}});}}
 refreshBrief(input);assert.equal(store.applyProducer(input).response.state.evidence?.occurrenceCount,512);assert.equal((db.prepare('SELECT COUNT(*) n FROM brief_evidence_occurrences').get() as {n:number}).n,512);assert.equal((db.prepare('SELECT COUNT(*) n FROM reference_occurrences').get() as {n:number}).n,6);
 const before=briefTables(db);input.projection.revision=9;input.projection.expectedRevision=8;input.evidence.occurrences.push({...template,sourceOccurrenceId:'ref-512'});assert.throws(()=>store.applyProducer(input));assert.deepEqual(briefTables(db),before);
});

test('Brief primary/status SQL rejects NULL/fractional revisions; another producer cannot clear blocked intent',t=>{
 const {db,store}=makeStore();t.after(()=>db.close());const first=briefFixture();store.applyProducer(first);store.reportProducerStatus(briefStatus(first));const before=briefTables(db);
 for(const table of ['brief_evidence_streams','brief_producer_status']){const column=table==='brief_evidence_streams'?'graph_revision':'attempt_revision';assert.throws(()=>db.prepare(`UPDATE ${table} SET ${column}=NULL`).run());assert.throws(()=>db.prepare(`UPDATE ${table} SET ${column}=1.5`).run());}assert.deepEqual(briefTables(db),before);
 const other=makeCommand({source:first.projection.source,producerPluginId:'another-producer',targets:[],revision:12,tombstone:true});store.applyProjection(other);const state=store.getProducerState({version:1,producerPluginId:'thread-brief',source:{provider:first.projection.source.provider,keys:first.projection.source.keys}});assert.equal(state.projection?.revision,8);assert.equal(state.status?.attemptRevision,10);assert.equal(state.evidence?.state,'bound');
});

test('Brief heading exact Unicode/U+FFFD roundtrips; malformed, oversized and incomplete replacements reject atomically',t=>{
 const {db,store}=makeStore();t.after(()=>db.close());const title='😀 e\u0301 界 \uFFFD',input=briefFixture(8,0,{heading:{state:'named',text:title}});store.applyProducer(input);assert.ok((db.prepare('SELECT locator_json FROM brief_evidence_occurrences').get() as {locator_json:string}).locator_json.includes(title));const before=briefTables(db);
 for(const text of ['\udfff','界'.repeat(86)]){const bad=briefFixture(9,8);Object.assign(bad.evidence.occurrences[0]!.locator.section,{heading:{state:'named',text}});assert.throws(()=>store.applyProducer(bad));assert.deepEqual(briefTables(db),before);}
 const partial=briefFixture(9,8);Object.assign(partial.evidence.completeness,{state:'partial'});assert.throws(()=>store.applyProducer(partial));assert.deepEqual(briefTables(db),before);
});


import {readBriefSnapshot} from '../brief-evidence.ts';
test('contradictory EMPTY replacement rejects ALL durable tables atomically; persisted EMPTY corruption rejects',t=>{
 const {db,store}=makeStore();t.after(()=>db.close());store.applyProducer(briefFixture());store.reportProducerStatus(briefStatus(briefFixture()));
 const snapshot=()=>Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all() as string[]).map(name=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()]));
 const before=snapshot();
 for(const edit of [(e:BriefEvidenceV1)=>{e.frame!.rawBytes=10;e.frame!.fileUtf16Length=10;e.frame!.bodyBase.utf16Length=10;},(e:BriefEvidenceV1)=>{e.sourceContentRevision=sha256Hex('not empty');}]){
  const bad=briefEmptyFixture(11,8);edit(bad.evidence);refreshBrief(bad);assert.throws(()=>store.applyProducer(bad));assert.deepEqual(snapshot(),before);
 }
 assert.equal(store.applyProducer(briefEmptyFixture(11,8)).response.state.evidence?.sourceState,'empty');
 const bom=briefEmptyFixture(12,11,true);assert.equal(store.applyProducer(bom).response.state.evidence?.sourceState,'empty');
 const row=db.prepare('SELECT source_resource_id FROM brief_evidence_streams').get() as {source_resource_id:number};assert.equal(readBriefSnapshot(db,'thread-brief',row.source_resource_id)?.evidence.sourceContentRevision,sha256Hex('\uFEFF'));
 // Retained JSON/digest agree with each other but contradict literal EMPTY.
 const corrupt=structuredClone(bom.evidence);corrupt.frame!.rawBytes=10;corrupt.frame!.bomBytes=0;corrupt.frame!.fileUtf16Length=10;corrupt.frame!.bodyBase.utf16Length=10;
 db.prepare('UPDATE brief_evidence_streams SET frame_json=?,evidence_digest=?').run(JSON.stringify(corrupt.frame),briefEvidenceDigest(corrupt));
 assert.throws(()=>readBriefSnapshot(db,'thread-brief',row.source_resource_id));
});
