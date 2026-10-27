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
  const prefix = crossReferencesMigrations.slice(0, -1);assert.equal(prefix.length, 12);
  for (const migration of prefix) db.exec(migration);
  db.prepare("INSERT INTO assistant_link_jobs(thread_id,project_id,version,deleted,retry_at,attempts) VALUES (?,?,?,?,?,?)")
    .run("thr_viewed", "proj_a", 7, 0, -1, 0);
  db.prepare("INSERT INTO assistant_link_jobs(thread_id,project_id,version,deleted,retry_at,attempts) VALUES (?,?,?,?,?,?)")
    .run("thr_failed", "proj_a", 9, 1, 900_000, 3);
  const before = db.prepare("SELECT * FROM assistant_link_jobs ORDER BY thread_id").all() as any[];
  db.exec(crossReferencesMigrations.at(-1)!);
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
