import { createHash } from "node:crypto";
import { z } from "zod";

import { describeCommandExecution, type CommandExecutionShape } from "./command-signature.ts";

export const FACT_PROJECTION_VERSION = 4;

export interface TurnTiming {
  startedAtMs: number;
  completedAtMs: number;
}

export interface ToolExecutionFact {
  sourceEventId: string;
  threadId: string;
  turnId: string | null;
  sequence: number;
  projectId: string;
  providerId: string;
  createdAtMs: number;
  turnStartedAtMs: number | null;
  turnCompletedAtMs: number | null;
  capabilityKind: "tool" | "command" | "file_read";
  capabilityKey: string;
  status: "completed" | "failed" | "interrupted" | "unknown";
  durationMs: number;
  failed: boolean;
  errorClass: string | null;
  errorSignature: string | null;
  commandBinary: string | null;
  commandArgument1: string | null;
  commandArgument2: string | null;
  commandUsesHelp: boolean;
  commandShape: CommandExecutionShape | null;
  commandShellWrapped: boolean;
  commandAttributionEligible: boolean;
}

const itemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("toolCall"),
    tool: z.string(),
    server: z.string().optional(),
    status: z.enum(["completed", "failed", "interrupted", "pending"]),
    durationMs: z.number().nonnegative().optional(),
    error: z.string().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("commandExecution"),
    status: z.enum(["completed", "failed", "interrupted", "pending"]),
    durationMs: z.number().nonnegative().optional(),
    exitCode: z.number().optional(),
    command: z.string().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("fileRead"),
    status: z.enum(["completed", "failed", "interrupted", "pending"]),
  }).passthrough(),
]);

const completedEventSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  seq: z.number().int().nonnegative(),
  createdAt: z.number(),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("thread") }),
    z.object({ kind: z.literal("turn"), turnId: z.string() }),
  ]),
  type: z.literal("item/completed"),
  data: z.object({ item: itemSchema }).passthrough(),
}).passthrough();

const turnBoundaryEventSchema = z.object({
  createdAt: z.number(),
  scope: z.object({ kind: z.literal("turn"), turnId: z.string() }),
  type: z.enum(["turn/started", "turn/completed"]),
}).passthrough();

/**
 * Retain only turns with both lifecycle boundaries. A partial event page must
 * not turn an incomplete timing observation into a guessed turn duration.
 */
export function collectTurnTimings(events: readonly unknown[]): ReadonlyMap<string, TurnTiming> {
  const partial = new Map<string, { startedAtMs?: number; completedAtMs?: number }>();
  for (const event of events) {
    const parsed = turnBoundaryEventSchema.safeParse(event);
    if (!parsed.success) continue;
    const timing = partial.get(parsed.data.scope.turnId) ?? {};
    if (parsed.data.type === "turn/started") {
      timing.startedAtMs = Math.min(timing.startedAtMs ?? parsed.data.createdAt, parsed.data.createdAt);
    } else {
      timing.completedAtMs = Math.max(timing.completedAtMs ?? parsed.data.createdAt, parsed.data.createdAt);
    }
    partial.set(parsed.data.scope.turnId, timing);
  }

  const complete = new Map<string, TurnTiming>();
  for (const [turnId, timing] of partial) {
    if (timing.startedAtMs == null || timing.completedAtMs == null || timing.completedAtMs < timing.startedAtMs) continue;
    complete.set(turnId, { startedAtMs: timing.startedAtMs, completedAtMs: timing.completedAtMs });
  }
  return complete;
}

function classifyError(message: string | undefined): { errorClass: string; signature: string } | null {
  if (message == null || message.trim() === "") return null;
  const lower = message.toLowerCase();
  const errorClass = /timeout|timed out|deadline/.test(lower)
    ? "timeout"
    : /permission|forbidden|unauthorized|denied/.test(lower)
      ? "permission"
      : /not found|enoent|missing/.test(lower)
        ? "not_found"
        : /rate.?limit|too many requests|429/.test(lower)
          ? "rate_limit"
          : /invalid|validation|schema|argument/.test(lower)
            ? "invalid_input"
            : /network|connection|econn|dns|socket/.test(lower)
              ? "network"
              : "other";
  const normalized = lower
    .replace(/[0-9a-f]{8,}/g, "#")
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 240);
  return {
    errorClass,
    signature: createHash("sha256").update(normalized).digest("hex").slice(0, 16),
  };
}

export function projectToolExecutionFact(
  input: unknown,
  dimensions: { projectId: string; providerId: string },
  turnTimings: ReadonlyMap<string, TurnTiming> = new Map(),
): ToolExecutionFact | null {
  const parsed = completedEventSchema.safeParse(input);
  if (!parsed.success) return null;
  const event = parsed.data;
  const item = event.data.item;
  if (item.status === "pending") return null;

  const status = item.status;
  const failed = item.type === "commandExecution"
    ? status === "failed" || (item.exitCode ?? 0) !== 0
    : status === "failed";
  const classified = item.type === "toolCall" && failed ? classifyError(item.error) : null;
  const command = item.type === "commandExecution" ? describeCommandExecution(item.command) : null;
  const capabilityKind = item.type === "toolCall"
    ? "tool"
    : item.type === "commandExecution"
      ? "command"
      : "file_read";
  const capabilityKey = item.type === "toolCall"
    ? `${item.server ?? "unknown"}:${item.tool}`
    : item.type === "commandExecution"
      ? "native:command_execution"
      : "native:file_read";
  const turnId = event.scope.kind === "turn" ? event.scope.turnId : null;
  const timing = turnId == null ? null : turnTimings.get(turnId) ?? null;

  return {
    sourceEventId: event.id,
    threadId: event.threadId,
    turnId,
    sequence: event.seq,
    projectId: dimensions.projectId,
    providerId: dimensions.providerId,
    createdAtMs: event.createdAt,
    turnStartedAtMs: timing?.startedAtMs ?? null,
    turnCompletedAtMs: timing?.completedAtMs ?? null,
    capabilityKind,
    capabilityKey,
    status,
    durationMs: item.type === "fileRead" ? 0 : Math.round(item.durationMs ?? 0),
    failed,
    errorClass: classified?.errorClass ?? null,
    errorSignature: classified?.signature ?? null,
    commandBinary: command?.binary ?? null,
    commandArgument1: command?.argument1 ?? null,
    commandArgument2: command?.argument2 ?? null,
    commandUsesHelp: command?.usesHelp ?? false,
    commandShape: command?.shape ?? null,
    commandShellWrapped: command?.shellWrapped ?? false,
    commandAttributionEligible: command?.attributionEligible ?? false,
  };
}
