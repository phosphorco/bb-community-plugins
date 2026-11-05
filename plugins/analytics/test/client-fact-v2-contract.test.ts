import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { ClientFactReadError, parseClientFactRequest, readClientFactBatch, type ClientFactSdk } from "../extraction/client-fact-source.ts";

const contract = JSON.parse(readFileSync(new URL("./fixtures/client-facts-v2-contract.json", import.meta.url), "utf8"));
const canonical = JSON.parse(readFileSync(new URL("./fixtures/client-facts-v2-canonical.json", import.meta.url), "utf8"));
const source = { namespace: "fixture-client", epoch: "fixture-epoch" };
for (const fixture of contract.cases.filter((c: any) => c.target === "request" && c.value !== undefined)) {
  test(`frozen V2 request contract: ${fixture.id}`, () => {
    if (fixture.valid) assert.deepEqual(parseClientFactRequest(fixture.value), fixture.value);
    else assert.throws(() => parseClientFactRequest(fixture.value), (error: unknown) => error instanceof ClientFactReadError && error.code === "invalid_request");
  });
}
for (const fixture of contract.cases.filter((c: any) => c.target === "projection")) {
  test(`frozen native projection contract: ${fixture.id}`, async () => {
    const sdk = { threads: {
      async get() { return { id: fixture.conversation, providerId: fixture.provider, parentThreadId: null, sourceThreadId: null, lifecycleOwnerThreadId: null }; },
      async list() { return []; }, events: { async list() { return [fixture.value]; } },
    } } as unknown as ClientFactSdk;
    const read = readClientFactBatch(sdk, { version: 2, expectedSource: source, conversations: [{ id: fixture.conversation, cursor: null }], discovery: null }, { source, signal: new AbortController().signal });
    if (!fixture.valid) {
      await assert.rejects(read, (error: unknown) => error instanceof ClientFactReadError && (error.code === "invalid_source" || error.code === "source_conflict") && error.conversation === fixture.conversation);
    } else {
      const result = await read;
      assert.deepEqual(result.facts.filter(f => f.kind !== "conversation"), fixture.expected === null ? [] : [fixture.expected]);
      assert.equal(result.cursors[0]!.outsideProjectionRows, fixture.expected === null ? 1 : 0);
      assert.equal(result.cursors[0]!.cursor!.disposition, fixture.expected === null ? "outside_projection" : "fact");
      assert.ok(result.budget.receivedBytes > 0);
    }
  });
}
test("actual common V1 projections preserve the frozen canonical digest grammar", async () => {
  for (const vector of canonical.vectors.filter((v: any) => v.commonV1Kind)) {
    const expected = vector.fact;
    const provider = expected.provider ?? (expected.session?.issuer === "codex:header" || expected.checkpoint?.issuer === "codex:turn" ? "codex" : "claude-code");
    const metadata = expected.kind === "conversation" ? { id: expected.conversation, providerId: provider, parentThreadId: expected.displayParent, sourceThreadId: expected.sourceFork, lifecycleOwnerThreadId: expected.lifecycleOwner } : { id: expected.conversation, providerId: provider, parentThreadId: null, sourceThreadId: null, lifecycleOwnerThreadId: null };
    const type = { native_session: "thread/identity", turn_input: "turn/input/accepted", turn_checkpoint: "turn/completed" }[expected.kind as "native_session"];
    const data = { providerThreadId: expected.session?.id ?? null, ...(expected.kind === "turn_input" ? { clientRequestId: expected.clientRequest } : {}), ...(expected.checkpoint === null || expected.checkpoint === undefined ? {} : { providerCheckpointId: expected.checkpoint.id }) };
    const sdk = { threads: { async get() { return metadata; }, async list() { return []; }, events: { async list() { return expected.kind === "conversation" ? [] : [{ id: expected.eventId, seq: expected.sequence, threadId: expected.conversation, type, scope: expected.kind === "native_session" ? { kind: "thread" } : { kind: "turn", turnId: expected.clientTurn }, data }]; } } } } as unknown as ClientFactSdk;
    const result = await readClientFactBatch(sdk, { version: 2, expectedSource: source, conversations: [{ id: expected.conversation, cursor: null }], discovery: null }, { source, signal: new AbortController().signal });
    const projected = result.facts.find(fact => fact.kind === expected.kind)!;
    assert.deepEqual(projected, expected);
    const fact: Record<string, unknown> = {};
    for (const key of Object.keys(projected).sort()) {
      const value = (projected as unknown as Record<string, any>)[key];
      fact[key] = ["session", "checkpoint"].includes(key) && value !== null ? { issuer: value.issuer, id: value.id } : value;
    }
    const wire = JSON.stringify(fact).replace(/[&<>\u2028\u2029]/gu, value => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`);
    assert.equal(wire, vector.canonicalUtf8);
    assert.equal(createHash("sha256").update(wire).digest("hex"), vector.sha256);
  }
});
