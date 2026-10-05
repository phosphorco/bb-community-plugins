import assert from "node:assert/strict";
import test from "node:test";
import { createResolverOnlyProvider } from "../examples/resolver-only-provider.mjs";
import { createHostAdapter, inspectForkExtension } from "../host-runtime.js";

const signal = new AbortController().signal;
const presentation = { displayName: "Avery", handle: "avery", avatarUrl: null };
const configuration = {
  version: 1,
  boundaryId: "fixture-boundary",
  pluginId: "fixture-plugin",
  ingressIds: ["fixture"],
  credentials: [],
  resolver: { timeoutMs: 1_000 },
};

function upstream() {
  return {
    instanceId: "fixture-instance",
    pluginId: "fixture-plugin",
    inputCodec: { decode: (value) => ({ ok: true, value }), encode: (value) => value },
    scheduler: { now: () => 1_750_000_000_000, schedule: () => () => {} },
    session: async () => ({ status: "unavailable", instanceId: "fixture-instance", error: { code: "unavailable", message: "unused", retry: "never" } }),
    selfProfile: async () => ({ ok: false, error: { code: "unavailable", message: "unused", retry: "never" } }),
    openScope: async () => ({ ok: false, error: { code: "unavailable", message: "unused", retry: "never" } }),
    submit: async () => ({ status: "rejected", error: { code: "unavailable", message: "unused", retry: "never" } }),
    labelExternal: (_author, input) => input,
    toolCorrelation: () => ({ status: "unknown", correlation: null, reason: "unused" }),
    forward: async () => undefined,
    subscribe: () => () => {},
  };
}

test("resolver-only provider registers through the enhanced adapter without a readiness invocation", async () => {
  let registered = null;
  const personCalls = [];
  const raw = {
    version: 1,
    instanceId: "fixture-instance",
    bindInvocation: () => ({ registration: { generation: "binding-r1", status: "active", dispose: () => {} }, handler: () => undefined }),
    session: async () => ({ status: "unavailable", instanceId: "fixture-instance", error: { code: "unavailable", message: "unused", retry: "never" } }),
    selfProfile: async () => ({ ok: false, error: { code: "unavailable", message: "unused", retry: "never" } }),
    openRequest: async () => ({ ok: false, error: { code: "unavailable", message: "unused", retry: "never" } }),
    accept: async () => ({ status: "rejected", error: { code: "unavailable", message: "unused", retry: "never" } }),
    lookup: async () => ({ ok: true, value: { status: "unknown", reason: "unsupported" } }),
    provenance: async () => ({ ok: true, value: { status: "unknown", correlation: null, reason: "unused" } }),
    historyContributions: async () => ({ ok: true, value: { status: "unavailable", reason: "unsupported" } }),
    historyAttempts: async () => ({ ok: true, value: { status: "unavailable", reason: "unsupported" } }),
    directorySources: () => [],
    participants: async () => ({ ok: true, value: { items: [], nextCursor: null, revision: "revision-r1", coverage: "complete-history" } }),
    forwardRpc: async () => undefined,
    registerProvider: async (provider) => {
      registered = provider;
      return {
        ok: true,
        value: {
          generation: "provider-r1",
          configuration,
          getStatus: () => "active",
          signal,
          subscribe: () => () => {},
          invalidate: () => ({ ok: true, value: undefined }),
          dispose: () => {},
          person: (issuer, subject) => {
            personCalls.push({ issuer, subject });
            return { ok: true, value: { kind: "person", key: `${issuer}:${subject}`, issuer, subject } };
          },
        },
      };
    },
    subscribe: () => () => {},
  };
  const provider = createResolverOnlyProvider({
    issuer: "fixture:resolver-only",
    subject: "subject-1",
    presentation,
  });
  const extension = inspectForkExtension(raw);
  assert.equal(extension.status, "supported");
  const host = createHostAdapter({ upstream: upstream(), extension });

  const result = await host.registerProvider(provider);

  assert.equal(result.ok, true);
  assert.deepEqual(registered.issuers, provider.issuers);
  assert.equal(typeof registered.resolve, "function");
  assert.equal("validateReadiness" in registered, false);
  assert.equal("validateReadiness" in provider, false);
  if (!result.ok) return;
  assert.deepEqual(result.value.person("fixture:resolver-only", "subject-1"), {
    ok: true,
    value: {
      kind: "person",
      key: "fixture:resolver-only:subject-1",
      issuer: "fixture:resolver-only",
      subject: "subject-1",
    },
  });
  assert.deepEqual(personCalls, [{ issuer: "fixture:resolver-only", subject: "subject-1" }]);
});

test("optional readiness receives the raw host's ordinary generation and boundary inputs", async () => {
  let readinessInput = null;
  const provider = {
    ...createResolverOnlyProvider({
      issuer: "fixture:with-readiness",
      subject: "subject-2",
      presentation,
    }),
    async validateReadiness(input) {
      readinessInput = input;
      return { ok: true, value: undefined };
    },
  };
  const raw = {
    version: 1,
    instanceId: "fixture-instance",
    bindInvocation: () => ({ registration: { generation: "binding-r1", status: "active", dispose: () => {} }, handler: () => undefined }),
    session: async () => ({ status: "unavailable", instanceId: "fixture-instance", error: { code: "unavailable", message: "unused", retry: "never" } }),
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
    registerProvider: async (candidate) => {
      const readiness = candidate.validateReadiness;
      if (readiness !== undefined) {
        const result = await readiness({
          generation: "provider-r2",
          configuration,
          deadlineAt: 1_750_000_001_000,
          signal,
        });
        if (!result.ok) return result;
      }
      return {
        ok: true,
        value: {
          generation: "provider-r2",
          configuration,
          getStatus: () => "active",
          signal,
          subscribe: () => () => {},
          invalidate: () => ({ ok: true, value: undefined }),
          dispose: () => {},
          person: (issuer, subject) => ({ ok: true, value: { kind: "person", key: `${issuer}:${subject}`, issuer, subject } }),
        },
      };
    },
    subscribe: () => () => {},
  };
  const extension = inspectForkExtension(raw);
  assert.equal(extension.status, "supported");
  const result = await createHostAdapter({ upstream: upstream(), extension }).registerProvider(provider);

  assert.equal(result.ok, true);
  assert.deepEqual(readinessInput, {
    generation: "provider-r2",
    configuration,
    deadlineAt: 1_750_000_001_000,
    signal,
  });
});
