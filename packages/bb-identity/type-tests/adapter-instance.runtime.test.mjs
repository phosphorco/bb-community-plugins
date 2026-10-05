import assert from "node:assert/strict";
import test from "node:test";
import { createHostAdapter, inspectForkExtension } from "../host-runtime.js";
import { createAdapterHarness } from "../testing-runtime.js";

const codec = {
  decode: (value) => ({ ok: true, value }),
  encode: (value) => value,
};

const rawInstanceId = "persisted-instance";

function rawProtocol(session) {
  return {
    version: 1,
    instanceId: rawInstanceId,
    bindInvocation: () => ({ registration: { generation: "binding-r1", status: "active", dispose: () => {} }, handler: () => undefined }),
    session,
    selfProfile: async () => ({ ok: false, error: { code: "unsupported", message: "unused", retry: "never" } }),
    openRequest: async () => ({ ok: false, error: { code: "unavailable", message: "unused", retry: "never" } }),
    accept: async () => ({ status: "rejected", error: { code: "unavailable", message: "unused", retry: "never" } }),
    lookup: async () => ({ ok: true, value: { status: "unknown", reason: "unsupported" } }),
    provenance: async () => ({ ok: true, value: { status: "unknown", correlation: null, reason: "unused" } }),
    historyContributions: async () => ({ ok: true, value: { status: "unavailable", reason: "unsupported" } }),
    historyAttempts: async () => ({ ok: true, value: { status: "unavailable", reason: "unsupported" } }),
    directorySources: () => [],
    participants: async () => ({ ok: false, error: { code: "unsupported", message: "unused", retry: "never" } }),
    forwardRpc: async () => undefined,
    registerProvider: async () => ({ ok: false, error: { code: "unsupported", message: "unused", retry: "never" } }),
    subscribe: () => () => {},
  };
}

test("enhanced adapter uses the persisted raw instance rather than a differing upstream instance", async () => {
  const harness = createAdapterHarness({ mode: "multi-user", instanceId: "upstream-instance", inputCodec: codec });
  const raw = rawProtocol(async () => {
    const upstream = await harness.upstream.session(harness.request());
    return { ...upstream, instanceId: rawInstanceId };
  });
  const extension = inspectForkExtension(raw);
  assert.equal(extension.status, "supported");
  const host = createHostAdapter({ upstream: harness.upstream, extension });

  const session = await host.session(harness.request());

  assert.equal(host.instanceId, rawInstanceId);
  assert.equal(session.status, "ready");
  if (session.status === "ready") assert.equal(session.instanceId, rawInstanceId);
});

test("enhanced ready session with a different persisted instance is incompatible", async () => {
  const harness = createAdapterHarness({ mode: "multi-user", instanceId: "upstream-instance", inputCodec: codec });
  const extension = inspectForkExtension(rawProtocol((context) => harness.upstream.session(context)));
  assert.equal(extension.status, "supported");
  const host = createHostAdapter({ upstream: harness.upstream, extension });

  const session = await host.session(harness.request());

  assert.deepEqual(session, {
    status: "incompatible",
    instanceId: rawInstanceId,
    error: {
      code: "incompatible",
      message: "Enhanced ready session instance does not match persisted host instance.",
      retry: "never",
    },
  });
});

test("a raw extension without persisted instanceId is rejected and never falls back to the singleton", async () => {
  const harness = createAdapterHarness({ mode: "multi-user", instanceId: "upstream-instance", inputCodec: codec });
  const malformed = {
    version: 1,
    bindInvocation: () => ({ registration: { generation: "binding-r1", status: "active", dispose: () => {} }, handler: () => undefined }),
    session: async () => { throw new Error("malformed enhanced session must not run"); },
    openRequest: async () => ({ ok: false, error: { code: "unavailable", message: "unused", retry: "never" } }),
    accept: async () => ({ status: "rejected", error: { code: "unavailable", message: "unused", retry: "never" } }),
    forwardRpc: async () => undefined,
    subscribe: () => () => {},
  };
  const extension = inspectForkExtension(malformed);
  assert.notEqual(extension.status, "supported");
  const upstream = { ...harness.upstream, session: async () => { throw new Error("singleton fallback must not run"); } };
  const host = createHostAdapter({ upstream, extension });

  const session = await host.session(harness.request());

  assert.equal(host.instanceId, "upstream-instance");
  assert.equal(session.status, "incompatible");
  if (session.status === "incompatible") assert.equal(session.error.code, "incompatible");
});
