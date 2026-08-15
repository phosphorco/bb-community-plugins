import { describe, test } from "node:test";

import { expect } from "./expect.ts";

import {
  collectPanelResults,
  parsePerspectivePlan,
  runGatherPerspectives,
  runHelp,
  type Perspective,
  type PerspectiveResult,
} from "../Perspectives.ts";

function perspectiveTable(rows: readonly (readonly [string, string, string])[]): string {
  return [
    "| Lens | Why this lens | Expert prompt |",
    "| --- | --- | --- |",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

test("help keeps expert construction outside the caller thread", async () => {
  const spawnCalls: Array<Record<string, unknown>> = [];
  let nextThread = 0;
  const never = new Promise<never>(() => undefined);
  const bb = {
    sdk: {
      threads: {
        get: async () => ({ environmentId: "environment", providerId: "provider" }),
        defaultExecutionOptions: async () => null,
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

  expect(result).toBe(`The boundary is separate. [internal consultation reference omitted]

Expert consultation: @thread:thread-2`);
  expect(result).not.toContain("@thread:thread-1");
  expect(spawnCalls).toHaveLength(2);
  expect(spawnCalls.every((call) => call.parentThreadId === undefined)).toBe(true);
  expect(String(spawnCalls[0]!.prompt)).toContain("| Lens | Why this lens | Expert prompt |");
  expect(String(spawnCalls[0]!.prompt)).not.toContain("Return JSON");
  expect(String(spawnCalls[1]!.prompt)).toContain("Answer directly from the supplied question and context");
  expect(String(spawnCalls[1]!.prompt)).toContain("Return only the minimum needed");
  expect(String(spawnCalls[1]!.prompt)).toContain("Support every material factual claim");
  expect(String(spawnCalls[1]!.prompt)).toContain("## Sources");
  expect(String(spawnCalls[1]!.prompt)).toContain("Internal planning provenance for inspection only: @thread:thread-1");
});

test("gather_perspectives exposes only the final synthesis thread", async () => {
  let nextThread = 0;
  let callerReads = 0;
  let executionReads = 0;
  const never = new Promise<never>(() => undefined);
  const outputs = new Map<string, string>();
  const prompts = new Map<string, string>();
  const bb = {
    sdk: {
      threads: {
        get: async () => {
          callerReads += 1;
          return { environmentId: "environment", providerId: "provider" };
        },
        defaultExecutionOptions: async () => {
          executionReads += 1;
          return null;
        },
        spawn: async ({ title, prompt }: { title: string; prompt: string }) => {
          nextThread += 1;
          const threadId = `thread-${nextThread}`;
          prompts.set(title, prompt);
          if (title.startsWith("Perspective planner")) {
            outputs.set(threadId, perspectiveTable(
              ["runtime", "complexity", "duplication"].map((name) => [
                name,
                `${name} matters.`,
                `You are the ${name} expert with a distinct investigative focus and evidence standard.`,
              ]),
            ));
          } else if (title === "Perspective synthesis") {
            outputs.set(threadId, "Unified answer accidentally echoed @thread:thread-2.");
          } else {
            outputs.set(threadId, `${title} answer.`);
          }
          return { id: threadId };
        },
        wait: async ({ status }: { status: string }) => status === "idle" ? {} : never,
        output: async ({ threadId }: { threadId: string }) => ({ output: outputs.get(threadId) }),
        send: async () => undefined,
        stop: async () => undefined,
      },
    },
  };

  const result = await runGatherPerspectives(
    bb as any,
    { question: "Which implementation is best?", lenses: ["runtime", "complexity", "duplication"] },
    { projectId: "project", threadId: "caller", signal: new AbortController().signal } as any,
  );

  expect(result).toBe(`Unified answer accidentally echoed [internal consultation reference omitted].

Final synthesis: @thread:thread-5`);
  expect(result).not.toContain("@thread:thread-2");
  expect(prompts.get("Perspective synthesis")).toContain("Internal evidence thread: @thread:thread-2");
  expect(prompts.get("Perspective synthesis")).toContain("Internal planning provenance: @thread:thread-1");
  expect(prompts.get("Perspective synthesis")).toContain("Do not include them in the answer or Sources section");
  expect(callerReads).toBe(1);
  expect(executionReads).toBe(1);
});

test("gather_perspectives synthesizes complete, partial, and failed worker outcomes", async () => {
  let nextThread = 0;
  const outputs = new Map<string, string>();
  const titles = new Map<string, string>();
  const prompts = new Map<string, string>();
  const bb = {
    sdk: {
      threads: {
        get: async () => ({ environmentId: "environment", providerId: "provider" }),
        defaultExecutionOptions: async () => null,
        spawn: async ({ title, prompt }: { title: string; prompt: string }) => {
          nextThread += 1;
          const threadId = `thread-${nextThread}`;
          titles.set(threadId, title);
          prompts.set(title, prompt);
          if (title.startsWith("Perspective planner")) {
            outputs.set(threadId, perspectiveTable(
              ["complete", "partial", "failed"].map((name) => [
                name,
                `${name} matters.`,
                `You are the ${name} expert with a distinct investigative focus and evidence standard.`,
              ]),
            ));
          } else if (title.includes("complete")) {
            outputs.set(threadId, "Complete answer.");
          } else if (title.includes("partial")) {
            outputs.set(threadId, "Partial answer recovered before timeout.");
          } else if (title === "Perspective synthesis") {
            outputs.set(threadId, "Synthesis used all available evidence.");
          }
          return { id: threadId };
        },
        wait: async ({ threadId }: { threadId: string }) => {
          const title = titles.get(threadId) ?? "";
          if (title.includes("partial")) {
            const error = new Error("worker deadline reached");
            error.name = "ThreadWaitTimeoutError";
            throw error;
          }
          if (title.includes("failed")) {
            const error = new Error("worker entered error state");
            error.name = "ThreadWaitUnreachableError";
            throw error;
          }
          return {};
        },
        output: async ({ threadId }: { threadId: string }) => ({ output: outputs.get(threadId) }),
        send: async () => undefined,
        stop: async () => undefined,
      },
    },
  };

  const result = await runGatherPerspectives(
    bb as any,
    { question: "What should we do?", lenses: ["complete", "partial", "failed"] },
    { projectId: "project", threadId: "caller", signal: new AbortController().signal } as any,
  );

  const synthesis = prompts.get("Perspective synthesis")!;
  expect(synthesis).toContain("Status: Complete");
  expect(synthesis).toContain("Status: Incomplete (timed out)");
  expect(synthesis).toContain("Partial answer recovered before timeout.");
  expect(synthesis).toContain("Status: Unavailable (failed)");
  expect(synthesis).toContain("Preserve source citations from the perspective outputs");
  expect(synthesis).toContain("## Sources");
  expect(result).toContain("Synthesis used all available evidence.");
  expect(result).toContain("Final synthesis: @thread:thread-5");
  expect(result).not.toContain("@thread:thread-1");
  expect(synthesis).toContain("Do not include thread IDs or internal consultation references.");
});

test("gather_perspectives degrades one launch failure without cancelling the panel", async () => {
  let nextThread = 0;
  const outputs = new Map<string, string>();
  let synthesisPrompt = "";
  let stops = 0;
  const bb = {
    sdk: {
      threads: {
        get: async () => ({ environmentId: "environment", providerId: "provider" }),
        defaultExecutionOptions: async () => null,
        spawn: async ({ title, prompt }: { title: string; prompt: string }) => {
          if (title.includes("two")) throw new Error("provider refused launch");
          nextThread += 1;
          const threadId = `thread-${nextThread}`;
          if (title.startsWith("Perspective planner")) {
            outputs.set(threadId, perspectiveTable(
              ["one", "two", "three"].map((name) => [
                name,
                `${name} matters.`,
                `You are the ${name} expert with a distinct investigative focus and evidence standard.`,
              ]),
            ));
          } else if (title === "Perspective synthesis") {
            synthesisPrompt = prompt;
            outputs.set(threadId, "Synthesis survived a launch failure.");
          } else {
            outputs.set(threadId, `${title} answer.`);
          }
          return { id: threadId };
        },
        wait: async () => ({}),
        output: async ({ threadId }: { threadId: string }) => ({ output: outputs.get(threadId) }),
        send: async () => undefined,
        stop: async () => {
          stops += 1;
        },
      },
    },
  };

  const result = await runGatherPerspectives(
    bb as any,
    { question: "What should we do?", lenses: ["one", "two", "three"] },
    { projectId: "project", threadId: "caller", signal: new AbortController().signal } as any,
  );

  expect(result).toContain("Synthesis survived a launch failure.");
  expect(synthesisPrompt).toContain("Agent could not be launched: provider refused launch");
  expect(synthesisPrompt).toContain("Status: Unavailable (failed)");
  expect(stops).toBe(0);
});

test("gather_perspectives returns preserved answers when synthesis cannot launch", async () => {
  let nextThread = 0;
  const outputs = new Map<string, string>();
  const bb = {
    sdk: {
      threads: {
        get: async () => ({ environmentId: "environment", providerId: "provider" }),
        defaultExecutionOptions: async () => null,
        spawn: async ({ title }: { title: string }) => {
          if (title === "Perspective synthesis") throw new Error("synthesis provider unavailable");
          nextThread += 1;
          const threadId = `thread-${nextThread}`;
          if (title.startsWith("Perspective planner")) {
            outputs.set(threadId, perspectiveTable(
              ["one", "two", "three"].map((name) => [
                name,
                `${name} matters.`,
                `You are the ${name} expert with a distinct investigative focus and evidence standard.`,
              ]),
            ));
          } else {
            outputs.set(threadId, `${title} answer.`);
          }
          return { id: threadId };
        },
        wait: async () => ({}),
        output: async ({ threadId }: { threadId: string }) => ({ output: outputs.get(threadId) }),
        send: async () => undefined,
        stop: async () => undefined,
      },
    },
  };

  const result = await runGatherPerspectives(
    bb as any,
    { question: "What should we do?", lenses: ["one", "two", "three"] },
    { projectId: "project", threadId: "caller", signal: new AbortController().signal } as any,
  );

  expect(result).toContain("## Synthesis unavailable");
  expect(result).toContain("The synthesis agent could not be launched: synthesis provider unavailable");
  expect(result).toContain("Perspective 1: one answer.");
  expect(result).not.toContain("@thread:");
});

test("gather_perspectives falls back to caller lenses when planning fails", async () => {
  let nextThread = 0;
  const outputs = new Map<string, string>();
  const workerPrompts: string[] = [];
  const bb = {
    sdk: {
      threads: {
        get: async () => ({ environmentId: "environment", providerId: "provider" }),
        defaultExecutionOptions: async () => null,
        spawn: async ({ title, prompt }: { title: string; prompt: string }) => {
          nextThread += 1;
          const threadId = `thread-${nextThread}`;
          if (title.startsWith("Perspective planner")) {
            outputs.set(threadId, "Malformed planner output.");
          } else if (title === "Perspective synthesis") {
            outputs.set(threadId, "Fallback panel synthesized.");
          } else {
            workerPrompts.push(prompt);
            outputs.set(threadId, `${title} answer.`);
          }
          return { id: threadId };
        },
        wait: async () => ({}),
        output: async ({ threadId }: { threadId: string }) => ({ output: outputs.get(threadId) }),
        send: async () => undefined,
        stop: async () => undefined,
      },
    },
  };

  const result = await runGatherPerspectives(
    bb as any,
    { question: "What should we do?", lenses: ["one", "two", "three"] },
    { projectId: "project", threadId: "caller", signal: new AbortController().signal } as any,
  );

  expect(result).toContain("Fallback panel synthesized.");
  expect(workerPrompts).toHaveLength(3);
  expect(workerPrompts[0]).toContain("Perspective assignment: one");
  expect(workerPrompts[1]).toContain("Perspective assignment: two");
  expect(workerPrompts[2]).toContain("Perspective assignment: three");
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function perspective(name: string): Perspective {
  return {
    name,
    rationale: `${name} is necessary.`,
    expertPrompt: `You are the ${name} expert with a distinct evidence standard and investigative focus.`,
  };
}

function succeeded(item: Perspective, threadId: string): PerspectiveResult {
  return {
    perspective: item,
    threadId,
    status: "succeeded",
    output: `${item.name} answer`,
  };
}

function failed(item: Perspective, threadId: string): PerspectiveResult {
  return {
    perspective: item,
    threadId,
    status: "failed",
    output: "",
    error: "failed",
  };
}

function agent(name: string) {
  const item = perspective(name);
  const completion = deferred<PerspectiveResult>();
  const events: string[] = [];
  return {
    item,
    completion,
    events,
    handle: {
      perspective: item,
      threadId: name,
      result: completion.promise,
      steer: async () => {
        events.push("steer");
      },
      stop: async () => {
        events.push("stop");
      },
    },
  };
}

describe("perspective plans", () => {
  test("requires a separately generated expert prompt for every perspective", () => {
    const plan = parsePerspectivePlan(
      perspectiveTable([
        [
          "Architecture",
          "Recover the system boundary.",
          "You are a distributed-systems architect who proves boundaries through dependency and failure analysis.",
        ],
        [
          "Operations",
          "Expose runtime hazards.",
          "You are a production operator who prioritizes observability, recovery, and bounded failure modes.",
        ],
        [
          "Adoption",
          "Test whether people can use it.",
          "You are a product adoption specialist who investigates workflow fit, clarity, and switching costs.",
        ],
      ]),
      ["Architecture", "Operations", "Adoption"],
    );

    expect(plan.map((item) => item.name)).toEqual(["Architecture", "Operations", "Adoption"]);
    expect(new Set(plan.map((item) => item.expertPrompt)).size).toBe(3);
  });

  test("rejects a shared expert prompt reused across perspectives", () => {
    const shared = "You are a broadly capable expert who analyzes the question and reports important tradeoffs and risks.";
    expect(() => parsePerspectivePlan(perspectiveTable([
      ["One", "First.", shared],
      ["Two", "Second.", shared],
      ["Three", "Third.", shared],
    ]), ["One", "Two", "Three"])).toThrow("reused an expert prompt");
  });

  test("rejects planner attempts to rename or reorder caller lenses", () => {
    expect(() => parsePerspectivePlan(perspectiveTable([
      [
        "Complexity analysis",
        "Analyze growth.",
        "You are an algorithms expert who analyzes asymptotic growth and computational bounds.",
      ],
      [
        "duplicate work",
        "Find repetition.",
        "You are a systems profiler who finds redundant computation and repeated work.",
      ],
      [
        "v8 performance characteristics",
        "Inspect runtime behavior.",
        "You are a V8 performance expert who analyzes runtime optimization and deoptimization behavior.",
      ],
    ]), ["v8 performance characteristics", "big-O complexity", "duplicate work"]))
      .toThrow("must preserve caller lens");
  });

  test("parses escaped pipes in reviewable planner tables", () => {
    const [plan] = parsePerspectivePlan(
      perspectiveTable([[
        "Correctness",
        "Compare safety \\| liveness.",
        "You are a formal-methods expert who checks safety \\| liveness with explicit counterexamples.",
      ]]),
      ["Correctness"],
    );

    expect(plan).toEqual({
      name: "Correctness",
      rationale: "Compare safety | liveness.",
      expertPrompt: "You are a formal-methods expert who checks safety | liveness with explicit counterexamples.",
    });
  });

  test("rejects the former JSON planner protocol", () => {
    expect(() => parsePerspectivePlan(JSON.stringify({
      perspectives: [{
        name: "Correctness",
        rationale: "Find defects.",
        expertPrompt: "You are a correctness expert who looks for concrete counterexamples.",
      }],
    }), ["Correctness"])).toThrow("no perspective table");
  });
});

describe("panel collection", () => {
  test("does not cut off workers when a majority finishes", async () => {
    const agents = [agent("one"), agent("two"), agent("three"), agent("four"), agent("five")];
    const collected = collectPanelResults(agents.map((item) => item.handle), Date.now() + 1_000);

    agents[0]!.completion.resolve(succeeded(agents[0]!.item, "one"));
    agents[1]!.completion.resolve(succeeded(agents[1]!.item, "two"));
    agents[2]!.completion.resolve(succeeded(agents[2]!.item, "three"));
    await Promise.resolve();

    expect(agents[3]!.events).toEqual([]);
    expect(agents[4]!.events).toEqual([]);

    agents[3]!.completion.resolve(succeeded(agents[3]!.item, "four"));
    agents[4]!.completion.resolve(succeeded(agents[4]!.item, "five"));

    const results = await collected;

    expect(results.filter((result) => result.status === "succeeded")).toHaveLength(5);
    expect(agents.flatMap((item) => item.events)).toEqual([]);
  });

  test("asks only unfinished workers to wrap up at the phase boundary", async () => {
    const agents = [agent("one"), agent("two"), agent("three")];
    for (const pending of agents.slice(1)) {
      pending.handle.steer = async () => {
        pending.events.push("steer");
        pending.completion.resolve(succeeded(pending.item, pending.item.name));
      };
    }
    const collected = collectPanelResults(agents.map((item) => item.handle), Date.now() + 5);

    agents[0]!.completion.resolve(succeeded(agents[0]!.item, "one"));

    const results = await collected;

    expect(results.map((result) => result.perspective.name)).toEqual(["one", "two", "three"]);
    expect(agents[0]!.events).toEqual([]);
    expect(agents[1]!.events).toEqual(["steer"]);
    expect(agents[2]!.events).toEqual(["steer"]);
  });

  test("preserves lens order and every terminal outcome", async () => {
    const agents = [agent("one"), agent("two"), agent("three")];
    const collected = collectPanelResults(agents.map((item) => item.handle), Date.now() + 1_000);

    agents[2]!.completion.resolve({
      ...failed(agents[2]!.item, "three"),
      status: "timed_out",
      output: "partial three",
    });
    agents[0]!.completion.resolve(succeeded(agents[0]!.item, "one"));
    agents[1]!.completion.resolve(failed(agents[1]!.item, "two"));

    const results = await collected;

    expect(results.map((result) => result.perspective.name)).toEqual(["one", "two", "three"]);
    expect(results.map((result) => result.status)).toEqual(["succeeded", "failed", "timed_out"]);
    expect(results[2]!.output).toBe("partial three");
    expect(agents.flatMap((item) => item.events)).toEqual([]);
  });
});
