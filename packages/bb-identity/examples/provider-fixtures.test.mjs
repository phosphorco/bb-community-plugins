import assert from "node:assert/strict";
import test from "node:test";
import {
  createFixtureKeyPair,
  createSignedAssertionProvider,
  signFixtureAssertion,
} from "./signed-assertion-provider.mjs";
import { createResolverOnlyProvider } from "./resolver-only-provider.mjs";

const nowValue = 1_750_000_000_000;
const presentation = Object.freeze({ displayName: "Avery", handle: "avery", avatarUrl: null });

function evidence(assertion, overrides = {}) {
  return {
    configuration: { resolver: { timeoutMs: 1_000 } },
    request: { authority: "proof.bb.test", method: "GET", pathname: "/", transport: "http", receivedAt: nowValue },
    ingress: { id: "fixture", kind: "owned-proxy", authenticatedPeer: "fixture-proxy" },
    credentials: [{ name: "x-bb-assertion", value: assertion }],
    deadlineAt: nowValue + 1_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("signed assertion resolves only its configured issuer and preserves issuer/subject", async () => {
  const key = createFixtureKeyPair("a");
  const provider = createSignedAssertionProvider({ issuer: "https://issuer-a.test", audience: "bb-proof", keys: new Map([[key.kid, key.publicKey]]), now: () => nowValue });
  const assertion = signFixtureAssertion({ key, issuer: "https://issuer-a.test", subject: "user-7", audience: "bb-proof", now: nowValue, expiresAt: nowValue + 120_000, presentation });
  const result = await provider.resolve(evidence(assertion));
  assert.deepEqual(result, { status: "resolved", issuer: "https://issuer-a.test", subject: "user-7", presentation });
  assert.equal("directory" in provider, false);
  assert.equal("validateReadiness" in provider, false);
});

test("issuer isolation rejects a valid assertion at another issuer boundary", async () => {
  const key = createFixtureKeyPair("shared-fixture-key");
  const assertion = signFixtureAssertion({ key, issuer: "https://issuer-a.test", subject: "same-subject", audience: "bb-proof", now: nowValue, expiresAt: nowValue + 60_000, presentation });
  const providerB = createSignedAssertionProvider({ issuer: "https://issuer-b.test", audience: "bb-proof", keys: new Map([[key.kid, key.publicKey]]), now: () => nowValue });
  assert.deepEqual(await providerB.resolve(evidence(assertion)), { status: "not-applicable" });
});

test("locally supplied key refresh is provider-owned and has no network dependency", async () => {
  const oldKey = createFixtureKeyPair("old");
  const rotated = createFixtureKeyPair("rotated");
  let refreshes = 0;
  const provider = createSignedAssertionProvider({
    issuer: "https://issuer-a.test", audience: "bb-proof", keys: new Map([[oldKey.kid, oldKey.publicKey]]), now: () => nowValue,
    refreshKeys: async ({ kid }) => { refreshes += 1; return kid === rotated.kid ? [rotated] : []; },
  });
  const assertion = signFixtureAssertion({ key: rotated, issuer: "https://issuer-a.test", subject: "user-7", audience: "bb-proof", now: nowValue, expiresAt: nowValue + 60_000, presentation });
  assert.equal((await provider.resolve(evidence(assertion))).status, "resolved");
  assert.equal(refreshes, 1);
});

test("resolver-only provider returns session presentation without a directory", async () => {
  const provider = createResolverOnlyProvider({ issuer: "fixture:resolver-only", subject: "subject-1", presentation });
  const result = await provider.resolve({ ...evidence("fixture-user"), credentials: [{ name: "fixture-credential", value: "fixture-user" }] });
  assert.deepEqual(result, { status: "resolved", issuer: "fixture:resolver-only", subject: "subject-1", presentation });
  assert.equal("directory" in provider, false);
});

test("malformed assertions and untrusted ingress fail closed", async () => {
  const key = createFixtureKeyPair("a");
  const provider = createSignedAssertionProvider({ issuer: "https://issuer-a.test", audience: "bb-proof", keys: new Map([[key.kid, key.publicKey]]), now: () => nowValue });
  assert.equal((await provider.resolve(evidence("not-a-jws"))).status, "rejected");
  assert.equal((await provider.resolve(evidence("not-a-jws", { ingress: { id: null, kind: "unverified", authenticatedPeer: null } }))).status, "rejected");
});
