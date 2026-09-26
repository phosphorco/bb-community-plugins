import assert from "node:assert/strict";
import test from "node:test";

import { parsePerspectivePlan, runHelp } from "../Perspectives.ts";

function perspectiveTable(rows: readonly (readonly [string, string, string])[]): string {
  return [
    "| Lens | Why this lens | Expert prompt |",
    "| --- | --- | --- |",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function callerExecution() {
  return {
    providerId: "provider",
    model: "model",
    serviceTier: "default",
    reasoningLevel: "medium",
    permissionMode: "auto",
  } as const;
}

test("help keeps expert construction outside the caller thread", async () => {
  const spawnCalls: Array<Record<string, unknown>> = [];
  let nextThread = 0;
  const never = new Promise<never>(() => undefined);
  const bb = {
    sdk: {
      threads: {
        get: async () => ({ environmentId: "environment", providerId: "provider" }),
        defaultExecutionOptions: async () => callerExecution(),
        spawn: async (input: Record<string, unknown>) => {
          spawnCalls.push(input);
          nextThread += 1;
          return { id: `thread-${nextThread}` };
        },
        wait: async ({ status }: { status: string }) => status === "idle" ? {} : never,
        output: async ({ threadId }: { threadId: string }) => ({
          output: threadId === "thread-1"
            ? perspectiveTable([[
              "Boundary expert",
              "Keep responsibilities separate.",
              "You are a boundary expert who analyzes responsibility and context separation.",
            ]])
            : "The boundary is separate. @thread:thread-1",
        }),
        stop: async () => undefined,
      },
    },
  };

  const result = await runHelp(
    bb as any,
    { question: "Who should generate the expert prompt?" },
    { projectId: "project", threadId: "caller", signal: new AbortController().signal } as any,
  );

  assert.equal(result, `The boundary is separate. [internal consultation reference omitted]

Expert consultation: @thread:thread-2`);
  assert.doesNotMatch(result, /@thread:thread-1/);
  assert.equal(spawnCalls.length, 2);
  assert.ok(spawnCalls.every((call) => call.parentThreadId === undefined));
  assert.match(String(spawnCalls[0]!.prompt), /\| Lens \| Why this lens \| Expert prompt \|/);
  assert.doesNotMatch(String(spawnCalls[0]!.prompt), /Return JSON/);
  assert.match(String(spawnCalls[1]!.prompt), /Answer directly from the supplied question and context/);
  assert.match(String(spawnCalls[1]!.prompt), /Support every material factual claim/);
  assert.match(String(spawnCalls[1]!.prompt), /## Sources/);
});

test("perspective plans preserve caller order and parse escaped pipes", () => {
  const plan = parsePerspectivePlan(
    perspectiveTable([
      [
        "Correctness",
        "Compare safety \\| liveness.",
        "You are a formal-methods expert who checks safety \\| liveness with explicit counterexamples.",
      ],
      [
        "Operations",
        "Recover the service.",
        "You are an operations expert who traces durable state, restart paths, and bounded recovery outcomes.",
      ],
    ]),
    ["Correctness", "Operations"],
  );

  assert.deepEqual(plan.map(({ name }) => name), ["Correctness", "Operations"]);
  assert.equal(plan[0]!.rationale, "Compare safety | liveness.");
  assert.throws(() => parsePerspectivePlan(
    perspectiveTable([
      ["Operations", "Recover the service.", "You are an operations expert who traces durable state, restart paths, and bounded recovery outcomes."],
      ["Correctness", "Find defects.", "You are a formal-methods expert who checks safety and liveness with explicit counterexamples."],
    ]),
    ["Correctness", "Operations"],
  ), /preserve caller lens/);
});

test("perspective plans give each caller lens a distinct expert prompt", () => {
  const plan = parsePerspectivePlan(
    perspectiveTable([
      [
        "Architecture",
        "Recover the system boundary.",
        "You are a distributed-systems architect who proves boundaries through dependencies and failure analysis.",
      ],
      [
        "Operations",
        "Expose runtime hazards.",
        "You are a production operator who prioritizes observability, recovery, and bounded failure modes.",
      ],
    ]),
    ["Architecture", "Operations"],
  );

  assert.equal(new Set(plan.map(({ expertPrompt }) => expertPrompt)).size, 2);
});

test("perspective plans reject reused expert prompts and renamed lenses", () => {
  const shared = "You are an expert who investigates the question and reports evidence, tradeoffs, and uncertainty.";
  assert.throws(() => parsePerspectivePlan(perspectiveTable([
    ["Architecture", "Inspect the boundary.", shared],
    ["Operations", "Inspect recovery.", shared],
  ]), ["Architecture", "Operations"]), /reused an expert prompt/);

  assert.throws(() => parsePerspectivePlan(perspectiveTable([
    ["Architecture design", "Inspect the boundary.", "You are an architect who traces dependencies, failure boundaries, and recovery behavior."],
    ["Operations", "Inspect recovery.", "You are an operator who examines retries, queue delays, and partial outcomes."],
  ]), ["Architecture", "Operations"]), /preserve caller lens/);
});

test("perspective plans reject the former JSON protocol", () => {
  assert.throws(() => parsePerspectivePlan(JSON.stringify({
    perspectives: [{
      name: "Correctness",
      rationale: "Find defects.",
      expertPrompt: "You are a correctness expert who finds concrete counterexamples.",
    }],
  }), ["Correctness"]), /no perspective table/);
});
