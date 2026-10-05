import assert from "node:assert/strict";
import test from "node:test";
import { createStateTransport } from "../state-transport-runtime.js";

const codec = { decode: (value) => typeof value === "string" ? { ok: true, value } : { ok: false, error: { code: "invalid-input", message: "string", retry: "never" } }, encode: (value) => value };
const address = { instanceId: "instance-1", pluginId: "plugin-1", collection: "preferences", recordId: "theme", owner: "person:a" };
const expected = { actor: "person:a", session: "session-a" };
const mutation = { kind: "replace", address, expectedVersion: { epoch: "epoch", sequence: 1 }, expected, ownerSession: "owner-a", localGeneration: 1, operationId: "op-1", schemaVersion: 1, value: "dark" };
const failure = (code) => ({ ok: false, error: { code, message: code, retry: "never" } });

function connection() {
  let health = { generation: 1, identity: { status: "healthy" }, state: { status: "healthy" } };
  const listeners = new Set(); const calls = []; let revalidations = 0; let nextError = null; let onRevalidate = null;
  return {
    calls, listeners, get revalidations() { return revalidations; }, setState(next) { health = { ...health, state: next }; }, setIdentity(next) { health = { ...health, identity: next }; }, setError(value) { nextError = value; }, onRevalidate(callback) { onRevalidate = callback; },
    getHealth: () => health, subscribeHealth: () => () => {},
    request: async (method, input) => { calls.push({ method, input });
      if (method.endsWith("/load")) return { ok: true, value: { status: "empty", address, version: { epoch: "epoch", sequence: 0 } } };
      if (method.endsWith("/save")) return nextError ? { ok: false, error: nextError } : { ok: true, value: { status: "saved", envelope: { address, version: { epoch: "epoch", sequence: 2 }, schemaVersion: 1, value: "dark", lastEditedBy: null }, operationId: "op-1" } };
      return { ok: true, value: { status: "pending" } };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    revalidate: async () => { revalidations++; onRevalidate?.(); return { ok: true, value: undefined }; }, dispose() {},
  };
}

test("state transport uses only documented routes, borrows health, and revalidates writes", async () => {
  const raw = connection(); const transport = createStateTransport({ connection: raw, resource: { pluginId: "plugin-1", definition: { collection: "preferences", schemaVersion: 1, codec, initialValue: () => "light", equal: (a, b) => a === b } } });
  const loaded = await transport.load({ address, expected }); assert.equal(loaded.ok, true);
  const saved = await transport.save(mutation); assert.equal(saved.ok, true); assert.equal(raw.revalidations, 1);
  assert.deepEqual(raw.calls.map((call) => call.method), ["bb-identity/v1/state/load", "bb-identity/v1/state/save"]);
  raw.setState({ status: "unavailable", error: { code: "unavailable", message: "state only", retry: "after-reconnect" } });
  const blocked = await transport.save(mutation); assert.equal(blocked.ok, false); assert.equal(raw.calls.length, 2);
  raw.setState({ status: "connecting" }); const connecting = await transport.save(mutation); assert.equal(connecting.ok, false);
  raw.setState({ status: "healthy" }); raw.setIdentity({ status: "reconnecting" }); const reconnecting = await transport.save(mutation); assert.equal(reconnecting.ok, false);
});

test("write payload is cloned before revalidation and malformed route errors are rejected", async () => {
  const raw = connection(); const transport = createStateTransport({ connection: raw, resource: { pluginId: "plugin-1", definition: { collection: "preferences", schemaVersion: 1, codec, initialValue: () => "light", equal: (a, b) => a === b } } });
  const mutable = { ...mutation, address: { ...address } }; raw.onRevalidate(() => { mutable.value = "mutated"; mutable.operationId = "op-mutated"; });
  const saved = await transport.save(mutable); assert.equal(saved.ok, true); assert.equal(raw.calls.at(-1).input.value, "dark");
  raw.setError({ code: "unavailable", message: "missing retry" }); const malformed = await transport.save(mutation); assert.equal(malformed.ok, false); if (!malformed.ok) assert.equal(malformed.error.code, "incompatible");
});

test("explicit read and receipt recovery remain reachable after state failure while new writes stay blocked", async () => {
  const raw = connection();
  const transport = createStateTransport({ connection: raw, resource: { pluginId: "plugin-1", definition: { collection: "preferences", schemaVersion: 1, codec, initialValue: () => "light", equal: (a, b) => a === b } } });
  raw.setState({ status: "unavailable", error: { code: "unavailable", message: "previous RPC failed", retry: "after-reconnect" } });
  assert.equal((await transport.save(mutation)).ok, false); assert.equal(raw.calls.length, 0);
  assert.equal((await transport.load({ address, expected })).ok, true);
  assert.deepEqual(await transport.reconcile({ address, expected, operationId: mutation.operationId }), { ok: true, value: { status: "pending" } });
  assert.deepEqual(raw.calls.map(call => call.method), ["bb-identity/v1/state/load", "bb-identity/v1/state/reconcile"]);
  assert.equal((await transport.save(mutation)).ok, false); assert.equal(raw.revalidations, 0);
  const controller = new AbortController(); controller.abort();
  assert.equal((await transport.load({ address, expected }, { signal: controller.signal })).ok, false);
  assert.equal(raw.calls.length, 2);
});

test("state invalidations are resource-address scoped and cleanup is finite", () => {
  const raw = connection(); const transport = createStateTransport({ connection: raw, resource: { pluginId: "plugin-1", definition: { collection: "preferences", schemaVersion: 1, codec, initialValue: () => "light", equal: (a, b) => a === b } } });
  let count = 0; const stop = transport.subscribe(address, () => count++);
  for (const listener of raw.listeners) listener({ kind: "state", event: { address: { ...address, recordId: "other" }, version: { epoch: "epoch", sequence: 2 }, operationId: null } });
  for (const listener of raw.listeners) listener({ kind: "state", event: { address, version: { epoch: "epoch", sequence: 2 }, operationId: null } });
  assert.equal(count, 1); stop(); assert.equal(raw.listeners.size, 0);
});
