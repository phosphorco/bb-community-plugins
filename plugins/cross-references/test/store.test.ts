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
  type ListForwardReferencesInput,
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
