/** @typedef {import("../host.js").IdentityProvider} IdentityProvider */
/** @typedef {import("../host.js").ProviderEvidenceV1} ProviderEvidenceV1 */
/** @typedef {Awaited<ReturnType<IdentityProvider["resolve"]>>} ProviderResolution */

/**
 * Offline fixture shaped as the public IdentityProvider contract. It deliberately
 * has neither `directory` nor `validateReadiness`: resolved session presentation
 * must therefore be sufficient for a resolver-only consumer.
 * @param {{ issuer: string; subject: string; presentation: import("../model.js").ProfilePresentation;
 *   credentialName?: string; credentialValue?: string }} options
 * @returns {IdentityProvider}
 */
export function createResolverOnlyProvider({
  issuer,
  subject,
  presentation,
  credentialName = "fixture-credential",
  credentialValue = "fixture-user",
}) {
  if (!issuer || !subject || !presentation) {
    throw new TypeError("resolver-only fixture requires issuer, subject, and presentation");
  }

  return Object.freeze({
    issuers: Object.freeze([issuer]),
    /** @param {ProviderEvidenceV1} evidence @returns {Promise<ProviderResolution>} */
    async resolve(evidence) {
      if (evidence.ingress.kind !== "owned-proxy") {
        return { status: "rejected", reason: "untrusted-ingress" };
      }
      if (evidence.signal?.aborted || evidence.deadlineAt <= evidence.request.receivedAt) {
        return { status: "unavailable", reason: "resolver-deadline" };
      }
      const credentials = evidence.credentials.filter((credential) => credential.name === credentialName);
      if (credentials.length !== 1 || credentials[0].value !== credentialValue) {
        return { status: "rejected", reason: "invalid-credential" };
      }
      return { status: "resolved", issuer, subject, presentation };
    },
  });
}
