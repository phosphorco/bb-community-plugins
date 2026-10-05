import assert from "node:assert/strict";
import test from "node:test";
import { createHostAdapter, inspectForkExtension } from "../host-runtime.js";
import { createAdapterHarness } from "../testing-runtime.js";

const codec = {
  decode: (value) => ({ ok: true, value }),
  encode: (value) => value,
};
const receipt = {
  evidence: "host-accepted",
  operationId: "operation-1",
  acceptedAt: "2026-09-05T00:00:00.000Z",
  references: [],
  native: { deliveryId: "delivery-1", queuedMessageId: null, turnId: "turn-1" },
  provenance: "structured",
  deduplication: "guaranteed",
  retainedUntil: "2026-09-06T00:00:00.000Z",
};
const accepted = { status: "submitted", receipt };
const input = { operationId: "operation-1", threadId: "thread-1", input: ["continue"], mode: "start" };
const externalAuthor = { subject: "webhook-42", presentation: { displayName: "Webhook", handle: null, avatarUrl: null } };

test("enhanced adapter preserves accepted scoped and external envelopes and unwraps final lookup", async () => {
  const harness = createAdapterHarness({ mode: "multi-user", inputCodec: codec });
  const calls = [];
  const scope = {
    signal: new AbortController().signal,
    validate: () => ({ ok: true }),
    release: () => {},
  };
  const raw = {
    version: 1,
    instanceId: "fixture-instance",
    bindInvocation: () => ({ registration: { generation: "binding-r1", status: "active", dispose: () => {} }, handler: () => undefined }),
    session: (context) => harness.upstream.session(context),
    selfProfile: (context, options) => harness.upstream.selfProfile(context, options),
    async openRequest(context) {
      const opened = await harness.upstream.openScope(context);
      return opened.ok ? { ok: true, value: { ...opened.value, scope } } : opened;
    },
    accept: async (request) => {
      calls.push(request);
      return accepted;
    },
    lookup: async () => ({ ok: true, value: { status: "final", outcome: accepted } }),
    provenance: async () => ({ ok: true, value: { status: "unknown", correlation: null, reason: "fixture" } }),
    historyContributions: async () => ({ ok: true, value: { status: "unavailable", reason: "unsupported" } }),
    historyAttempts: async () => ({ ok: true, value: { status: "unavailable", reason: "unsupported" } }),
    directorySources: () => [],
    participants: async () => ({ ok: false, error: { code: "unsupported", message: "unused", retry: "never" } }),
    forwardRpc: async () => undefined,
    registerProvider: async () => ({ ok: false, error: { code: "unsupported", message: "unused", retry: "never" } }),
    subscribe: () => () => {},
  };
  const extension = inspectForkExtension(raw);
  assert.equal(extension.status, "supported");
  const host = createHostAdapter({ upstream: harness.upstream, extension });
  const opened = await host.openPersonRequest(harness.request());
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const scoped = await host.send(opened.value, input);
  const external = await host.sendExternal(externalAuthor, input);
  const lookup = await host.lookupOperation(input.operationId);

  assert.deepEqual(scoped, accepted);
  assert.deepEqual(external, accepted);
  assert.deepEqual(lookup, { ok: true, value: { status: "final", outcome: accepted } });
  assert.deepEqual(calls, [
    { source: { kind: "scope", scope }, input },
    { source: { kind: "external", author: externalAuthor }, input },
  ]);
});
