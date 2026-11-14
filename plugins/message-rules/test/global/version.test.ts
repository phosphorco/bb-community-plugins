import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, type FrozenSuite } from "../../state/store.ts";
import { createGlobalCatalog } from "../../state/global.ts";
import { createMessageRules } from "../../ui-suite-server.ts";
import { savedBasis } from "../../suites/runner.ts";
import { snapshotSchema } from "../../suite-rpc-contract.ts";
import { GLOBAL_CATALOG as G } from "../../contracts/catalog.ts";
import { VERSION, newGroup, type Evaluation } from "../../contracts/model.ts";
import { fingerprint, canonical, sha256 } from "../../contracts/hash.ts";
import { parseFixture } from "../../contracts/fixture.ts";
import { evaluate, prepare } from "../../evaluation/evaluator.ts";
import { groupSummary } from "../../ui/summary.ts";
import { jevRule, answer, count } from "../helpers.ts";

for (const type of ["choice", "score"] as const)
  test(`historical v1.4 ${type} pass keeps immutable contradictory observations but is stale under current validation without replay`, async () => {
    const db = new Database(":memory:"), store = createStore(db);
    const catalog = createGlobalCatalog(store);
    let p = store.get(G)!;
    p = store.saveGroup(G, p.revision, { ...newGroup("all"), enabled: true, match: { kind: "all", children: [] } });
    const rule = { ...jevRule("check"), groupId: "all", match: { kind: "all" as const, children: [] } };
    if (type === "score") rule.criteria = [{ ...rule.criteria[0]!, type: "score", criteria: ["low", "high"], comparison: "gte", rejectAt: 1 }];
    p = store.saveRule(G, p.revision, rule);
    const source = '---\nversion: 1\nid: historical\nexpect: allow\nexpected_rules: []\n---\n# Message\nHistorical input\n';
    p = store.discover(G, p.revision, [{ occurrenceId: "fixture", path: "historical.md", logicalId: "historical", groupId: "all", projectId: null, hash: sha256(source), source, enabled: true, missing: false, error: null }]);
    catalog.sync();
    p = store.get(G)!;
    const capture = { ...parseFixture(source).capture, projectId: null };
    const plan = prepare(capture, p.rules, p.config.connection, count);
    const partition = plan.partitions[0]!;
    const response: any = answer(partition.wire);
    const observation: any = Object.values(response.answers)[0];
    if (type === "choice") observation.choice = "no";
    else observation.score = 0;
    // Historical fixture: v1.4 trusted the metric independently of its
    // distribution. These captured rows never involve a real provider call.
    const legacyBasis = fingerprint({ version: "message-rules-v1.4", config: p.config, rules: p.rules, groups: p.groups, occurrences: p.occurrences });
    const legacyInputHash = fingerprint({ version: "message-rules-v1.4", c: capture, rules: p.rules, config: p.config.connection });
    const legacyWire = { ...partition.wire, state: { ...(partition.wire.state as object), version: "message-rules-v1.4" } };
    const frozen: FrozenSuite = { version: "message-rules-v1.4", projectId: G, config: p.config, groups: p.groups, rules: p.rules, occurrences: p.occurrences, basis: legacyBasis, denominator: 1, actor: { historical: true } };
    const old = store.start("historical-request", frozen, "historical-owner");
    const evaluation: Evaluation = { version: "message-rules-v1.4", inputHash: legacyInputHash, policy: "allow", rules: [{ id: rule.id, title: rule.title, revision: p.rules[0]!.revision, status: "allow", observations: { progress: observation } }], advice: [], errors: [] };
    assert.ok(store.append(old.id, old.owner, { occurrenceId: "fixture", path: "historical.md", status: "pass", reason: "Historical v1.4 metric permitted allowance.", evaluation }));
    db.prepare("INSERT INTO mr_attempts(id,run_id,owner,request_hash,request,state,observation,context) VALUES(?,?,?,?,?,?,?,?)")
      .run("historical-attempt", old.id, old.owner, fingerprint(legacyWire), canonical(legacyWire), "observed", canonical(response), canonical({ occurrenceId: "fixture", savedBasis: legacyBasis, inputHash: legacyInputHash }));
    store.finish(old.id, old.owner, "complete"); store.quiesce(old.id, old.owner);
    const rows = () => ["mr_projects", "mr_runs", "mr_attempts"].map(t => db.prepare("SELECT * FROM " + t).all());
    const before = structuredClone(rows());
    const fake = createFakePluginHost({ pluginId: "message-rules" });
    fake.bb.storage.database = () => db;
    let replayCalls = 0;
    createMessageRules(fake.bb, { transportFor: () => async () => { replayCalls++; throw Error("Historical attempts must never replay"); } });
    try {
      const read = async (method: string, input: object) => snapshotSchema.parse(await fake.harness.behavior.callRpc(method, { projectId: G, ...input }));
      const snapshot = await read("snapshot", { discoverFiles: false });
      assert.deepEqual(snapshot.project, p, "catalog/fixture inputs are identical");
      assert.notEqual(snapshot.basis, legacyBasis, "validator semantics must invalidate the old captured basis");
      assert.equal(snapshot.basis, savedBasis(p));
      assert.equal(snapshot.run!.results[0]!.status, "pass", "preserve historical verdict");
      assert.equal(snapshot.run!.frozen.version, "message-rules-v1.4");
      const summary = groupSummary(p.occurrences, snapshot.run!.frozen.occurrences, new Map(snapshot.run!.results.map(r => [r.occurrenceId, r])), snapshot.run!.frozen.basis !== snapshot.basis, 0);
      assert.match(summary, /Stale/); assert.match(summary, /1 \/ 1 passed/);
      const ack = await read("startSuite", { requestId: old.requestId, basis: legacyBasis, hasRelevantDrafts: false });
      assert.equal(ack.acknowledgedRun!.id, old.id);
      assert.notEqual(ack.acknowledgedRun!.frozen.basis, ack.basis);
      await assert.rejects(() => read("startSuite", {
        requestId: "new-request-with-old-basis", basis: legacyBasis, hasRelevantDrafts: false,
      }), /changed|conflict/i);
      const current = await evaluate(capture, p.rules, p.config.connection, async () => response, new AbortController().signal, count);
      assert.equal(current.version, VERSION);
      assert.equal(current.policy, "unknown"); assert.deepEqual(current.advice, []);
      assert.match(current.errors.join(" "), /Inconsistent/);
      assert.equal(replayCalls, 0);
      assert.deepEqual(rows(), before, "historical rows, observations and invocation record stay byte-identical");
      console.log(JSON.stringify({ type, historicalVersion: frozen.version, currentVersion: VERSION,
        historicalBasis: legacyBasis, currentBasis: snapshot.basis, summary,
        historicalVerdict: snapshot.run!.results[0]!.status, currentPolicy: current.policy,
        historicalRowsUnchanged: true, replayCalls }));
    } finally { await fake.harness.lifecycle.dispose(); db.close(); }
  });
