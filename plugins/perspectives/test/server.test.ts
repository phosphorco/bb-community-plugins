import { describe, test } from "node:test";
import { z } from "zod";

import { expect } from "./expect.ts";
import plugin from "../server.ts";

describe("plugin registration", () => {
  test("exposes tools to ordinary agents and excludes them from its own workers", () => {
    const tools: Array<{ name: string; parameters: { safeParse(input: unknown): { success: boolean } } }> = [];
    let settingDescriptors: Record<string, any> = {};
    let configure!: (context: any) => { tools: string[]; skills: string[] };
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
        configure: (provider: typeof configure) => {
          configure = provider;
        },
      },
      log: { info: () => undefined },
    };

    plugin(bb as any);

    expect(tools.map((tool) => tool.name)).toEqual(["help", "gather_perspectives"]);
    expect(configure({ origin: { pluginId: null } }).tools).toEqual(["help", "gather_perspectives"]);
    expect(configure({ origin: { pluginId: "perspectives" } }).tools).toEqual([]);
    expect(Object.keys(settingDescriptors)).toEqual([
      "plannerProvider",
      "plannerModel",
      "plannerReasoning",
      "plannerPermission",
      "workerProvider",
      "workerModel",
      "workerReasoning",
      "workerPermission",
    ]);
    expect(settingDescriptors.plannerProvider.default).toBe("");
    expect(settingDescriptors.workerModel.default).toBe("");
    expect(settingDescriptors.plannerReasoning.default).toBe("inherit");
    expect(settingDescriptors.workerPermission.options).toEqual([
      "inherit",
      "accept-edits",
      "auto",
      "full",
    ]);

    const help = tools.find((tool) => tool.name === "help")!;
    expect((help as any).instructions).toContain("only the returned expert-consultation thread");
    expect((help as any).instructions).toContain("do not enumerate planner or pipeline threads");
    expect((help as any).instructions).toContain("cites primary evidence");
    expect(help.parameters.safeParse({ question: "What matters?" }).success).toBe(true);
    expect(help.parameters.safeParse({ prompt: "You are an expert." }).success).toBe(false);

    const gather = tools.find((tool) => tool.name === "gather_perspectives")! as any;
    const gatherJsonSchema = z.toJSONSchema(gather.parameters) as any;
    expect(gather.description).toContain("v8 performance characteristics");
    expect(gather.description).toContain("leverages platform native UX");
    expect(gather.description.match(/, \.\.\.\]/g)).toHaveLength(2);
    expect(gather.instructions).toContain("big-O complexity");
    expect(gather.instructions).toContain("over-labeling/structure, IA, and visual cues");
    expect(gather.instructions.match(/, \.\.\.\]/g)).toHaveLength(2);
    expect(gather.instructions).toContain("only the final-synthesis thread named in the result");
    expect(gather.instructions).toContain("do not enumerate planner, worker, or pipeline threads");
    expect(gather.instructions).toContain("synthesis preserves those citations");
    expect(gather.instructions).toContain("returns a launch receipt immediately");
    expect(gather.instructions).toContain("Do not wait, poll, or re-invoke");
    expect(gather.instructions).toContain('later message beginning "Perspectives panel result"');
    expect(gather.description).toContain("hard-caps the run at 25 minutes");
    expect(gatherJsonSchema.properties.lenses.description).toContain("duplicate work");
    expect(gatherJsonSchema.properties.lenses.description).toContain("for every action, there is a reversal implemented");
    expect(gatherJsonSchema.properties.lenses.description.match(/, \.\.\.\]/g)).toHaveLength(2);
    expect(gatherJsonSchema.properties.lenses.examples).toEqual([
      ["v8 performance characteristics", "big-O complexity", "duplicate work"],
      [
        "leverages platform native UX",
        "for every action, there is a reversal implemented",
        "over-labeling/structure, IA, and visual cues",
      ],
    ]);
    expect(gather.parameters.safeParse({
      question: "Where is the work?",
      lenses: ["v8 performance characteristics", "big-O complexity", "duplicate work"],
    }).success).toBe(true);
    expect(gather.parameters.safeParse({ question: "Where is the work?", perspectives: 3 }).success).toBe(false);
    expect(gather.parameters.safeParse({
      question: "Where is the work?",
      lenses: ["performance", "Performance", "correctness"],
    }).success).toBe(false);
  });
});
