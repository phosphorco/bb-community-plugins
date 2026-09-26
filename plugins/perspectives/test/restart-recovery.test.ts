import assert from "node:assert/strict";
import test from "node:test";

import { runGatherPerspectives } from "../Perspectives.ts";

const REQUEST = {
  question: "How should a durable coordinator recover?",
  context: "We need bounded results and explicit uncertainty.",
  lenses: ["host restart", "queue delivery", "artifact integrity"],
};
const TOOL_CONTEXT = {
  projectId: "project-1",
  threadId: "caller-1",
  signal: new AbortController().signal,
} as any;

interface HarnessOptions {
  readonly spawnMode?: "success" | "commit-then-throw" | "throw-without-commit" | "duplicate-commit-then-throw";
  readonly sendMode?: "success" | "persist-then-throw" | "throw-without-row" | "row-without-content" | "row-with-wrong-content" | "row-with-failure";
  readonly noExecution?: boolean;
  readonly initialEventMode?: "exact" | "altered" | "missing";
}

function makeHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const rows: Array<Record<string, any>> = [];
  const children: Array<Record<string, any>> = [];
  const spawnCalls: Array<Record<string, any>> = [];
  const sendCalls: Array<Record<string, any>> = [];
  const prompts = new Map<string, string>();
  let nextRow = 0;

  const createChild = (args: Record<string, any>, id: string) => {
    const child = {
      id,
      parentThreadId: args.parentThreadId,
      visibility: args.visibility,
      title: args.title,
      prompt: args.prompt,
    };
    children.push(child);
    prompts.set(id, args.prompt);
  };

  const bb = {
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({
          id: threadId,
          projectId: "project-1",
          environmentId: "environment-1",
          providerId: "provider-1",
          parentThreadId: null,
          visibility: "visible",
          title: "caller",
        }),
        defaultExecutionOptions: async () => options.noExecution ? undefined : ({
          model: "model-1",
          reasoningLevel: "high",
          permissionMode: "auto",
          // Providers without service-tier support omit this value.
        }),
        send: async (args: Record<string, any>) => {
          events.push("send-backstop");
          sendCalls.push(args);
          if (options.sendMode === "throw-without-row") throw new Error("response unavailable");
          nextRow += 1;
          const message = args.input.map((part: { text?: string }) => part.text ?? "").join("\n");
          const row = {
            id: `queue-${nextRow}`,
            threadId: args.threadId,
            sendAt: args.sendAt,
            content: options.sendMode === "row-without-content"
              ? undefined
              : [{ type: "text", text: options.sendMode === "row-with-wrong-content" ? `${message} altered` : message }],
            failureReason: options.sendMode === "row-with-failure" ? "dispatch failed" : null,
            editable: options.sendMode !== "row-with-failure",
          };
          rows.push(row);
          if (options.sendMode === "persist-then-throw") throw new Error("response lost after queue commit");
          if (options.sendMode === "row-without-content") {
            return { delivery: "queued", queuedMessage: { ...row, content: undefined } };
          }
          return { delivery: "queued", queuedMessage: row };
        },
        spawn: async (args: Record<string, any>) => {
          events.push("spawn-coordinator");
          spawnCalls.push(args);
          assert.equal(rows.length, spawnCalls.length, "each caller backstop must be queued before its coordinator spawn");
          if (options.spawnMode === "commit-then-throw") {
            createChild(args, "coordinator-committed");
            throw Object.assign(new Error("HTTP 400 response after commit"), { status: 400 });
          }
          if (options.spawnMode === "duplicate-commit-then-throw") {
            createChild(args, "coordinator-committed-1");
            createChild(args, "coordinator-committed-2");
            throw new Error("response lost after duplicate commits");
          }
          if (options.spawnMode === "throw-without-commit") {
            throw Object.assign(new Error("HTTP 400 response; commit status unavailable"), { status: 400 });
          }
          const id = `coordinator-${spawnCalls.length}`;
          createChild(args, id);
          return { id };
        },
        list: async (args: Record<string, any>) => {
          events.push("list-children");
          return children
            .filter((child) => child.parentThreadId === args.parentThreadId)
            .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100));
        },
        promptHistory: async () => {
          throw new Error("Initial agent-only prompts are absent from BB prompt history");
        },
        events: {
          list: async ({ threadId, types, order, limit }: {
            threadId: string;
            types: string[];
            order: string;
            limit: string;
          }) => {
            events.push("read-initial-event");
            assert.deepEqual(types, ["client/turn/requested"]);
            assert.equal(order, "asc");
            assert.equal(limit, "1");
            if (options.initialEventMode === "missing" || !prompts.has(threadId)) return [];
            return [{ type: "client/turn/requested", data: { input: [{
              type: "text",
              text: options.initialEventMode === "altered"
                ? `${prompts.get(threadId)} altered`
                : prompts.get(threadId),
            }] } }];
          },
        },
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) => rows.filter((row) => row.threadId === threadId),
        },
      },
      providers: {
        list: async () => [],
        models: async () => ({ models: [], selectedOnlyModels: [], permissionCeiling: "auto" }),
      },
    },
  };

  return { bb, events, rows, children, spawnCalls, sendCalls };
}

function gather(harness: ReturnType<typeof makeHarness>, request = REQUEST) {
  return runGatherPerspectives(
    harness.bb as any,
    request,
    TOOL_CONTEXT,
    undefined,
    { spawnTimeoutMs: 25 },
  );
}

function markerFrom(value: string): string {
  const marker = value.match(/perspectives-invocation:[0-9a-f-]+/i)?.[0];
  assert.ok(marker, "invocation marker should be present");
  return marker;
}

test("gather queues one marker-bearing caller backstop before spawning the coordinator", async () => {
  const harness = makeHarness();
  const receipt = await gather(harness);

  assert.ok(harness.events.indexOf("send-backstop") < harness.events.indexOf("spawn-coordinator"));
  assert.equal(harness.sendCalls.length, 1);
  assert.equal(harness.rows.length, 1);
  assert.ok(harness.sendCalls[0]!.sendAt > Date.now() + 24 * 60_000);
  assert.equal(harness.sendCalls[0]!.threadId, TOOL_CONTEXT.threadId);
  assert.equal(harness.sendCalls[0]!.mode, "auto");

  const backstopText = harness.sendCalls[0]!.input[0]!.text as string;
  const marker = markerFrom(backstopText);
  const spawn = harness.spawnCalls[0]!;
  assert.ok(spawn.title.includes(marker));
  assert.ok(spawn.prompt.includes(marker));
  assert.equal(spawn.parentThreadId, TOOL_CONTEXT.threadId);
  assert.equal(spawn.visibility, "hidden");
  assert.equal(spawn.originKind, undefined, "the native parent-report default must remain in effect");
  assert.equal(spawn.serviceTier, undefined);
  assert.equal(spawn.executionInputSources.serviceTier, undefined);
  assert.match(backstopText, /"question": "How should a durable coordinator recover\?"/);
  assert.match(backstopText, /"orderedLenses": \[/);
  assert.match(backstopText, /"callerThreadId": "caller-1"/);
  assert.match(backstopText, /"coordinatorExecution":/);
  assert.match(backstopText, /"workerExecution":/);
  assert.match(receipt, /Perspectives panel launched/);
  assert.match(receipt, /Coordinator: @thread:coordinator-1/);
  assert.match(receipt, /Caller backstop: queued \(queue-1\)/);
});

test("an ambiguous spawn response recovers exactly one committed child by marker and prompt", async () => {
  const harness = makeHarness({ spawnMode: "commit-then-throw" });
  const receipt = await gather(harness);

  assert.match(receipt, /Coordinator: @thread:coordinator-committed/);
  assert.equal(harness.spawnCalls.length, 1, "recovery must not retry the spawn");
  assert.equal(harness.rows.length, 1, "the durable backstop remains in place");
  assert.ok(harness.events.indexOf("send-backstop") < harness.events.indexOf("spawn-coordinator"));
  assert.ok(harness.events.includes("list-children"));
  assert.ok(harness.events.includes("read-initial-event"));
});

test("an unresolved spawn returns launch uncertain without false success or blind retry", async () => {
  const harness = makeHarness({ spawnMode: "throw-without-commit" });

  await assert.rejects(gather(harness), (error: Error) => {
    assert.match(error.message, /Launch uncertain/);
    assert.match(error.message, new RegExp(markerFrom(harness.rows[0]!.content[0]!.text)));
    assert.match(error.message, /Caller backstop: queued \(queue-1\)/);
    assert.match(error.message, new RegExp(new Date(harness.rows[0]!.sendAt).toISOString()));
    return true;
  });
  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.children.length, 0);
  assert.equal(harness.rows.length, 1, "the backstop stays available for restart-time marker discovery");
});

test("marker match without the exact initial request prompt is not a recovered child", async () => {
  const harness = makeHarness({ spawnMode: "commit-then-throw", initialEventMode: "altered" });

  await assert.rejects(gather(harness), /Launch uncertain/);
  assert.equal(harness.children.length, 1);
  assert.equal(harness.rows.length, 1);
});

test("a missing initial request event leaves committed spawn identity uncertain", async () => {
  const harness = makeHarness({ spawnMode: "commit-then-throw", initialEventMode: "missing" });

  await assert.rejects(gather(harness), /Launch uncertain/);
  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.rows.length, 1);
});

test("multiple marker matches remain ambiguous and keep their separate child records", async () => {
  const harness = makeHarness({ spawnMode: "duplicate-commit-then-throw" });

  await assert.rejects(gather(harness), (error: unknown) => {
    assert.match(String((error as Error).message), /Launch uncertain/);
    assert.match(String((error as Error).message), /coordinator-committed-1, coordinator-committed-2/);
    return true;
  });
  assert.equal(harness.children.length, 2);
  assert.equal(harness.rows.length, 1);
  assert.equal(harness.spawnCalls.length, 1);
});

test("an ambiguous backstop response is reconciled from its queue row before spawn", async () => {
  const harness = makeHarness({ sendMode: "persist-then-throw" });
  const receipt = await gather(harness);

  assert.match(receipt, /Caller backstop: queued/);
  assert.equal(harness.sendCalls.length, 1, "queue reconciliation must not create a second row");
  assert.equal(harness.rows.length, 1);
  assert.ok(harness.events.indexOf("send-backstop") < harness.events.indexOf("spawn-coordinator"));
});

test("a caller backstop that cannot be confirmed prevents coordinator spawn", async () => {
  const harness = makeHarness({ sendMode: "throw-without-row" });

  await assert.rejects(gather(harness), /Caller backstop.*could not be confirmed/);
  assert.equal(harness.spawnCalls.length, 0);
  assert.equal(harness.rows.length, 0);
});

test("queue rows without content fail closed without a matching error", async () => {
  const harness = makeHarness({ sendMode: "row-without-content" });

  await assert.rejects(gather(harness), /Caller backstop.*could not be confirmed/);
  assert.equal(harness.spawnCalls.length, 0);
});

test("a row with the same marker and schedule but altered text is not the backstop", async () => {
  const harness = makeHarness({ sendMode: "row-with-wrong-content" });

  await assert.rejects(gather(harness), /Caller backstop.*could not be confirmed/);
  assert.equal(harness.spawnCalls.length, 0);
  assert.equal(harness.rows.length, 1);
});

test("a failed or claimed backstop row is not accepted as pending", async () => {
  const harness = makeHarness({ sendMode: "row-with-failure" });

  await assert.rejects(gather(harness), /Caller backstop.*could not be confirmed/);
  assert.equal(harness.spawnCalls.length, 0);
});

test("lens and execution validation happen before any durable queue or child effect", async () => {
  const invalidLenses = makeHarness();
  await assert.rejects(gather(invalidLenses, { ...REQUEST, lenses: ["same", "SAME"] }), /distinct lenses/);
  assert.equal(invalidLenses.sendCalls.length, 0);
  assert.equal(invalidLenses.spawnCalls.length, 0);

  const invalidExecution = makeHarness();
  await assert.rejects(runGatherPerspectives(
    invalidExecution.bb as any,
    REQUEST,
    TOOL_CONTEXT,
    { planner: { providerId: "missing-provider" }, worker: {} },
    { spawnTimeoutMs: 25 },
  ), /provider "missing-provider" is unavailable/);
  assert.equal(invalidExecution.sendCalls.length, 0);
  assert.equal(invalidExecution.spawnCalls.length, 0);
});

test("a replay starts a separate coordinator and gives concrete duplicate-disclosure guidance", async () => {
  const harness = makeHarness();
  const firstReceipt = await gather(harness);
  const firstPrompt = harness.spawnCalls[0]!.prompt as string;
  const secondReceipt = await gather(harness);
  const secondPrompt = harness.spawnCalls[1]!.prompt as string;

  assert.match(firstReceipt, /possible duplicates/);
  assert.match(secondReceipt, /identical requests may be intentional/);
  assert.notEqual(harness.children[0]!.id, harness.children[1]!.id);
  assert.notEqual(markerFrom(firstPrompt), markerFrom(secondPrompt));
  assert.equal(harness.rows.length, 2);
  assert.equal(harness.children.length, 2);
  assert.match(firstPrompt, /"callerThreadId": "caller-1"/);
  assert.match(firstPrompt, /"orderedLenses": \[/);
  assert.match(firstPrompt, /"projectId": "project-1"/);
  assert.match(firstPrompt, /"coordinatorExecution":/);
  assert.match(firstPrompt, /"workerExecution":/);
});

test("the product prompt defines reconciliation, bounded synthesis, and one verified artifact", async () => {
  const harness = makeHarness();
  await gather(harness);
  const prompt = harness.spawnCalls[0]!.prompt as string;

  assert.match(prompt, /^Perspectives coordinator protocol: 1/m);
  assert.match(prompt, /"protocolVersion": 1/);
  assert.match(prompt, /perspectives_coordinator_step/);
  assert.match(prompt, /perspectives_publish_result/);
  assert.match(prompt, /perspectives_read_result/);
  assert.match(prompt, /complete stored outputs/);
  assert.match(prompt, /missing output is unavailable evidence/);
  assert.match(prompt, /create-only atomic semantics/);
  assert.match(prompt, /full-file SHA-256/);
  assert.match(prompt, /explicit queue recovery or operator action/);
  assert.match(prompt, /Never promise an eventual wake/);
  assert.doesNotMatch(prompt, /\bbb (thread|file) /);
});

test("coordinator prompt grants scoped BB operations without inheriting worker-wide prohibitions", async () => {
  const harness = makeHarness();
  await gather(harness);
  const prompt = harness.spawnCalls[0]!.prompt as string;
  const coordinatorAuthority = prompt.slice(0, prompt.indexOf("## Complete run request"));
  const workerPolicyStart = prompt.indexOf("## Worker-only instructions");
  const workerPolicyEnd = prompt.indexOf("## Coordinator protocol", workerPolicyStart);
  const workerPolicy = prompt.slice(workerPolicyStart, workerPolicyEnd);

  assert.match(coordinatorAuthority, /^Perspectives coordinator protocol: 1\n\nYou are coordinating a read-only research panel\./);
  assert.match(coordinatorAuthority, /perspectives_coordinator_step reconciles its ordinary hidden children/);
  assert.match(coordinatorAuthority, /perspectives_publish_result verifies and publishes one result into this coordinator thread's storage/);
  assert.match(coordinatorAuthority, /A queue row, spawn response, worker count, native report, or tool response alone does not prove delivery/);
  assert.match(coordinatorAuthority, /Do not claim eventual delivery, exactly-once execution, guaranteed recovery/);
  assert.match(coordinatorAuthority, /Repository and source inspection is read-only/);
  assert.match(coordinatorAuthority, /Include the Perspectives READ_ONLY_INSTRUCTIONS policy in every worker prompt/);
  assert.doesNotMatch(coordinatorAuthority, /BB thread CLI operations/);
  assert.doesNotMatch(coordinatorAuthority, /BB file CLI operations/);
  assert.doesNotMatch(coordinatorAuthority, /This is an advisory, read-only assignment\./);
  assert.match(workerPolicy, /It limits workers only/);
  assert.match(workerPolicy, /This is an advisory, read-only assignment\./);
  assert.match(workerPolicy, /Do not edit, create, move, or delete files\./);
  assert.match(workerPolicy, /Do not commit, push, open pull requests, send messages, or mutate external systems\./);
});

// These cases require an isolated real auto-mode provider turn and a server
// restart while workers are active. SDK-boundary tests do not prove tool
// exposure to the provider or post-restart scheduled wake dispatch.
test.todo("live BB runtime: auto-mode tool call, restart during worker activity, dispatch a scheduled wake, and publish/read the artifact");
test.todo("live BB runtime: deliver the caller backstop after lost coordinator completion and verify readback once");
