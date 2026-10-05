import assert from "node:assert/strict";
import test from "node:test";
import { createHostAdapter, inspectForkExtension } from "../host-runtime.js";
import { createAdapterHarness } from "../testing-runtime.js";

const codec = {
  decode: (value) => ({ ok: true, value }),
  encode: (value) => value,
};

function scope() {
  return {
    signal: new AbortController().signal,
    validate: () => ({ ok: true }),
    release: () => {},
  };
}

function extension(harness, values = {}) {
  return {
    version: 1,
    instanceId: "fixture-instance",
    bindInvocation: () => ({ registration: { generation: "binding-r1", status: "active", dispose: () => {} }, handler: () => undefined }),
    session: (context) => values.session ?? harness.upstream.session(context),
    selfProfile: () => values.selfProfile ?? { ok: false, error: { code: "unsupported", message: "unused", retry: "never" } },
    async openRequest(context) {
      const opened = await harness.upstream.openScope(context);
      return opened.ok ? { ok: true, value: { ...opened.value, scope: scope() } } : opened;
    },
    accept: async () => values.accept ?? { status: "rejected", error: { code: "unsupported", message: "unused", retry: "never" } },
    lookup: async () => values.lookup ?? { ok: false, error: { code: "unsupported", message: "unused", retry: "never" } },
    provenance: async () => values.provenance ?? { ok: false, error: { code: "unsupported", message: "unused", retry: "never" } },
    historyContributions: async () => ({ ok: false, error: { code: "unsupported", message: "unused", retry: "never" } }),
    historyAttempts: async () => ({ ok: false, error: { code: "unsupported", message: "unused", retry: "never" } }),
    directorySources: () => [],
    participants: async () => ({ ok: false, error: { code: "unsupported", message: "unused", retry: "never" } }),
    forwardRpc: async () => undefined,
    registerProvider: async () => ({ ok: false, error: { code: "unsupported", message: "unused", retry: "never" } }),
    subscribe: () => () => {},
  };
}

test("adapter rejects false core success envelopes instead of treating them as accepted identity facts", async () => {
  const harness = createAdapterHarness({ mode: "multi-user", inputCodec: codec });
  const falseSuccess = extension(harness, {
    session: async () => ({
      status: "ready", instanceId: "fixture-instance", mode: "multi-user", stamp: "fixture-session",
      actor: { identity: { issuer: "fixture", subject: "person" }, presentation: { displayName: "Person", handle: null, avatarUrl: null } },
      capabilities: {},
    }),
    selfProfile: { ok: true, value: { displayName: "Person", handle: null, avatarUrl: null } },
    accept: { status: "submitted", operationId: "operation-1" },
    lookup: { ok: true, value: { operationId: "operation-1", outcome: { status: "submitted", operationId: "operation-1" } } },
    provenance: { ok: true, value: { status: "unknown" } },
  });
  const discovery = inspectForkExtension(falseSuccess);
  assert.equal(discovery.status, "supported");
  const host = createHostAdapter({ upstream: harness.upstream, extension: discovery });
  const session = await host.session(harness.request());
  assert.equal(session.status, "incompatible");

  const profile = await host.selfProfile(harness.request());
  const provenance = await host.readToolProvenance({ id: "fixture-tool" });
  const opened = await host.openPersonRequest(harness.request());
  assert.equal(profile.ok, false);
  assert.equal(provenance.ok, false);
  assert.equal(opened.ok, true);
  if (!profile.ok) assert.equal(profile.error.code, "invalid-input");
  if (!provenance.ok) assert.equal(provenance.error.code, "invalid-input");
  if (!opened.ok) return;

  const input = { operationId: "operation-1", threadId: "thread-1", input: ["continue"], mode: "start" };
  const scoped = await host.send(opened.value, input);
  const external = await host.sendExternal({ subject: "webhook-42", presentation: { displayName: "Webhook", handle: null, avatarUrl: null } }, input);
  const lookup = await host.lookupOperation(input.operationId);
  assert.equal(scoped.status, "rejected");
  assert.equal(external.status, "rejected");
  if (scoped.status === "rejected") assert.equal(scoped.error.code, "incompatible");
  if (external.status === "rejected") assert.equal(external.error.code, "incompatible");
  assert.equal(lookup.ok, false);
  if (!lookup.ok) assert.equal(lookup.error.code, "incompatible");
});
