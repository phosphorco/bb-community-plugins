import { z } from "zod";
export const VERSION = "message-rules-v1.4";
export const Id = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const text = z.string().max(65536);
export type Predicate =
  | {
      kind: "condition";
      field:
        | "sender_title"
        | "destination_title"
        | "message"
        | "project_id"
        | "project_title"
        | "sender_thread_id"
        | "destination_thread_id";
      operator: "contains" | "equals";
      value: string;
      insensitive: boolean;
    }
  | { kind: "all" | "any"; children: Predicate[] }
  | { kind: "not"; child: Predicate };
export const PredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("condition"),
      field: z.enum([
        "sender_title",
        "destination_title",
        "message",
        "project_id",
        "project_title",
        "sender_thread_id",
        "destination_thread_id",
      ]),
      operator: z.enum(["contains", "equals"]),
      value: text,
      insensitive: z.boolean(),
    }),
    z.object({
      kind: z.enum(["all", "any"]),
      children: z.array(PredicateSchema).max(32),
    }),
    z.object({ kind: z.literal("not"), child: PredicateSchema }),
  ]),
);
export const ContextSchema = z.object({
  message: z.boolean(),
  senderHistory: z.number().int().min(0).max(100),
  destinationHistory: z.number().int().min(0).max(100),
  requireComplete: z.boolean(),
});
const base = {
  id: Id,
  instructions: z.string().min(1).max(12000),
  context: ContextSchema,
};
export const CriterionSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("score"),
    criteria: z.array(z.string().min(1).max(2000)).min(2).max(10),
    rejectAt: z.number().min(0).max(9),
    comparison: z.enum(["gte", "lte"]),
  }),
  z.object({
    ...base,
    type: z.literal("choice"),
    criteria: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
        z.string().min(1).max(2000),
      )
      .refine((x) => Object.keys(x).length >= 2 && Object.keys(x).length <= 32),
    rejectChoices: z.array(z.string()).min(1),
  }),
]);
export type Criterion = z.infer<typeof CriterionSchema>;
export const RuleSchema = z
  .object({
    version: z.literal(1),
    id: Id,
    title: z.string().min(1).max(200),
    groupId: Id.default("legacy-unscoped"),
    enabled: z.boolean(),
    order: z.number().int(),
    match: PredicateSchema,
    action: z.enum(["reject", "jev", "batch"]),
    criteria: z.array(CriterionSchema).max(32),
    reduction: z.enum(["all", "any"]),
    advice: text,
    revision: z.number().int().nonnegative(),
  })
  .superRefine((r, c) => {
    if (r.action === "jev" && r.enabled && !r.criteria.length)
      c.addIssue({
        code: "custom",
        message: "Add a configured JEV question before enabling.",
      });
    if (new Set(r.criteria.map((x) => x.id)).size !== r.criteria.length)
      c.addIssue({ code: "custom", message: "Criterion IDs must be unique." });
    for (const q of r.criteria) {
      if (q.type === "score" && q.rejectAt > q.criteria.length - 1)
        c.addIssue({
          code: "custom",
          message: "Score threshold is outside the configured levels.",
        });
      if (
        q.type === "choice" &&
        q.rejectChoices.some((x) => !Object.hasOwn(q.criteria, x))
      )
        c.addIssue({
          code: "custom",
          message: "Reject choices must exist in criteria.",
        });
    }
    if (r.enabled && r.action !== "batch" && !r.advice.trim())
      c.addIssue({
        code: "custom",
        message: "Write actionable advice before enabling.",
      });
  });
export type Rule = z.infer<typeof RuleSchema>;
export const ConnectionSchema = z.object({
  model: z.enum(["jev-1.14.0", "jev-1.13.0"]),
  maxWireBytes: z.number().int().min(1024).max(1000000),
  maxCalls: z.number().int().min(1).max(100),
  timeoutMs: z.number().int().min(1000).max(60000),
  maxResponseBytes: z.number().int().min(1024).max(1048576),
  perRequestTokens: z.number().int().min(1).max(64000),
  perQuestionTokens: z.number().int().min(1).max(32000),
});
export type Connection = z.infer<typeof ConnectionSchema>;
export const defaultConnection: Connection = {
  model: "jev-1.14.0",
  maxWireBytes: 64000,
  maxCalls: 32,
  timeoutMs: 15000,
  maxResponseBytes: 262144,
  perRequestTokens: 64000,
  perQuestionTokens: 32000,
};
export type HistoryEvent = { id: string; text: string; sequence: number };
export type History = {
  events: HistoryEvent[];
  coverage: "complete" | "truncated" | "unavailable" | "empty-confirmed";
  through: number | null;
};
export type Capture = {
  projectId?: string | null;
  projectTitle?: string | null;
  message: string;
  senderTitle: string | null;
  destinationTitle: string | null;
  sender: History;
  destination: History;
  provenance: { senderId: string | null; destinationId: string | null };
};
export type Policy = "allow" | "reject" | "unknown";
export type RuleResult = {
  id: string;
  title: string;
  revision: number;
  status: "not-applicable" | "allow" | "reject" | "unknown";
  reason?: string;
  observations: Record<string, unknown>;
};
export type Evaluation = {
  version: string;
  inputHash: string;
  policy: Policy;
  rules: RuleResult[];
  advice: { text: string; ruleIds: string[] }[];
  groups?: {
    id: string;
    title: string;
    revision: number;
    status: "in-scope" | "outside-scope" | "disabled" | "scope-unavailable";
  }[];
  contextAdmission?: "verified-counter" | "provider-checked";
  plannedBatch?: string[];
  errors: string[];
};
export const normalizeAdvice = (s: string) =>
  s.replace(/\r\n/g, "\n").normalize("NFC").replace(/\n$/, "");
export function newRule(id: string, groupId = "legacy-unscoped"): Rule {
  return {
    version: 1,
    id,
    title: "New rule",
    groupId,
    enabled: false,
    order: 0,
    match: { kind: "all", children: [] },
    action: "jev",
    criteria: [],
    reduction: "any",
    advice: "",
    revision: 0,
  };
}
export function match(p: Predicate, c: Capture): boolean | null {
  if (p.kind === "not") {
    const n = match(p.child, c);
    return n === null ? null : !n;
  }
  if (p.kind === "all" || p.kind === "any") {
    const v = p.children.map((x) => match(x, c));
    return p.kind === "all"
      ? v.includes(false)
        ? false
        : v.includes(null)
          ? null
          : true
      : v.includes(true)
        ? true
        : v.includes(null)
          ? null
          : false;
  }
  if (p.kind !== "condition") return null;
  const val =
    p.field === "project_id"
      ? (c.projectId ?? null)
      : p.field === "project_title"
        ? (c.projectTitle ?? null)
        : p.field === "sender_thread_id"
          ? c.provenance.senderId
          : p.field === "destination_thread_id"
            ? c.provenance.destinationId
            : p.field === "message"
              ? c.message
              : p.field === "sender_title"
                ? c.senderTitle
                : c.destinationTitle;
  if (val === null) return null;
  const norm = (s: string) =>
    p.insensitive ? s.normalize("NFC").toLowerCase() : s;
  return p.operator === "equals"
    ? norm(val) === norm(p.value)
    : norm(val).includes(norm(p.value));
}
export function validateRule(value: unknown): Rule {
  const r = RuleSchema.parse(value);
  const walk = (p: Predicate, depth: number) => {
    if (depth > 12) throw Error("Condition nesting exceeds 12.");
    if (p.kind === "all" || p.kind === "any")
      p.children.forEach((x) => walk(x, depth + 1));
    else if (p.kind === "not") walk(p.child, depth + 1);
  };
  walk(r.match, 0);
  return r;
}

export const GroupSchema = z
  .object({
    id: Id,
    title: z.string().min(1).max(200),
    enabled: z.boolean(),
    order: z.number().int(),
    revision: z.number().int().nonnegative(),
    match: PredicateSchema,
  })
  .superRefine((g, ctx) => {
    let size = 0;
    const walk = (p: Predicate, depth: number) => {
      if (++size > 256 || depth > 12) {
        ctx.addIssue({
          code: "custom",
          message: "Group predicate exceeds nesting/size limits.",
        });
        return;
      }
      if (p.kind === "condition" && p.field === "message")
        ctx.addIssue({
          code: "custom",
          message:
            "Group scope uses project/thread metadata, not message content.",
        });
      if (p.kind === "all" || p.kind === "any")
        p.children.forEach((x) => walk(x, depth + 1));
      if (p.kind === "not") walk(p.child, depth + 1);
    };
    walk(g.match, 0);
  });
export type RuleGroup = z.infer<typeof GroupSchema>;
export function newGroup(id: string): RuleGroup {
  return {
    id,
    title: "New group",
    enabled: false,
    order: 0,
    revision: 0,
    match: { kind: "any", children: [] },
  };
}

export type FileLocation = { hostId: string; root: string; revision: number };
export function fileLocation(config: {
  hostId: string;
  root: string;
  locationRevision?: number;
}): FileLocation {
  return {
    hostId: config.hostId,
    root: config.root,
    revision: config.locationRevision ?? 0,
  };
}
