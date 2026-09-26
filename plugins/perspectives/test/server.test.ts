import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { expect } from "./expect.ts";
import plugin from "../server.ts";

describe("Perspectives agent tool registration", () => {
  test("exposes scoped recovery and retrieval tools to caller and coordinator contexts", () => {
    const tools: Array<{
      name: string;
      description?: string;
      instructions?: string;
      parameters: { safeParse(input: unknown): { success: boolean } };
    }> = [];
    let settingDescriptors: Record<string, any> = {};
    let configure!: (context: any) => { tools: string[]; skills: string[]; instructions?: string };
    const bb = {
      pluginId: "perspectives",
      settings: {
        define: (descriptors: Record<string, any>) => {
          settingDescriptors = descriptors;
          return {
            get: async () => Object.fromEntries(
              Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.default]),
            ),
          };
        },
      },
      agents: {
        registerTool: (registration: typeof tools[number]) => tools.push(registration),
        configure: (provider: typeof configure) => { configure = provider; },
      },
      log: { info: () => undefined },
    };

    plugin(bb as any);

    expect(tools.map((tool) => tool.name)).toEqual([
      "help",
      "gather_perspectives",
      "perspectives_coordinator_step",
      "perspectives_publish_result",
      "perspectives_read_result",
    ]);
    // host-policy.ts enforces this on registered tool.instructions.length
    // (JavaScript UTF-16 code units); descriptions are bounded here too.
    const bbToolTextLimit = 4096;
    for (const tool of tools) {
      assert.ok(
        tool.instructions === undefined || tool.instructions.length <= bbToolTextLimit,
        `${tool.name} instructions exceed BB's ${bbToolTextLimit}-character limit`,
      );
      assert.ok(
        tool.description === undefined || tool.description.length <= bbToolTextLimit,
        `${tool.name} description exceeds the registration text budget`,
      );
    }
    const callerContext = {
      origin: { pluginId: null },
      thread: { id: "caller", title: "Caller", parentThreadId: null, sourceThreadId: null },
    };
    const ordinary = configure(callerContext);
    expect(ordinary.tools).toEqual([
      "help",
      "gather_perspectives",
      "perspectives_read_result",
    ]);
    assert.ok(
      ordinary.instructions === undefined || ordinary.instructions.length <= bbToolTextLimit,
      `caller dynamic instructions exceed BB's ${bbToolTextLimit}-character limit`,
    );
    expect(ordinary.instructions).toContain("launch-intent queue row");
    expect(ordinary.instructions).toContain("explicit queue recovery or operator action");
    expect(ordinary.instructions).toContain("intermediate event text and native notice excerpts are not research findings");
    expect(ordinary.instructions).toContain("latest successful completed turn's final persisted agent message");
    expect(ordinary.instructions).toContain("retains the backstop");

    const recognizableWorker = configure({
      ...callerContext,
      thread: { ...callerContext.thread, id: "worker", title: "Perspectives worker run lens-1", parentThreadId: "coordinator" },
      origin: { kind: null, pluginId: "perspectives" },
    });
    expect(recognizableWorker.tools).toEqual(["help"]);

    const renamedPluginOriginCoordinator = configure({
      ...callerContext,
      origin: { kind: null, pluginId: "perspectives" },
      thread: { ...callerContext.thread, id: "coordinator", title: "renamed coordinator", parentThreadId: "caller" },
    });
    expect(renamedPluginOriginCoordinator.tools).toEqual([
      "perspectives_coordinator_step",
      "perspectives_publish_result",
    ]);
    expect(configure({
      ...callerContext,
      origin: { kind: null, pluginId: "perspectives" },
      thread: { ...callerContext.thread, id: "plugin-helper", title: "expert helper", parentThreadId: null },
    }).tools).toEqual(["help"]);
    expect(configure({
      ...callerContext,
      origin: { kind: null, pluginId: "rosetta-slack" },
      thread: { ...callerContext.thread, id: "slack-caller", title: "Slack caller", parentThreadId: "slack-plugin" },
    }).tools).toEqual(["help", "gather_perspectives", "perspectives_read_result"]);

    const gather = tools.find((tool) => tool.name === "gather_perspectives")! as any;
    const gatherSchema = z.toJSONSchema(gather.parameters) as any;
    expect(gather.description).toContain("2–7 distinct caller-supplied lenses");
    expect(gatherSchema.properties.lenses.examples).toEqual([
      ["v8 performance characteristics", "big-O complexity", "duplicate work"],
      [
        "leverages platform native UX",
        "for every action, there is a reversal implemented",
        "over-labeling/structure, IA, and visual cues",
      ],
    ]);
    expect(gather.parameters.safeParse({ question: "How?", lenses: ["performance", "correctness"] }).success).toBe(true);
    expect(gather.parameters.safeParse({ question: "How?", lenses: ["performance"] }).success).toBe(false);

    const step = tools.find((tool) => tool.name === "perspectives_coordinator_step")!;
    const publish = tools.find((tool) => tool.name === "perspectives_publish_result")!;
    const read = tools.find((tool) => tool.name === "perspectives_read_result")!;
    expect(step.parameters.safeParse({}).success).toBe(true);
    expect(step.parameters.safeParse({ coordinatorId: "other" }).success).toBe(false);
    expect(publish.parameters.safeParse({ synthesis: "Evidence bounded synthesis." }).success).toBe(true);
    expect(publish.parameters.safeParse({ synthesis: "Evidence bounded synthesis.", coverage: "uncertain" }).success).toBe(true);
    expect(read.parameters.safeParse({ coordinatorId: "coordinator" }).success).toBe(true);
    expect(read.parameters.safeParse({ coordinatorId: "coordinator", includeArtifact: true }).success).toBe(true);
    expect(read.parameters.safeParse({ invocationMarker: "perspectives-invocation:00000000-0000-0000-0000-000000000000" }).success).toBe(true);
    expect(read.parameters.safeParse({ coordinatorId: "coordinator", invocationMarker: "perspectives-invocation:00000000-0000-0000-0000-000000000000" }).success).toBe(false);
    expect(settingDescriptors.plannerPermission.options).toEqual(["inherit", "accept-edits", "auto", "full"]);
  });
});
