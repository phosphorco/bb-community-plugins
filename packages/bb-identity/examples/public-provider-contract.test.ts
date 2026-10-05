/** Compile-only structural witness for the public provider interface. */
import type { IdentityProvider } from "../host.js";
import { createResolverOnlyProvider } from "./resolver-only-provider.mjs";
import { createFixtureKeyPair, createSignedAssertionProvider } from "./signed-assertion-provider.mjs";

const now = () => 1_750_000_000_000;
const presentation = { displayName: "Fixture", handle: "fixture", avatarUrl: null };
const key = createFixtureKeyPair("contract-key");

const resolverOnly: IdentityProvider = createResolverOnlyProvider({
  issuer: "fixture:resolver-only",
  subject: "subject-1",
  presentation,
});

const signed: IdentityProvider = createSignedAssertionProvider({
  issuer: "https://fixture-issuer.test",
  audience: "bb-proof",
  keys: new Map([[key.kid, key.publicKey]]),
  now,
});

void resolverOnly;
void signed;
