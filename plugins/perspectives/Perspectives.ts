import type { BbPluginApi, PluginAgentToolContext } from "@bb/plugin-sdk";
import { z } from "zod";

const PLANNER_PHASE_TIMEOUT_MS = 15_000;
const PANEL_PHASE_TIMEOUT_MS = 205_000;
const PANEL_WRAP_UP_REMAINING_MS = 45_000;
const SYNTHESIS_PHASE_TIMEOUT_MS = 50_000;
const HELPER_PHASE_TIMEOUT_MS = 250_000;
const MAX_SYNTHESIS_EVIDENCE_CHARS = 240_000;
const INTERNAL_REQUEST_GRACE_MS = 2_000;

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

  const thread = await bb.sdk.threads.spawn({
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
  });

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

async function createSpawnContexts(
  bb: BbPluginApi,
  toolContext: PluginAgentToolContext,
  settings: PerspectivesExecutionSettings,
): Promise<SpawnContexts> {
  const [caller, execution] = await Promise.all([
    bb.sdk.threads.get({ threadId: toolContext.threadId, signal: toolContext.signal }),
    bb.sdk.threads.defaultExecutionOptions({ threadId: toolContext.threadId, signal: toolContext.signal }),
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
    providersPromise ??= bb.sdk.providers.list({ ...routing, signal: toolContext.signal });
  const models = (providerId: string) => {
    let promise = modelPromises.get(providerId);
    if (!promise) {
      promise = bb.sdk.providers.models({
        ...routing,
        providerId,
        signal: toolContext.signal,
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
    signal: toolContext.signal,
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

  const contexts = await createSpawnContexts(bb, toolContext, executionSettings);
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

export async function runGatherPerspectives(
  bb: BbPluginApi,
  input: { question: string; context?: string; lenses: readonly string[] },
  toolContext: PluginAgentToolContext,
  executionSettings: PerspectivesExecutionSettings = INHERIT_EXECUTION_SETTINGS,
): Promise<string> {
  const question = clean(input.question);
  const sharedContext = clean(input.context);
  if (!question) throw new Error("gather_perspectives requires a non-empty question.");

  const contexts = await createSpawnContexts(bb, toolContext, executionSettings);
  const plannerDeadline = Date.now() + PLANNER_PHASE_TIMEOUT_MS;
  const plan = await generatePlan(bb, contexts.planner, question, sharedContext, input.lenses, plannerDeadline);
  const panelDeadline = Date.now() + PANEL_PHASE_TIMEOUT_MS;
  const launched = await Promise.allSettled(
    plan.perspectives.map(async (perspective, index) => ({
      index,
      agent: {
        perspective,
        ...(await spawnAgent(
          bb,
          contexts.worker,
          `Perspective ${index + 1}: ${perspective.name}`,
          workerPrompt(question, sharedContext, perspective),
          perspective,
          panelDeadline,
        )),
      } satisfies PanelAgent,
    })),
  );
  const agents = launched.flatMap((result) => result.status === "fulfilled" ? [result.value.agent] : []);

  const completed = await collectPanelResults(
    agents,
    panelDeadline - PANEL_WRAP_UP_REMAINING_MS,
  );
  const completedByThread = new Map(completed.map((result) => [result.threadId, result]));
  const results = launched.map((launch, index): PerspectiveResult => {
    if (launch.status === "fulfilled") return completedByThread.get(launch.value.agent.threadId)!;
    return {
      perspective: plan.perspectives[index]!,
      threadId: "",
      status: "failed",
      output: "",
      error: `Agent could not be launched: ${
        launch.reason instanceof Error ? launch.reason.message : String(launch.reason)
      }`,
    };
  });
  const synthesis = await synthesize(
    bb,
    contexts.planner,
    question,
    sharedContext,
    results,
    plan.threadIds,
    Date.now() + SYNTHESIS_PHASE_TIMEOUT_MS,
  );
  return withResultThread(synthesis.output, "Final synthesis", synthesis.threadId);
}
