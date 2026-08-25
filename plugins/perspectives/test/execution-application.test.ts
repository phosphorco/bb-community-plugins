import assert from "node:assert/strict";
import test from "node:test";

import { deliverGatherPerspectives } from "../Perspectives.ts";

function perspectiveTable(): string {
  return [
    "| Lens | Why this lens | Expert prompt |",
    "| --- | --- | --- |",
    "| runtime | Runtime matters. | You are a runtime specialist using primary evidence. |",
    "| complexity | Complexity matters. | You are a complexity specialist using primary evidence. |",
    "| duplication | Duplication matters. | You are a duplication specialist using primary evidence. |",
  ].join("\n");
}

test("configured planner and worker tuples are applied to their complete phases", async () => {
  const spawnCalls: Array<Record<string, any>> = [];
  const outputs = new Map<string, string>();
  const never = new Promise<never>(() => undefined);

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
        spawn: async (input: Record<string, any>) => {
          spawnCalls.push(input);
          const id = `thread-${spawnCalls.length}`;
          outputs.set(
            id,
            input.title.startsWith("Perspective planner")
              ? perspectiveTable()
              : input.title === "Perspective synthesis"
                ? "Unified answer."
                : `${input.title} answer.`,
          );
          return { id };
        },
        wait: async ({ status }: { status: string }) => status === "idle" ? {} : never,
        output: async ({ threadId }: { threadId: string }) => ({ output: outputs.get(threadId) }),
        send: async () => undefined,
        stop: async () => undefined,
      },
    },
  };

  await deliverGatherPerspectives(
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

  assert.equal(spawnCalls.length, 5);
  for (const [index, call] of spawnCalls.entries()) {
    const plannerPhase = index === 0 || index === 4;
    assert.equal(call.providerId, plannerPhase ? "codex" : "terra");
    assert.equal(call.model, plannerPhase ? "gpt-5.6" : "gpt-5.6-terra");
    assert.equal(call.reasoningLevel, plannerPhase ? "high" : "medium");
    assert.equal(call.permissionMode, "accept-edits");
    assert.deepEqual(call.executionInputSources, {
      providerId: "explicit",
      model: "explicit",
      serviceTier: "explicit",
      reasoningLevel: "explicit",
      permissionMode: "explicit",
    });
  }
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
