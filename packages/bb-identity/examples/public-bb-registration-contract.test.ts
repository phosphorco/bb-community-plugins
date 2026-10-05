/** Compile-only imported recipe: public /bb registration narrows Result before use. */
import type { BbIdentityBinding } from "../bb.js";
import { createResolverOnlyProvider } from "./resolver-only-provider.mjs";

const provider = createResolverOnlyProvider({
  issuer: "fixture:resolver-only",
  subject: "subject-1",
  presentation: { displayName: "Fixture", handle: "fixture", avatarUrl: null },
});

export async function registerFixtureProvider(identity: BbIdentityBinding) {
  const registered = await identity.registerProvider(provider);
  if (registered.ok === false) return registered.error;

  const registration = registered.value;
  const status: "staged" | "active" | "retired" = registration.getStatus();
  const configuration = registration.configuration;
  const person = registration.person("fixture:resolver-only", "subject-1");
  registration.dispose();
  return { status, configuration, person };
}
