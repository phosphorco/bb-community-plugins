import { createHash } from "node:crypto";
import { z } from "zod";

export interface ToolExecutionFact {
  sourceEventId: string;
  threadId: string;
  turnId: string | null;
  sequence: number;
  projectId: string;
  providerId: string;
  createdAtMs: number;
  capabilityKind: "tool" | "command" | "file_read";
  capabilityKey: string;
  status: "completed" | "failed" | "interrupted" | "unknown";
  durationMs: number;
  failed: boolean;
  errorClass: string | null;
  errorSignature: string | null;
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

  return {
    sourceEventId: event.id,
    threadId: event.threadId,
    turnId: event.scope.kind === "turn" ? event.scope.turnId : null,
    sequence: event.seq,
    projectId: dimensions.projectId,
    providerId: dimensions.providerId,
    createdAtMs: event.createdAt,
    capabilityKind,
    capabilityKey,
    status,
    durationMs: item.type === "fileRead" ? 0 : Math.round(item.durationMs ?? 0),
    failed,
    errorClass: classified?.errorClass ?? null,
    errorSignature: classified?.signature ?? null,
  };
}
