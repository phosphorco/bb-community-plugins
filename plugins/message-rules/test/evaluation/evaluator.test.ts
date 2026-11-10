import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, prepare, decode } from "../../evaluation/evaluator.ts";
import { createHttpTransport } from "../../evaluation/transport.ts";
import { defaultConnection } from "../../contracts/model.ts";
import { captured, jevRule, count, answer } from "../helpers.ts";
const signal = new AbortController().signal;
test("multiple named checks share state, reverse response order binds exactly and retains uncertainty", async () => {
  const a = jevRule("one"),
    b = jevRule("two");
  b.advice = "Other advice";
  let calls = 0;
  const result = await evaluate(
    captured,
    [a, b],
    defaultConnection,
    async (wire) => {
      calls++;
      assert.equal(Object.keys(wire.questions).length, 2);
      assert.equal(
        Object.keys((wire.state as { evidence: object }).evidence).length,
        1,
      );
      const response = answer(wire);
      const keys = Object.keys(response.answers);
      response.answers[keys[0]!]!.choice = "no";
      response.answers[keys[0]!]!.probabilities = { yes: 0, no: 1 };
      return response;
    },
    signal,
    count,
  );
  assert.equal(calls, 1);
  assert.equal(result.rules[1]?.status, "allow");
  assert.equal(result.rules[0]?.status, "reject");
  assert.equal(
    (result.rules[0]?.observations.progress as { confidence: number })
      .confidence,
    0.6,
  );
});
test("wrong/missing/unexpected/model/duplicate-as-array answers cannot pass", () => {
  const p = prepare(captured, [jevRule()], defaultConnection, count)
    .partitions[0]!;
  for (const raw of [
    { ...answer(p.wire), model: "wrong" },
    { model: p.wire.model, answers: {} },
    { model: p.wire.model, answers: { unknown: {} } },
    { model: p.wire.model, answers: [{ name: "q0" }, { name: "q0" }] },
  ])
    assert.throws(() => decode(raw, p));
});
test("zero applicable and deterministic-only rules make zero calls", async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    throw Error("must not call");
  };
  assert.equal(
    (await evaluate(captured, [], defaultConnection, transport, signal)).policy,
    "allow",
  );
  const r = { ...jevRule(), action: "reject" as const, criteria: [] };
  assert.equal(
    (await evaluate(captured, [r], defaultConnection, transport, signal))
      .policy,
    "reject",
  );
  assert.equal(calls, 0);
});
test("unknown mandatory checks hold after known rejection; all applicable checks still attempted", async () => {
  const r = jevRule("known"),
    s = jevRule("missing");
  s.criteria[0]!.context.senderHistory = 2;
  const result = await evaluate(
    { ...captured, sender: { ...captured.sender, coverage: "unavailable" } },
    [r, s],
    defaultConnection,
    async (wire) => answer(wire),
    signal,
    count,
  );
  assert.equal(result.policy, "unknown");
  assert.equal(result.rules[0]?.status, "reject");
  assert.deepEqual(result.advice, []);
});
test("different context windows select distinct evidence and unavailable remains unknown", () => {
  const a = jevRule("one"),
    b = jevRule("two");
  a.criteria[0]!.context.senderHistory = 1;
  b.criteria[0]!.context.senderHistory = 3;
  const c = {
    ...captured,
    sender: {
      ...captured.sender,
      events: [1, 2, 3].map((n) => ({
        id: "e" + n,
        text: String(n),
        sequence: n,
      })),
    },
  };
  const p = prepare(c, [a, b], defaultConnection, count).partitions[0]!;
  const q = Object.values(p.wire.questions);
  assert.match(q[0]!.instructions, /sender:e3/);
  assert.doesNotMatch(q[0]!.instructions, /sender:e1/);
  assert.match(q[1]!.instructions, /sender:e1/);
});
test("whole-request and singleton limits fail before calls; no service question-count cap", async () => {
  const rules = Array.from({ length: 40 }, (_, i) => jevRule("rule-" + i));
  assert.equal(
    prepare(
      captured,
      rules,
      { ...defaultConnection, maxWireBytes: 1000000 },
      () => 1,
    ).partitions.length,
    1,
  );
  const oversized = prepare(
    captured,
    [jevRule()],
    { ...defaultConnection, perQuestionTokens: 1 },
    count,
  );
  assert.equal(oversized.partitions.length, 0);
  assert.ok(oversized.errors.length);
  const partitioned = prepare(
    captured,
    rules,
    { ...defaultConnection, perRequestTokens: 2000, maxCalls: 100 },
    count,
  );
  assert.ok(partitioned.partitions.length > 1);
  assert.equal(
    new Set(partitioned.partitions.flatMap((p) => Object.keys(p.bindings)))
      .size,
    40,
  );
});
test("provider-checked admission without a counter dispatches once; transport faults remain unresolved", async () => {
  let calls = 0;
  const result = await evaluate(
    captured,
    [jevRule()],
    defaultConnection,
    async () => {
      calls++;
      throw Error("timeout");
    },
    signal,
  );
  assert.equal(result.policy, "unknown");
  assert.equal(calls, 1);
  assert.equal(result.contextAdmission, "provider-checked");
  assert.match(result.errors.join(" "), /timeout/);
  assert.equal(
    (
      await evaluate(
        captured,
        [jevRule()],
        defaultConnection,
        async () => {
          throw Error("timeout");
        },
        signal,
        count,
      )
    ).policy,
    "unknown",
  );
});
test("real configured HTTP transport uses own credential, bounded body and no retries", async () => {
  let calls = 0;
  const p = prepare(captured, [jevRule()], defaultConnection, count)
    .partitions[0]!;
  const transport = createHttpTransport(
    defaultConnection,
    async () => "private-test-key",
    async (url, init) => {
      calls++;
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer private-test-key",
      );
      return new Response(JSON.stringify(answer(p.wire)));
    },
  );
  assert.deepEqual(await transport(p.wire, signal), answer(p.wire));
  assert.equal(calls, 1);
  const bad = createHttpTransport(
    defaultConnection,
    async () => "private-test-key",
    async () => new Response("private-test-key denied", { status: 401 }),
  );
  await assert.rejects(
    () => bad(p.wire, signal),
    (e) => e instanceof Error && !e.message.includes("private-test-key"),
  );
  const no = createHttpTransport(
    defaultConnection,
    async () => null,
    async () => {
      throw Error("must not invoke");
    },
  );
  await assert.rejects(() => no(p.wire, signal), /not configured/);
});
test("duplicate JSON wire keys fail, not last-value-wins; oversized response stays unknown", async () => {
  const p = prepare(captured, [jevRule()], defaultConnection, count)
    .partitions[0]!;
  const value = JSON.stringify(answer(p.wire).answers.q0);
  const duplicated = `{"model":"${defaultConnection.model}","answers":{"q0":${value},"q0":${value}}}`;
  const t = createHttpTransport(
    defaultConnection,
    async () => "own-key",
    async () => new Response(duplicated),
  );
  await assert.rejects(() => t(p.wire, signal), /Duplicate JSON/);
  const huge = createHttpTransport(
    { ...defaultConnection, maxResponseBytes: 1024 },
    async () => "own-key",
    async () => new Response("x".repeat(2048)),
  );
  await assert.rejects(() => huge(p.wire, signal), /Response exceeds/);
});
