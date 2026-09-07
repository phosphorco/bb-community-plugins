import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  runGatherPerspectives,
  runHelp,
  type PerspectivesExecutionSettings,
  type PhaseExecutionSettings,
} from "./Perspectives.ts";

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

const reasoningOptions = [
  "inherit",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
] as const;
const permissionOptions = ["inherit", "accept-edits", "auto", "full"] as const;

function phaseSettings(
  providerId: string,
  model: string,
  reasoningLevel: string,
  permissionMode: string,
): PhaseExecutionSettings {
  return {
    ...(providerId.trim() ? { providerId: providerId.trim() } : {}),
    ...(model.trim() ? { model: model.trim() } : {}),
    ...(reasoningLevel !== "inherit"
      ? { reasoningLevel: reasoningLevel as PhaseExecutionSettings["reasoningLevel"] }
      : {}),
    ...(permissionMode !== "inherit"
      ? { permissionMode: permissionMode as PhaseExecutionSettings["permissionMode"] }
      : {}),
  };
}

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    plannerProvider: {
      type: "string",
      label: "Planner provider ID",
      description: "Blank inherits the caller provider. Also applies to final synthesis.",
      default: "",
    },
    plannerModel: {
      type: "string",
      label: "Planner model ID",
      description: "Blank inherits the caller model, or the configured provider's default model.",
      default: "",
    },
    plannerReasoning: {
      type: "select",
      label: "Planner reasoning",
      description: "Inheritance uses the caller value when the model is unchanged; another model uses its default.",
      options: [...reasoningOptions],
      default: "inherit",
    },
    plannerPermission: {
      type: "select",
      label: "Planner permission",
      description: "The authority envelope for planner and synthesis threads. Prompt instructions remain read-only.",
      options: [...permissionOptions],
      default: "inherit",
    },
    workerProvider: {
      type: "string",
      label: "Worker provider ID",
      description: "Blank inherits the caller provider. Applies to help and every panel worker.",
      default: "",
    },
    workerModel: {
      type: "string",
      label: "Worker model ID",
      description: "Blank inherits the caller model, or the configured provider's default model.",
      default: "",
    },
    workerReasoning: {
      type: "select",
      label: "Worker reasoning",
      description: "Inheritance uses the caller value when the model is unchanged; another model uses its default.",
      options: [...reasoningOptions],
      default: "inherit",
    },
    workerPermission: {
      type: "select",
      label: "Worker permission",
      description: "The authority envelope for expert threads. Prompt instructions prohibit mutation.",
      options: [...permissionOptions],
      default: "inherit",
    },
  });

  async function readExecutionSettings(): Promise<PerspectivesExecutionSettings> {
    const values = await settings.get();
    return {
      planner: phaseSettings(
        values.plannerProvider,
        values.plannerModel,
        values.plannerReasoning,
        values.plannerPermission,
      ),
      worker: phaseSettings(
        values.workerProvider,
        values.workerModel,
        values.workerReasoning,
        values.workerPermission,
      ),
    };
  }

  bb.agents.registerTool({
    name: "help",
    description: "Ask one independently generated, question-specific expert for a concise, source-cited read-only answer.",
    instructions: "Use help when one independent expert can clarify a question or chart the work ahead. Supply only the question, relevant facts, and constraints; the tool generates the expert identity and prompt in a separate context. The expert cites primary evidence for material factual claims and distinguishes sourced facts from analysis. Answer with the expert result. If retaining an inspectable reference, use only the returned expert-consultation thread; do not enumerate planner or pipeline threads.",
    presentation: { label: {
      pending: "Consulting an expert helper",
      completed: "Consulted an expert helper",
    } },
    parameters: z.object({
      question: z.string().trim().min(1),
      context: z.string().optional(),
    }).strict(),
    async execute(input, context) {
      try {
        return await runHelp(bb, input, context, await readExecutionSettings());
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "gather_perspectives",
    description: `Launch a background expert panel for caller-supplied lenses and return immediately. ${LENSES_EXAMPLE_TEXT} The panel gathers source-cited read-only perspectives concurrently, asks unfinished workers to wrap up after ~20 minutes, hard-caps the run at 25 minutes, and delivers the synthesized result to this thread as a later message beginning "Perspectives panel result".`,
    instructions: `Use gather_perspectives for consequential questions where specific independent lenses can reveal tradeoffs or disagreement. Supply the question, relevant facts, and constraints, and 3-7 short lens names. ${LENSES_EXAMPLE_TEXT} The tool generates each expert identity and prompt in a separate context and returns a launch receipt immediately; the panel keeps working in the background. Do not wait, poll, or re-invoke the tool for the result: continue with other work or end the turn, telling the user the panel is running. The synthesized result arrives in this thread as a later message beginning "Perspectives panel result"; when it arrives, answer with it. Each perspective cites primary evidence for material factual claims; synthesis preserves those citations and flags unsupported inferences. If retaining an inspectable reference, use only the final-synthesis thread named in the result; do not enumerate planner, worker, or pipeline threads.`,
    presentation: { label: {
      pending: "Launching an expert perspective panel",
      completed: "Launched an expert perspective panel",
    } },
    parameters: z.object({
      question: z.string().trim().min(1),
      context: z.string().optional(),
      lenses: lensesSchema,
    }).strict(),
    async execute(input, context) {
      try {
        return await runGatherPerspectives(bb, input, context, await readExecutionSettings());
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
      instructions: `Perspectives tools generate expert identities and prompts in separate hidden contexts. Callers provide the question, relevant facts, and constraints; gather_perspectives also requires specific lenses. ${LENSES_EXAMPLE_TEXT} Workers are advisory and instructed not to modify state. They cite primary evidence for material factual claims and distinguish sourced facts from analysis; synthesis preserves those citations. Completed and partial worker outcomes are retained for synthesis, while unavailable perspectives are reported as confidence limits. gather_perspectives returns a launch receipt immediately and delivers its synthesized result to the calling thread as a later message beginning "Perspectives panel result"; never wait or poll for it, and answer with the result message when it arrives. help returns its expert answer directly. Return the result itself and, when useful, only its single final-result thread reference; never enumerate internal planner or worker threads.`,
    };
  });

  bb.log.info("Perspectives tools loaded");
}
