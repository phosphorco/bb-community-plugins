import { generateKeyPairSync, sign, verify } from "node:crypto";

/** @typedef {import("node:crypto").KeyObject} KeyObject */
/** @typedef {import("../host.js").IdentityProvider} IdentityProvider */
/** @typedef {import("../host.js").ProviderEvidenceV1} ProviderEvidenceV1 */
/** @typedef {Awaited<ReturnType<IdentityProvider["resolve"]>>} ProviderResolution */
/** @typedef {{ readonly kid: string; readonly publicKey: KeyObject }} FixturePublicKey */

const text = new TextEncoder();
const decoder = new TextDecoder();

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeJson(value) {
  try {
    return JSON.parse(decoder.decode(Buffer.from(value, "base64url")));
  } catch {
    return null;
  }
}

/** @returns {ProviderResolution} */
function unavailable(reason) {
  return { status: "unavailable", reason };
}

/** @returns {ProviderResolution} */
function rejected(reason) {
  return { status: "rejected", reason };
}

function audienceIncludes(audience, expected) {
  return Array.isArray(audience) ? audience.includes(expected) : audience === expected;
}

function assertionParts(assertion) {
  if (typeof assertion !== "string") return null;
  const parts = assertion.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeJson(headerPart);
  const payload = decodeJson(payloadPart);
  if (!header || !payload || typeof header !== "object" || typeof payload !== "object") return null;
  return { header, payload, signature: Buffer.from(signaturePart, "base64url"), signingInput: text.encode(`${headerPart}.${payloadPart}`) };
}

/** Creates a local-only RSA fixture key. The returned key material is test data. */
/** @param {string} [kid] */
export function createFixtureKeyPair(kid = "fixture-key") {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return Object.freeze({ kid, privateKey: pair.privateKey, publicKey: pair.publicKey });
}

/** Signs a compact RS256 assertion for this fixture; it performs no network I/O. */
/**
 * @param {{ key: { readonly kid: string; readonly privateKey: KeyObject }; issuer: string; subject: string;
 *   audience: string; now: number; expiresAt: number; presentation: import("../model.js").ProfilePresentation;
 *   nonce?: string }} input
 */
export function signFixtureAssertion({ key, issuer, subject, audience, now, expiresAt, presentation, nonce = "fixture-nonce" }) {
  const headerPart = encode({ alg: "RS256", typ: "JWT", kid: key.kid });
  const payloadPart = encode({
    iss: issuer,
    sub: subject,
    aud: audience,
    iat: Math.floor(now / 1000),
    exp: Math.floor(expiresAt / 1000),
    nonce,
    name: presentation.displayName,
    preferred_username: presentation.handle,
    picture: presentation.avatarUrl,
  });
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = sign("RSA-SHA256", text.encode(signingInput), key.privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * An offline IdP fixture shaped as IdentityProvider. `keys` and `refreshKeys`
 * are caller supplied so tests control clock/key rotation without production
 * credentials or network. Key verification and refresh policy stay here, not
 * in the core-facing consumer.
 * @param {{ issuer: string; audience: string; keys: Map<string, KeyObject>; now: () => number;
 *   credentialName?: string; refreshKeys?: (input: { readonly kid: string; readonly signal: AbortSignal;
 *   readonly deadlineAt: number }) => Promise<readonly FixturePublicKey[]>;
 *   trustedIngressKinds?: readonly ProviderEvidenceV1["ingress"]["kind"][] }} options
 * @returns {IdentityProvider}
 */
export function createSignedAssertionProvider({
  issuer,
  audience,
  keys,
  now,
  credentialName = "x-bb-assertion",
  refreshKeys,
  trustedIngressKinds = ["owned-proxy"],
}) {
  if (!issuer || !audience || !(keys instanceof Map) || typeof now !== "function" || !Array.isArray(trustedIngressKinds)) {
    throw new TypeError("signed assertion fixture requires issuer, audience, keys, now, and trusted ingress kinds");
  }

  /** @param {string} kid @param {ProviderEvidenceV1} evidence @returns {Promise<KeyObject | null | undefined>} */
  async function keyFor(kid, evidence) {
    const known = keys.get(kid);
    if (known) return known;
    if (!refreshKeys) return null;
    if (evidence.signal?.aborted || now() >= evidence.deadlineAt) return undefined;
    try {
      const refreshed = await refreshKeys({ kid, signal: evidence.signal, deadlineAt: evidence.deadlineAt });
      for (const key of refreshed) keys.set(key.kid, key.publicKey);
      return keys.get(kid) ?? null;
    } catch {
      return undefined;
    }
  }

  return Object.freeze({
    issuers: Object.freeze([issuer]),
    /** Optional readiness hook is intentionally omitted: this fixture is resolver-lazy. */
    /** @param {ProviderEvidenceV1} evidence @returns {Promise<ProviderResolution>} */
    async resolve(evidence) {
      if (!trustedIngressKinds.includes(evidence.ingress.kind)) return rejected("untrusted-ingress");
      if (evidence.signal?.aborted || now() >= evidence.deadlineAt) return unavailable("resolver-deadline");
      const credentials = evidence.credentials.filter((credential) => credential.name === credentialName);
      if (credentials.length !== 1) return rejected("missing-or-ambiguous-assertion");
      const parts = assertionParts(credentials[0].value);
      if (!parts || parts.header.alg !== "RS256" || typeof parts.header.kid !== "string") {
        return rejected("malformed-assertion");
      }
      if (parts.payload.iss !== issuer) return { status: "not-applicable" };
      if (typeof parts.payload.sub !== "string" || !audienceIncludes(parts.payload.aud, audience)) {
        return rejected("issuer-or-audience-mismatch");
      }
      if (!Number.isFinite(parts.payload.exp) || !Number.isFinite(parts.payload.iat)) return rejected("invalid-time-claims");
      const expiresAt = parts.payload.exp * 1000;
      if (expiresAt <= now() || parts.payload.iat * 1000 > now()) return rejected("expired-or-future-assertion");
      const publicKey = await keyFor(parts.header.kid, evidence);
      if (publicKey === undefined) return unavailable("key-refresh-unavailable");
      if (publicKey === null || !verify("RSA-SHA256", parts.signingInput, publicKey, parts.signature)) {
        return rejected("invalid-signature-or-key");
      }
      const presentation = {
        displayName: typeof parts.payload.name === "string" ? parts.payload.name : parts.payload.sub,
        handle: typeof parts.payload.preferred_username === "string" ? parts.payload.preferred_username : null,
        avatarUrl: typeof parts.payload.picture === "string" ? parts.payload.picture : null,
      };
      return { status: "resolved", issuer, subject: parts.payload.sub, presentation };
    },
  });
}
