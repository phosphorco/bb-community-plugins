import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import Database from "better-sqlite3";

import {
  canonicalizeResource,
  projectionPayloadDigest,
  type Resource,
} from "../canonical.ts";
import {
  type ApplyProjectionInput,
  type ListBacklinksInput,
} from "../model.ts";
import {
  CrossReferenceStore,
  crossReferencesMigrations,
  enableForeignKeys,
} from "../store.ts";

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

test("returns exact bounded backlinks with source context, producer occurrences, and stable cursors", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  const target = makeThread("Shared target");
  for (const producerPluginId of ["producer-one", "producer-two", "producer-three"]) {
    assert.equal(store.applyProjection(makeCommand({
      producerPluginId,
      source: makeResource("shared-source", "Shared source"),
      targets: [target],
      revision: 1,
    })).outcome, "applied");
  }

  const targetIdentity = { provider: target.provider, keys: target.keys };
  const firstInput: ListBacklinksInput = { target: targetIdentity, pageSize: 1 };
  const first = store.listBacklinks(firstInput);
  assert.equal(first.rows.length, 1);
  assert.notEqual(first.nextCursor, null);
  const second = store.listBacklinks({ target: targetIdentity, pageSize: 1, cursor: first.nextCursor! });
  const third = store.listBacklinks({ target: targetIdentity, pageSize: 1, cursor: second.nextCursor! });
  assert.equal(second.rows.length, 1);
  assert.equal(third.rows.length, 1);
  assert.equal(third.nextCursor, null);
  assert.deepEqual(
    [first.rows[0], second.rows[0], third.rows[0]].map((row) => ({
      source: row?.source.presentation.label,
      producer: row?.producerPluginId,
      position: row?.position,
      target: row?.targetPresentation.label,
    })),
    [
      { source: "Shared source", producer: "producer-one", position: 0, target: "Shared target" },
      { source: "Shared source", producer: "producer-two", position: 0, target: "Shared target" },
      { source: "Shared source", producer: "producer-three", position: 0, target: "Shared target" },
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
  assert.deepEqual(store.listBacklinks({ target: { provider: "bb", keys: { project: "proj_12345678", thread: "thr_absent01" } }, pageSize: 100 }), { rows: [], nextCursor: null });

  const plan = db.prepare(
    `EXPLAIN QUERY PLAN
       SELECT id FROM reference_occurrences
        WHERE target_resource_id = ? AND id > ? AND id <= ?
        ORDER BY id ASC LIMIT ?`,
  ).all(1, 0, 100, 2) as Array<{ detail: string }>;
  assert.ok(plan.some((entry) => entry.detail.includes("reference_occurrences_target_idx")), JSON.stringify(plan));
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
