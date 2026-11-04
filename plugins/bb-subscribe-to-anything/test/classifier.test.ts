import test from "node:test";
import assert from "node:assert/strict";
import { classify, MAX_INPUT_BYTES } from "../classifier.ts";
import { recipeSchema } from "../contracts.ts";
import type { Record, Run } from "../contracts.ts";
const signal = new AbortController().signal;
const run: Run = {
  id: "run",
  generation: 1,
  started_at: 10,
  ended_at: 20,
  duration_ms: 10,
  output: "pending evidence",
  stdout: "",
  stderr: "",
  exit_code: 0,
};
const record = {
  request: {
    subject: "https://example.com",
    notify_when: "ready",
    required_evidence: "proof",
  },
  created_at: 1,
  runs: [],
  recipe: recipeSchema.parse({
    script: "echo data",
    interpretation: "ready status",
    coverage: "sampled",
    evaluation: { kind: "semantic" },
  }),
} as unknown as Record;
const options = { enabled: true, model: "test", apiKey: "test-only", signal };
test("only valid confident pending bypasses review", async () => {
  for (const [validity, condition, confidence, expected] of [
    ["usable", "pending", 0.99, "pending"],
    ["invalid", "pending", 1, "review"],
    ["usable", "matched", 1, "review"],
    ["usable", "pending", 0.98, "review"],
    ["usable", "unknown", 1, "review"],
    ["usable", "pending", 2, "review"],
  ] as const) {
    const response = {
      answers: {
        validity: { choice: validity, confidence },
        condition: { choice: condition, confidence },
      },
    };
    const decision = await classify(record, run, {
      ...options,
      fetch: async () => Response.json(response),
    });
    assert.equal(decision.kind, expected);
  }
});
test("entire classifier body is bounded before any API call", async () => {
  let calls = 0;
  const response = await classify(
    { ...record, runs: [{ ...run, output: "x".repeat(MAX_INPUT_BYTES) }] },
    run,
    {
      ...options,
      fetch: async () => {
        calls++;
        return Response.json({});
      },
    },
  );
  assert.equal(calls, 0);
  assert.equal(response.kind, "review");
  assert.match(response.reason, /exceeds/);
});
test("metadata, criteria and unicode count toward byte budget", async () => {
  let calls = 0;
  const response = await classify(
    {
      ...record,
      request: {
        subject: "x",
        notify_when: "界".repeat(7000),
        required_evidence: "proof",
      },
    },
    run,
    {
      ...options,
      fetch: async () => {
        calls++;
        return Response.json({});
      },
    },
  );
  assert.equal(calls, 0);
  assert.equal(response.kind, "review");
});
test("collection errors never reach classifier and malformed/API failures never become pending", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return Response.json({});
  };
  assert.equal(
    (
      await classify(
        record,
        { ...run, problem: "timeout" },
        { ...options, fetch: fetcher },
      )
    ).kind,
    "review",
  );
  assert.equal(calls, 0);
  assert.equal(
    (await classify(record, run, { ...options, fetch: fetcher })).kind,
    "review",
  );
  assert.equal(
    (
      await classify(record, run, {
        ...options,
        fetch: async () => {
          throw Error("offline");
        },
      })
    ).kind,
    "review",
  );
});
test("exact projection rejects missing fields and object comparisons", async () => {
  const r = {
    ...record,
    recipe: {
      ...record.recipe!,
      evaluation: {
        kind: "json_equals" as const,
        path: ["ready"],
        value: true,
      },
    },
  };
  assert.equal(
    (await classify(r, { ...run, output: '{"other":true}' }, options)).kind,
    "review",
  );
  assert.equal(
    (await classify(r, { ...run, output: '{"ready":{}}' }, options)).kind,
    "review",
  );
});
test("zero history means none, not all retained executions", async () => {
  let state = "";
  await classify(
    {
      ...record,
      recipe: { ...record.recipe!, history_count: 0 },
      runs: [{ ...run, output: "x".repeat(MAX_INPUT_BYTES) }],
    },
    run,
    {
      ...options,
      fetch: async (_url, init) => {
        state = String(init?.body);
        return Response.json({});
      },
    },
  );
  assert.ok(state);
  assert.equal(JSON.parse(JSON.parse(state).state).history.length, 0);
});
test("semantic changes require a reviewed initial baseline without calling Jev", async () => {
  let calls = 0;
  const decision = await classify({ ...record, mode: "changes" }, run, {
    ...options,
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  assert.equal(decision.kind, "review");
  assert.equal(calls, 0);
});
