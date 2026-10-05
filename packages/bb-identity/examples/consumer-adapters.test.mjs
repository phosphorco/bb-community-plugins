import assert from "node:assert/strict";
import test from "node:test";
import { createExternalContributionAdapter, ImmutableOperationError, writePreferences } from "./consumer-adapters.mjs";

const actor = { identity: { key: "person:issuer:cole" }, presentation: { displayName: "Cole" } };
const alice = { key: "person:issuer:alice" };

test("preferences write keeps actual actor separate from viewed subject", async () => {
  const target = {
    snapshot: () => ({ actor, subject: alice, expected: { actor: actor.identity.key, session: "session-1" } }),
  };
  const personRequest = {
    actor,
    expected: { actor: actor.identity.key, session: "session-1" },
    async target(request) {
      assert.deepEqual(request, {
        selection: { kind: "person", key: alice.key }, policy: { kind: "collaborators" }, intent: "write",
        expected: { actor: actor.identity.key, session: "session-1" }, expectedSubject: alice.key,
      });
      return { ok: true, value: target };
    },
  };
  const result = await writePreferences({
    personRequest, viewedSubject: alice.key, policy: { kind: "collaborators" }, value: { muted: true },
    commit: ({ target: issued, actor: actualActor, subject, value }) => ({ ok: true, issued, actualActor, subject, value }),
  });
  assert.equal(result.actualActor.identity.key, actor.identity.key);
  assert.equal(result.subject.key, alice.key);
  assert.deepEqual(result.value, { muted: true });
});

test("external adapter binds a verified author and immutable operation before host submission", async () => {
  const calls = [];
  const adapter = createExternalContributionAdapter({
    verifyCredential: async (credential) => credential === "verified" ? {
      ok: true,
      value: { subject: "remote-44", presentation: { displayName: "Remote", handle: "remote", avatarUrl: null } },
    } : { ok: false, error: { code: "unauthenticated" } },
    server: {
      async sendExternal(author, input) { calls.push({ author, input }); return { status: "submitted", receipt: { operationId: input.operationId } }; },
      async lookupOperation(operationId) { return { ok: true, value: { status: "unknown", reason: "expired", operationId } }; },
    },
  });
  const input = { operationId: "operation-1", threadId: "thread-1", input: ["hello"], mode: "start" };
  const first = await adapter.accept({ credential: "verified", input });
  const retry = await adapter.accept({ credential: "verified", input: { ...input, input: ["hello"] } });
  assert.equal(first.status, "submitted");
  assert.equal(retry.status, "submitted");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].author, { subject: "remote-44", presentation: { displayName: "Remote", handle: "remote", avatarUrl: null } });
  await assert.rejects(() => adapter.accept({ credential: "verified", input: { ...input, input: ["changed"] } }), ImmutableOperationError);
  assert.deepEqual(await adapter.recover(input.operationId), { ok: true, value: { status: "unknown", reason: "expired", operationId: input.operationId } });
});
