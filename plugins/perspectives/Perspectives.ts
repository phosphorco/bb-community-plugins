import { createHash, randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { z } from "zod";

const PLANNER_PHASE_TIMEOUT_MS = 15_000;
const PANEL_WRAP_UP_AFTER_MS = 20 * 60_000;
const RUN_HARD_CAP_MS = 25 * 60_000;
const SYNTHESIS_RESERVE_MS = 120_000;
const SYNTHESIS_PHASE_TIMEOUT_MS = 90_000;
const SPAWN_TIMEOUT_MS = 60_000;
const HELPER_PHASE_TIMEOUT_MS = 250_000;
const MAX_SYNTHESIS_EVIDENCE_CHARS = 240_000;
const INTERNAL_REQUEST_GRACE_MS = 2_000;

/**
 * Test seams for the gather pipeline's wall-clock budgets. Production always
 * uses the defaults: wrap-up steer after 20 minutes of continuous panel work
 * and a hard cap of 25 minutes on the whole run, after which every remaining
 * agent is stopped and whatever was gathered is synthesized and delivered.
 */
export interface GatherTiming {
  readonly plannerTimeoutMs?: number;
  readonly wrapUpAfterMs?: number;
  readonly hardCapMs?: number;
  readonly synthesisTimeoutMs?: number;
  readonly synthesisReserveMs?: number;
  readonly spawnTimeoutMs?: number;
}

interface ResolvedGatherTiming {
  readonly plannerTimeoutMs: number;
  readonly wrapUpAfterMs: number;
  readonly hardCapMs: number;
  readonly synthesisTimeoutMs: number;
  readonly synthesisReserveMs: number;
  readonly spawnTimeoutMs: number;
}

export function resolveGatherTiming(timing?: GatherTiming): ResolvedGatherTiming {
  const duration = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) && value > 0
      ? Math.max(1, Math.floor(value))
      : fallback;
  const hardCapMs = duration(timing?.hardCapMs, RUN_HARD_CAP_MS);
  return {
    plannerTimeoutMs: Math.min(
      duration(timing?.plannerTimeoutMs, PLANNER_PHASE_TIMEOUT_MS),
      hardCapMs,
    ),
    wrapUpAfterMs: Math.min(
      duration(timing?.wrapUpAfterMs, PANEL_WRAP_UP_AFTER_MS),
      hardCapMs,
    ),
    hardCapMs,
    synthesisTimeoutMs: Math.min(
      duration(timing?.synthesisTimeoutMs, SYNTHESIS_PHASE_TIMEOUT_MS),
      hardCapMs,
    ),
    synthesisReserveMs: Math.min(
      duration(timing?.synthesisReserveMs, SYNTHESIS_RESERVE_MS),
      Math.max(0, hardCapMs - 1),
    ),
    spawnTimeoutMs: Math.min(duration(timing?.spawnTimeoutMs, SPAWN_TIMEOUT_MS), hardCapMs),
  };
}

const perspectiveSchema = z.object({
  name: z.string().trim().min(1).max(80),
  rationale: z.string().trim().min(1).max(300),
  expertPrompt: z.string().trim().min(20).max(1_200),
});

export interface Perspective {
  readonly name: string;
  readonly rationale: string;
  readonly expertPrompt: string;
}

export interface PerspectiveResult {
  readonly perspective: Perspective;
  readonly threadId: string;
  readonly status: "succeeded" | "failed" | "timed_out" | "stopped";
  readonly output: string;
  readonly error?: string;
}

interface SpawnContext {
  readonly projectId: string;
  readonly callerThreadId: string;
  readonly signal: AbortSignal;
  readonly spawnTimeoutMs: number;
  readonly environment: Parameters<Threads["spawn"]>[0]["environment"];
  readonly execution: ResolvedExecution;
}

type CallerExecution = NonNullable<Awaited<ReturnType<Threads["defaultExecutionOptions"]>>>;
type ReasoningLevel = CallerExecution["reasoningLevel"];
type PermissionMode = CallerExecution["permissionMode"];
type ServiceTier = CallerExecution["serviceTier"];

interface ResolvedExecution {
  readonly providerId: string;
  readonly model: string;
  readonly serviceTier?: ServiceTier;
  readonly reasoningLevel: ReasoningLevel;
  readonly permissionMode: PermissionMode;
}

export interface PhaseExecutionSettings {
  readonly providerId?: string;
  readonly model?: string;
  readonly reasoningLevel?: ReasoningLevel;
  readonly permissionMode?: PermissionMode;
}

export interface PerspectivesExecutionSettings {
  readonly planner: PhaseExecutionSettings;
  readonly worker: PhaseExecutionSettings;
}

interface SpawnContexts {
  readonly planner: SpawnContext;
  readonly worker: SpawnContext;
}

const INHERIT_EXECUTION_SETTINGS: PerspectivesExecutionSettings = {
  planner: {},
  worker: {},
};

interface SpawnedAgent {
  readonly threadId: string;
  readonly result: Promise<PerspectiveResult>;
  steer(message: string): Promise<void>;
  stop(): Promise<void>;
}

interface PanelAgent extends SpawnedAgent {
  readonly perspective: Perspective;
}

interface GeneratedPlan {
  readonly perspectives: Perspective[];
  readonly threadIds: string[];
}

interface SynthesisResult {
  readonly output: string;
  readonly threadId?: string;
}

type Threads = BbPluginApi["sdk"]["threads"];

const READ_ONLY_INSTRUCTIONS = `This is an advisory, read-only assignment.
- You may inspect local files and run commands only when they do not modify state.
- Do not edit, create, move, or delete files.
- Do not run formatters, generators, installers, migrations, or other mutating commands.
- Do not commit, push, open pull requests, send messages, or mutate external systems.
- Do not delegate or ask other agents for help.
- Return a concise, self-contained answer to the assignment.`;

const COORDINATOR_AUTHORITY_INSTRUCTIONS = `You are coordinating a read-only research panel. Perspectives exposes two narrow BB agent tools for this coordinator's own run: perspectives_coordinator_step reconciles its ordinary hidden children and scheduled wakes; perspectives_publish_result verifies and publishes one result into this coordinator thread's storage. Use those tools instead of BB shell commands for coordination or file access.
- Repository and source inspection is read-only. Do not change project files or mutate external systems; do not send messages through external channels.
- Workers remain read-only advisory experts. Include the Perspectives READ_ONLY_INSTRUCTIONS policy in every worker prompt. Worker threads do not receive coordinator tools.
- Base every factual statement on persisted worker final outputs or cited sources those workers actually inspected. Separate observations from inference and supplied context. A queue row, spawn response, worker count, native report, or tool response alone does not prove delivery, research completion, or a guarantee.
- Do not claim eventual delivery, exactly-once execution, guaranteed recovery, complete coverage, or reliability unless the available primary evidence directly establishes that claim. Describe operational limits and unknowns plainly.
- If coordinator_step reports wake-setup-failed with readyToPublish true, call perspectives_publish_result with a short failure note and coverage partial. The product rechecks that at least one required wake row has a persisted failureReason, the other required wake state is known, and no worker launch was attempted before publishing the fixed no-research failed artifact. If it reports wake-setup-uncertain, no new workers were launched; end the turn and rely only on a confirmed wake or the caller backstop. Ambiguous queue state does not authorize early publication.`;

const DIRECT_HELP_INSTRUCTIONS = `Answer directly from the supplied question and context.
- Do not inspect the repository or invoke tools unless the answer would otherwise depend on a guess.
- If inspection is necessary, keep it narrowly focused on the missing fact.
- Prefer a concise answer over a comprehensive survey.`;

const SOURCE_INSTRUCTIONS = `Evidence and citation requirements:
- Support every material factual claim with the strongest available primary source that you actually inspected.
- Cite repository evidence inline with clickable absolute file links and a relevant line number, for example [server.ts](/absolute/path/server.ts:42).
- Cite web or documentation evidence inline with direct Markdown links to the specific source page, not search-result pages.
- Prefer unbundled source, authoritative declarations, and official documentation. Do not inspect or cite generated bundles, minified distributions, or build artifacts when source or declarations are available.
- Never invent a citation, URL, file path, line number, quotation, or source detail. Distinguish sourced facts from your own analysis or inference.
- When a claim relies only on the supplied context, say so explicitly instead of presenting the context as independently verified.
- End with a short \`## Sources\` section listing only the sources actually used. If no source inspection was necessary, say that the answer is analysis based on the supplied question and context.`;

const WRAP_UP_MESSAGE = `Wrap up now. Return the highest-signal conclusions, recommendation, risks, and important unknowns. Do not begin new investigation.`;

function abortError(): Error {
  return new DOMException("The perspectives tool was interrupted.", "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

function withResultThread(output: string, label: string, threadId?: string): string {
  return threadId ? `${output}\n\n${label}: @thread:${threadId}` : output;
}

function withoutInternalThreadReferences(
  output: string,
  internalThreadIds: readonly string[],
): string {
  let sanitized = output;
  for (const threadId of new Set(internalThreadIds.filter(Boolean))) {
    sanitized = sanitized.replaceAll(`@thread:${threadId}`, "[internal consultation reference omitted]");
  }
  return sanitized;
}

function parseMarkdownRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;

  const cells: string[] = [];
  let cell = "";
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const character = trimmed[index]!;
    const next = trimmed[index + 1];
    if (character === "\\" && next === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function isMarkdownSeparator(cells: readonly string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function extractPerspectiveTable(text: string): Perspective[] {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = parseMarkdownRow(lines[index]!);
    const separator = parseMarkdownRow(lines[index + 1]!);
    if (!header || !separator || header.length !== 3 || separator.length !== 3) continue;
    if (header.map((cell) => cell.toLocaleLowerCase()).join("|") !== "lens|why this lens|expert prompt") continue;
    if (!isMarkdownSeparator(separator)) continue;

    const perspectives: Perspective[] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const row = parseMarkdownRow(lines[rowIndex]!);
      if (!row) break;
      if (row.length !== 3) throw new Error(`Planner table row ${rowIndex - index - 1} must have exactly 3 columns.`);
      perspectives.push(perspectiveSchema.parse({
        name: row[0],
        rationale: row[1],
        expertPrompt: row[2],
      }));
    }
    if (perspectives.length === 0) throw new Error("Planner table contained no perspectives.");
    return perspectives;
  }
  throw new Error("Planner returned no perspective table.");
}

export function parsePerspectivePlan(
  text: string,
  expected: number | readonly string[],
): Perspective[] {
  const perspectives = extractPerspectiveTable(text);
  const expectedCount = typeof expected === "number" ? expected : expected.length;
  if (perspectives.length !== expectedCount) {
    throw new Error(`Planner returned ${perspectives.length} perspectives; expected ${expectedCount}.`);
  }

  const names = new Set<string>();
  const prompts = new Set<string>();
  for (const [index, perspective] of perspectives.entries()) {
    if (typeof expected !== "number" && perspective.name !== expected[index]) {
      throw new Error(
        `Planner must preserve caller lens ${JSON.stringify(expected[index])} at position ${index + 1}.`,
      );
    }
    const nameKey = perspective.name.toLocaleLowerCase();
    if (names.has(nameKey)) throw new Error(`Planner returned duplicate perspective name: ${perspective.name}.`);
    names.add(nameKey);

    const promptKey = perspective.expertPrompt.toLocaleLowerCase();
    if (prompts.has(promptKey)) throw new Error("Planner reused an expert prompt across perspectives.");
    prompts.add(promptKey);

    if (!perspective.expertPrompt.startsWith("You are")) {
      throw new Error(`Expert prompt for ${perspective.name} must start with \"You are\".`);
    }
  }

  return perspectives;
}

function plannerPrompt(
  question: string,
  context: string,
  requestedLenses: readonly string[] | null,
): string {
  const assignment = requestedLenses
    ? `Generate one expert perspective for each caller-supplied lens below, in the same order.

Caller-supplied lenses:
${requestedLenses.map((lens, index) => `${index + 1}. ${JSON.stringify(lens)}`).join("\n")}

The Lens column must exactly equal its caller-supplied lens. Do not add, remove, rename, reorder, merge, or reinterpret lenses.`
    : "Design exactly one decision-relevant expert perspective for the question below.";

  return `${assignment}

For each lens:
- Why this lens: one short sentence explaining its distinct value.
- Expert prompt: one or two concise sentences starting with the exact words "You are" and naming only the relevant expertise, evidence standard, and investigative focus.

Do not pre-answer the question, prescribe an answer format, or repeat shared instructions in the expert prompt.

Return only this Markdown table, with one perspective per line:
| Lens | Why this lens | Expert prompt |
| --- | --- | --- |
| exact lens name | one-sentence rationale | You are ... |

Keep every cell on one line. Escape any pipe within a cell as \\|.

Question:
${question}${context ? `\n\nContext:\n${context}` : ""}`;
}

function workerPrompt(
  question: string,
  context: string,
  perspective: Perspective,
  assignmentInstructions: string = "",
): string {
  return `${perspective.expertPrompt}

Perspective assignment: ${perspective.name}
Why this perspective is employed: ${perspective.rationale}

${READ_ONLY_INSTRUCTIONS}
${SOURCE_INSTRUCTIONS}
${assignmentInstructions ? `\n${assignmentInstructions}\n` : ""}

Question:
${question}${context ? `\n\nContext:\n${context}` : ""}

Answer from this perspective only. Return only the minimum needed to materially inform the decision: lead with the conclusion, support it with evidence, and include only consequential tradeoffs, risks, or unknowns. Do not restate the question or your role.`;
}

function synthesisPrompt(
  question: string,
  context: string,
  results: readonly PerspectiveResult[],
  plannerThreadIds: readonly string[],
): string {
  const maximumOutputChars = Math.max(
    1,
    Math.floor(MAX_SYNTHESIS_EVIDENCE_CHARS / Math.max(1, results.length)),
  );
  const evidence = results
    .map((result) => {
      const truncated = result.output.length > maximumOutputChars;
      const output = result.output.slice(0, maximumOutputChars);
      const availability = result.status === "succeeded"
        ? "Complete"
        : result.output
          ? `Incomplete (${result.status.replace("_", " ")})`
          : `Unavailable (${result.status.replace("_", " ")})`;
      const error = result.error ? `\nFailure detail: ${result.error.slice(0, 1_000)}` : "";
      const answer = output
        ? `\n\n${output}${truncated ? "\n\n[Output truncated to fit the synthesis context.]" : ""}`
        : "\n\n[No usable answer was returned.]";
      const provenance = result.threadId
        ? `\nInternal evidence thread: @thread:${result.threadId}`
        : "";
      return `### ${result.perspective.name}\nWhy employed: ${result.perspective.rationale}\nStatus: ${availability}${error}${provenance}${answer}`;
    })
    .join("\n\n---\n\n");

  return `Synthesize the independent expert perspectives below into one decision-ready answer.

${READ_ONLY_INSTRUCTIONS}

Return concise Markdown with these sections:
## Unified Answer
## Perspective Takeaways
## Disagreements and Tradeoffs
## Risks and Unknowns
## Confidence
## Sources

Preserve meaningful dissent. Do not treat the number of similar answers as proof. Do not invent facts absent from the perspective outputs. Explicitly account for unavailable perspectives as limits on confidence; failure details and partial outputs are context, not completed expert conclusions.

Preserve source citations from the perspective outputs and keep them next to the claims they support. Prefer primary sources, deduplicate repeated sources, and include only sources that a perspective actually inspected in the Sources section. Never invent or repair a missing citation. If a material claim lacks support, qualify it as analysis, inference, supplied context, or an unresolved evidence gap.

Return only the decision-ready answer. Do not describe the orchestration pipeline, worker lifecycle, thread structure, or internal statuses except where missing evidence materially affects confidence. Do not include thread IDs or internal consultation references.

Question:
${question}${context ? `\n\nContext:\n${context}` : ""}

Perspective outputs:
${evidence}

Internal planning provenance: ${plannerThreadIds.map((threadId) => `@thread:${threadId}`).join(" · ") || "unavailable"}

The internal thread references above are inspectability metadata, not evidence. Do not include them in the answer or Sources section.`;
}

function fallbackSynthesis(
  results: readonly PerspectiveResult[],
  failure: string,
  partialSynthesis: string = "",
): string {
  const maximumOutputChars = Math.max(
    1,
    Math.floor(MAX_SYNTHESIS_EVIDENCE_CHARS / Math.max(1, results.length)),
  );
  const outputs = results.map((item) => {
    const detail = item.error ? ` — ${item.error.slice(0, 1_000)}` : "";
    const truncated = item.output.length > maximumOutputChars;
    const answer = item.output
      ? `${item.output.slice(0, maximumOutputChars)}${truncated ? "\n\n[Output truncated.]" : ""}`
      : "No usable answer returned.";
    return `### ${item.perspective.name}\n\n_Status: ${item.status}${detail}_\n\n${answer}`;
  }).join("\n\n");

  const partial = partialSynthesis
    ? `\n\n## Partial synthesis\n\n${partialSynthesis}\n\nThis synthesis was interrupted and may be incomplete.`
    : "";
  return `## Synthesis unavailable\n\n${failure}${partial}\n\n## Perspective outputs\n\n${outputs}`;
}

function fallbackPerspectives(lenses: readonly string[]): Perspective[] {
  return lenses.map((lens) => ({
    name: lens,
    rationale: `Evaluate the question specifically through the ${lens} lens.`,
    expertPrompt: `You are an independent specialist evaluating the question specifically through the ${lens} lens, using concrete evidence and identifying consequential uncertainty.`,
  }));
}

async function waitForTerminal(
  threads: Threads,
  threadId: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<"idle" | "error"> {
  throwIfAborted(signal);
  try {
    await threads.wait({ threadId, status: "idle", timeoutMs, signal });
    return "idle";
  } catch (error) {
    if (error instanceof Error && error.name === "ThreadWaitUnreachableError") {
      return "error";
    }
    throw error;
  }
}

function isThreadWaitTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "ThreadWaitTimeoutError";
}

async function readAgentOutput(threads: Threads, threadId: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTERNAL_REQUEST_GRACE_MS);
  try {
    const { output } = await threads.output({ threadId, signal: controller.signal });
    return clean(output ?? undefined);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * threads.spawn is a raw RPC with no abort or timeout of its own; racing it
 * keeps one hung spawn from stalling the whole run. A spawn that resolves
 * after the race was lost is stopped so it cannot linger as a zombie.
 */
async function spawnThreadWithin(
  threads: Threads,
  args: Parameters<Threads["spawn"]>[0],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ id: string }> {
  const spawned = threads.spawn(args);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const outcome = await Promise.race([
      spawned.then((thread) => ({ kind: "spawned" as const, thread })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
      new Promise<{ kind: "aborted" }>((resolve) => {
        abort = () => resolve({ kind: "aborted" });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
    if (outcome.kind === "spawned") return outcome.thread;
    void spawned.then(
      (thread) => settleWithin(threads.stop({ threadId: thread.id }), INTERNAL_REQUEST_GRACE_MS),
      () => undefined,
    );
    if (outcome.kind === "aborted") throw abortError();
    throw new Error(`Spawning an agent thread timed out after ${timeoutMs}ms.`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function spawnAgent(
  bb: BbPluginApi,
  context: SpawnContext,
  title: string,
  prompt: string,
  perspective: Perspective,
  deadline: number,
): Promise<SpawnedAgent> {
  throwIfAborted(context.signal);
  const executionInputSources = {
    providerId: "explicit" as const,
    model: "explicit" as const,
    ...(context.execution.serviceTier ? { serviceTier: "explicit" as const } : {}),
    reasoningLevel: "explicit" as const,
    permissionMode: "explicit" as const,
  };

  const thread = await spawnThreadWithin(
    bb.sdk.threads,
    {
      projectId: context.projectId,
      environment: context.environment,
      title,
      prompt,
      visibility: "hidden",
      providerId: context.execution.providerId,
      model: context.execution.model,
      ...(context.execution.serviceTier ? { serviceTier: context.execution.serviceTier } : {}),
      reasoningLevel: context.execution.reasoningLevel,
      permissionMode: context.execution.permissionMode,
      executionInputSources,
    },
    Math.min(context.spawnTimeoutMs, remainingMilliseconds(deadline)),
    context.signal,
  );

  const localController = new AbortController();
  let stopPromise: Promise<void> | undefined;
  const requestStop = (): Promise<void> => {
    localController.abort();
    stopPromise ??= settleWithin(
      bb.sdk.threads.stop({ threadId: thread.id }),
      INTERNAL_REQUEST_GRACE_MS,
    );
    return stopPromise;
  };
  const abortLocal = () => {
    void requestStop();
  };
  context.signal.addEventListener("abort", abortLocal, { once: true });
  if (context.signal.aborted) abortLocal();

  const result = (async (): Promise<PerspectiveResult> => {
    try {
      const terminal = await waitForTerminal(
        bb.sdk.threads,
        thread.id,
        localController.signal,
        remainingMilliseconds(deadline),
      );
      const normalized = await readAgentOutput(bb.sdk.threads, thread.id);
      if (terminal === "error") {
        return {
          perspective,
          threadId: thread.id,
          status: "failed",
          output: normalized,
          error: "Agent thread entered the error state.",
        };
      }
      if (!normalized) {
        return {
          perspective,
          threadId: thread.id,
          status: "failed",
          output: "",
          error: "Agent returned no final answer.",
        };
      }
      return { perspective, threadId: thread.id, status: "succeeded", output: normalized };
    } catch (error) {
      const externallyStopped = localController.signal.aborted;
      const partialBeforeStop = externallyStopped
        ? ""
        : await readAgentOutput(bb.sdk.threads, thread.id);
      if (!externallyStopped) {
        await requestStop();
      } else if (stopPromise) {
        await stopPromise;
      }
      const partialAfterStop = externallyStopped
        ? ""
        : await readAgentOutput(bb.sdk.threads, thread.id);
      return {
        perspective,
        threadId: thread.id,
        status: externallyStopped
          ? "stopped"
          : isThreadWaitTimeout(error)
            ? "timed_out"
            : "failed",
        output: partialAfterStop || partialBeforeStop,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      context.signal.removeEventListener("abort", abortLocal);
    }
  })();

  return {
    threadId: thread.id,
    result,
    steer: async (message) => {
      await bb.sdk.threads.send({
        threadId: thread.id,
        mode: "steer-if-active",
        input: [{ type: "text", text: message, mentions: [], visibility: "agent-only" }],
      });
    },
    stop: async () => {
      await requestStop();
    },
  };
}

function configurationError(message: string): Error {
  return Object.assign(new Error(message), { name: "NeedsConfigurationError" });
}

function hasOverrides(settings: PhaseExecutionSettings): boolean {
  return Boolean(
    clean(settings.providerId) ||
      clean(settings.model) ||
      settings.reasoningLevel ||
      settings.permissionMode,
  );
}

const permissionRank: Record<PermissionMode, number> = {
  "accept-edits": 0,
  auto: 1,
  full: 2,
};

/**
 * The run signal, not the tool-call request signal, governs the pipeline:
 * gather_perspectives keeps working after its tool call has already returned,
 * when the request (and its signal) may be long gone.
 */
async function createSpawnContexts(
  bb: BbPluginApi,
  toolContext: PluginAgentToolContext,
  settings: PerspectivesExecutionSettings,
  signal: AbortSignal,
  spawnTimeoutMs: number,
): Promise<SpawnContexts> {
  const [caller, execution] = await Promise.all([
    bb.sdk.threads.get({ threadId: toolContext.threadId, signal }),
    bb.sdk.threads.defaultExecutionOptions({ threadId: toolContext.threadId, signal }),
  ]);
  if (!execution) {
    throw configurationError(
      "Perspectives could not resolve the caller's execution defaults. Choose a provider and model in the calling thread, then retry.",
    );
  }

  const inheritedExecution: ResolvedExecution = {
    providerId: caller.providerId,
    model: execution.model,
    serviceTier: execution.serviceTier,
    reasoningLevel: execution.reasoningLevel,
    permissionMode: execution.permissionMode,
  };

  const environment = caller.environmentId
    ? { type: "reuse" as const, environmentId: caller.environmentId }
    : { type: "project-default" as const };
  const routing = caller.environmentId ? { environmentId: caller.environmentId } : {};
  let providersPromise: ReturnType<typeof bb.sdk.providers.list> | undefined;
  const modelPromises = new Map<string, ReturnType<typeof bb.sdk.providers.models>>();

  const providers = () =>
    providersPromise ??= bb.sdk.providers.list({ ...routing, signal });
  const models = (providerId: string) => {
    let promise = modelPromises.get(providerId);
    if (!promise) {
      promise = bb.sdk.providers.models({
        ...routing,
        providerId,
        signal,
      });
      modelPromises.set(providerId, promise);
    }
    return promise;
  };

  const resolvePhase = async (
    phase: "planner" | "worker",
    configured: PhaseExecutionSettings,
  ): Promise<ResolvedExecution> => {
    if (!hasOverrides(configured)) return inheritedExecution;

    const providerId = clean(configured.providerId) || inheritedExecution.providerId;
    const provider = (await providers()).find((candidate) => candidate.id === providerId);
    if (!provider?.available) {
      throw configurationError(
        `Configured ${phase} provider ${JSON.stringify(providerId)} is unavailable on the caller's environment host.`,
      );
    }

    const options = await models(providerId);
    const availableModels = [...options.models, ...options.selectedOnlyModels];
    const requestedModel = clean(configured.model);
    const inheritedModel = providerId === inheritedExecution.providerId
      ? inheritedExecution.model
      : "";
    const model = requestedModel
      ? availableModels.find(
          (candidate) => candidate.id === requestedModel || candidate.model === requestedModel,
        )
      : availableModels.find((candidate) => candidate.model === inheritedModel) ??
        availableModels.find((candidate) => candidate.isDefault);
    if (!model) {
      const detail = requestedModel
        ? `model ${JSON.stringify(requestedModel)}`
        : "a default model";
      throw configurationError(
        `Configured ${phase} provider ${JSON.stringify(providerId)} does not expose ${detail}.`,
      );
    }

    const reasoningLevel = configured.reasoningLevel ??
      (providerId === inheritedExecution.providerId && model.model === inheritedExecution.model
        ? inheritedExecution.reasoningLevel
        : model.defaultReasoningEffort);
    if (!model.supportedReasoningEfforts.some((item) => item.reasoningEffort === reasoningLevel)) {
      throw configurationError(
        `Configured ${phase} reasoning level ${JSON.stringify(reasoningLevel)} is unavailable for ${providerId}/${model.model}.`,
      );
    }

    const permissionMode = configured.permissionMode ?? inheritedExecution.permissionMode;
    if (!provider.capabilities.permissionModes.includes(permissionMode)) {
      throw configurationError(
        `Configured ${phase} permission mode ${JSON.stringify(permissionMode)} is unavailable for provider ${JSON.stringify(providerId)}.`,
      );
    }
    if (permissionRank[permissionMode] > permissionRank[options.permissionCeiling]) {
      throw configurationError(
        `Configured ${phase} permission mode ${JSON.stringify(permissionMode)} exceeds the current host ceiling ${JSON.stringify(options.permissionCeiling)}.`,
      );
    }

    return {
      providerId,
      model: model.model,
      serviceTier: provider.capabilities.supportsServiceTier
        ? inheritedExecution.serviceTier ?? "default"
        : undefined,
      reasoningLevel,
      permissionMode,
    };
  };

  const [plannerExecution, workerExecution] = await Promise.all([
    resolvePhase("planner", settings.planner),
    resolvePhase("worker", settings.worker),
  ]);
  const common = {
    projectId: toolContext.projectId,
    callerThreadId: toolContext.threadId,
    signal,
    spawnTimeoutMs,
    environment,
  };
  return {
    planner: { ...common, execution: plannerExecution },
    worker: { ...common, execution: workerExecution },
  };
}

async function nextResult(
  pending: ReadonlyMap<string, PanelAgent>,
): Promise<{ agent: PanelAgent; result: PerspectiveResult }> {
  return Promise.race(
    [...pending.values()].map((agent) => agent.result.then((result) => ({ agent, result }))),
  );
}

export async function collectPanelResults(
  agents: readonly PanelAgent[],
  wrapUpAt: number,
): Promise<PerspectiveResult[]> {
  const pending = new Map(agents.map((agent) => [agent.threadId, agent]));
  const results = new Map<string, PerspectiveResult>();
  let wrapUpSent = false;

  while (pending.size > 0) {
    if (!wrapUpSent) {
      const remainingMs = wrapUpAt - Date.now();
      if (remainingMs > 0) {
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const wrapUpTime = new Promise<{ kind: "wrap_up" }>((resolve) => {
          deadlineTimer = setTimeout(() => resolve({ kind: "wrap_up" }), remainingMs);
        });
        const raced = await Promise.race([
          nextResult(pending).then((value) => ({ kind: "result" as const, value })),
          wrapUpTime,
        ]);
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        if (raced.kind === "result") {
          pending.delete(raced.value.agent.threadId);
          results.set(raced.value.agent.threadId, raced.value.result);
          continue;
        }
      }

      wrapUpSent = true;
      for (const agent of pending.values()) {
        void agent.steer(WRAP_UP_MESSAGE).catch(() => undefined);
      }
      continue;
    }

    const completed = await nextResult(pending);
    pending.delete(completed.agent.threadId);
    results.set(completed.agent.threadId, completed.result);
  }

  return agents.map((agent) => results.get(agent.threadId)!);
}

async function generatePlan(
  bb: BbPluginApi,
  context: SpawnContext,
  question: string,
  sharedContext: string,
  requestedLenses: readonly string[] | null,
  phaseDeadline: number,
): Promise<GeneratedPlan> {
  const plannerPerspective: Perspective = {
    name: "Perspective Planner",
    rationale: "Design the expert panel.",
    expertPrompt: "You are an expert panel designer who decomposes questions into distinct, decision-relevant modes of inquiry.",
  };

  let lastError = "Planner failed.";
  const threadIds: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (Date.now() >= phaseDeadline) break;
    let planner: SpawnedAgent;
    try {
      planner = await spawnAgent(
        bb,
        context,
        `Perspective planner ${attempt}`,
        `${READ_ONLY_INSTRUCTIONS}\n\n${plannerPrompt(question, sharedContext, requestedLenses)}`,
        plannerPerspective,
        phaseDeadline,
      );
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }
    threadIds.push(planner.threadId);
    const result = await planner.result;
    if (result.output) {
      try {
        return {
          perspectives: parsePerspectivePlan(result.output, requestedLenses ?? 1),
          threadIds,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    } else {
      lastError = result.error ?? "Planner failed.";
    }
  }
  if (requestedLenses) {
    return { perspectives: fallbackPerspectives(requestedLenses), threadIds };
  }
  throw new Error(`Unable to generate expert perspectives: ${lastError}`);
}

async function synthesize(
  bb: BbPluginApi,
  context: SpawnContext,
  question: string,
  sharedContext: string,
  results: readonly PerspectiveResult[],
  plannerThreadIds: readonly string[],
  phaseDeadline: number,
): Promise<SynthesisResult> {
  const internalThreadIds = [
    ...plannerThreadIds,
    ...results.map((result) => result.threadId).filter(Boolean),
  ];
  if (!results.some((result) => result.output)) {
    return {
      output: fallbackSynthesis(
        results,
        "No perspective returned usable output, so there was no evidence to synthesize.",
      ),
    };
  }

  const synthesisPerspective: Perspective = {
    name: "Synthesis",
    rationale: "Unify the completed perspectives without erasing disagreement.",
    expertPrompt: "You are a rigorous synthesis editor who preserves evidence, disagreement, and uncertainty while producing a decision-ready answer.",
  };
  let agent: SpawnedAgent;
  try {
    agent = await spawnAgent(
      bb,
      context,
      "Perspective synthesis",
      synthesisPrompt(question, sharedContext, results, plannerThreadIds),
      synthesisPerspective,
      phaseDeadline,
    );
  } catch (error) {
    return {
      output: fallbackSynthesis(
        results,
        `The synthesis agent could not be launched: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  const result = await agent.result;
  if (result.status === "succeeded") {
    return {
      output: withoutInternalThreadReferences(result.output, internalThreadIds),
      threadId: agent.threadId,
    };
  }

  return {
    output: fallbackSynthesis(
      results,
      `The synthesis agent did not complete: ${result.error ?? "unknown provider failure"}`,
      withoutInternalThreadReferences(result.output, internalThreadIds),
    ),
    threadId: agent.threadId,
  };
}

export async function runHelp(
  bb: BbPluginApi,
  input: { question: string; context?: string },
  toolContext: PluginAgentToolContext,
  executionSettings: PerspectivesExecutionSettings = INHERIT_EXECUTION_SETTINGS,
): Promise<string> {
  const question = clean(input.question);
  const sharedContext = clean(input.context);
  if (!question) throw new Error("help requires a non-empty question.");

  const contexts = await createSpawnContexts(
    bb,
    toolContext,
    executionSettings,
    toolContext.signal,
    SPAWN_TIMEOUT_MS,
  );
  const plannerDeadline = Date.now() + PLANNER_PHASE_TIMEOUT_MS;
  const plan = await generatePlan(bb, contexts.planner, question, sharedContext, null, plannerDeadline);
  const [perspective] = plan.perspectives;
  const helper = await spawnAgent(
    bb,
    contexts.worker,
    `Help: ${perspective!.name}`,
    workerPrompt(
      question,
      sharedContext,
      perspective!,
      `${DIRECT_HELP_INSTRUCTIONS}\n\nInternal planning provenance for inspection only: ${plan.threadIds.map((threadId) => `@thread:${threadId}`).join(" · ") || "unavailable"}. Do not include internal thread references in the answer or Sources section.`,
    ),
    perspective!,
    Date.now() + HELPER_PHASE_TIMEOUT_MS,
  );
  const result = await helper.result;
  if (result.status !== "succeeded" && !result.output) {
    throw new Error(result.error ?? "Expert helper failed.");
  }
  const output = result.status === "succeeded"
    ? result.output
    : `## Partial expert answer\n\n${result.output}\n\n_The helper was interrupted and this answer may be incomplete._`;
  return withResultThread(
    withoutInternalThreadReferences(output, plan.threadIds),
    "Expert consultation",
    helper.threadId,
  );
}

export const GATHER_RESULT_HEADER = "Perspectives panel result";
export const GATHER_FAILURE_HEADER = "Perspectives panel failed";

const COORDINATOR_WRAP_UP_MS = 20 * 60_000;
const COORDINATOR_DEADLINE_MS = 25 * 60_000;
const CALLER_BACKSTOP_GRACE_MS = 60_000;
const COORDINATOR_ARTIFACT_PATH = "perspectives/results/$BB_THREAD_ID.md";
const COORDINATOR_MARKER_PREFIX = "perspectives-invocation:";
const THREAD_LIST_PAGE_SIZE = 100;
const PRESENTATION_EVENT_PAGE_SIZE = 100;
const PRESENTATION_EVENT_MAX_PAGES = 5;

function normalizedLenses(input: { readonly lenses: readonly string[] }): string[] {
  if (!Array.isArray(input.lenses) || input.lenses.length < 2 || input.lenses.length > 7) {
    throw new Error("gather_perspectives requires 2–7 distinct lenses.");
  }
  const lenses = input.lenses.map((lens) => typeof lens === "string" ? lens.trim() : "");
  if (lenses.some((lens) => !lens || lens.length > 120)) {
    throw new Error("Each gather_perspectives lens must contain 1–120 characters.");
  }
  const seen = new Set<string>();
  for (const lens of lenses) {
    const key = lens.toLocaleLowerCase();
    if (seen.has(key)) throw new Error("gather_perspectives requires distinct lenses.");
    seen.add(key);
  }
  return lenses;
}

interface CoordinatorRunRequest {
  readonly protocolVersion: 1;
  readonly invocationMarker: string;
  readonly question: string;
  readonly context: string;
  readonly orderedLenses: readonly string[];
  readonly callerThreadId: string;
  readonly projectId: string;
  readonly environmentId: string | null;
  readonly coordinatorExecution: ResolvedExecution;
  readonly workerExecution: ResolvedExecution;
  readonly startedAtEpochMs: number;
  readonly wrapUpAtEpochMs: number;
  readonly deadlineAtEpochMs: number;
  readonly callerBackstopAtEpochMs: number;
  readonly artifactRelativePath: string;
}

const executionSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  serviceTier: z.enum(["default", "fast"]).optional(),
  reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]),
  permissionMode: z.enum(["accept-edits", "auto", "full"]),
}).strict();

// Protocol v1 is persisted run identity. Keep this decoder stable across
// prompt edits and plugin upgrades; add a versioned decoder before changing it.
const coordinatorRequestProtocolV1Schema = z.object({
  protocolVersion: z.literal(1),
  invocationMarker: z.string().regex(/^perspectives-invocation:[0-9a-f-]{36}$/i),
  question: z.string().min(1),
  context: z.string(),
  orderedLenses: z.array(z.string().min(1).max(120)).min(2).max(7),
  callerThreadId: z.string().min(1),
  projectId: z.string().min(1),
  environmentId: z.string().min(1).nullable(),
  coordinatorExecution: executionSchema,
  workerExecution: executionSchema,
  startedAtEpochMs: z.number().int().nonnegative(),
  wrapUpAtEpochMs: z.number().int().nonnegative(),
  deadlineAtEpochMs: z.number().int().nonnegative(),
  callerBackstopAtEpochMs: z.number().int().nonnegative(),
  artifactRelativePath: z.literal(COORDINATOR_ARTIFACT_PATH),
}).strict().superRefine((request, context) => {
  if (request.wrapUpAtEpochMs !== request.startedAtEpochMs + COORDINATOR_WRAP_UP_MS ||
      request.deadlineAtEpochMs !== request.startedAtEpochMs + COORDINATOR_DEADLINE_MS ||
      request.callerBackstopAtEpochMs !== request.deadlineAtEpochMs + CALLER_BACKSTOP_GRACE_MS) {
    context.addIssue({ code: "custom", message: "Run deadlines do not match the Perspectives schedule." });
  }
});

function coordinatorPrompt(request: CoordinatorRunRequest): string {
  return `Perspectives coordinator protocol: ${request.protocolVersion}

${COORDINATOR_AUTHORITY_INSTRUCTIONS}

You are the durable Perspectives panel coordinator. Your BB thread ID is the run ID. Coordinate one ordinary hidden worker for each requested lens, reconcile through the Perspectives tools, synthesize only from persisted full outputs, and publish one immutable result artifact. Do not create planner or synthesis threads.

## Complete run request

\`\`\`json
${JSON.stringify(request, null, 2)}
\`\`\`

## Worker-only instructions

Include this block in every worker prompt. It limits workers only; the coordinator has the narrow BB tools described above:

${READ_ONLY_INSTRUCTIONS}

## Coordinator protocol

On the first turn and every native child report or scheduled wake, call \`perspectives_coordinator_step\`. It authenticates this run from the thread ID, parent-child relationship, and first persisted client/turn/requested event; it schedules the wrap-up and deadline rows, discovers or creates ordinary hidden workers, reconciles child status and complete stored outputs, and stops remaining workers at or after the deadline. Do not use shell commands for BB operations.

If the step reports workers still running, end the turn. Do not wait or poll. If it reports ready to synthesize, use only the returned full outputs; a missing output is unavailable evidence, and notification excerpts are never evidence. Cite factual claims from sources actually inspected by workers. Preserve disagreements, partial findings, supplied context versus inference, and unknowns. Do not treat agreement or worker count as proof. Never claim more certainty or coverage than the returned evidence supports. If a child identity is ambiguous or duplicated, disclose that lens as uncertain and keep distinct child IDs separate.

After synthesis, call \`perspectives_publish_result\` exactly once with the complete synthesis text and a coverage choice. Choose partial if any requested lens could not inspect relevant sources, cannot answer, has unsupported citations, or has materially unknown coverage. Choose complete only if every requested lens returned exactly one persisted final output and you judge the requested lenses substantively addressed. This is a conservative coordinator judgment, not a mechanical proof of factual coverage; when unsure, choose partial. Older coordinator prompts may omit the optional choice; the product then uses partial. The tool separately computes worker-output availability from persisted children and caps complete status if any requested lens lacks exactly one idle verified worker with a final output. A complete status still does not prove the synthesis factually complete. The tool builds an exact UTF-8 artifact, computes the body SHA-256, writes with create-only atomic semantics, reads back, and verifies the exact bytes. Do not write files directly or retry a conflicting publication. Include the returned status, run ID, relative path, body SHA-256, and full-file SHA-256 in your short final response. The caller can read the full verified artifact with \`perspectives_read_result\`.

The 20-, 25-, and 26-minute targets depend on BB's scheduled-message sweep and host availability. Queue acceptance is not delivery. A failed queue row does not wake this coordinator automatically; if the native report is also lost, BB currently needs explicit queue recovery or operator action. Never promise an eventual wake, exactly-once creation, or a strict wall-clock deadline.`;
}

function backstopMessage(args: {
  readonly marker: string;
  readonly requestIdentity: {
    readonly question: string;
    readonly context: string;
    readonly orderedLenses: readonly string[];
    readonly callerThreadId: string;
    readonly projectId: string;
    readonly environmentId: string | null;
    readonly coordinatorExecution: ResolvedExecution;
    readonly workerExecution: ResolvedExecution;
  };
  readonly backstopAt: number;
}): string {
  return `${GATHER_RESULT_HEADER} caller backstop\nInvocation marker: ${args.marker}\nRequest identity:\n${JSON.stringify(args.requestIdentity, null, 2)}\nScheduled target: ${new Date(args.backstopAt).toISOString()}\n\nUse Perspectives' perspectives_read_result tool with this invocation marker. It searches this caller's hidden children and verifies each candidate's first persisted client/turn/requested input and parent relationship. Zero verified matches means launch failed or remains uncertain; listing errors mean discovery is unavailable. One verified coordinator lets you read its artifact. Multiple verified coordinators are possible duplicates: disclose their IDs and statuses and keep their artifacts separate. Present a result only after the tool verifies the full file bytes, embedded run identity, body SHA-256, and terminal marker. Report missing, corrupt, or host-offline outcomes without claiming success. Do not use the shell or guess a thread-storage path.`;
}

function queuedRowMatches(
  row: {
    readonly threadId?: string;
    readonly sendAt?: number | null;
    readonly content?: unknown;
    readonly failureReason?: string | null;
    readonly editable?: boolean;
  },
  threadId: string,
  sendAt: number,
  expectedMessage: string,
): boolean {
  const content = row.content;
  const message = Array.isArray(content) && content.length === 1 &&
      content[0] && typeof content[0] === "object" &&
      (content[0] as { readonly type?: unknown }).type === "text" &&
      typeof (content[0] as { readonly text?: unknown }).text === "string"
    ? (content[0] as { readonly text: string }).text
    : undefined;
  return row.threadId === threadId &&
    row.sendAt === sendAt &&
    sendAt > Date.now() &&
    row.failureReason === null &&
    row.editable === true &&
    message === expectedMessage;
}

async function confirmCallerBackstop(
  bb: BbPluginApi,
  callerThreadId: string,
  marker: string,
  sendAt: number,
  message: string,
): Promise<string> {
  try {
    const response = await bb.sdk.threads.send({
      threadId: callerThreadId,
      mode: "auto",
      sendAt,
      input: [{ type: "text", text: message, mentions: [], visibility: "agent-only" }],
    });
    if (response.delivery === "queued" && queuedRowMatches(response.queuedMessage, callerThreadId, sendAt, message)) {
      return response.queuedMessage.id;
    }
  } catch {
    // Inspect durable queue state below before deciding whether acceptance is unknown.
  }

  const rows = await bb.sdk.threads.queuedMessages.list({ threadId: callerThreadId });
  const matches = rows.filter((row) => queuedRowMatches(row, callerThreadId, sendAt, message));
  if (matches.length === 1) return matches[0]!.id;
  throw new Error(
    `Caller backstop for invocation ${marker} could not be confirmed${matches.length > 1 ? " uniquely" : ""}; no coordinator was spawned and no success receipt was issued.`,
  );
}

async function listChildrenByParent(threads: Threads, parentThreadId: string, signal?: AbortSignal) {
  const children: Awaited<ReturnType<Threads["list"]>> = [];
  let offset = 0;
  for (;;) {
    const page = await threads.list({
      parentThreadId,
      includeHidden: true,
      limit: THREAD_LIST_PAGE_SIZE,
      offset,
      ...(signal ? { signal } : {}),
    });
    children.push(...page);
    if (page.length < THREAD_LIST_PAGE_SIZE) return children;
    offset += page.length;
  }
}

async function rediscoverCoordinator(
  threads: Threads,
  callerThreadId: string,
  marker: string,
  expectedPrompt: string,
): Promise<
  | { readonly kind: "one"; readonly coordinatorId: string }
  | { readonly kind: "none" }
  | { readonly kind: "multiple"; readonly coordinatorIds: readonly string[] }
  | { readonly kind: "unavailable" }
> {
  try {
    const children = await listChildrenByParent(threads, callerThreadId);
    const candidates = children.filter((child) =>
      child.parentThreadId === callerThreadId &&
      child.visibility === "hidden"
    );
    const verified: string[] = [];
    for (const child of candidates) {
      // BB prompt history omits agent-only spawn input. The initial request
      // event is persisted with the thread and retains that complete input.
      const initialRequests = await threads.events.list({
        threadId: child.id,
        types: ["client/turn/requested"],
        order: "asc",
        limit: "1",
      });
      const initial = initialRequests[0];
      if (initial?.type === "client/turn/requested" &&
        initial.data.input.length === 1 &&
        initial.data.input[0]?.type === "text" &&
        initial.data.input[0].text === expectedPrompt
      ) verified.push(child.id);
    }
    if (verified.length === 1) return { kind: "one", coordinatorId: verified[0]! };
    if (verified.length > 1) return { kind: "multiple", coordinatorIds: verified };
    return { kind: "none" };
  } catch {
    return { kind: "unavailable" };
  }
}

async function spawnCoordinator(
  bb: BbPluginApi,
  args: Parameters<Threads["spawn"]>[0],
  callerThreadId: string,
  marker: string,
  timeoutMs: number,
): Promise<string> {
  let pending: Promise<
    | { readonly kind: "spawned"; readonly id: string }
    | { readonly kind: "ambiguous"; readonly error: unknown }
  >;
  try {
    pending = bb.sdk.threads.spawn(args).then(
      (thread) => ({ kind: "spawned" as const, id: thread.id }),
      (error: unknown) => ({ kind: "ambiguous" as const, error }),
    );
  } catch (error) {
    pending = Promise.resolve({ kind: "ambiguous", error });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    pending,
    new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  if (outcome.kind === "spawned") return outcome.id;

  const discovery = typeof args.prompt === "string"
    ? await rediscoverCoordinator(bb.sdk.threads, callerThreadId, marker, args.prompt)
    : { kind: "unavailable" as const };
  if (discovery.kind === "one") return discovery.coordinatorId;
  const spawnReason = outcome.kind === "timeout"
    ? `spawn response timed out after ${timeoutMs}ms`
    : outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
  const discoveryReason = discovery.kind === "multiple"
    ? `multiple marker-matched children were found (${discovery.coordinatorIds.join(", ")})`
    : discovery.kind === "none"
      ? "no marker-matched child was found"
      : "child discovery was unavailable";
  throw new Error(`Launch uncertain: coordinator spawn is ambiguous (${spawnReason}); ${discoveryReason}. No successful launch was confirmed, and this invocation did not retry it.`);
}

function launchReceipt(runId: string, backstopRowId: string, backstopAt: number, lensCount: number): string {
  return `Perspectives panel launched for ${lensCount} lenses.\n\nRun ID: ${runId}\nCoordinator: @thread:${runId}\nCaller backstop: queued (${backstopRowId}) for ${new Date(backstopAt).toISOString()}.\nArtifact: perspectives/results/${runId}.md\n\nThe coordinator reconciles native child reports and scheduled wakes, then publishes one complete, partial, or failed artifact. Its final response arrives through BB's native parent report; the queued backstop recovers a lost completion. When either arrives, verify the artifact by coordinator ID and relative path, then present it once. After restart, compare older coordinator prompts by caller ID, question, context, ordered lenses, project/environment, and execution settings; disclose matching runs as possible duplicates with separate IDs because identical requests may be intentional. Keep their artifacts separate. Do not wait or poll for the result. The 20-, 25-, and 26-minute times are scheduling targets, not delivery guarantees.`;
}

const WORKER_TITLE_PREFIX = "Perspectives worker ";
const ARTIFACT_BODY_START = "<!-- perspectives-body:start -->\n";
const ARTIFACT_BODY_END = "\n<!-- perspectives-body:end -->";
const MAX_RECONCILED_OUTPUT_CHARS = MAX_SYNTHESIS_EVIDENCE_CHARS;

interface AuthenticatedCoordinator {
  readonly thread: Awaited<ReturnType<Threads["get"]>>;
  readonly request: CoordinatorRunRequest;
  readonly prompt: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function eventText(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const input = (data as { input?: unknown }).input;
  if (!Array.isArray(input) || input.length !== 1) return undefined;
  const first = input[0];
  if (!first || typeof first !== "object" || (first as { type?: unknown }).type !== "text") return undefined;
  return typeof (first as { text?: unknown }).text === "string" ? (first as { text: string }).text : undefined;
}

async function firstRequestedPrompt(threads: Threads, threadId: string, signal?: AbortSignal): Promise<string | undefined> {
  const events = await threads.events.list({
    threadId,
    types: ["client/turn/requested"],
    order: "asc",
    limit: "1",
    ...(signal ? { signal } : {}),
  });
  const first = events[0];
  return first?.type === "client/turn/requested" ? eventText(first) : undefined;
}

function requestFromCoordinatorPrompt(prompt: string): CoordinatorRunRequest | undefined {
  const protocolMarkers = prompt.match(/^Perspectives coordinator protocol: (\d+)$/gm) ?? [];
  const requestBlocks = [...prompt.matchAll(/^## Complete run request\n\n```json\n([\s\S]*?)\n```$/gm)];
  if (protocolMarkers.length !== 1 || protocolMarkers[0] !== "Perspectives coordinator protocol: 1" || requestBlocks.length !== 1) return undefined;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(requestBlocks[0]![1]!);
  } catch {
    return undefined;
  }
  const parsed = coordinatorRequestProtocolV1Schema.safeParse(parsedJson);
  if (!parsed.success || parsed.data.protocolVersion !== 1) return undefined;
  return parsed.data;
}

async function authenticateCoordinator(
  bb: BbPluginApi,
  context: PluginAgentToolContext,
): Promise<AuthenticatedCoordinator> {
  const { threads } = bb.sdk;
  const thread = await threads.get({ threadId: context.threadId, signal: context.signal });
  if (thread.visibility !== "hidden" || !thread.parentThreadId) {
    throw new Error("Unauthorized Perspectives coordinator operation: this thread is not a hidden coordinator child.");
  }
  const prompt = await firstRequestedPrompt(threads, context.threadId, context.signal);
  const request = prompt ? requestFromCoordinatorPrompt(prompt) : undefined;
  if (!request || thread.parentThreadId !== request.callerThreadId || thread.projectId !== request.projectId ||
      context.projectId !== request.projectId ||
      (request.environmentId !== null && thread.environmentId !== request.environmentId)) {
    throw new Error("Unauthorized Perspectives coordinator operation: persisted run request or parent relationship does not match.");
  }
  const caller = await threads.get({ threadId: request.callerThreadId, signal: context.signal });
  if (caller.projectId !== request.projectId || (caller.environmentId ?? null) !== request.environmentId) {
    throw new Error("Unauthorized Perspectives coordinator operation: persisted caller project or environment does not match.");
  }
  return { thread, request, prompt: prompt! };
}

function workerTitle(runId: string, lensIndex: number): string {
  return `${WORKER_TITLE_PREFIX}${runId} lens-${lensIndex + 1}`;
}

function coordinatorWorkerPrompt(request: CoordinatorRunRequest, runId: string, lensIndex: number): string {
  const lens = request.orderedLenses[lensIndex]!;
  return `${READ_ONLY_INSTRUCTIONS}\n\n${SOURCE_INSTRUCTIONS}\n\nYou are one ordinary hidden Perspectives worker.\nRun ID: ${runId}\nLens slot: ${lensIndex + 1} of ${request.orderedLenses.length}\nAssigned lens: ${lens}\n\nQuestion:\n${request.question}\n\nSupplied context (not independently verified):\n${request.context || "(none)"}\n\nInvestigate only the assigned lens. Give a concise answer with the strongest primary sources you actually inspected, meaningful uncertainty, and best available partial work if interrupted. Do not create children, schedule messages, publish files, or operate on the coordinator or caller thread.`;
}

interface VerifiedWorker {
  readonly threadId: string;
  readonly status: string;
  readonly output: string | null;
  readonly outputSha256: string | null;
  readonly outputChars: number;
  readonly outputUnavailableReason?: string;
}

interface LensReconciliation {
  readonly lensIndex: number;
  readonly lens: string;
  readonly state: "running" | "complete" | "failed" | "output-unavailable" | "launch-uncertain" | "duplicate" | "identity-unavailable" | "not-launched";
  readonly launchIntent: "confirmed" | "not-attempted" | "ambiguous" | "unavailable";
  readonly workers: readonly VerifiedWorker[];
  readonly verifiedChildIds: readonly string[];
}

async function verifyWorkerPrompt(
  threads: Threads,
  child: Awaited<ReturnType<Threads["list"]>>[number],
  runId: string,
  request: CoordinatorRunRequest,
  lensIndex: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (child.parentThreadId !== runId || child.visibility !== "hidden" || child.projectId !== request.projectId ||
      (request.environmentId !== null && child.environmentId !== request.environmentId)) return false;
  const prompt = await firstRequestedPrompt(threads, child.id, signal);
  return prompt === coordinatorWorkerPrompt(request, runId, lensIndex);
}

function textContent(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const item = content[0];
  if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "text") return undefined;
  return typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : undefined;
}

function queueStateFor(rows: readonly Record<string, unknown>[], threadId: string, targetAt: number, message: string):
  | { readonly state: "confirmed"; readonly rowId: string }
  | { readonly state: "due" }
  | { readonly state: "failed"; readonly reason: string }
  | { readonly state: "missing" }
  | { readonly state: "ambiguous"; readonly rowIds: readonly string[] } {
  const matches = rows.filter((row) => row.threadId === threadId && row.sendAt === targetAt && textContent(row.content) === message);
  if (matches.length > 1) return { state: "ambiguous", rowIds: matches.map((row) => String(row.id ?? "unknown")) };
  if (matches.length === 0) return { state: "missing" };
  const row = matches[0]!;
  if (typeof row.failureReason === "string" && row.failureReason) {
    return { state: "failed", reason: row.failureReason };
  }
  if (row.editable === true && targetAt > Date.now()) return { state: "confirmed", rowId: String(row.id) };
  if (targetAt <= Date.now()) return { state: "due" };
  return { state: "ambiguous", rowIds: [String(row.id ?? "unknown")] };
}

function coordinatorWakeMessage(runId: string, kind: "wrap-up" | "deadline"): string {
  return `Perspectives coordinator wake: ${runId}; tag=${kind}. Reconcile with perspectives_coordinator_step before acting.`;
}

function workerLaunchIntentMessage(runId: string, lensIndex: number): string {
  return `Perspectives worker launch intent: ${runId}; lens-slot=${lensIndex + 1}. This persisted marker prevents retrying an ambiguous worker spawn.`;
}

type LaunchIntentState = "confirmed" | "not-attempted" | "ambiguous" | "unavailable";

async function inspectWorkerLaunchIntent(
  bb: BbPluginApi,
  runId: string,
  lensIndex: number,
  request: CoordinatorRunRequest,
  signal: AbortSignal,
): Promise<LaunchIntentState> {
  const message = workerLaunchIntentMessage(runId, lensIndex);
  try {
    const [rows, events] = await Promise.all([
      bb.sdk.threads.queuedMessages.list({ threadId: runId, signal }),
      bb.sdk.threads.events.list({ threadId: runId, types: ["client/turn/requested"], order: "desc", limit: "100", signal }),
    ]);
    const matches = rows.filter((row) => row.threadId === runId && row.sendAt === request.callerBackstopAtEpochMs && textContent(row.content) === message);
    if (matches.length > 1) return "ambiguous";
    if (matches.length === 1 || events.some((event) => eventText(event) === message)) return "confirmed";
    return "not-attempted";
  } catch {
    return "unavailable";
  }
}

async function createWorkerLaunchIntent(
  bb: BbPluginApi,
  runId: string,
  lensIndex: number,
  request: CoordinatorRunRequest,
  signal: AbortSignal,
): Promise<boolean> {
  const before = await inspectWorkerLaunchIntent(bb, runId, lensIndex, request, signal);
  if (before !== "not-attempted") return false;
  const message = workerLaunchIntentMessage(runId, lensIndex);
  try {
    await bb.sdk.threads.send({
      threadId: runId,
      mode: "steer",
      sendAt: request.callerBackstopAtEpochMs,
      input: [{ type: "text", text: message, mentions: [], visibility: "agent-only" }],
    });
  } catch {
    // A queue response can be lost after persistence. Only one exact future row
    // is enough to authorize the subsequent spawn attempt.
  }
  try {
    const rows = await bb.sdk.threads.queuedMessages.list({ threadId: runId, signal });
    const matches = rows.filter((row) => row.threadId === runId && row.sendAt === request.callerBackstopAtEpochMs && textContent(row.content) === message);
    return matches.length === 1 && matches[0]!.failureReason === null && matches[0]!.editable === true;
  } catch {
    return false;
  }
}

async function ensureCoordinatorWake(
  bb: BbPluginApi,
  runId: string,
  targetAt: number,
  kind: "wrap-up" | "deadline",
  signal: AbortSignal,
): Promise<{ readonly state: "confirmed" | "due" | "failed" | "ambiguous"; readonly rowId?: string; readonly reason?: string }> {
  const message = coordinatorWakeMessage(runId, kind);
  const listRows = () => bb.sdk.threads.queuedMessages.list({ threadId: runId, signal });
  let rows: readonly Record<string, unknown>[];
  try {
    rows = await listRows() as readonly Record<string, unknown>[];
  } catch (error) {
    return { state: "ambiguous", reason: `queue reconciliation unavailable: ${errorMessage(error)}` };
  }
  let state = queueStateFor(rows, runId, targetAt, message);
  if (state.state === "confirmed") return { state: "confirmed", rowId: state.rowId };
  if (state.state === "due") return { state: "due" };
  if (state.state === "failed") return { state: "failed", reason: state.reason };
  if (state.state === "ambiguous") return { state: "ambiguous", reason: `duplicate matching queue rows: ${state.rowIds.join(", ")}` };
  if (targetAt <= Date.now()) return { state: "due" };

  let sendError: unknown;
  let explicitNotQueued = false;
  try {
    const response = await bb.sdk.threads.send({
      threadId: runId,
      mode: "steer",
      sendAt: targetAt,
      input: [{ type: "text", text: message, mentions: [], visibility: "agent-only" }],
    });
    if (response.delivery !== "queued") {
      sendError = new Error(`scheduled ${kind} wake was explicitly not queued`);
      explicitNotQueued = true;
    }
  } catch (error) {
    sendError = error;
  }

  try {
    rows = await listRows() as readonly Record<string, unknown>[];
  } catch (error) {
    return { state: "ambiguous", reason: `could not reconcile ${kind} wake after send${sendError ? ` (${errorMessage(sendError)})` : ""}: ${errorMessage(error)}` };
  }
  state = queueStateFor(rows, runId, targetAt, message);
  if (state.state === "confirmed") return { state: "confirmed", rowId: state.rowId };
  if (state.state === "due") return { state: "due" };
  if (state.state === "ambiguous") return { state: "ambiguous", reason: `duplicate matching queue rows: ${state.rowIds.join(", ")}` };
  if (state.state === "failed") return { state: "failed", reason: state.reason };
  return explicitNotQueued
    ? { state: "failed", reason: `BB explicitly did not queue the ${kind} wake; no matching row was found` }
    : { state: "ambiguous", reason: `no matching durable ${kind} queue row was found after ${sendError ? errorMessage(sendError) : "queue send"}; commit status remains uncertain and the operation was not retried` };
}

async function verifyKnownWakeSetupFailure(
  bb: BbPluginApi,
  runId: string,
  request: CoordinatorRunRequest,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const rows = await bb.sdk.threads.queuedMessages.list({ threadId: runId, signal });
    let hasPersistedFailure = false;
    const allKnown = (["wrap-up", "deadline"] as const).every((kind) => {
      const targetAt = kind === "wrap-up" ? request.wrapUpAtEpochMs : request.deadlineAtEpochMs;
      const message = coordinatorWakeMessage(runId, kind);
      const matches = rows.filter((row) => row.threadId === runId && row.sendAt === targetAt && textContent(row.content) === message);
      if (matches.length > 1) return false;
      const row = matches[0];
      if (row && typeof row.failureReason === "string" && row.failureReason.length > 0) {
        hasPersistedFailure = true;
        return true;
      }
      if (targetAt <= Date.now()) return true;
      return matches.length === 1 && row!.editable === true;
    });
    return allKnown && hasPersistedFailure;
  } catch {
    return false;
  }
}

function noWorkerLaunchWasAttempted(outcomes: readonly LensReconciliation[]): boolean {
  return outcomes.every((outcome) => outcome.workers.length === 0 &&
    outcome.launchIntent === "not-attempted" && outcome.state !== "identity-unavailable");
}

function failedSetupOutcomes(request: CoordinatorRunRequest): LensReconciliation[] {
  return request.orderedLenses.map((lens, lensIndex) => ({
    lensIndex,
    lens,
    state: "not-launched",
    launchIntent: "not-attempted",
    workers: [],
    verifiedChildIds: [],
  }));
}

function workerSpawnArgs(
  request: CoordinatorRunRequest,
  runId: string,
  lensIndex: number,
): Parameters<Threads["spawn"]>[0] {
  const execution = request.workerExecution;
  return {
    projectId: request.projectId,
    environment: request.environmentId
      ? { type: "reuse", environmentId: request.environmentId }
      : { type: "project-default" },
    parentThreadId: runId,
    title: workerTitle(runId, lensIndex),
    prompt: coordinatorWorkerPrompt(request, runId, lensIndex),
    visibility: "hidden",
    providerId: execution.providerId,
    model: execution.model,
    ...(execution.serviceTier ? { serviceTier: execution.serviceTier } : {}),
    reasoningLevel: execution.reasoningLevel,
    permissionMode: execution.permissionMode,
    executionInputSources: {
      providerId: "explicit",
      model: "explicit",
      ...(execution.serviceTier ? { serviceTier: "explicit" } : {}),
      reasoningLevel: "explicit",
      permissionMode: "explicit",
    },
  };
}

function isActiveStatus(status: string): boolean {
  return status === "pending" || status === "starting" || status === "active" || status === "stopping";
}

async function reconcileWorkers(
  bb: BbPluginApi,
  runId: string,
  request: CoordinatorRunRequest,
  signal: AbortSignal,
  options: { readonly spawnMissing: boolean; readonly stopAtDeadline: boolean },
): Promise<{ readonly outcomes: readonly LensReconciliation[]; readonly allTerminal: boolean; readonly listError?: string }> {
  let children: Awaited<ReturnType<Threads["list"]>>;
  try {
    children = await listChildrenByParent(bb.sdk.threads, runId, signal);
  } catch (error) {
    return { outcomes: [], allTerminal: false, listError: errorMessage(error) };
  }

  const matchingBySlot: Array<Array<Awaited<ReturnType<Threads["list"]>>[number]>> = request.orderedLenses.map(() => []);
  const suspiciousBySlot = new Set<number>();
  for (const child of children) {
    if (child.parentThreadId !== runId || child.visibility !== "hidden") continue;
    let prompt: string | undefined;
    try {
      prompt = await firstRequestedPrompt(bb.sdk.threads, child.id, signal);
    } catch {
      prompt = undefined;
    }
    let matched = false;
    for (let index = 0; index < request.orderedLenses.length; index++) {
      if (child.projectId === request.projectId &&
          (request.environmentId === null || child.environmentId === request.environmentId) &&
          prompt === coordinatorWorkerPrompt(request, runId, index)) {
        matchingBySlot[index]!.push(child);
        matched = true;
      }
    }
    if (!matched) {
      // A title may help locate a malformed child, but only the exact first
      // persisted worker prompt can establish the slot identity.
      for (let index = 0; index < request.orderedLenses.length; index++) {
        if (child.title === workerTitle(runId, index)) suspiciousBySlot.add(index);
      }
    }
  }

  const ambiguousSpawn = new Set<number>();
  const launchIntents: LaunchIntentState[] = await Promise.all(request.orderedLenses.map((_, index) =>
    inspectWorkerLaunchIntent(bb, runId, index, request, signal)));
  if (options.spawnMissing && Date.now() < request.deadlineAtEpochMs) {
    for (let index = 0; index < request.orderedLenses.length; index++) {
      if (matchingBySlot[index]!.length > 0 || suspiciousBySlot.has(index)) continue;
      if (launchIntents[index] !== "not-attempted") {
        ambiguousSpawn.add(index);
        continue;
      }
      if (!await createWorkerLaunchIntent(bb, runId, index, request, signal)) {
        ambiguousSpawn.add(index);
        launchIntents[index] = await inspectWorkerLaunchIntent(bb, runId, index, request, signal);
        continue;
      }
      launchIntents[index] = "confirmed";
      let spawnError: unknown;
      try {
        const created = await bb.sdk.threads.spawn(workerSpawnArgs(request, runId, index));
        const directChild = await bb.sdk.threads.get({ threadId: created.id, signal });
        if (directChild.parentThreadId !== runId || directChild.visibility !== "hidden" || directChild.projectId !== request.projectId ||
            (request.environmentId !== null && directChild.environmentId !== request.environmentId)) {
          ambiguousSpawn.add(index);
          continue;
        }
      } catch (error) {
        spawnError = error;
      }

      // A durable per-slot queue marker is written before spawn. If spawn is
      // ambiguous, later wakes see that marker and freeze the slot rather than
      // retrying a late-committed worker.
      if (spawnError || matchingBySlot[index]!.length === 0) {
        try {
          const refreshed = await listChildrenByParent(bb.sdk.threads, runId, signal);
          const candidates = refreshed.filter((child) => child.parentThreadId === runId && child.visibility === "hidden");
          const verified: Array<Awaited<ReturnType<Threads["list"]>>[number]> = [];
          for (const child of candidates) {
            if (await verifyWorkerPrompt(bb.sdk.threads, child, runId, request, index, signal)) verified.push(child);
          }
          matchingBySlot[index]!.splice(0, matchingBySlot[index]!.length, ...verified);
          if (verified.length === 0 && spawnError) ambiguousSpawn.add(index);
        } catch {
          ambiguousSpawn.add(index);
        }
      }
    }
    try {
      const refreshed = await listChildrenByParent(bb.sdk.threads, runId, signal);
      for (let index = 0; index < request.orderedLenses.length; index++) {
        const verified: Array<Awaited<ReturnType<Threads["list"]>>[number]> = [];
        for (const child of refreshed.filter((candidate) => candidate.parentThreadId === runId && candidate.visibility === "hidden")) {
          if (await verifyWorkerPrompt(bb.sdk.threads, child, runId, request, index, signal)) verified.push(child);
        }
        matchingBySlot[index]!.splice(0, matchingBySlot[index]!.length, ...verified);
      }
      children = refreshed;
    } catch (error) {
      return { outcomes: [], allTerminal: false, listError: errorMessage(error) };
    }
  }

  const remainingBudget = { chars: MAX_RECONCILED_OUTPUT_CHARS };
  const outcomes: LensReconciliation[] = [];
  let allTerminal = true;
  for (let index = 0; index < request.orderedLenses.length; index++) {
    const slotChildren = matchingBySlot[index]!;
    const workerRecords: VerifiedWorker[] = [];
    for (const child of slotChildren) {
      let current: Awaited<ReturnType<Threads["get"]>>;
      try {
        current = await bb.sdk.threads.get({ threadId: child.id, signal });
      } catch {
        workerRecords.push({ threadId: child.id, status: "unknown", output: null, outputSha256: null, outputChars: 0, outputUnavailableReason: "thread status unavailable" });
        allTerminal = false;
        continue;
      }
      let status = current.status;
      if (options.stopAtDeadline && Date.now() >= request.deadlineAtEpochMs && isActiveStatus(status)) {
        try {
          await bb.sdk.threads.stop({ threadId: child.id });
          current = await bb.sdk.threads.get({ threadId: child.id, signal });
          status = current.status;
        } catch {
          status = current.status;
        }
      }
      if (isActiveStatus(status)) allTerminal = false;
      let output: string | null = null;
      let outputSha256: string | null = null;
      let outputChars = 0;
      let outputUnavailableReason: string | undefined;
      if (status === "idle" || status === "error") {
        try {
          const response = await bb.sdk.threads.output({ threadId: child.id, signal });
          const fullOutput = response.output;
          if (typeof fullOutput !== "string" || fullOutput.length === 0) {
            outputUnavailableReason = "BB has no persisted final agent message; intermediate event text is not treated as research output";
          } else {
            outputChars = fullOutput.length;
            outputSha256 = sha256(Buffer.from(fullOutput, "utf8"));
            if (fullOutput.length > remainingBudget.chars) {
              outputUnavailableReason = "persisted final output exceeds the bounded synthesis input; it was not truncated into evidence";
            } else {
              remainingBudget.chars -= fullOutput.length;
              output = fullOutput;
            }
          }
        } catch (error) {
          outputUnavailableReason = `full output unavailable: ${errorMessage(error)}`;
        }
      }
      workerRecords.push({
        threadId: child.id,
        status,
        output,
        outputSha256,
        outputChars,
        ...(outputUnavailableReason ? { outputUnavailableReason } : {}),
      });
    }

    let state: LensReconciliation["state"];
    if (slotChildren.length > 1) state = "duplicate";
    else if (suspiciousBySlot.has(index)) state = "identity-unavailable";
    else if (slotChildren.length === 0) {
      state = ambiguousSpawn.has(index) ? "launch-uncertain" : "launch-uncertain";
      if (Date.now() < request.deadlineAtEpochMs) allTerminal = false;
    } else if (workerRecords.some((record) => isActiveStatus(record.status))) state = "running";
    else if (workerRecords.some((record) => record.output !== null)) {
      state = workerRecords.every((record) => record.status === "idle" && record.output !== null) ? "complete" : "failed";
    } else state = "output-unavailable";

    if (slotChildren.length === 0 && Date.now() < request.deadlineAtEpochMs) allTerminal = false;
    if (workerRecords.some((record) => record.status === "unknown" || isActiveStatus(record.status)) || state === "identity-unavailable") allTerminal = false;
    outcomes.push({
      lensIndex: index,
      lens: request.orderedLenses[index]!,
      state,
      launchIntent: launchIntents[index]!,
      workers: workerRecords,
      verifiedChildIds: slotChildren.map((child) => child.id),
    });
  }
  return { outcomes, allTerminal };
}

function statusText(content: string): string {
  const match = content.match(/^Status: (complete|partial|failed)$/m);
  return match?.[1] ?? "";
}

interface ValidatedArtifact {
  readonly content: string;
  readonly status: "complete" | "partial" | "failed";
  readonly bodySha256: string;
  readonly fileSha256: string;
  readonly body: string;
}

function validateArtifactBytes(
  bytes: Buffer,
  runId: string,
  serverSha256?: string,
  sizeBytes?: number,
): ValidatedArtifact | undefined {
  if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) return undefined;
  if (serverSha256 && sha256(bytes) !== serverSha256) return undefined;
  if (sizeBytes !== undefined && bytes.byteLength !== sizeBytes) return undefined;
  const open = Buffer.from(ARTIFACT_BODY_START, "utf8");
  const close = Buffer.from(ARTIFACT_BODY_END, "utf8");
  const openAt = bytes.indexOf(open);
  const closeAt = openAt < 0 ? -1 : bytes.indexOf(close, openAt + open.byteLength);
  if (openAt < 0 || closeAt < 0 || bytes.indexOf(open, openAt + open.byteLength) >= 0 || bytes.indexOf(close, closeAt + close.byteLength) >= 0) return undefined;
  const header = bytes.subarray(0, openAt).toString("utf8");
  if (header !== `# Perspectives panel result\nRun ID: ${runId}\n\n`) return undefined;
  const bodyBytes = bytes.subarray(openAt + open.byteLength, closeAt);
  const body = bodyBytes.toString("utf8");
  const bodySha256 = sha256(bodyBytes);
  const tail = bytes.subarray(closeAt + close.byteLength).toString("utf8");
  const status = statusText(body);
  const expectedTail = `\nBody SHA-256: ${bodySha256}\n<!-- perspectives-terminal run-id=${runId} status=${status} body-sha256=${bodySha256} -->\n`;
  if (!(status === "complete" || status === "partial" || status === "failed") || tail !== expectedTail) return undefined;
  return { content: bytes.toString("utf8"), status, bodySha256, fileSha256: sha256(bytes), body };
}

type ArtifactRead =
  | { readonly kind: "present"; readonly artifact: ValidatedArtifact }
  | { readonly kind: "corrupt" }
  | { readonly kind: "missing" }
  | { readonly kind: "host-offline"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };

function apiErrorDetails(error: unknown): { readonly code?: string; readonly status?: number; readonly message: string } {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const body = value.body && typeof value.body === "object" ? value.body as Record<string, unknown> : {};
  return {
    code: typeof value.code === "string" ? value.code : typeof body.code === "string" ? body.code : undefined,
    status: typeof value.status === "number" ? value.status : undefined,
    message: errorMessage(error),
  };
}

function classifyFileError(error: unknown, isFileRead: boolean): ArtifactRead {
  const details = apiErrorDetails(error);
  if (details.code === "host_unavailable" || details.code === "host_disconnected") {
    return { kind: "host-offline", detail: details.message };
  }
  if (isFileRead && (details.status === 404 || details.code === "not_found" || details.code === "file_not_found")) {
    return { kind: "missing" };
  }
  return { kind: "unavailable", detail: details.message };
}

function artifactRelativePath(runId: string): string {
  return `perspectives/results/${runId}.md`;
}

function artifactAbsolutePath(rootPath: string, runId: string): string {
  const target = resolve(rootPath, artifactRelativePath(runId));
  const rel = relative(resolve(rootPath), target);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Perspectives artifact path escaped its thread storage root.");
  return target;
}

async function readThreadArtifact(bb: BbPluginApi, runId: string): Promise<ArtifactRead> {
  let storage: Awaited<ReturnType<Threads["storageLocation"]>>;
  try {
    storage = await bb.sdk.threads.storageLocation({ threadId: runId });
  } catch (error) {
    return classifyFileError(error, false);
  }
  const path = artifactAbsolutePath(storage.storageRootPath, runId);
  let file: Awaited<ReturnType<BbPluginApi["sdk"]["files"]["read"]>>;
  try {
    file = await bb.sdk.files.read({ hostId: storage.hostId, path, rootPath: storage.storageRootPath });
  } catch (error) {
    return classifyFileError(error, true);
  }
  if (file.contentEncoding !== "utf8") return { kind: "corrupt" };
  const bytes = Buffer.from(file.content, "utf8");
  const artifact = validateArtifactBytes(bytes, runId, file.sha256, file.sizeBytes);
  return artifact ? { kind: "present", artifact } : { kind: "corrupt" };
}

function artifactReadFailure(runId: string, result: Exclude<ArtifactRead, { kind: "present" }>): Error {
  switch (result.kind) {
    case "missing": return new Error(`Perspectives artifact is missing for run ${runId}.`);
    case "corrupt": return new Error(`Perspectives artifact is corrupt or failed byte verification for run ${runId}.`);
    case "host-offline": return new Error(`Perspectives artifact host is offline for run ${runId}; retrieval is unavailable (${result.detail}).`);
    case "unavailable": return new Error(`Perspectives artifact could not be read for run ${runId} (${result.detail}).`);
  }
}

async function verifyCallerCoordinator(
  bb: BbPluginApi,
  callerThreadId: string,
  callerProjectId: string,
  coordinatorId: string,
  signal: AbortSignal,
): Promise<AuthenticatedCoordinator | undefined> {
  try {
    const { threads } = bb.sdk;
    const thread = await threads.get({ threadId: coordinatorId, signal });
    if (thread.parentThreadId !== callerThreadId || thread.projectId !== callerProjectId || thread.visibility !== "hidden") return undefined;
    const prompt = await firstRequestedPrompt(threads, coordinatorId, signal);
    if (!prompt) return undefined;
    const request = requestFromCoordinatorPrompt(prompt);
    if (!request || request.callerThreadId !== callerThreadId || request.projectId !== callerProjectId ||
        (request.environmentId !== null && thread.environmentId !== request.environmentId)) return undefined;
    const caller = await threads.get({ threadId: callerThreadId, signal });
    if (caller.projectId !== callerProjectId || (caller.environmentId ?? null) !== request.environmentId) return undefined;
    return { thread, request, prompt };
  } catch {
    return undefined;
  }
}

async function isVerifiedPanelWorker(
  bb: BbPluginApi,
  context: PluginAgentToolContext,
): Promise<boolean> {
  try {
    const thread = await bb.sdk.threads.get({ threadId: context.threadId, signal: context.signal });
    if (thread.visibility !== "hidden" || !thread.parentThreadId || thread.projectId !== context.projectId) return false;
    const parent = await authenticateCoordinator(bb, {
      threadId: thread.parentThreadId,
      projectId: context.projectId,
      signal: context.signal,
    });
    if (thread.environmentId !== parent.request.environmentId && parent.request.environmentId !== null) return false;
    const prompt = await firstRequestedPrompt(bb.sdk.threads, thread.id, context.signal);
    return parent.request.orderedLenses.some((_, index) => prompt === coordinatorWorkerPrompt(parent.request, parent.thread.id, index));
  } catch {
    return false;
  }
}

async function isVerifiedPanelCoordinator(
  bb: BbPluginApi,
  context: PluginAgentToolContext,
): Promise<boolean> {
  try {
    await authenticateCoordinator(bb, context);
    return true;
  } catch {
    return false;
  }
}

/** SDK-backed coordinator operation, authorized only for the persisted run's own thread. */
export async function runPerspectivesCoordinatorStep(
  bb: BbPluginApi,
  context: PluginAgentToolContext,
): Promise<string> {
  const { request } = await authenticateCoordinator(bb, context);
  const runId = context.threadId;
  const existing = await readThreadArtifact(bb, runId);
  if (existing.kind === "present") {
    const pendingRunRowsRemoved = await cleanupPublishedRunRows(bb, runId, request, context.signal);
    return JSON.stringify({ phase: "already-published", runId, status: existing.artifact.status, bodySha256: existing.artifact.bodySha256, fileSha256: existing.artifact.fileSha256, artifactRelativePath: artifactRelativePath(runId), pendingRunRowsRemoved });
  }
  if (existing.kind !== "missing") throw artifactReadFailure(runId, existing);

  const now = Date.now();
  const wakeReports = await Promise.all([
    ensureCoordinatorWake(bb, runId, request.wrapUpAtEpochMs, "wrap-up", context.signal),
    ensureCoordinatorWake(bb, runId, request.deadlineAtEpochMs, "deadline", context.signal),
  ]);
  const bothRequiredWakesReady = wakeReports.every((wake) => wake.state === "confirmed" || wake.state === "due");

  const deadlineReached = now >= request.deadlineAtEpochMs;
  const wakeSetupKnown = wakeReports.every((wake) => wake.state === "confirmed" || wake.state === "due" || wake.state === "failed");
  if (!deadlineReached && wakeSetupKnown && wakeReports.some((wake) => wake.state === "failed")) {
    const setupInspection = await reconcileWorkers(bb, runId, request, context.signal, {
      spawnMissing: false,
      stopAtDeadline: false,
    });
    const failedSetupVerified = await verifyKnownWakeSetupFailure(bb, runId, request, context.signal);
    if (!setupInspection.listError && failedSetupVerified && noWorkerLaunchWasAttempted(setupInspection.outcomes)) {
      return JSON.stringify({
        phase: "wake-setup-failed",
        runId,
        wakeReports,
        readyToPublish: true,
        limitation: "At least one required wake row has a persisted failureReason, the other required wake state is known, and no worker launch was attempted. Publish a failed artifact stating that no research was performed; callers may retrieve it through the verified direct-child tool.",
        outcomes: failedSetupOutcomes(request),
      });
    }
  }

  const reconciliation = await reconcileWorkers(bb, runId, request, context.signal, {
    spawnMissing: !deadlineReached && bothRequiredWakesReady,
    stopAtDeadline: deadlineReached,
  });
  if (reconciliation.listError) {
    return JSON.stringify({ phase: "reconciliation-unavailable", runId, error: reconciliation.listError, readyToPublish: false });
  }

  let activeWorkers: string[] = [];
  for (const outcome of reconciliation.outcomes) {
    activeWorkers.push(...outcome.workers.filter((worker) => isActiveStatus(worker.status)).map((worker) => worker.threadId));
  }
  if (!deadlineReached && now >= request.wrapUpAtEpochMs) {
    for (const workerId of activeWorkers) {
      const message = `Perspectives wrap-up request for run ${runId}; return the strongest supported findings and important unknowns now.`;
      let alreadyQueuedOrRequested = false;
      try {
        const [rows, events] = await Promise.all([
          bb.sdk.threads.queuedMessages.list({ threadId: workerId, signal: context.signal }),
          bb.sdk.threads.events.list({ threadId: workerId, types: ["client/turn/requested"], order: "desc", limit: "100", signal: context.signal }),
        ]);
        alreadyQueuedOrRequested = rows.some((row) => textContent(row.content) === message) || events.some((event) => eventText(event) === message);
      } catch {
        alreadyQueuedOrRequested = true;
      }
      if (alreadyQueuedOrRequested) continue;
      try {
        await bb.sdk.threads.send({
          threadId: workerId,
          mode: "steer",
          input: [{ type: "text", text: message, mentions: [], visibility: "agent-only" }],
        });
      } catch {
        // The next native report/wake reconciles persisted status. Do not retry
        // an ambiguous send during this step.
      }
    }
  }

  const queueSummary = wakeReports.map((wake, index) => ({ tag: index === 0 ? "wrap-up" : "deadline", ...wake }));
  const readyToPublish = deadlineReached || reconciliation.allTerminal;
  const wakeSetupUncertain = !bothRequiredWakesReady && !deadlineReached && !reconciliation.allTerminal;
  return JSON.stringify({
    phase: deadlineReached ? "deadline-reached" : wakeSetupUncertain ? "wake-setup-uncertain" : reconciliation.allTerminal ? "ready-to-synthesize" : "running",
    runId,
    nowEpochMs: now,
    wrapUpAtEpochMs: request.wrapUpAtEpochMs,
    deadlineAtEpochMs: request.deadlineAtEpochMs,
    wakeReports: queueSummary,
    readyToPublish,
    limitation: !bothRequiredWakesReady
      ? "Both required coordinator wake rows are not confirmed or due. No new workers were launched. If at least one required wake row has a persisted failureReason, the other required wake state is known, and no worker launch was attempted, publish the failed no-research artifact; otherwise end this turn and rely on any confirmed wake or the caller backstop. Ambiguous queue state requires explicit recovery or operator action and is not a delivery guarantee. Do not claim a future wake."
      : undefined,
    outcomes: reconciliation.outcomes,
  });
}

type PerspectivesStatus = "complete" | "partial" | "failed";
type CoverageAssessment = "complete" | "partial";

/** Mechanical availability of one usable persisted final output per requested lens. */
function workerOutputAvailability(outcomes: readonly LensReconciliation[]): PerspectivesStatus {
  const usable = outcomes.some((outcome) => outcome.workers.some((worker) => worker.output !== null));
  if (!usable) return "failed";
  const everyLensHasOneUsableOutput = outcomes.length > 0 && outcomes.every((outcome) =>
    outcome.state === "complete" &&
    outcome.verifiedChildIds.length === 1 &&
    outcome.workers.length === 1 &&
    outcome.workers[0]!.status === "idle" &&
    outcome.workers[0]!.output !== null);
  return everyLensHasOneUsableOutput ? "complete" : "partial";
}

function outcomeStatus(availability: PerspectivesStatus, coverage: CoverageAssessment): PerspectivesStatus {
  if (availability === "failed") return "failed";
  return availability === "complete" && coverage === "complete" ? "complete" : "partial";
}

async function cleanupPublishedRunRows(
  bb: BbPluginApi,
  runId: string,
  request: CoordinatorRunRequest,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const rows = await bb.sdk.threads.queuedMessages.list({ threadId: runId, ...(signal ? { signal } : {}) });
    const cleanupMessages = new Set([
      coordinatorWakeMessage(runId, "wrap-up"),
      coordinatorWakeMessage(runId, "deadline"),
      ...request.orderedLenses.map((_, index) => workerLaunchIntentMessage(runId, index)),
    ]);
    for (const row of rows) {
      if (row.failureReason === null && row.editable && cleanupMessages.has(textContent(row.content) ?? "")) {
        await bb.sdk.threads.queuedMessages.delete({ threadId: runId, queuedMessageId: row.id });
      }
    }
    return true;
  } catch {
    return false;
  }
}

function artifactBody(
  status: PerspectivesStatus,
  availability: PerspectivesStatus,
  coverage: CoverageAssessment,
  outcomes: readonly LensReconciliation[],
  synthesis: string,
): string {
  const lines = outcomes.map((outcome) => {
    const ids = outcome.verifiedChildIds.length > 0 ? outcome.verifiedChildIds.join(", ") : "none verified";
    const digests = outcome.workers.filter((worker) => worker.outputSha256).map((worker) => `${worker.threadId}=${worker.outputSha256}`).join(", ");
    return `- ${JSON.stringify(outcome.lens)}: ${outcome.state}; worker IDs: ${ids}${digests ? `; full-output SHA-256: ${digests}` : ""}`;
  });
  return [
    `Status: ${status}`,
    `Worker output availability: ${availability}`,
    `Coordinator coverage assessment (not mechanically verified): ${coverage}`,
    "",
    "## Lens outcomes",
    ...lines,
    "",
    "## Synthesis",
    synthesis,
  ].join("\n");
}

function buildArtifact(runId: string, status: "complete" | "partial" | "failed", body: string): { readonly content: string; readonly bytes: Buffer; readonly bodySha256: string; readonly fileSha256: string } {
  const bodyBytes = Buffer.from(body, "utf8");
  const bodySha256 = sha256(bodyBytes);
  const header = Buffer.from(`# Perspectives panel result\nRun ID: ${runId}\n\n${ARTIFACT_BODY_START}`, "utf8");
  const footer = Buffer.from(`${ARTIFACT_BODY_END}\nBody SHA-256: ${bodySha256}\n<!-- perspectives-terminal run-id=${runId} status=${status} body-sha256=${bodySha256} -->\n`, "utf8");
  const bytes = Buffer.concat([header, bodyBytes, footer]);
  return { content: bytes.toString("utf8"), bytes, bodySha256, fileSha256: sha256(bytes) };
}

async function publishBytesCreateOnly(
  bb: BbPluginApi,
  runId: string,
  artifact: ReturnType<typeof buildArtifact>,
): Promise<ValidatedArtifact> {
  const storage = await bb.sdk.threads.storageLocation({ threadId: runId });
  const path = artifactAbsolutePath(storage.storageRootPath, runId);
  const before = await readThreadArtifact(bb, runId);
  if (before.kind === "present") {
    if (before.artifact.fileSha256 === artifact.fileSha256 && before.artifact.content === artifact.content) return before.artifact;
    throw new Error(`Perspectives artifact already exists with different bytes for run ${runId}; it was not overwritten.`);
  }
  if (before.kind !== "missing") throw artifactReadFailure(runId, before);

  let writeError: unknown;
  let writeOutcome: string | undefined;
  try {
    const write = await bb.sdk.files.write({
      hostId: storage.hostId,
      path,
      rootPath: storage.storageRootPath,
      content: artifact.content,
      contentEncoding: "utf8",
      createParents: true,
      expectedSha256: null,
      mode: 0o600,
    });
    writeOutcome = write.outcome;
  } catch (error) {
    writeError = error;
  }

  const after = await readThreadArtifact(bb, runId);
  if (after.kind === "present") {
    if (after.artifact.fileSha256 === artifact.fileSha256 && after.artifact.content === artifact.content) return after.artifact;
    throw new Error(`Perspectives artifact write conflicted with divergent bytes for run ${runId}; it was not overwritten.`);
  }
  if (after.kind === "corrupt") throw new Error(`Perspectives artifact is corrupt after ${writeOutcome ?? "ambiguous write"} for run ${runId}; it was not overwritten.`);
  if (after.kind === "missing") {
    throw new Error(`Perspectives artifact was not readable after ${writeOutcome ?? "ambiguous write"} for run ${runId}${writeError ? `: ${errorMessage(writeError)}` : ""}.`);
  }
  throw artifactReadFailure(runId, after);
}

/** Publish one run artifact using the SDK's atomic create-only host file API. */
export async function runPerspectivesPublishResult(
  bb: BbPluginApi,
  input: { readonly synthesis: string; readonly coverage?: string },
  context: PluginAgentToolContext,
): Promise<string> {
  const { request } = await authenticateCoordinator(bb, context);
  const runId = context.threadId;
  const existing = await readThreadArtifact(bb, runId);
  if (existing.kind === "present") {
    const pendingRunRowsRemoved = await cleanupPublishedRunRows(bb, runId, request, context.signal);
    return JSON.stringify({ phase: "already-published", runId, status: existing.artifact.status, artifactRelativePath: artifactRelativePath(runId), bodySha256: existing.artifact.bodySha256, fileSha256: existing.artifact.fileSha256, pendingRunRowsRemoved });
  }
  if (existing.kind !== "missing") throw artifactReadFailure(runId, existing);

  const now = Date.now();
  const deadlineReached = now >= request.deadlineAtEpochMs;
  const reconciliation = await reconcileWorkers(bb, runId, request, context.signal, {
    spawnMissing: false,
    stopAtDeadline: deadlineReached,
  });
  if (reconciliation.listError) throw new Error(`Cannot publish Perspectives result because worker reconciliation failed: ${reconciliation.listError}`);
  const failedSetupPublication = !deadlineReached && !reconciliation.allTerminal &&
    await verifyKnownWakeSetupFailure(bb, runId, request, context.signal) &&
    noWorkerLaunchWasAttempted(reconciliation.outcomes);
  if (!deadlineReached && !reconciliation.allTerminal && !failedSetupPublication) {
    throw new Error("Perspectives workers are not all terminal yet. End this turn and let a native child report or scheduled wake prompt another reconciliation.");
  }
  const outcomes = failedSetupPublication ? failedSetupOutcomes(request) : reconciliation.outcomes;
  const availability = workerOutputAvailability(outcomes);
  const coverage: CoverageAssessment = failedSetupPublication || input.coverage !== "complete" ? "partial" : "complete";
  const status = outcomeStatus(availability, coverage);
  const hasUsableEvidence = outcomes.some((outcome) => outcome.workers.some((worker) => worker.output !== null));
  const synthesis = failedSetupPublication
    ? "No research was performed. BB has a persisted failureReason for at least one required coordinator wake row, the other required wake state is known, and no worker launch intent or worker child is recorded. The panel failed before research began. Queue recovery or operator action is required; this run supports no substantive conclusion."
    : !hasUsableEvidence
      ? "No usable persisted final worker output is available. Intermediate events and notification excerpts are not evidence for this artifact, so this run supports no substantive conclusion."
      : input.synthesis;
  const body = artifactBody(status, availability, coverage, outcomes, synthesis);
  const artifact = buildArtifact(runId, status, body);
  const verified = await publishBytesCreateOnly(bb, runId, artifact);

  const pendingRunRowsRemoved = await cleanupPublishedRunRows(bb, runId, request, context.signal);

  return JSON.stringify({
    phase: "published",
    runId,
    status: verified.status,
    artifactRelativePath: artifactRelativePath(runId),
    bodySha256: verified.bodySha256,
    fileSha256: verified.fileSha256,
    verifiedBytes: Buffer.byteLength(verified.content, "utf8"),
    pendingRunRowsRemoved,
  });
}

async function readVerifiedCoordinatorArtifact(
  bb: BbPluginApi,
  callerThreadId: string,
  callerProjectId: string,
  coordinatorId: string,
  signal: AbortSignal,
): Promise<{ readonly identity: AuthenticatedCoordinator; readonly artifact: ValidatedArtifact } | { readonly identity: AuthenticatedCoordinator; readonly error: Error }> {
  const identity = await verifyCallerCoordinator(bb, callerThreadId, callerProjectId, coordinatorId, signal);
  if (!identity) throw new Error("Unauthorized Perspectives artifact read: the target is not a verified hidden coordinator child of this caller.");
  const read = await readThreadArtifact(bb, coordinatorId);
  if (read.kind === "present") return { identity, artifact: read.artifact };
  return { identity, error: artifactReadFailure(coordinatorId, read) };
}

function presentationMarker(runId: string, fileSha256: string): string {
  return `<!-- perspectives-presented run-id=${runId} file-sha256=${fileSha256} -->`;
}

function hasStandalonePresentationMarker(output: string, runId: string, fileSha256: string): boolean {
  const expected = presentationMarker(runId, fileSha256);
  return output.split(/\r?\n/).some((line) => line === expected);
}

async function callerPresentationEvidence(
  bb: BbPluginApi,
  callerThreadId: string,
  runId: string,
  fileSha256: string,
  signal: AbortSignal,
): Promise<"matched" | "not-found" | "unavailable"> {
  try {
    const completedTurns = await bb.sdk.threads.events.list({
      threadId: callerThreadId,
      types: ["turn/completed"],
      order: "desc",
      limit: "1",
      signal,
    });
    const turn = completedTurns[0] as unknown as {
      readonly type?: unknown;
      readonly seq?: unknown;
      readonly scope?: { readonly kind?: unknown; readonly turnId?: unknown };
      readonly data?: { readonly status?: unknown };
    } | undefined;
    if (turn?.type !== "turn/completed" || turn.data?.status !== "completed") return "not-found";
    if (turn.scope?.kind !== "turn" || typeof turn.scope.turnId !== "string" ||
        typeof turn.seq !== "number" || !Number.isSafeInteger(turn.seq) || turn.seq <= 0) return "unavailable";

    let beforeSeq = String(turn.seq);
    let newerCompletedItemFound = false;
    for (let pageIndex = 0; pageIndex < PRESENTATION_EVENT_MAX_PAGES; pageIndex++) {
      const events = await bb.sdk.threads.events.list({
        threadId: callerThreadId,
        types: ["item/completed"],
        order: "desc",
        beforeSeq,
        limit: String(PRESENTATION_EVENT_PAGE_SIZE),
        signal,
      });
      if (events.length === 0) return "not-found";
      for (const event of events) {
        const row = event as unknown as {
          readonly type?: unknown;
          readonly scope?: { readonly kind?: unknown; readonly turnId?: unknown };
          readonly data?: { readonly item?: unknown };
        };
        if (row.scope?.kind !== "turn" || typeof row.scope.turnId !== "string") return "unavailable";
        if (row.scope.turnId !== turn.scope.turnId) return "not-found";
        if (row.type !== "item/completed" || !row.data?.item || typeof row.data.item !== "object") return "unavailable";
        const item = row.data.item as { readonly type?: unknown; readonly text?: unknown };
        if (item.type === "agentMessage" && typeof item.text === "string") {
          if (newerCompletedItemFound) return "not-found";
          return hasStandalonePresentationMarker(item.text, runId, fileSha256) ? "matched" : "not-found";
        }
        newerCompletedItemFound = true;
      }
      if (events.length < PRESENTATION_EVENT_PAGE_SIZE) return "not-found";
      const lastSequence = (events.at(-1) as unknown as { readonly seq?: unknown }).seq;
      if (typeof lastSequence !== "number" || !Number.isSafeInteger(lastSequence) || lastSequence <= 0) return "unavailable";
      beforeSeq = String(lastSequence);
    }
    return "not-found";
  } catch {
    return "unavailable";
  }
}

/** Caller-only result retrieval; the coordinator ID is checked against direct persisted parentage. */
export async function runPerspectivesReadResult(
  bb: BbPluginApi,
  input: { readonly coordinatorId?: string; readonly invocationMarker?: string; readonly includeArtifact?: boolean },
  context: PluginAgentToolContext,
): Promise<string> {
  if (Boolean(input.coordinatorId) === Boolean(input.invocationMarker)) {
    throw new Error("Provide exactly one coordinatorId or invocationMarker.");
  }
  let coordinatorIds: string[];
  if (input.coordinatorId) {
    coordinatorIds = [input.coordinatorId];
  } else {
    try {
      const children = await listChildrenByParent(bb.sdk.threads, context.threadId, context.signal);
      const verifiedIds: string[] = [];
      for (const child of children) {
        if (child.parentThreadId !== context.threadId || child.visibility !== "hidden") continue;
        const verified = await verifyCallerCoordinator(bb, context.threadId, context.projectId, child.id, context.signal);
        if (verified?.request.invocationMarker === input.invocationMarker) verifiedIds.push(child.id);
      }
      coordinatorIds = verifiedIds;
    } catch (error) {
      throw new Error(`Perspectives coordinator discovery is unavailable; do not claim the run is absent (${errorMessage(error)}).`);
    }
    if (coordinatorIds.length === 0) {
      throw new Error(`No verified coordinator child was found for invocation ${input.invocationMarker}; the launch may have failed or remain uncertain.`);
    }
    if (coordinatorIds.length > 1) {
      const children = await Promise.all(coordinatorIds.map(async (id) => ({
        coordinatorId: id,
        status: (await bb.sdk.threads.get({ threadId: id, signal: context.signal })).status,
      })));
      return JSON.stringify({ phase: "possible-duplicate-runs", invocationMarker: input.invocationMarker, coordinators: children, instruction: "Keep each run separate. Do not merge or present an artifact until one run is selected and individually verified." });
    }
  }

  const coordinatorId = coordinatorIds[0]!;
  const result = await readVerifiedCoordinatorArtifact(bb, context.threadId, context.projectId, coordinatorId, context.signal);
  if ("error" in result) throw result.error;
  const marker = presentationMarker(coordinatorId, result.artifact.fileSha256);
  const priorPresentation = input.includeArtifact
    ? "not-found"
    : await callerPresentationEvidence(bb, context.threadId, coordinatorId, result.artifact.fileSha256, context.signal);
  if (priorPresentation === "matched") {
    return `Perspectives artifact ${coordinatorId} was already presented according to the exact receipt in the latest successfully completed caller turn's final agent message. The artifact remains retrievable on a user request by calling perspectives_read_result with includeArtifact: true. The caller backstop is retained.\nStatus: ${result.artifact.status}\nArtifact: ${artifactRelativePath(coordinatorId)}\nBody SHA-256: ${result.artifact.bodySha256}\nFull-file SHA-256: ${result.artifact.fileSha256}\nPresentation receipt:\n${marker}`;
  }
  const evidenceNote = priorPresentation === "unavailable"
    ? "The latest persisted final output could not be read, so this tool returns the artifact to avoid risking silent loss."
    : "No exact presentation marker was found in the latest persisted final output, so this tool returns the artifact. A legacy markerless presentation may be repeated.";
  return `Verified Perspectives artifact for run ${coordinatorId}.\nStatus: ${result.artifact.status}\nArtifact: ${artifactRelativePath(coordinatorId)}\nBody SHA-256: ${result.artifact.bodySha256}\nFull-file SHA-256: ${result.artifact.fileSha256}\nCaller backstop: retained. ${evidenceNote}\n\n${result.artifact.content}\n\nAfter presenting this artifact in your final response, include this exact standalone receipt line so a later read can verify durable presentation:\n${marker}`;
}

/** Launch one durable hidden coordinator and acknowledge its caller backstop. */
export async function runGatherPerspectives(
  bb: BbPluginApi,
  input: { question: string; context?: string; lenses: readonly string[] },
  toolContext: PluginAgentToolContext,
  executionSettings: PerspectivesExecutionSettings = INHERIT_EXECUTION_SETTINGS,
  timing?: GatherTiming,
): Promise<string> {
  const currentThread = await bb.sdk.threads.get({ threadId: toolContext.threadId, signal: toolContext.signal });
  if (currentThread.title?.startsWith(WORKER_TITLE_PREFIX) || await isVerifiedPanelWorker(bb, toolContext)) {
    throw new Error("A verified Perspectives panel worker cannot start another panel.");
  }
  if (await isVerifiedPanelCoordinator(bb, toolContext)) {
    throw new Error("A Perspectives coordinator cannot start a nested panel.");
  }
  const question = clean(input.question);
  if (!question) throw new Error("gather_perspectives requires a non-empty question.");
  const lenses = normalizedLenses(input);
  const sharedContext = clean(input.context);
  const resolved = resolveGatherTiming(timing);
  const contexts = await createSpawnContexts(
    bb,
    toolContext,
    executionSettings,
    toolContext.signal,
    resolved.spawnTimeoutMs,
  );
  const startedAt = Date.now();
  const marker = `${COORDINATOR_MARKER_PREFIX}${randomUUID()}`;
  const request = coordinatorRequestProtocolV1Schema.parse({
    protocolVersion: 1,
    invocationMarker: marker,
    question,
    context: sharedContext,
    orderedLenses: lenses,
    callerThreadId: toolContext.threadId,
    projectId: toolContext.projectId,
    environmentId: contexts.planner.environment.type === "reuse"
      ? contexts.planner.environment.environmentId
      : null,
    coordinatorExecution: contexts.planner.execution,
    workerExecution: contexts.worker.execution,
    startedAtEpochMs: startedAt,
    wrapUpAtEpochMs: startedAt + COORDINATOR_WRAP_UP_MS,
    deadlineAtEpochMs: startedAt + COORDINATOR_DEADLINE_MS,
    callerBackstopAtEpochMs: startedAt + COORDINATOR_DEADLINE_MS + CALLER_BACKSTOP_GRACE_MS,
    artifactRelativePath: COORDINATOR_ARTIFACT_PATH,
  });
  const prompt = coordinatorPrompt(request);
  const coordinatorExecution = contexts.planner.execution;
  const executionInputSources = {
    providerId: "explicit" as const,
    model: "explicit" as const,
    ...(coordinatorExecution.serviceTier ? { serviceTier: "explicit" as const } : {}),
    reasoningLevel: "explicit" as const,
    permissionMode: "explicit" as const,
  };
  const spawnArgs: Parameters<Threads["spawn"]>[0] = {
    projectId: contexts.planner.projectId,
    environment: contexts.planner.environment,
    parentThreadId: toolContext.threadId,
    title: `Perspectives coordinator ${marker}`,
    prompt,
    visibility: "hidden",
    providerId: coordinatorExecution.providerId,
    model: coordinatorExecution.model,
    ...(coordinatorExecution.serviceTier ? { serviceTier: coordinatorExecution.serviceTier } : {}),
    reasoningLevel: coordinatorExecution.reasoningLevel,
    permissionMode: coordinatorExecution.permissionMode,
    executionInputSources,
  };

  const backstopAt = startedAt + COORDINATOR_DEADLINE_MS + CALLER_BACKSTOP_GRACE_MS;
  const requestIdentity = {
    question,
    context: sharedContext,
    orderedLenses: lenses,
    callerThreadId: toolContext.threadId,
    projectId: contexts.planner.projectId,
    environmentId: contexts.planner.environment.type === "reuse"
      ? contexts.planner.environment.environmentId
      : null,
    coordinatorExecution: contexts.planner.execution,
    workerExecution: contexts.worker.execution,
  };
  const backstopRowId = await confirmCallerBackstop(
    bb,
    toolContext.threadId,
    marker,
    backstopAt,
    backstopMessage({ marker, requestIdentity, backstopAt }),
  );

  try {
    const coordinatorId = await spawnCoordinator(
      bb,
      spawnArgs,
      toolContext.threadId,
      marker,
      resolved.spawnTimeoutMs,
    );
    return launchReceipt(coordinatorId, backstopRowId, backstopAt, lenses.length);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : `Coordinator launch could not be confirmed; caller backstop ${backstopRowId} remains scheduled for marker-based rediscovery and no success receipt was issued.`,
    );
  }
}

/** Compatibility export for integrations compiled against the former name. */
export async function deliverGatherPerspectives(
  bb: BbPluginApi,
  input: { question: string; context?: string; lenses: readonly string[] },
  toolContext: PluginAgentToolContext,
  executionSettings: PerspectivesExecutionSettings = INHERIT_EXECUTION_SETTINGS,
  timing?: GatherTiming,
): Promise<string> {
  return runGatherPerspectives(bb, input, toolContext, executionSettings, timing);
}
