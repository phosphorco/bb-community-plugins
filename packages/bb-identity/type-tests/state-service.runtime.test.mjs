import assert from "node:assert/strict";
import test from "node:test";
import { Database } from "bun:sqlite";
import { createStateService, stateAddressKey, stateCodecs } from "../state-service-runtime.js";

const codec = { decode: (value) => typeof value === "string" ? { ok: true, value } : { ok: false, error: { code: "invalid-input", message: "string required", retry: "never" } }, encode: (value) => value };
const definition = { collection: "preferences", schemaVersion: 1, codec, initialValue: () => "light", equal: (left, right) => left === right };
const actor = { identity: { kind: "person", key: "person:alex", issuer: "fixture", subject: "alex" }, presentation: { displayName: "Alex", handle: null, avatarUrl: null }, evidence: "provider-verified" };
const target = { intent: "write", signal: new AbortController().signal, snapshot: () => ({ actor, subject: actor.identity, expected: { actor: actor.identity.key, session: "session-1" } }) };
const readTarget = { ...target, intent: "read" };
const error = (code, message) => ({ ok: false, error: { code, message, retry: "never" } });
const address = { instanceId: "instance-1", pluginId: "plugin-1", collection: "preferences", recordId: "appearance", owner: actor.identity.key };
const version = (sequence) => ({ epoch: "epoch-1", sequence });
const mutation = (operationId, value, expectedVersion = version(0), kind = "replace") => ({
  kind, address: { ...address }, expectedVersion: { ...expectedVersion }, expected: { actor: actor.identity.key, session: "session-1" },
  ownerSession: "owner-session-1", localGeneration: 1, operationId, schemaVersion: 1, value,
});

/** A feature-owned SQLite fixture: receipts and records share one real transaction. */
function sqliteStorage() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE records (address TEXT PRIMARY KEY, value TEXT NOT NULL, epoch TEXT NOT NULL, sequence INTEGER NOT NULL, schemaVersion INTEGER NOT NULL); CREATE TABLE receipts (operationId TEXT PRIMARY KEY, payload TEXT NOT NULL, outcome TEXT NOT NULL, address TEXT NOT NULL)");
  let pause = null;
  const readRow = (input) => db.query("SELECT * FROM records WHERE address = ?").get(stateAddressKey(input));
  const read = async (input) => {
    const row = readRow(input);
    return { ok: true, value: row ? { status: "present", envelope: { address: input, version: version(row.sequence), schemaVersion: row.schemaVersion, value: JSON.parse(row.value), lastEditedBy: actor } } : { status: "empty", address: input, version: version(0) } };
  };
  return {
    boundary: "same-process-synchronous", receiptRetentionMs: 60_000, read,
    pauseBeforeCommit() {
      let reachedResolve; let release;
      const reached = new Promise((resolve) => { reachedResolve = resolve; });
      const released = new Promise((resolve) => { release = resolve; });
      pause = { resolve: reachedResolve, release, released };
      return { reached, release, released };
    },
    async commit(input) {
      if (pause) { const gate = pause; pause = null; gate.resolve(); await gate.released; }
      const payload = JSON.stringify(input.mutation);
      db.exec("BEGIN IMMEDIATE");
      try {
        const duplicate = db.query("SELECT payload, outcome, address FROM receipts WHERE operationId = ?").get(input.mutation.operationId);
        if (duplicate) {
          if (duplicate.payload !== payload || duplicate.address !== stateAddressKey(input.mutation.address)) { db.exec("ROLLBACK"); return error("invalid-operation", "operation payload or address changed"); }
          db.exec("COMMIT"); return { ok: true, value: JSON.parse(duplicate.outcome) };
        }
        const live = input.validateAtCommit();
        if (!live.ok) { db.exec("ROLLBACK"); return live; }
        const current = readRow(input.mutation.address);
        const currentRead = current ? { status: "present", envelope: { address: input.mutation.address, version: version(current.sequence), schemaVersion: current.schemaVersion, value: JSON.parse(current.value), lastEditedBy: actor } } : { status: "empty", address: input.mutation.address, version: version(0) };
        if (input.mutation.kind === "initialize" && current) {
          const outcome = { status: "already-initialized", current: currentRead, operationId: input.mutation.operationId };
          db.query("INSERT INTO receipts VALUES (?, ?, ?, ?)").run(input.mutation.operationId, payload, JSON.stringify(outcome), stateAddressKey(input.mutation.address));
          db.exec("COMMIT"); return { ok: true, value: outcome };
        }
        if ((current && (current.sequence !== input.mutation.expectedVersion.sequence || current.epoch !== input.mutation.expectedVersion.epoch))
          || (!current && (input.mutation.expectedVersion.sequence !== 0 || input.mutation.expectedVersion.epoch !== "epoch-1"))) {
          const outcome = { status: "conflict", current: currentRead, operationId: input.mutation.operationId };
          db.query("INSERT INTO receipts VALUES (?, ?, ?, ?)").run(input.mutation.operationId, payload, JSON.stringify(outcome), stateAddressKey(input.mutation.address));
          db.exec("COMMIT"); return { ok: true, value: outcome };
        }
        if (current && current.value === JSON.stringify(input.mutation.value) && current.schemaVersion === input.mutation.schemaVersion) {
          const outcome = { status: "unchanged", envelope: currentRead.envelope, operationId: input.mutation.operationId };
          db.query("INSERT INTO receipts VALUES (?, ?, ?, ?)").run(input.mutation.operationId, payload, JSON.stringify(outcome), stateAddressKey(input.mutation.address));
          db.exec("COMMIT"); return { ok: true, value: outcome };
        }
        const next = (current?.sequence ?? 0) + 1;
        db.query("INSERT INTO records(address, value, epoch, sequence, schemaVersion) VALUES (?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET value=excluded.value, epoch=excluded.epoch, sequence=excluded.sequence, schemaVersion=excluded.schemaVersion")
          .run(stateAddressKey(input.mutation.address), JSON.stringify(input.mutation.value), "epoch-1", next, input.mutation.schemaVersion);
        const outcome = { status: "saved", envelope: { address: input.mutation.address, version: version(next), schemaVersion: input.mutation.schemaVersion, value: input.mutation.value, lastEditedBy: actor }, operationId: input.mutation.operationId };
        db.query("INSERT INTO receipts VALUES (?, ?, ?, ?)").run(input.mutation.operationId, payload, JSON.stringify(outcome), stateAddressKey(input.mutation.address));
        db.exec("COMMIT"); return { ok: true, value: outcome };
      } catch (caught) { try { db.exec("ROLLBACK"); } catch {} throw caught; }
    },
    async reconcile({ address: inputAddress, operationId }) {
      const receipt = db.query("SELECT outcome, address FROM receipts WHERE operationId = ?").get(operationId);
      return { ok: true, value: receipt && receipt.address === stateAddressKey(inputAddress)
        ? { status: "final", outcome: JSON.parse(receipt.outcome) }
        : { status: "absent-final", retry: "same-operation-only" } };
    },
    close: () => db.close(),
  };
}

function service(storage, options = {}) {
  let live = true;
  const published = [];
  const validations = [];
  const commits = { boundary: "same-process-synchronous", validate(currentTarget, scope) {
    validations.push(currentTarget.signal.aborted);
    const active = live && !currentTarget.signal.aborted;
    return active && scope.instanceId === "instance-1" && scope.pluginId === "plugin-1" && scope.collection === "preferences" && scope.schemaVersion === 1
      ? { ok: true, value: undefined } : error(active ? "stale-context" : "expired", "not live");
  } };
  return { published, validations, invalidate: () => { live = false; }, state: createStateService({ instanceId: "instance-1", pluginId: "plugin-1", definition: options.definition ?? definition, storage, commits, publish(event) { published.push(event); if (options.throwPublish) throw new Error("observer unavailable"); } }) };
}

test("state service enforces the resource envelope at SQLite commit time", async () => {
  const storage = sqliteStorage(); const fixture = service(storage);
  const mismatch = await fixture.state.save(target, { ...mutation("operation-bad", "dark"), address: { ...address, collection: "other" } });
  assert.equal(mismatch.ok, false);
  const gate = storage.pauseBeforeCommit();
  const delayedController = new AbortController();
  const delayedTarget = { ...target, signal: delayedController.signal };
  const saving = fixture.state.save(delayedTarget, mutation("operation-delayed", "dark"));
  await gate.reached; delayedController.abort(); gate.release();
  const aborted = await saving;
  assert.deepEqual(fixture.validations, [true]);
  assert.equal(aborted.ok, false); if (!aborted.ok) assert.equal(aborted.error.code, "expired");
  const staleEmpty = await fixture.state.save(target, mutation("operation-stale-empty", "light", { epoch: "old-epoch", sequence: 9 }));
  assert.equal(staleEmpty.ok, true); if (staleEmpty.ok) assert.equal(staleEmpty.value.status, "conflict");
  const submitted = mutation("operation-frozen", "dark");
  const frozenGate = storage.pauseBeforeCommit();
  const savingFrozen = fixture.state.save(target, submitted);
  await frozenGate.reached;
  submitted.address.owner = "person:mutated";
  submitted.value = "mutated";
  submitted.operationId = "operation-mutated";
  submitted.schemaVersion = 99;
  frozenGate.release();
  const saved = await savingFrozen;
  assert.equal(saved.ok, true); if (saved.ok) {
    assert.equal(saved.value.operationId, "operation-frozen");
    assert.equal(saved.value.status, "saved");
    if (saved.value.status === "saved") assert.equal(saved.value.envelope.value, "dark");
  }
  storage.close();
});

test("initialize winner, unchanged, durable duplicate and publication semantics stay distinct", async () => {
  const storage = sqliteStorage(); const fixture = service(storage, { throwPublish: true });
  const first = await fixture.state.save(target, mutation("operation-initialize", "dark", version(0), "initialize"));
  assert.equal(first.ok, true); if (!first.ok) return;
  assert.equal(first.value.status, "saved");
  const winner = await fixture.state.save(target, mutation("operation-initialize-2", "light", version(0), "initialize"));
  assert.equal(winner.ok, true); if (winner.ok) assert.equal(winner.value.status, "already-initialized");
  const unchanged = await fixture.state.save(target, mutation("operation-unchanged", "dark", version(1)));
  assert.equal(unchanged.ok, true); if (unchanged.ok) assert.equal(unchanged.value.status, "unchanged");
  const duplicate = await fixture.state.save(target, mutation("operation-initialize", "dark", version(0), "initialize"));
  assert.equal(duplicate.ok, true); if (duplicate.ok) assert.equal(duplicate.value.status, "saved");
  // Publication exceptions do not turn the durable saved receipt into indeterminate.
  assert.deepEqual(fixture.published.map(event => [event.operationId, event.version.sequence]), [["operation-initialize", 1], ["operation-initialize-2", 1], ["operation-initialize", 1]]);
  const wrongAddress = await fixture.state.reconcile(target, "another-record", "operation-initialize");
  assert.deepEqual(wrongAddress, { ok: true, value: { status: "absent-final", retry: "same-operation-only" } });
  storage.close();
});

test("state codecs reject malformed envelope metadata and preserve delimiter-safe addresses", () => {
  const codecs = stateCodecs(codec);
  assert.equal(codecs.read.decode({ status: "present", envelope: { address, version: version(1), schemaVersion: 1, value: "dark", lastEditedBy: actor } }).ok, true);
  assert.equal(codecs.read.decode({ status: "present", envelope: { address: { ...address, collection: "" }, version: version(1), schemaVersion: 1, value: "dark", lastEditedBy: actor } }).ok, false);
  assert.notEqual(stateAddressKey(address), stateAddressKey({ ...address, collection: "preferences|appearance", recordId: "" }));
});


test("state wire codec round-trips machine editor snapshots and rejects person relabeling", () => {
  const machine = {
    identity: { kind: "machine", key: "machine:instance-1", instanceId: "instance-1", hostId: null },
    presentation: { displayName: "BB machine", handle: null, avatarUrl: null },
    evidence: "machine",
  };
  const codecs = stateCodecs(codec);
  const encoded = codecs.read.decode({ status: "present", envelope: { address, version: version(1), schemaVersion: 1, value: "dark", lastEditedBy: machine } });
  assert.equal(encoded.ok, true);
  assert.equal(codecs.read.decode({ status: "present", envelope: { address, version: version(1), schemaVersion: 1, value: "dark", lastEditedBy: { ...machine, evidence: "provider-verified" } } }).ok, false);
});

test("typed service boundaries round-trip a distinct wire codec for save, read, winner and receipt", async () => {
  const wireCodec = {
    decode: value => value && typeof value === 'object' && typeof value.text === 'string'
      ? {ok:true,value:value.text} : error('invalid-input','wire object required'),
    encode: value => { if(typeof value !== 'string') throw Error('typed string required'); return {text:value}; },
  };
  const storage=sqliteStorage(); const fixture=service(storage,{definition:{...definition,codec:wireCodec}});
  try {
    const saved=await fixture.state.save(target,mutation('distinct-wire','dark',version(0),'initialize'));
    assert.equal(saved.ok,true); assert.equal(saved.value.envelope.value,'dark');
    const read=await fixture.state.read(readTarget,'appearance');
    assert.equal(read.ok,true); assert.equal(read.value.envelope.value,'dark');
    const winner=await fixture.state.save(target,mutation('other-initializer','light',version(0),'initialize'));
    assert.equal(winner.ok,true); assert.equal(winner.value.status,'already-initialized');
    assert.equal(winner.value.current.envelope.value,'dark');
    const receipt=await fixture.state.reconcile(readTarget,'appearance','distinct-wire');
    assert.equal(receipt.ok,true); assert.equal(receipt.value.status,'final');
    assert.equal(receipt.value.outcome.envelope.value,'dark');
    const replay=await fixture.state.save(target,mutation('distinct-wire','dark',version(0),'initialize'));
    assert.deepEqual(replay,saved);
    assert.equal(fixture.validations.length,2);
    const invalid=service({...storage,read:async a=>({ok:true,value:{status:'bogus',address:a,storedSchemaVersion:1}})},{definition:{...definition,codec:wireCodec}});
    assert.equal((await invalid.state.read(readTarget,'appearance')).ok,false);
  } finally { storage.close(); }
});
