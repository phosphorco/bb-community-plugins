import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIENT_FACT_EVENT_TYPES, CLIENT_FACT_LIMITS, ClientFactReadError,
  readClientFactBatch, type ClientFactRequest, type ClientFactSdk,
} from "../extraction/client-fact-source.ts";

const source = { namespace: "bb-installation-one", epoch: "explicit-epoch-one" };
interface Metadata { id: string; providerId: string; parentThreadId: string | null; sourceThreadId: string | null; lifecycleOwnerThreadId: string | null; }
const meta = (id = "conversation-one", providerId = "codex"): Metadata => ({
  id, providerId, parentThreadId: null, sourceThreadId: null, lifecycleOwnerThreadId: null,
});
type Row = { id: string; seq: number; threadId: string; type: string;
  scope: { kind: "thread" } | { kind: "turn"; turnId: string }; data: Record<string, unknown> };
function row(type: string, seq: number, data: Record<string, unknown>, conversation = "conversation-one", turn = "bb-turn-one"): Row {
  return { id: `event-${seq}`, seq, threadId: conversation, type,
    scope: type === "thread/identity" ? { kind: "thread" } : { kind: "turn", turnId: turn }, data };
}
function fixture(options: { rows?: Row[]; metadata?: ReturnType<typeof meta>; discovery?: ReturnType<typeof meta>[] } = {}) {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const sdk = { threads: {
    async get(input: Record<string, unknown>) { calls.push({ method: "get", input }); return options.metadata ?? meta(String(input.threadId)); },
    async list(input: Record<string, unknown>) { calls.push({ method: "list", input }); return options.discovery ?? []; },
    events: { async list(input: Record<string, unknown>) {
      calls.push({ method: "events", input });
      return (options.rows ?? []).filter(value => value.threadId === input.threadId &&
        value.seq > Number(input.afterSeq ?? 0) && value.seq < Number(input.beforeSeq ?? Infinity))
        .slice(0, Number(input.limit));
    } },
  } } as unknown as ClientFactSdk;
  return { sdk, calls };
}
function request(overrides: Partial<ClientFactRequest> = {}): ClientFactRequest {
  return { version: 2, expectedSource: source, conversations: [{ id: "conversation-one", cursor: null }], discovery: null, ...overrides };
}
function options() { return { source, signal: new AbortController().signal }; }
const hasCode = (code: ClientFactReadError["code"]) => (error: unknown) => error instanceof ClientFactReadError && error.code === code;

test("one conversation retains several sessions and exact Codex checkpoint/request identities", async () => {
  const { sdk, calls } = fixture({ rows: [
    row("thread/identity", 1, { providerThreadId: "native-one" }),
    row("turn/input/accepted", 2, { providerThreadId: "native-one", clientRequestId: "client-request-one" }),
    row("turn/completed", 3, { providerThreadId: "native-one", providerCheckpointId: "codex-turn-one" }),
    row("thread/identity", 4, { providerThreadId: "native-two" }),
    row("turn/input/accepted", 5, { providerThreadId: "native-two", clientRequestId: "client-request-two" }, undefined, "bb-turn-two"),
    row("turn/completed", 6, { providerThreadId: "native-two", providerCheckpointId: "codex-turn-two" }, undefined, "bb-turn-two"),
  ] });
  const result = await readClientFactBatch(sdk, request(), options());
  assert.equal(result.facts.length, 7);
  assert.deepEqual(result.facts.filter(fact => fact.kind === "turn_input").map(fact => [fact.clientTurn, fact.clientRequest]), [
    ["bb-turn-one", "client-request-one"], ["bb-turn-two", "client-request-two"],
  ]);
  assert.deepEqual(result.facts.filter(fact => fact.kind === "turn_checkpoint").map(fact => fact.checkpoint), [
    { issuer: "codex:turn", id: "codex-turn-one" }, { issuer: "codex:turn", id: "codex-turn-two" },
  ]);
  assert.deepEqual(result.cursors, [{ conversation: "conversation-one", cursor: { sequence: 6, eventId: "event-6", eventType: "turn/completed", disposition: "fact" }, pageExhausted: true, scannedRows: 6, projectedRows: 6, outsideProjectionRows: 0 }]);
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.budget.calls, 2);
  assert.equal(result.budget.workRows, 1 + 5 * CLIENT_FACT_LIMITS.eventRows);
  assert.deepEqual(calls[1]!.input.types, CLIENT_FACT_EVENT_TYPES);
  assert.equal(calls[1]!.input.order, "asc");
});

test("Claude message checkpoints remain distinct from HTTP turns; content/error details never enter facts", async () => {
  const rawMessage = "private prompt material should not enter curated facts";
  const { sdk, calls } = fixture({ metadata: { ...meta(undefined, "claude-code"), title: rawMessage } as ReturnType<typeof meta>, rows: [
    row("turn/input/accepted", 1, { providerThreadId: "claude-session", clientRequestId: "canonical-request", input: rawMessage }),
    row("turn/completed", 2, { providerThreadId: "claude-session", providerCheckpointId: "sdk-message", error: { message: rawMessage } }),
  ] });
  const result = await readClientFactBatch(sdk, request(), options());
  const checkpoint = result.facts.find(fact => fact.kind === "turn_checkpoint");
  assert.ok(checkpoint?.kind === "turn_checkpoint");
  assert.deepEqual(checkpoint.checkpoint, { issuer: "claude-code:message", id: "sdk-message" });
  assert.equal(result.coverage.claudeHttpTurn, "response_identity_partial");
  assert.ok(!JSON.stringify(result).includes(rawMessage));
  assert.ok(calls.filter(call => call.method === "events").every(call => !(call.input.types as string[]).includes("client/turn/requested")));
});

test("exact cursor anchor is checked before continuation and charged by type", async () => {
  const { sdk, calls } = fixture({ rows: [
    row("thread/identity", 7, { providerThreadId: "native-one" }),
    row("turn/input/accepted", 11, { providerThreadId: "native-one", clientRequestId: "client-one" }),
  ] });
  const result = await readClientFactBatch(sdk, request({ conversations: [{ id: "conversation-one", cursor: { sequence: 7, eventId: "event-7", eventType: "thread/identity", disposition: "fact" } }] }), options());
  assert.deepEqual(calls[1]!.input.afterSeq, "6"); assert.deepEqual(calls[1]!.input.beforeSeq, "8");
  assert.equal(calls[2]!.input.afterSeq, "7");
  assert.equal(result.budget.workRows, 1 + 5 + 5 * CLIENT_FACT_LIMITS.eventRows);
  assert.deepEqual(result.cursors[0]!.cursor, { sequence: 11, eventId: "event-11", eventType: "turn/input/accepted", disposition: "fact" });
  assert.ok(result.facts.some(fact => fact.kind === "native_session" && fact.eventId === "event-7"), "replay anchor facts so Foundation can reject a changed immutable binding digest");
});

test("epoch mismatch or missing/replaced anchor requests reset without publishing facts/cursors", async () => {
  const mismatch = fixture();
  const changedEpoch = await readClientFactBatch(mismatch.sdk, request({ expectedSource: { ...source, epoch: "old" } }), options());
  assert.equal(changedEpoch.resetReason, "source_epoch_mismatch"); assert.equal(mismatch.calls.length, 0);
  for (const found of [false, true]) {
    const f = fixture({ rows: found ? [row("thread/identity", 3, { providerThreadId: "native-one" })] : [] });
    const result = await readClientFactBatch(f.sdk, request({ conversations: [{ id: "conversation-one", cursor: { sequence: 3, eventId: "other-event", eventType: "thread/identity", disposition: "fact" } }] }), options());
    assert.equal(result.state, "reset_required"); assert.equal(result.resetReason, found ? "anchor_changed" : "anchor_missing");
    assert.deepEqual(result.facts, []); assert.deepEqual(result.cursors, []); assert.equal(f.calls.length, 2);
  }
});

test("discovery remains partial and current parent/fork/owner meanings stay separate", async () => {
  const f = fixture({ discovery: [
    { ...meta("child"), parentThreadId: "display-parent", sourceThreadId: "source-fork", lifecycleOwnerThreadId: "owner" } as ReturnType<typeof meta>,
    meta("response_identity_partial", "other-provider"),
  ] });
  const result = await readClientFactBatch(f.sdk, request({ conversations: [], discovery: { offset: 50 } }), options());
  assert.deepEqual(result.facts[0], { kind: "conversation", conversation: "child", provider: "codex", displayParent: "display-parent", sourceFork: "source-fork", lifecycleOwner: "owner", relationshipRevision: null });
  assert.deepEqual(result.discovery, { offset: 50, nextOffset: 52, conversations: ["child"], pageExhausted: true });
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.reasons.includes("unsupported_provider_excluded"));
  assert.equal(f.calls[0]!.input.includeHidden, true);
  assert.equal(f.calls[0]!.input.archived, undefined, "omission includes archived and unarchived native rows");
});

test("SDK calls/work/bytes/output/time are aggregate finite budgets, not per-page allowances", async () => {
  for (const limits of [{ calls: 1 }, { workRows: 75 }, { receivedBytes: 1 }, { outputBytes: 1 }]) {
    const f = fixture();
    await assert.rejects(readClientFactBatch(f.sdk, request(), { ...options(), limits }), hasCode("read_budget"));
    assert.ok(f.calls.length <= 2);
    if ("calls" in limits || "workRows" in limits || "receivedBytes" in limits) assert.equal(f.calls.length, 1);
  }
  const f = fixture(); let time = 0;
  const sdk = { threads: { ...f.sdk.threads, async get(input: Parameters<ClientFactSdk["threads"]["get"]>[0]) { const result = await f.sdk.threads.get(input); time = 2_000; return result; } } };
  await assert.rejects(readClientFactBatch(sdk, request(), { ...options(), clock: () => time }), hasCode("read_budget"));
  assert.equal(f.calls.length, 1);
});

test("cancellation does not race an ignored SDK request or start follow-on work", async () => {
  const f = fixture(); const controller = new AbortController();
  let release!: (value: Awaited<ReturnType<ClientFactSdk["threads"]["get"]>>) => void;
  let started = false, settled = false;
  const sdk = { threads: { ...f.sdk.threads, async get(input: Parameters<ClientFactSdk["threads"]["get"]>[0]) {
    assert.equal(input.signal, controller.signal); started = true;
    return new Promise<Awaited<ReturnType<ClientFactSdk["threads"]["get"]>>>(resolve => { release = resolve; });
  } } };
  const pending = readClientFactBatch(sdk, request(), { source, signal: controller.signal });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  assert.equal(started, true); controller.abort(); await Promise.resolve();
  assert.equal(settled, false, "ignored cancellation must still occupy central admission");
  release(meta() as Awaited<ReturnType<ClientFactSdk["threads"]["get"]>>);
  await assert.rejects(pending, hasCode("cancelled")); assert.equal(f.calls.length, 0);
});

test("closed input and fixed ceilings reject unknown fields/duplicate targets before any SDK call", async () => {
  const f = fixture();
  for (const input of [{ ...request(), token: "must-not-be-input" }, request({ conversations: [{ id: "x", cursor: null }, { id: "x", cursor: null }] })]) {
    await assert.rejects(readClientFactBatch(f.sdk, input, options()), hasCode("invalid_request"));
  }
  await assert.rejects(readClientFactBatch(f.sdk, request(), { ...options(), limits: { calls: CLIENT_FACT_LIMITS.calls + 1 } }), hasCode("invalid_request"));
  assert.equal(f.calls.length, 0);
});

test("malformed parent metadata and unexpected event types fail, without guessing roots or capturing input", async () => {
  const broken = fixture({ metadata: { id: "conversation-one", providerId: "codex" } as ReturnType<typeof meta> });
  await assert.rejects(readClientFactBatch(broken.sdk, request(), options()), hasCode("invalid_source"));
  const unexpected = fixture({ rows: [row("client/turn/requested", 1, { input: "must-not-leave-source" })] });
  await assert.rejects(readClientFactBatch(unexpected.sdk, request(), options()), hasCode("source_conflict"));
});

test("contradictory native sessions and Codex checkpoint joins are conflicts", async () => {
  for (const rows of [
    [row("turn/input/accepted", 1, { providerThreadId: "session-a", clientRequestId: "request" }), row("turn/completed", 2, { providerThreadId: "session-b", providerCheckpointId: "checkpoint" })],
    [row("turn/completed", 1, { providerThreadId: "session", providerCheckpointId: "checkpoint" }), row("turn/completed", 2, { providerThreadId: "session", providerCheckpointId: "checkpoint" }, undefined, "different-turn")],
  ]) {
    await assert.rejects(readClientFactBatch(fixture({ rows }).sdk, request(), options()), hasCode("source_conflict"));
  }
  const native = "same-session";
  const f = fixture({ rows: [row("thread/identity", 1, { providerThreadId: native }), { ...row("thread/identity", 1, { providerThreadId: native }, "other-conversation"), id: "other-event-1" }] });
  const shared = await readClientFactBatch(f.sdk, request({ conversations: [{ id: "conversation-one", cursor: null }, { id: "other-conversation", cursor: null }] }), options());
  assert.equal(shared.facts.filter(fact => fact.kind === "native_session").length, 2, "shared sessions remain diagnostic ambiguous facts, not source corruption");
});

test("short/capped/empty event pages preserve partial coverage and deterministic replay across sequence gaps", async () => {
  const f = fixture({ rows: [row("thread/identity", 1, { providerThreadId: "session" }), row("turn/input/accepted", 100, { providerThreadId: "session", clientRequestId: "request" })] });
  const firstInput = request();
  const first = await readClientFactBatch(f.sdk, firstInput, { ...options(), limits: { eventRows: 1 } });
  const replay = await readClientFactBatch(f.sdk, firstInput, { ...options(), limits: { eventRows: 1 } });
  assert.deepEqual(replay, first, "replay is deterministic; no timestamp-derived identity or ordering");
  assert.equal(first.cursors[0]!.pageExhausted, false);
  assert.ok(first.coverage.reasons.includes("event_page_capped"));
  const second = await readClientFactBatch(f.sdk, request({ conversations: [{ id: "conversation-one", cursor: first.cursors[0]!.cursor }] }), options());
  assert.deepEqual(second.cursors[0]!.cursor, { sequence: 100, eventId: "event-100", eventType: "turn/input/accepted", disposition: "fact" });
  assert.equal(second.coverage.complete, false, "filtered sequence gaps and exhausting a page establish no history completeness");
  const empty = await readClientFactBatch(f.sdk, request({ conversations: [{ id: "conversation-one", cursor: second.cursors[0]!.cursor }] }), options());
  assert.deepEqual(empty.cursors[0]!.cursor, second.cursors[0]!.cursor);
  assert.equal(empty.coverage.complete, false);
});

test("already-cancelled reads and oversized reset output publish nothing", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(readClientFactBatch(f.sdk, request(), { source, signal: controller.signal }), hasCode("cancelled"));
  await assert.rejects(readClientFactBatch(f.sdk, request({ expectedSource: { ...source, epoch: "other" } }), { ...options(), limits: { outputBytes: 1 } }), hasCode("read_budget"));
  assert.equal(f.calls.length, 0);
});

function nativePayload(overrides: Record<string, unknown> = {}) {
  return { version: 1, binding: "turn_scope", reason: null, phase: "message_start", nativeSessionId: "claude-native", messageId: "msg-native", providerRequestId: null, parentToolUseId: null, aborted: null, supersedesSdkUuids: [], ...overrides };
}
function nativeRow(seq: number, payload: Record<string, unknown>, state = false): Row {
  const result = row(state ? "thread/extensionState/updated" : "item/completed", seq,
    state ? { kind: "provider-claude-code/response-identity", payload } : { item: { type: "extension", kind: "provider-claude-code/response-identity", payload } });
  if (state) result.scope = { kind: "thread" };
  return result;
}
test("all ignored pages advance typed anchors, charge raw bodies and never export them", async () => {
  const text = "Synthetic unrelated tool body.".repeat(100);
  const rows = Array.from({ length: 25 }, (_, index) => row("item/completed", index + 1, { item: { type: "commandExecution", resultText: text } }));
  const f = fixture({ metadata: meta(undefined, "claude-code"), rows });
  const first = await readClientFactBatch(f.sdk, request(), options());
  assert.equal(first.facts.length, 1); assert.ok(!JSON.stringify(first).includes(text));
  assert.equal(first.cursors[0]!.scannedRows, 25); assert.equal(first.cursors[0]!.projectedRows, 0); assert.equal(first.cursors[0]!.outsideProjectionRows, 25);
  assert.equal(first.cursors[0]!.cursor!.disposition, "outside_projection"); assert.equal(first.cursors[0]!.pageExhausted, false);
  assert.ok(first.budget.receivedBytes > text.length * 25); assert.equal(first.budget.workRows, 126);
  const next = await readClientFactBatch(f.sdk, request({ conversations: [{ id: "conversation-one", cursor: first.cursors[0]!.cursor }] }), options());
  assert.deepEqual(next.cursors[0]!.cursor, first.cursors[0]!.cursor); assert.equal(next.cursors[0]!.scannedRows, 0);
  await assert.rejects(readClientFactBatch(f.sdk, request(), { ...options(), limits: { receivedBytes: 1000 } }), (error: unknown) => error instanceof ClientFactReadError && error.code === "read_budget" && error.conversation === "conversation-one");
  const changed = fixture({ metadata: meta(undefined, "claude-code"), rows: [nativeRow(25, nativePayload())] });
  const reset = await readClientFactBatch(changed.sdk, request({ conversations: [{ id: "conversation-one", cursor: first.cursors[0]!.cursor }] }), options());
  assert.equal(reset.resetReason, "anchor_changed"); assert.deepEqual(reset.facts, []); assert.deepEqual(reset.cursors, []);
});

test("bound initial/enriched identities and unbound diagnosis retain explicit distinct roles", async () => {
  const f = fixture({ metadata: meta(undefined, "claude-code"), rows: [
    nativeRow(1, nativePayload()),
    nativeRow(2, nativePayload({ phase: "assistant", providerRequestId: "req-native", aborted: true, supersedesSdkUuids: ["sdk-before"] })),
    nativeRow(3, nativePayload({ binding: "unbound", reason: "identity_capacity_exceeded", messageId: null }), true),
  ] });
  const value = await readClientFactBatch(f.sdk, request(), options());
  const bound = value.facts.filter(f => f.kind === "native_response_id");
  assert.equal(bound.length, 2); assert.equal(bound[0]!.response.id, "msg-native"); assert.equal(bound[1]!.response.id, "msg-native");
  assert.deepEqual(bound[1]!.providerRequest, { issuer: "anthropic:request", id: "req-native" });
  const unbound = value.facts.find(f => f.kind === "native_response_coverage")!;
  assert.ok(!("clientTurn" in unbound)); assert.ok(!("clientRequest" in unbound));
  assert.equal(value.cursors[0]!.projectedRows, 3);
});

test("cross-conversation sessions and response owners remain ambiguity evidence, not latest-wins", async () => {
  const a = nativeRow(1, nativePayload()), b = { ...nativeRow(1, nativePayload()), id: "other-native-event", threadId: "other-conversation", scope: { kind: "turn" as const, turnId: "another-client-turn" } };
  const f = fixture({ rows: [a, b] });
  const sdk = { threads: { ...f.sdk.threads, async get(input: Parameters<ClientFactSdk["threads"]["get"]>[0]) { return meta(input.threadId, "claude-code") as Awaited<ReturnType<ClientFactSdk["threads"]["get"]>>; } } };
  const value = await readClientFactBatch(sdk, request({ conversations: [{ id: "conversation-one", cursor: null }, { id: "other-conversation", cursor: null }] }), options());
  assert.equal(value.facts.filter(f => f.kind === "native_response_id").length, 2);
});

test("eligible invalid payloads and wrong typed anchors fail atomically with finite context", async () => {
  for (const payload of [nativePayload({ extra: true }), nativePayload({ version: 2 }), nativePayload({ parentToolUseId: "subagent" }), nativePayload({ supersedesSdkUuids: Array(16).fill("🧪".repeat(128)) })]) {
    const f = fixture({ metadata: meta(undefined, "claude-code"), rows: [nativeRow(1, payload)] });
    await assert.rejects(readClientFactBatch(f.sdk, request(), options()), (error: unknown) => error instanceof ClientFactReadError && error.code === "invalid_source" && error.conversation === "conversation-one");
  }
  const f = fixture({ metadata: meta(undefined, "claude-code"), rows: [nativeRow(1, nativePayload())] });
  const value = await readClientFactBatch(f.sdk, request({ conversations: [{ id: "conversation-one", cursor: { sequence: 1, eventId: "event-1", eventType: "thread/extensionState/updated", disposition: "fact" } }] }), options());
  assert.equal(value.resetReason, "anchor_changed"); assert.deepEqual(value.facts, []);
});


test("ignored rows still obey scanned immutable identity uniqueness", async () => {
  const ordinary = row("item/completed", 1, { item: { type: "commandExecution", resultText: "unrelated" } });
  const f = fixture({ rows: [ordinary, { ...ordinary, seq: 2 }] });
  await assert.rejects(readClientFactBatch(f.sdk, request(), options()), hasCode("source_conflict"));
  const anchored = fixture({ rows: [ordinary, { ...ordinary, seq: 2 }] });
  await assert.rejects(readClientFactBatch(anchored.sdk, request({ conversations: [{ id: "conversation-one", cursor: { sequence: 1, eventId: "event-1", eventType: "item/completed", disposition: "outside_projection" } }] }), options()), hasCode("source_conflict"));
});
