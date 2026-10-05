/**
 * Test-only consumer recipes. They accept public request/server-shaped objects;
 * they neither read an ambient actor nor import a live plugin.
 */

export class ImmutableOperationError extends Error {
  constructor(operationId) {
    super(`operation ${operationId} was reused with a different immutable payload`);
    this.name = "ImmutableOperationError";
  }
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

/**
 * Preferences keep viewed subject separate from actual actor. `commit` receives
 * the target snapshot and lifecycle signal, so the storage seam can perform its
 * synchronous CommitValidator check.
 */
export async function writePreferences({ personRequest, viewedSubject, policy, value, commit }) {
  const expectedSubject = viewedSubject ?? personRequest.actor.identity.key;
  const targetResult = await personRequest.target({
    selection: viewedSubject ? { kind: "person", key: viewedSubject } : { kind: "self" },
    policy,
    intent: "write",
    expected: personRequest.expected,
    expectedSubject,
  });
  if (!targetResult.ok) return targetResult;
  const snapshot = targetResult.value.snapshot();
  return commit({ target: targetResult.value, actor: snapshot.actor, subject: snapshot.subject, value });
}

/**
 * The external integration owns credential verification. This adapter converts
 * only its verified stable subject/presentation to the public external-send
 * input. The host, not this fixture, owns external namespace construction and
 * durable deduplication; this local map only prevents altered retries before a
 * process-local caller reaches the host.
 */
export function createExternalContributionAdapter({ verifyCredential, server }) {
  const operations = new Map();

  async function accept({ credential, input }) {
    const fingerprint = stableJson(input);
    const known = operations.get(input.operationId);
    if (known && known.fingerprint !== fingerprint) throw new ImmutableOperationError(input.operationId);
    if (known) return known.result;

    const verified = await verifyCredential(credential);
    if (!verified.ok) return { status: "rejected", error: verified.error };
    const result = server.sendExternal({
      subject: verified.value.subject,
      presentation: verified.value.presentation,
    }, input);
    operations.set(input.operationId, { fingerprint, result });
    return result;
  }

  /** Reconciliation never creates replacement work after a lost response. */
  async function recover(operationId) {
    return server.lookupOperation(operationId);
  }

  return Object.freeze({ accept, recover });
}
