import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../../state/store.ts";
import { createMessageRules } from "../../ui-suite-server.ts";
import { snapshotSchema } from "../../suite-rpc-contract.ts";
import { GLOBAL_CATALOG as G } from "../../contracts/catalog.ts";
import { defaultConnection, newGroup, newRule, fileLocation } from "../../contracts/model.ts";
import { sha256 } from "../../contracts/hash.ts";
import { waitUntil } from "../helpers.ts";
const fixture = (id: string, message = id) =>
  `---\nversion: 1\nid: ${id}\nexpect: allow\nrule_catalog: global\nexpected_rules: []\n---\n# Message\n${message}\n`;
async function host(seed = true) {
  const db = new Database(":memory:"),
    store = createStore(db),
    fake = createFakePluginHost({ pluginId: "message-rules" });
  fake.bb.storage.database = () => db;
  const values = new Map<string, string>(),
    writes: string[] = [];
  if (seed)
    for (const id of ["a", "b"]) {
      let p = store.configure(id, null, {
        hostId: "h",
        root: "/" + id,
        connection: defaultConnection,
      });
      p = store.saveGroup(id, p.revision, {
        ...newGroup("group-" + id),
        match: { kind: "all", children: [] },
      });
      const bytes = fixture(id);
      values.set("/" + id + "/same.md", bytes);
      store.discover(id, p.revision, [
        {
          occurrenceId: "occ-" + id,
          path: "same.md",
          logicalId: id,
          hash: sha256(bytes),
          source: bytes,
          enabled: true,
          missing: false,
          error: null,
        },
      ]);
    }
  fake.harness.inspection.sdk.stub("files.list", (async (i: any) => ({
    files: [...values.keys()]
      .filter((path) => path.slice(0, path.lastIndexOf("/")) === i.path)
      .map((path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1) })),
    truncated: false,
  })) as never);
  fake.harness.inspection.sdk.stub("files.read", (async (i: any) => {
    const content = values.get(i.path);
    if (content === undefined) throw Error("Missing " + i.path);
    return {
      path: i.path,
      content,
      contentEncoding: "utf8",
      sha256: sha256(content),
      sizeBytes: content.length,
    };
  }) as never);
  fake.harness.inspection.sdk.stub("files.write", (async (i: any) => {
    writes.push(i.path);
    values.set(i.path, i.content);
    return {
      outcome: "written",
      sha256: sha256(i.content),
      sizeBytes: i.content.length,
    };
  }) as never);
  let calls = 0;
  const product = createMessageRules(fake.bb, {
    transportFor: () => async () => {
      calls++;
      throw Error("No inference permitted");
    },
  });
  const rpc = async (method: string, i: object = {}) =>
    snapshotSchema.parse(
      await fake.harness.behavior.callRpc(method, { projectId: G, ...i }),
    );
  return {
    db,
    store: product.store,
    fake,
    product,
    values,
    writes,
    rpc,
    calls: () => calls,
    dispose: async () => {
      await fake.harness.lifecycle.dispose();
      db.close();
    },
  };
}

test("review: three distinct same.md sources survive repeated global discovery with separate identity, hash, ownership and toggles", async () => {
  const h = await host();
  try {
    let s = await h.rpc("snapshot");
    // This simulates an already configured third location without changing legacy sources.
    h.values.set("/global/same.md", fixture("global-file"));
    s = await h.rpc("configure", {
      revision: s.project!.revision,
      hostId: "h",
      root: "/global",
      connection: defaultConnection,
    });
    assert.equal(s.readError, null);
    assert.equal(
      s.project!.occurrences.length,
      3,
      "all three source files must remain members",
    );
    const captured = s.project!.occurrences.map((o) => ({
      id: o.occurrenceId,
      source: o.sourceProjectId,
      root: o.location!.root,
      hash: o.hash,
      group: o.groupId,
    }));
    assert.equal(new Set(captured.map((o) => o.id)).size, 3);
    assert.deepEqual(captured.map((o) => o.root).sort(), [
      "/a",
      "/b",
      "/global",
    ]);
    assert.equal(new Set(captured.map((o) => o.hash)).size, 3);
    s = await h.rpc("snapshot");
    assert.deepEqual(
      s.project!.occurrences.map((o) => ({
        id: o.occurrenceId,
        source: o.sourceProjectId,
        root: o.location!.root,
        hash: o.hash,
        group: o.groupId,
      })),
      captured,
    );
    const global = s.project!.occurrences.find((o) => o.sourceProjectId === G)!;
    s = await h.rpc("toggleTest", {
      revision: s.project!.revision,
      occurrenceId: global.occurrenceId,
      enabled: false,
    });
    assert.equal(s.project!.occurrences.filter((o) => o.enabled).length, 2);
    assert.ok(
      s
        .project!.occurrences.filter((o) => o.sourceProjectId !== G)
        .every((o) => o.enabled),
    );
    const a = s.project!.occurrences.find((o) => o.sourceProjectId === "a")!;
    s = await h.rpc("toggleTest", {
      revision: s.project!.revision,
      occurrenceId: a.occurrenceId,
      enabled: false,
    });
    s = await h.rpc("snapshot");
    assert.equal(s.project!.occurrences.filter((o) => o.enabled).length, 1);
    assert.ok(
      s.project!.occurrences.find((o) => o.sourceProjectId === "b")!.enabled,
    );
    assert.equal(
      s.project!.occurrences.find((o) => o.sourceProjectId === G)!.enabled,
      false,
    );
    assert.equal(h.writes.length, 0);
  } finally {
    await h.dispose();
  }
});

test("review: lost acknowledgement A after completed B and unavailable discovery acknowledges exact A while keeping B latest", async () => {
  const h = await host(false);
  try {
    let s = await h.rpc("snapshot");
    s = await h.rpc("saveGroup", {
      revision: s.project!.revision,
      group: { ...newGroup("group"), match: { kind: "all", children: [] } },
    });
    h.values.set("/global/one.md", fixture("one"));
    s = await h.rpc("configure", {
      revision: s.project!.revision,
      hostId: "h",
      root: "/global",
      connection: defaultConnection,
    });
    s = await h.rpc("startSuite", {
      requestId: "a",
      basis: s.basis,
      hasRelevantDrafts: false,
    });
    const a = s.run!;
    await waitUntil(() => !!h.store.run(a.id)?.quiescent);
    s = await h.rpc("snapshot", { discoverFiles: false });
    s = await h.rpc("startSuite", {
      requestId: "b",
      basis: s.basis,
      hasRelevantDrafts: false,
    });
    const b = s.run!;
    await waitUntil(() => !!h.store.run(b.id)?.quiescent);
    h.fake.harness.inspection.sdk.stub("files.list", (() => {
      throw Error("offline after lost ack");
    }) as never);
    const retry = await h.rpc("startSuite", {
      requestId: "a",
      basis: a.frozen.basis,
      hasRelevantDrafts: false,
    });
    assert.equal(
      (retry as any).acknowledgedRun?.id,
      a.id,
      "requested A needs its own acknowledgement",
    );
    const read = await h.rpc("snapshot", {
      requestId: "a",
      discoverFiles: false,
    });
    assert.equal(read.acknowledgedRun!.id, a.id);
    const { confirmsWrite } = await import("../../ui/writes.ts");
    assert.ok(
      confirmsWrite(
        {
          projectId: G,
          method: "startSuite",
          input: { requestId: "a", basis: a.frozen.basis },
        },
        read,
      ),
    );
    assert.equal(retry.run!.id, b.id, "latest presentation remains B");
    const cancelled = await h.rpc("cancelSuite", { runId: a.id });
    assert.equal(cancelled.acknowledgedRun!.id, a.id);
    assert.equal(cancelled.run!.id, b.id);
    const cancellationRead = await h.rpc("snapshot", { runId: a.id, discoverFiles: false });
    assert.ok(confirmsWrite({ projectId: G, method: "cancelSuite", input: { runId: a.id } }, cancellationRead));
    assert.ok(!confirmsWrite({ projectId: G, method: "cancelSuite", input: { runId: "other" } }, cancellationRead));
    assert.equal(h.calls(), 0);
    assert.equal(
      (h.db.prepare("SELECT count(*) n FROM mr_runs").get() as any).n,
      2,
    );
  } finally {
    await h.dispose();
  }
});

test("creating a global namesake in an empty group returns its exact identity and preserves imported owners", async () => {
  const h = await host();
  try {
    let s = await h.rpc("snapshot");
    const imports = structuredClone(s.project!.occurrences);
    s = await h.rpc("configure", { revision: s.project!.revision, hostId: "h", root: "/global", connection: defaultConnection });
    s = await h.rpc("saveGroup", { revision: s.project!.revision, group: newGroup("new-empty") });
    s = await h.rpc("saveFile", { groupId: "new-empty", path: "same.md", source: fixture("new-local"), hash: null, location: fileLocation(s.project!.config) });
    const saved = s.project!.occurrences.find(o => o.occurrenceId === s.savedOccurrenceId)!;
    assert.ok(saved);
    assert.equal(saved.groupId, "new-empty");
    assert.equal(saved.path, "same.md");
    assert.equal(saved.location!.root, "/global");
    assert.equal(saved.source, fixture("new-local"));
    for (const imported of imports) assert.deepEqual(s.project!.occurrences.find(o => o.occurrenceId === imported.occurrenceId), imported);
    assert.deepEqual(h.writes, ["/global/same.md"]);
    const reread = await h.rpc("snapshot");
    assert.equal(reread.project!.occurrences.find(o => o.occurrenceId === saved.occurrenceId)!.groupId, "new-empty");
  } finally { await h.dispose(); }
});

test("review: enabled tests owned by a disabled group still evaluate another applicable group, with bytes/context/location preserved", async () => {
  const h = await host();
  try {
    let s = await h.rpc("snapshot");
    s = await h.rpc("saveGroup", {
      revision: s.project!.revision,
      group: {
        ...newGroup("global-checks"),
        enabled: true,
        match: { kind: "all", children: [] },
      },
    });
    s = await h.rpc("saveRule", {
      revision: s.project!.revision,
      rule: {
        ...newRule("cross-group", "global-checks"),
        enabled: true,
        action: "reject",
        advice: "Cross group advice",
        match: { kind: "all", children: [] },
      },
    });
    const before = s.project!.occurrences[0]!;
    s = await h.rpc("assignTest", {
      revision: s.project!.revision,
      occurrenceId: before.occurrenceId,
      groupId: "group-b",
    });
    const moved = s.project!.occurrences.find(
      (o) => o.occurrenceId === before.occurrenceId,
    )!;
    assert.equal(moved.groupId, "group-b");
    assert.ok(moved.enabled);
    for (const k of [
      "source",
      "hash",
      "path",
      "projectId",
      "sourceProjectId",
      "sourceOccurrenceId",
      "location",
    ] as const)
      assert.deepEqual(moved[k], before[k]);
    assert.equal(
      s.project!.groups.find((g) => g.id === "group-b")!.enabled,
      false,
    );
    s = await h.rpc("startSuite", {
      requestId: "cross-disabled-owner",
      basis: s.basis,
      hasRelevantDrafts: false,
    });
    await waitUntil(() => !!h.store.run(s.run!.id)?.quiescent);
    const run = h.store.run(s.run!.id)!;
    assert.equal(run.frozen.denominator, 2);
    assert.ok(
      run.results.every(
        (r) =>
          r.evaluation!.rules.find((r) => r.id === "cross-group")!.status ===
          "reject",
      ),
    );
    assert.ok(
      run.results.every(
        (r) =>
          r.evaluation!.groups!.find((g) => g.id === "group-b")!.status ===
          "disabled",
      ),
    );
    assert.equal(h.calls(), 0);
  } finally {
    await h.dispose();
  }
});

test("review: deleting an empty legacy default before later discovery keeps new enabled files in a visible disabled import group", async () => {
  const db = new Database(":memory:"),
    store = createStore(db);
  let p = store.configure("empty", null, {
    hostId: "h",
    root: "/empty",
    connection: defaultConnection,
  });
  store.saveGroup("empty", p.revision, newGroup("empty-default"));
  const { createGlobalCatalog } = await import("../../state/global.ts");
  const catalog = createGlobalCatalog(store);
  p = store.get(G)!;
  store.removeGroup(G, p.revision, "empty-default");
  const bytes = fixture("later");
  const original = store.get("empty")!;
  store.discover("empty", original.revision, [
    {
      occurrenceId: "later",
      path: "same.md",
      logicalId: "later",
      hash: sha256(bytes),
      source: bytes,
      enabled: true,
      missing: false,
      error: null,
    },
  ]);
  const global = catalog.sync();
  const owner = global.occurrences[0]!.groupId;
  assert.ok(global.groups.some((g) => g.id === owner && !g.enabled));
  assert.match(global.occurrences[0]!.ownership!, /default group was removed/);
  assert.equal(global.occurrences[0]!.source, bytes);
  db.close();
});

test("review: imported global save reconciles lost host acknowledgement only at the original identity and location", async () => {
  const h = await host();
  try {
    const s = await h.rpc("snapshot"),
      o = s.project!.occurrences[0]!,
      next = fixture("a", "Saved with a lost host ack");
    let writes = 0;
    h.fake.harness.inspection.sdk.stub("files.write", (async (i: any) => {
      writes++;
      h.values.set(i.path, i.content);
      throw Error("Lost host acknowledgement after commit");
    }) as never);
    const input = {
      occurrenceId: o.occurrenceId,
      path: o.path,
      source: next,
      hash: o.hash,
      location: o.location,
    };
    const saved = await h.rpc("saveFile", input);
    const { confirmsWrite } = await import("../../ui/writes.ts");
    assert.ok(
      confirmsWrite({ projectId: G, method: "saveFile", input }, saved),
    );
    assert.equal(
      saved.project!.occurrences.find((x) => x.occurrenceId === o.occurrenceId)!
        .location!.root,
      "/a",
    );
    assert.equal(writes, 1);
    await h.rpc("snapshot");
    assert.equal(writes, 1);
    assert.equal(h.values.get("/b/same.md"), fixture("b"));
  } finally {
    await h.dispose();
  }
});

test("review: queued imported saves recheck A→B→A location epoch and retain the rejected draft without a second write", async () => {
  const h = await host();
  try {
    const s = await h.rpc("snapshot"),
      o = s.project!.occurrences[0]!;
    let release!: () => void,
      calls = 0;
    const blocked = new Promise<void>((r) => (release = r));
    h.fake.harness.inspection.sdk.stub("files.write", (async (i: any) => {
      calls++;
      h.writes.push(i.path);
      await blocked;
      h.values.set(i.path, i.content);
      return {
        outcome: "written",
        sha256: sha256(i.content),
        sizeBytes: i.content.length,
      };
    }) as never);
    const input = {
      occurrenceId: o.occurrenceId,
      path: o.path,
      source: fixture("a", "A"),
      hash: o.hash,
      location: o.location,
    };
    const first = h.rpc("saveFile", input);
    await waitUntil(() => calls === 1);
    const secondInput = { ...input, source: fixture("a", "queued B") };
    const second = h.rpc("saveFile", secondInput);
    const rejected = assert.rejects(second, /location changed/);
    await new Promise((r) => setImmediate(r));
    let a = h.store.get("a")!;
    a = h.store.toggle("a", a.revision, a.occurrences[0]!.occurrenceId, false);
    a = h.store.configure("a", a.revision, { ...a.config, root: "/changed" });
    h.store.configure("a", a.revision, { ...a.config, root: "/a" });
    release();
    await first;
    await rejected;
    assert.equal(calls, 1);
    assert.deepEqual(h.writes, ["/a/same.md"]);
    assert.equal(secondInput.source, fixture("a", "queued B"));
    assert.equal(h.values.get("/a/same.md"), fixture("a", "A"));
    const after = await h.rpc("snapshot");
    const { confirmsWrite } = await import("../../ui/writes.ts");
    assert.equal(
      confirmsWrite(
        { projectId: G, method: "saveFile", input: secondInput },
        after,
      ),
      false,
    );
    assert.equal(h.values.get("/b/same.md"), fixture("b"));
  } finally {
    await h.dispose();
  }
});
