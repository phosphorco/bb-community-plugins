import assert from "node:assert/strict";
import test from "node:test";
import { createIdentityServer } from "../server-runtime.js";
import { createAdapterHarness } from "../testing-runtime.js";

const codec = {
  decode: (value) => ({ ok: true, value }),
  encode: (value) => value,
};

const selfWrite = (request) => ({
  selection: { kind: "self" },
  policy: { kind: "self-only" },
  intent: "write",
  expected: request.expected,
  expectedSubject: request.actor.identity.key,
});

test("write targets require a concrete live commit scope and reject after request invalidation", async () => {
  const harness = createAdapterHarness({ mode: "multi-user", inputCodec: codec });
  const host = harness.connect();
  const server = createIdentityServer({ host });
  const context = harness.request();
  const opened = await server.personRequest(context);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const issued = await opened.value.target(selfWrite(opened.value));
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  const snapshot = issued.value.snapshot();
  const scope = {
    instanceId: server.instanceId,
    pluginId: host.pluginId,
    collection: "preferences",
    recordId: "theme",
    subject: snapshot.subject.key,
    expected: snapshot.expected,
    schemaVersion: 1,
  };

  assert.deepEqual(server.commits.validate(issued.value, scope), { ok: true, value: undefined });

  // Commit validation uses the captured snapshot and live signal. A structurally
  // equivalent target can cross an adapter boundary without a private issuance
  // registry, while its intent, address and request facts remain checked.
  const copied = { intent: issued.value.intent, snapshot: issued.value.snapshot, signal: issued.value.signal };
  assert.deepEqual(server.commits.validate(copied, scope), { ok: true, value: undefined });

  // The value returned from snapshot() is public inspection data. Whether it is
  // frozen or copied, mutation attempts must not rewrite the captured facts used
  // by commit validation.
  const exposed = issued.value.snapshot();
  Reflect.set(exposed.subject, "key", "fixture:mutated-subject");
  Reflect.set(exposed.expected, "actor", "fixture:mutated-actor");
  Reflect.set(exposed.expected, "session", "mutated-session");
  Reflect.set(exposed.actor.identity, "key", "fixture:mutated-actor");
  assert.deepEqual(server.commits.validate(issued.value, scope), { ok: true, value: undefined });

  for (const invalid of [
    { ...scope, expected: { ...scope.expected, actor: "fixture:other-actor" } },
    { ...scope, expected: { ...scope.expected, session: "other-session" } },
    { ...scope, subject: "fixture:other-subject" },
    { ...scope, collection: "", recordId: "" },
  ]) {
    const rejected = server.commits.validate(issued.value, invalid);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "stale-context");
  }

  harness.abort(context);
  const expired = server.commits.validate(issued.value, scope);
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.error.code, "expired");
});

test("read targets are never commit authorities", async () => {
  const harness = createAdapterHarness({ mode: "multi-user", inputCodec: codec });
  const host = harness.connect();
  const server = createIdentityServer({ host });
  const opened = await server.personRequest(harness.request());
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const read = await opened.value.target({
    selection: { kind: "self" }, policy: { kind: "self-only" }, intent: "read",
  });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  const snapshot = read.value.snapshot();
  const result = server.commits.validate(read.value, {
    instanceId: server.instanceId,
    pluginId: host.pluginId,
    collection: "preferences",
    recordId: "theme",
    subject: snapshot.subject.key,
    expected: snapshot.expected,
    schemaVersion: 1,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid-input");
});
