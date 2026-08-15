import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

import { runGatherPerspectives, runHelp } from "./Perspectives.ts";

const LENS_EXAMPLES = [
  ["v8 performance characteristics", "big-O complexity", "duplicate work"],
  [
    "leverages platform native UX",
    "for every action, there is a reversal implemented",
    "over-labeling/structure, IA, and visual cues",
  ],
] as const;

function formatLensExample(lenses: readonly string[]): string {
  return `lenses: [${lenses.map((lens) => JSON.stringify(lens)).join(", ")}, ...]`;
}

const LENSES_EXAMPLE_TEXT = `For example: ${LENS_EXAMPLES.map(formatLensExample).join(" or ")}.`;

const lensesSchema = z.array(z.string().trim().min(1).max(120)).min(3).max(7).superRefine((lenses, context) => {
  const seen = new Set<string>();
  for (const [index, lens] of lenses.entries()) {
    const key = lens.toLocaleLowerCase();
    if (seen.has(key)) {
      context.addIssue({ code: "custom", message: "Lenses must be distinct.", path: [index] });
    }
    seen.add(key);
  }
}).meta({
  description: `Specific aspects or analytical angles the caller wants investigated. ${LENSES_EXAMPLE_TEXT}`,
  examples: LENS_EXAMPLES.map((example) => [...example]),
});

function toolError(error: unknown) {
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export default function plugin(bb: BbPluginApi): void {
  bb.agents.registerTool({
    name: "help",
    description: "Ask one independently generated, question-specific expert for a concise, source-cited read-only answer.",
    instructions: "Use help when one independent expert can clarify a question or chart the work ahead. Supply only the question, relevant facts, and constraints; the tool generates the expert identity and prompt in a separate context. The expert cites primary evidence for material factual claims and distinguishes sourced facts from analysis. Answer with the expert result. If retaining an inspectable reference, use only the returned expert-consultation thread; do not enumerate planner or pipeline threads.",
    experimental_statusLabels: {
      pending: "Consulting an expert helper",
      completed: "Consulted an expert helper",
    },
    parameters: z.object({
      question: z.string().trim().min(1),
      context: z.string().optional(),
    }).strict(),
    async execute(input, context) {
      try {
        return await runHelp(bb, input, context);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "gather_perspectives",
    description: `Generate expert prompts for caller-supplied lenses. ${LENSES_EXAMPLE_TEXT} Gather their source-cited read-only perspectives concurrently, ask unfinished workers to wrap up near the panel boundary, preserve partial outcomes, and synthesize all usable evidence.`,
    instructions: `Use gather_perspectives for consequential questions where specific independent lenses can reveal tradeoffs or disagreement. Supply the question, relevant facts, and constraints, and 3-7 short lens names. ${LENSES_EXAMPLE_TEXT} The tool generates each expert identity and prompt in a separate context. Each perspective cites primary evidence for material factual claims; synthesis preserves those citations and flags unsupported inferences. Answer with the synthesized result. If retaining an inspectable reference, use only the returned final-synthesis thread; do not enumerate planner, worker, or pipeline threads.`,
    experimental_statusLabels: {
      pending: "Gathering expert perspectives",
      completed: "Gathered expert perspectives",
    },
    parameters: z.object({
      question: z.string().trim().min(1),
      context: z.string().optional(),
      lenses: lensesSchema,
    }).strict(),
    async execute(input, context) {
      try {
        return await runGatherPerspectives(bb, input, context);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.configure((context) => {
    if (context.origin.pluginId === bb.pluginId) {
      return { tools: [], skills: [] };
    }
    return {
      tools: ["help", "gather_perspectives"],
      skills: [],
      instructions: `Perspectives tools generate expert identities and prompts in separate hidden contexts. Callers provide the question, relevant facts, and constraints; gather_perspectives also requires specific lenses. ${LENSES_EXAMPLE_TEXT} Workers are advisory and instructed not to modify state. They cite primary evidence for material factual claims and distinguish sourced facts from analysis; synthesis preserves those citations. Completed and partial worker outcomes are retained for synthesis, while unavailable perspectives are reported as confidence limits. Return the result itself and, when useful, only its single final-result thread reference; never enumerate internal planner or worker threads.`,
    };
  });

  bb.log.info("Perspectives tools loaded");
}
