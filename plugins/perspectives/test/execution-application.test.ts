import assert from "node:assert/strict";
import test from "node:test";

import { deliverGatherPerspectives } from "../Perspectives.ts";

test("configured planner and worker tuples reach the coordinator and its worker launch request", async () => {
  const spawnCalls: Array<Record<string, any>> = [];
  const events: string[] = [];
  const queuedRows: Array<Record<string, any>> = [];

  const bb = {
    sdk: {
      providers: {
        list: async () => [
          {
            id: "codex",
            available: true,
            capabilities: {
              supportsServiceTier: true,
              permissionModes: ["accept-edits", "auto", "full"],
            },
          },
          {
            id: "terra",
            available: true,
            capabilities: {
              supportsServiceTier: true,
              permissionModes: ["accept-edits", "auto"],
            },
          },
        ],
        models: async ({ providerId }: { providerId: string }) => ({
          providers: [],
          permissionCeiling: "full",
          models: providerId === "codex"
            ? [{
                id: "gpt-5.6",
                model: "gpt-5.6",
                supportedReasoningEfforts: [{ reasoningEffort: "high" }],
                defaultReasoningEffort: "high",
                isDefault: true,
              }]
            : [{
                id: "gpt-5.6-terra",
                model: "gpt-5.6-terra",
                supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
                defaultReasoningEffort: "medium",
                isDefault: true,
              }],
          selectedOnlyModels: [],
          modelLoadError: null,
        }),
      },
      threads: {
        get: async () => ({ environmentId: "environment", providerId: "caller-provider" }),
        defaultExecutionOptions: async () => ({
          providerId: "caller-provider",
          model: "caller-model",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "auto",
        }),
        send: async (input: Record<string, any>) => {
          events.push("queue-caller-backstop");
          const row = {
            id: "backstop-1",
            threadId: input.threadId,
            sendAt: input.sendAt,
            content: input.input,
            failureReason: null,
            editable: true,
          };
          queuedRows.push(row);
          return { delivery: "queued", queuedMessage: row };
        },
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) =>
            queuedRows.filter((row) => row.threadId === threadId),
        },
        spawn: async (input: Record<string, any>) => {
          events.push("spawn-coordinator");
          spawnCalls.push(input);
          return { id: "coordinator-1" };
        },
      },
    },
  };

  const receipt = await deliverGatherPerspectives(
    bb as any,
    {
      question: "Which implementation is best?",
      lenses: ["runtime", "complexity", "duplication"],
    },
    {
      projectId: "project",
      threadId: "caller",
      signal: new AbortController().signal,
    } as any,
    {
      planner: {
        providerId: "codex",
        model: "gpt-5.6",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
      },
      worker: {
        providerId: "terra",
        model: "gpt-5.6-terra",
        reasoningLevel: "medium",
        permissionMode: "accept-edits",
      },
    } as any,
  );

  assert.deepEqual(events, ["queue-caller-backstop", "spawn-coordinator"]);
  assert.equal(queuedRows.length, 1);
  assert.equal(queuedRows[0]!.threadId, "caller");
  assert.ok(queuedRows[0]!.sendAt > Date.now() + 25 * 60_000);
  assert.ok(queuedRows[0]!.sendAt < Date.now() + 27 * 60_000);
  assert.equal(spawnCalls.length, 1);

  const coordinator = spawnCalls[0]!;
  assert.equal(coordinator.title.startsWith("Perspectives coordinator perspectives-invocation:"), true);
  assert.equal(coordinator.parentThreadId, "caller");
  assert.equal(coordinator.visibility, "hidden");
  assert.equal(coordinator.providerId, "codex");
  assert.equal(coordinator.model, "gpt-5.6");
  assert.equal(coordinator.serviceTier, "default");
  assert.equal(coordinator.reasoningLevel, "high");
  assert.equal(coordinator.permissionMode, "accept-edits");
  assert.deepEqual(coordinator.executionInputSources, {
    providerId: "explicit",
    model: "explicit",
    serviceTier: "explicit",
    reasoningLevel: "explicit",
    permissionMode: "explicit",
  });
  const backstopText = queuedRows[0]!.content[0]!.text as string;
  const invocationMarker = backstopText.match(/perspectives-invocation:[0-9a-f-]+/i)?.[0];
  assert.ok(invocationMarker);
  assert.ok(coordinator.title.includes(invocationMarker));
  assert.ok(coordinator.prompt.includes(invocationMarker));
  assert.match(backstopText, /Request identity:/);
  assert.match(receipt, /Perspectives panel launched/);
  assert.match(receipt, /Caller backstop: queued/);
  assert.match(receipt, /Artifact: perspectives\/results\/coordinator-1\.md/);
  assert.doesNotMatch(receipt, /worker-[\w-]+/i);

  const requestJson = coordinator.prompt.match(/## Complete run request\n\n```json\n([\s\S]*?)\n```/)?.[1];
  assert.ok(requestJson, "coordinator prompt should include its complete resolved run request");
  const request = JSON.parse(requestJson);
  assert.deepEqual(request.coordinatorExecution, {
    providerId: "codex",
    model: "gpt-5.6",
    serviceTier: "default",
    reasoningLevel: "high",
    permissionMode: "accept-edits",
  });
  assert.deepEqual(request.workerExecution, {
    providerId: "terra",
    model: "gpt-5.6-terra",
    serviceTier: "default",
    reasoningLevel: "medium",
    permissionMode: "accept-edits",
  });
  assert.match(coordinator.prompt, /Coordinate one ordinary hidden worker for each requested lens/);
  assert.match(coordinator.prompt, /perspectives_coordinator_step/);
});

test("an unavailable configured provider fails before any hidden thread is created", async () => {
  let spawnCount = 0;
  const bb = {
    sdk: {
      providers: {
        list: async () => [{
          id: "codex",
          available: true,
          capabilities: { supportsServiceTier: true, permissionModes: ["accept-edits"] },
        }],
        models: async () => ({ providers: [], permissionCeiling: "full", models: [], selectedOnlyModels: [] }),
      },
      threads: {
        get: async () => ({ environmentId: "environment", providerId: "caller-provider" }),
        defaultExecutionOptions: async () => ({
          providerId: "caller-provider",
          model: "caller-model",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "auto",
        }),
        spawn: async () => {
          spawnCount += 1;
          return { id: "unexpected" };
        },
      },
    },
  };

  await assert.rejects(
    deliverGatherPerspectives(
      bb as any,
      { question: "What matters?", lenses: ["one", "two", "three"] },
      { projectId: "project", threadId: "caller", signal: new AbortController().signal } as any,
      {
        planner: { providerId: "missing" },
        worker: {},
      } as any,
    ),
    /configured planner provider "missing" is unavailable/i,
  );
  assert.equal(spawnCount, 0);
});
