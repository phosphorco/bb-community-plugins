import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { decodePhase, registerPerspectivesSettings } from "./execution-settings.ts";

import {
  runGatherPerspectives,
  runHelp,
  runPerspectivesCoordinatorStep,
  runPerspectivesPublishResult,
  runPerspectivesReadResult,
  COORDINATOR_ROLE,
  COORDINATOR_TITLE_PREFIX,
  WORKER_TITLE_PREFIX,
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

const lensesSchema = z.array(z.string().trim().min(1).max(120)).min(2).max(7).superRefine((lenses, context) => {
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
  const decoded = decodePhase(providerId, model, reasoningLevel);
  if (!decoded.ok) throw new Error(decoded.issues.map(issue => issue.message).join("; "));
  return {
    ...(decoded.value.kind === "fields" ? { ...decoded.value.fields, reasoningLevel: decoded.value.fields.reasoningLevel as PhaseExecutionSettings["reasoningLevel"] } : {}),
    ...(permissionMode !== "inherit" ? { permissionMode: permissionMode as PhaseExecutionSettings["permissionMode"] } : {}),
  };
}

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    plannerProvider: {
      type: "string",
      label: "Planner provider ID",
      description: "Blank inherits the caller provider. Applies to the help planner and the panel coordinator, which also writes the synthesis.",
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
      description: "The authority envelope for the help planner and the panel coordinator. Prompt instructions remain read-only.",
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

  registerPerspectivesSettings(bb, settings);

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
    description: `Launch a background expert panel for 2–7 distinct caller-supplied lenses. ${LENSES_EXAMPLE_TEXT} The tool queues one caller backstop, then creates a hidden coordinator lifecycle-owned by the caller. It returns a launch receipt only after the coordinator ID is known; an ambiguous spawn without one verified coordinator is reported as launch uncertain. The coordinator runs one hidden read-only worker per lens, stops unfinished workers at about 25 minutes, and publishes one verified complete, partial, or failed artifact. The caller is then woken once by a completion message; the backstop (about 35 minutes after launch) is removed when that message is delivered and otherwise prompts recovery. Times are scheduling targets, not delivery guarantees.`,
    instructions: `Use gather_perspectives for consequential questions. Supply the question, relevant facts, constraints, and 2–7 distinct lenses. ${LENSES_EXAMPLE_TEXT} This returns a launch receipt, not the result. If the launch is reported uncertain, report that and never retry blindly. When the completion or backstop message arrives, call perspectives_read_result and present the verified artifact with its receipt line. Partial or failed status, unavailable lenses, and unknowns must be disclosed; do not wait, poll, or re-invoke.`,
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

  bb.agents.registerTool({
    name: "perspectives_coordinator_step",
    description: "Reconcile this persisted Perspectives coordinator run through BB SDK thread and queue APIs. It only acts on the current verified coordinator.",
    instructions: "Use only from the hidden coordinator. This tool checks the first persisted request event, lifecycle owner (or legacy parent), project, and environment, then reconciles ordinary worker children and scheduled rows through BB's SDK. If readyToPublish is false, end the turn and wait for a native child report or scheduled wake; never poll. If phase is wake-setup-failed and readyToPublish is true, publish a brief failure note: the product rechecks that at least one required wake row has a persisted failureReason, the other required wake state is known, and no worker launch was attempted before creating a failed no-research artifact. If phase is wake-setup-uncertain, no new workers were launched; end the turn and rely only on a confirmed wake or explicit queue recovery. Ambiguous queue state does not authorize early publication. Missing final output is unavailable evidence; intermediate event text and native notice excerpts do not count as research output.",
    presentation: { label: { pending: "Reconciling Perspectives run", completed: "Reconciled Perspectives run" } },
    parameters: z.object({}).strict(),
    async execute(_input, context) {
      try {
        return await runPerspectivesCoordinatorStep(bb, context);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "perspectives_publish_result",
    description: "Publish the current verified coordinator's deterministic UTF-8 result artifact with atomic create-only write and readback verification. Choose complete or partial based on whether the synthesis substantively answers the requested lenses; this judgment is labeled and is not mechanically verified.",
    instructions: "Use only after perspectives_coordinator_step reports readyToPublish. For wake-setup-failed, provide a short failure note and choose coverage partial; the product independently confirms a persisted failureReason on at least one required wake row, a known state for the other row, and no worker launch before publishing a fixed failed artifact that states no research was performed. Otherwise supply synthesis limited to persisted full worker outputs and cited evidence. Choose coverage partial if any lens could not inspect relevant sources, cannot answer, has unsupported citations, or has materially unknown coverage. Choose complete only when every requested lens returned exactly one persisted final output and you judge the requested lenses substantively addressed. This coverage choice is your conservative assessment, not proof of factual correctness; the product mechanically reports worker-output availability separately and caps complete status when any lens output is missing, duplicated, inactive, or unavailable. Without confirmed coverage choose partial. The tool computes exact body and file digests, creates without overwriting, and reads back. A conflict or corrupt artifact is an error; do not retry or write a file directly.",
    presentation: { label: { pending: "Publishing Perspectives artifact", completed: "Published Perspectives artifact" } },
    parameters: z.object({
      synthesis: z.string().max(240_000),
      coverage: z.string().optional(),
    }).strict(),
    async execute(input, context) {
      try {
        return await runPerspectivesPublishResult(bb, input, context);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "perspectives_read_result",
    description: "Read and byte-verify a Perspectives artifact belonging to a verified caller-owned coordinator; suppress its body only after an exact durable presentation receipt is found.",
    instructions: "Call in the caller thread with exactly one coordinatorId or invocationMarker. The tool verifies the persisted caller ownership and full artifact bytes. It suppresses the body only if the latest successful completed turn's final persisted agent message is the turn's last completed item and contains the exact standalone HTML-comment receipt with matching run ID and full-file SHA-256; after presenting the artifact, include the exact receipt line returned by the tool in your final answer. Missing or mismatched markers, absent final output, and event-read failures return the full artifact. Set includeArtifact: true to return the body again on an explicit user request. A legacy markerless presentation may repeat. BB returns stored assistant-message text for this check, and normal Markdown rendering hides the HTML comment. Missing, corrupt, or host-offline artifact outcomes are not success.",
    presentation: { label: { pending: "Verifying Perspectives artifact", completed: "Verified Perspectives artifact" } },
    parameters: z.object({
      coordinatorId: z.string().min(1).optional(),
      invocationMarker: z.string().regex(/^perspectives-invocation:[0-9a-f-]{36}$/i).optional(),
      includeArtifact: z.boolean().optional(),
    }).strict().superRefine((input, validation) => {
      if (Boolean(input.coordinatorId) === Boolean(input.invocationMarker)) {
        validation.addIssue({ code: "custom", message: "Provide exactly one coordinatorId or invocationMarker." });
      }
    }),
    async execute(input, context) {
      try {
        return await runPerspectivesReadResult(bb, input, context);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.configure((context) => {
    if (context.thread.title?.startsWith(WORKER_TITLE_PREFIX)) {
      return { tools: [], skills: [] };
    }

    if (context.origin.pluginId === bb.pluginId) {
      // Configure is synchronous, so durable run identity cannot be checked
      // here; these hints only choose what to advertise. Coordinators carry
      // seeded role metadata (v2 runs before seeding carry the coordinator
      // title prefix, legacy v1 runs a parent). Every operation authenticates
      // the persisted request and caller ownership when it executes. Other
      // threads this plugin creates are help planners and experts, which must
      // not delegate.
      const coordinator = context.pluginMetadata?.role === COORDINATOR_ROLE ||
        (context.thread.title?.startsWith(COORDINATOR_TITLE_PREFIX) ?? false) ||
        context.thread.parentThreadId !== null;
      return coordinator
        ? { tools: ["perspectives_coordinator_step", "perspectives_publish_result"], skills: [] }
        : { tools: [], skills: [] };
    }

    return {
      tools: ["help", "gather_perspectives", "perspectives_read_result"],
      skills: [],
      instructions: `Perspectives experts are advisory and read-only. help answers synchronously. For consequential questions, give gather_perspectives the question, relevant facts, constraints, and 2–7 distinct lenses. ${LENSES_EXAMPLE_TEXT} It returns a launch receipt, not the result; the panel works in the background without waking this thread. If the launch is reported uncertain, never retry it blindly.

This thread is woken once when the panel publishes ("Perspectives panel result ready"). If that message was not confirmed, a "Perspectives panel backstop" message arrives instead, about 35 minutes after launch. On either, call perspectives_read_result with the coordinator ID or invocation marker it names. Present the verified artifact and include the exact standalone receipt line it returns in your final answer; if the tool reports the result was already presented, say nothing further about it. Preserve the artifact's citations, disagreements, and unknowns, and do not claim more coverage than its status states. Report missing, corrupt, uncertain, partial, or failed runs honestly, and keep possible duplicate runs separate. Do not wait, poll, or re-invoke for a result, and do not expose internal worker references.`,
    };
  });

  bb.log.info("Perspectives tools loaded");
}
