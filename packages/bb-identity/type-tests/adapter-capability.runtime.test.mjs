import assert from "node:assert/strict";
import test from "node:test";
import { createResolverOnlyProvider } from "../examples/resolver-only-provider.mjs";
import { createAdapterHarness } from "../testing-runtime.js";

const codec = {
  decode: (value) => ({ ok: true, value }),
  encode: (value) => value,
};
const presentation = { displayName: "Avery", handle: "avery", avatarUrl: null };

function resolverOnly(subject = "subject-1") {
  return createResolverOnlyProvider({
    issuer: "fixture:resolver-only",
    subject,
    presentation,
  });
}

test("extension absence retains the upstream singleton and refuses provider registration", async () => {
  const harness = createAdapterHarness({ mode: "single-user", inputCodec: codec });
  harness.setRawExtension(undefined);
  const host = harness.connect();

  const session = await host.session(harness.request());
  const registration = await host.registerProvider(resolverOnly());

  assert.equal(session.status, "ready");
  if (session.status === "ready") assert.equal(session.actor.identity.kind, "default-user");
  assert.deepEqual(registration, {
    ok: false,
    error: {
      code: "unsupported",
      message: "Identity provider registration requires the enhanced host.",
      retry: "never",
    },
  });
});

test("malformed extension and identity outage do not select the singleton fallback", async () => {
  const malformedHarness = createAdapterHarness({ mode: "single-user", inputCodec: codec });
  malformedHarness.setRawExtension({ version: 1 });
  const malformed = malformedHarness.connect();
  const malformedSession = await malformed.session(malformedHarness.request());
  const malformedRegistration = await malformed.registerProvider(resolverOnly());

  assert.equal(malformedSession.status, "incompatible");
  assert.equal(malformedRegistration.ok, false);
  if (!malformedRegistration.ok) assert.equal(malformedRegistration.error.code, "incompatible");

  const outageHarness = createAdapterHarness({ mode: "multi-user", inputCodec: codec });
  outageHarness.setIdentityAvailability("unavailable");
  const outage = await outageHarness.connect().session(outageHarness.request());

  assert.equal(outage.status, "unavailable");
});

test("a rejected replacement leaves the preceding enhanced registration active", async () => {
  const harness = createAdapterHarness({ mode: "multi-user", inputCodec: codec });
  const host = harness.connect();
  const first = await host.registerProvider(resolverOnly("first"));

  assert.equal(first.ok, true);
  if (!first.ok) return;
  harness.replaceProvider("fail");
  const replacement = await host.registerProvider(resolverOnly("second"));

  assert.equal(first.value.getStatus(), "active");
  assert.equal(replacement.ok, false);
  if (!replacement.ok) assert.equal(replacement.error.code, "unavailable");
});
