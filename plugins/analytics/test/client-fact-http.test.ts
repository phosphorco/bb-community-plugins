import assert from "node:assert/strict";
import test from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CLIENT_FACT_READ_PATH, CLIENT_FACT_REQUEST_BYTES, registerClientFactHttp } from "../extraction/client-fact-http.ts";
import type { ClientFactSdk } from "../extraction/client-fact-source.ts";

type Handler = Parameters<BbPluginApi["http"]["route"]>[2];
const configured = { sourceNamespace: "bb-production", sourceEpoch: "epoch-explicit" };
const requestBody = (id = "thread-codex") => ({ version: 1,
  expectedSource: { namespace: configured.sourceNamespace, epoch: configured.sourceEpoch },
  conversations: [{ id, cursor: null }], discovery: null });
function request(body: unknown = requestBody(), options: { signal?: AbortSignal; headers?: Record<string, string>; raw?: string } = {}) {
  return new Request("http://127.0.0.1/api/v1/plugins/analytics/http" + CLIENT_FACT_READ_PATH, {
    method: "POST", headers: { "content-type": "application/json", ...options.headers },
    body: options.raw ?? JSON.stringify(body), signal: options.signal,
  });
}
function fixture() {
  let values: Partial<typeof configured> = { ...configured };
  let handler: Handler | undefined;
  let descriptors: Record<string, { type: string; default?: unknown }> = {};
  let registration: { method: string; path: string; auth: string | undefined } | undefined;
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  let getOverride: ((input: Parameters<ClientFactSdk["threads"]["get"]>[0]) => Promise<unknown>) | undefined;
  let eventsOverride: (() => Promise<unknown[]>) | undefined;
  const sdk = { threads: {
    async get(input: Parameters<ClientFactSdk["threads"]["get"]>[0]) {
      calls.push({ method: "get", input: { ...input } });
      if (getOverride) return getOverride(input);
      return { id: input.threadId, providerId: input.threadId === "thread-claude" ? "claude-code" : "codex",
        parentThreadId: null, sourceThreadId: null, lifecycleOwnerThreadId: null };
    },
    async list(input: Record<string, unknown>) { calls.push({ method: "list", input }); return []; },
    events: { async list(input: Record<string, unknown>) {
      calls.push({ method: "events", input });
      if (eventsOverride) return eventsOverride();
      const claude = input.threadId === "thread-claude";
      // Native retained event shape observed Nov 5: identity fields live in
      // data, while the exact BB turn is on the row's explicit turn scope.
      return [{ id: claude ? "accepted-claude-66" : "accepted-codex-61", threadId: input.threadId,
        seq: claude ? 66 : 61, createdAt: 1_794_000_000_000,
        type: "turn/input/accepted", scope: { kind: "turn", turnId: claude ? "bb-claude-t3" : "bb-codex-t4" },
        data: { providerThreadId: claude ? "native-claude-session" : "native-codex-session", clientRequestId: claude ? "canonical-claude-request" : "canonical-codex-request" },
      }];
    } },
  } } as unknown as ClientFactSdk;
  const bb = {
    settings: { define(input: typeof descriptors) { descriptors = input; return { async get() { return values; } }; } },
    http: { route(method: string, path: string, invoke: Handler, opts: { auth?: string }) { handler = invoke; registration = { method, path, auth: opts.auth }; } },
    sdk,
    log: { error(message: string) { errors.push(message); } },
  } as unknown as Pick<BbPluginApi, "settings" | "http" | "sdk" | "log">;
  registerClientFactHttp(bb);
  return { calls, errors, sdk,
    get descriptors() { return descriptors; }, get registration() { return registration; },
    setConfig(next: Partial<typeof configured>) { values = next; },
    overrideGet(next: typeof getOverride) { getOverride = next; },
    overrideEvents(next: typeof eventsOverride) { eventsOverride = next; },
    async invoke(raw: Request) {
      assert.ok(handler);
      return handler({ req: { raw } } as Parameters<Handler>[0]);
    },
  };
}
async function body(response: Response) { return await response.json() as Record<string, any>; }

test("fixed native-token route and explicit settings register without defaults or source work", () => {
  const f = fixture();
  assert.deepEqual(f.registration, { method: "POST", path: "/client-facts/v1/read", auth: "token" });
  assert.deepEqual(Object.keys(f.descriptors), ["sourceNamespace", "sourceEpoch"]);
  assert.ok(Object.values(f.descriptors).every(value => value.type === "string" && !("default" in value)));
  assert.equal(f.calls.length, 0);
});

test("unconfigured/invalid source identity returns clear 503 without breaking registration or reading SDK", async () => {
  const f = fixture();
  for (const values of [{}, { sourceNamespace: "only-one-field" }, { ...configured, sourceEpoch: "\ninvalid" }, { ...configured, sourceNamespace: " " }]) {
    f.setConfig(values);
    const response = await f.invoke(request());
    assert.equal(response.status, 503);
    const value = await body(response); assert.equal(value.error.code, "source_unconfigured");
    assert.match(value.error.message, /sourceNamespace and sourceEpoch/u);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(f.calls.length, 0);
  f.setConfig(configured);
  assert.equal((await f.invoke(request())).status, 200, "settings are read per admitted request; no cached guessed identity");
});

test("native Claude seq 66 and Codex seq 61 accepted events produce exact canonical mappings", async () => {
  const f = fixture();
  for (const provider of ["claude", "codex"]) {
    const response = await f.invoke(request(requestBody(`thread-${provider}`)));
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type")!, /application\/json/u);
    const value = await body(response), turn = value.facts.find((fact: any) => fact.kind === "turn_input");
    assert.equal(turn.clientRequest, `canonical-${provider}-request`);
    assert.equal(turn.clientTurn, provider === "claude" ? "bb-claude-t3" : "bb-codex-t4");
    assert.equal(turn.sequence, provider === "claude" ? 66 : 61);
    assert.equal(turn.session.id, `native-${provider}-session`);
    assert.equal(value.coverage.complete, false);
    assert.equal(value.coverage.claudeHttpTurn, "unsupported");
  }
});

test("bounded content length, streamed bytes, JSON type/encoding and closed shape fail before SDK reads", async () => {
  const f = fixture();
  const examples = [
    { raw: request(undefined, { headers: { "content-length": String(CLIENT_FACT_REQUEST_BYTES + 1) } }), status: 413, code: "request_too_large" },
    { raw: request(undefined, { raw: " ".repeat(CLIENT_FACT_REQUEST_BYTES + 1) }), status: 413, code: "request_too_large" },
    { raw: request(undefined, { headers: { "content-type": "text/plain" } }), status: 415, code: "unsupported_media_type" },
    { raw: request(undefined, { raw: "{" }), status: 400, code: "invalid_json" },
    { raw: request({ ...requestBody(), unapprovedLimit: 500 }), status: 400, code: "invalid_request" },
  ];
  for (const value of examples) {
    const response = await f.invoke(value.raw);
    assert.equal(response.status, value.status); assert.equal((await body(response)).error.code, value.code);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(f.calls.length, 0);
});

test("ignored request cancellation holds the single slot until the actual SDK read settles", async () => {
  const f = fixture(), controller = new AbortController();
  let release!: (value: unknown) => void;
  const reached = new Promise<void>(resolve => {
    f.overrideGet(async () => { resolve(); return new Promise(finish => { release = finish; }); });
  });
  const first = f.invoke(request(requestBody(), { signal: controller.signal }));
  await reached;
  assert.equal((await f.invoke(request())).status, 429);
  controller.abort(); await Promise.resolve();
  assert.equal((await f.invoke(request())).status, 429, "cancelled SDK call still occupies source admission");
  release({}); const cancelled = await first;
  assert.equal(cancelled.status, 499); assert.equal((await body(cancelled)).error.code, "cancelled");
  assert.equal(f.calls.length, 1, "no event read follows cancelled metadata work");
  f.overrideGet(undefined); assert.equal((await f.invoke(request())).status, 200);
});

test("request deadline aborts follow-on work but does not release an ignored SDK promise", async () => {
  const f = fixture(); let release!: (value: unknown) => void; let sourceSignal: AbortSignal | undefined;
  const reached = new Promise<void>(resolve => {
    f.overrideGet(async input => { sourceSignal = input.signal; resolve(); return new Promise(finish => { release = finish; }); });
  });
  const first = f.invoke(request()); await reached;
  await new Promise(resolve => setTimeout(resolve, 2_100));
  assert.equal(sourceSignal!.aborted, true);
  assert.equal((await f.invoke(request())).status, 429);
  release({}); const expired = await first;
  assert.equal(expired.status, 504); assert.equal((await body(expired)).error.code, "deadline_exceeded");
  assert.equal(f.calls.length, 1);
  f.overrideGet(undefined); assert.equal((await f.invoke(request())).status, 200);
});

test("source conflict/failure responses are finite and release admission after settlement", async () => {
  const f = fixture();
  f.overrideEvents(async () => [{ id: "unexpected", seq: 1, threadId: "other-conversation", type: "turn/input/accepted", data: {} }]);
  const conflict = await f.invoke(request()); assert.equal(conflict.status, 409);
  assert.equal((await body(conflict)).error.code, "source_conflict");
  f.overrideEvents(undefined);
  f.overrideGet(async () => { throw new Error("arbitrary operational backend failure"); });
  const unavailable = await f.invoke(request()); assert.equal(unavailable.status, 502);
  assert.deepEqual(Object.keys((await body(unavailable)).error), ["code", "message"]);
  assert.deepEqual(f.errors, ["Client-fact source read failed: arbitrary operational backend failure"]);
  f.overrideGet(undefined); assert.equal((await f.invoke(request())).status, 200);
});

test("request cancellation before invocation performs no SDK work", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  const response = await f.invoke(request(requestBody(), { signal: controller.signal }));
  assert.equal(response.status, 499); assert.equal(f.calls.length, 0);
});

test("unpaired UTF-16 surrogates in either configured source field fail before SDK work", async () => {
  for (const value of ["broken-\ud800", "broken-\udc00", "\ud800\ud800", "\udc00\ud800", "🧪\udfff"]) {
    for (const field of ["sourceNamespace", "sourceEpoch"] as const) {
      const f = fixture(); f.setConfig({ ...configured, [field]: value });
      const response = await f.invoke(request({ ...requestBody(), expectedSource: null }));
      assert.equal(response.status, 503); assert.equal((await body(response)).error.code, "source_unconfigured");
      assert.equal(f.calls.length, 0);
    }
  }
});

test("unpaired UTF-16 in request identity fields is a closed-input error before SDK work", async () => {
  const f = fixture(), invalid = "bad-\ud800";
  const examples = [
    { ...requestBody(), expectedSource: { namespace: invalid, epoch: "epoch" } },
    { ...requestBody(), expectedSource: { namespace: "namespace", epoch: invalid } },
    requestBody(invalid),
    { ...requestBody(), conversations: [{ id: "thread-codex", cursor: { sequence: 1, eventId: invalid } }] },
  ];
  for (const value of examples) {
    const response = await f.invoke(request(value));
    assert.equal(response.status, 400); assert.equal((await body(response)).error.code, "invalid_request");
  }
  assert.equal(f.calls.length, 0);
});

test("unpaired UTF-16 in native event and relationship identities is rejected rather than published", async () => {
  const accepted = () => ({ id: "accepted", threadId: "thread-codex", seq: 61,
    type: "turn/input/accepted", scope: { kind: "turn", turnId: "bb-turn" },
    data: { providerThreadId: "native-session", clientRequestId: "canonical" } });
  const malformed = [
    { ...accepted(), id: "event-\ud800" },
    { ...accepted(), scope: { kind: "turn", turnId: "turn-\udc00" } },
    { ...accepted(), data: { providerThreadId: "native-\ud800", clientRequestId: "canonical" } },
    { ...accepted(), data: { providerThreadId: "native-session", clientRequestId: "request-\udc00" } },
    { ...accepted(), type: "turn/completed", data: { providerThreadId: "native-session", providerCheckpointId: "checkpoint-\ud800" } },
  ];
  for (const value of malformed) {
    const f = fixture(); f.overrideEvents(async () => [value]);
    const response = await f.invoke(request());
    assert.equal(response.status, 502); assert.equal((await body(response)).error.code, "invalid_source");
  }
  const f = fixture();
  f.overrideGet(async () => ({ id: "thread-codex", providerId: "codex", parentThreadId: "parent-\ud800", sourceThreadId: null, lifecycleOwnerThreadId: null }));
  assert.equal((await f.invoke(request())).status, 502);
  assert.equal(f.calls.length, 1);
});

test("valid non-BMP identities round-trip and retain the 256 UTF-16-unit boundary", async () => {
  const width256 = "🧪".repeat(128), width258 = "🧪".repeat(129);
  assert.equal(width256.length, 256);
  const f = fixture(); f.setConfig({ sourceNamespace: width256, sourceEpoch: "época-🧪" });
  const accepted = (native: string) => [{ id: "accepted-🧪", threadId: "thread-codex", seq: 61,
    type: "turn/input/accepted", scope: { kind: "turn", turnId: "turn-🧪" },
    data: { providerThreadId: native, clientRequestId: "request-🧪" } }];
  f.overrideEvents(async () => accepted(width256));
  const response = await f.invoke(request({ ...requestBody(), expectedSource: null }));
  assert.equal(response.status, 200);
  const value = await body(response);
  assert.deepEqual(value.source, { namespace: width256, epoch: "época-🧪" });
  assert.equal(value.facts.find((fact: any) => fact.kind === "turn_input").session.id, width256);
  f.overrideEvents(async () => accepted(width258));
  assert.equal((await f.invoke(request({ ...requestBody(), expectedSource: null }))).status, 502);
  f.setConfig({ sourceNamespace: width258, sourceEpoch: "epoch" });
  const before = f.calls.length;
  assert.equal((await f.invoke(request({ ...requestBody(), expectedSource: null }))).status, 503);
  assert.equal(f.calls.length, before);
});
