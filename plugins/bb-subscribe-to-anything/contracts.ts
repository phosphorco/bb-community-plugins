import { z } from "zod";

const text = z.string().trim().min(1).max(12000);
const seconds = z.number().int().min(1).max(31_536_000);
export const requestSchema = z.union([
  z
    .object({
      subject: text,
      notify_when: text,
      required_evidence: text,
      timeout_minutes: z.number().positive().max(525600).optional(),
    })
    .strict(),
  z
    .object({
      trigger: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("after"), seconds }).strict(),
        z.object({ kind: z.literal("interval"), seconds }).strict(),
        z
          .object({
            kind: z.literal("idle"),
            seconds,
            thread: text,
            activity: z.literal("visible_input").default("visible_input"),
            repeat: z
              .enum(["per_idle_episode", "during_idle"])
              .default("per_idle_episode"),
            max_wait_seconds: seconds.optional(),
          })
          .strict(),
      ]),
      message: text,
      timeout_minutes: z.number().positive().max(525600).optional(),
      delivery: z.enum(["queue", "steer"]).default("queue"),
    })
    .strict(),
]);
export type Request = z.infer<typeof requestSchema>;
export type Mode = "until" | "changes";
export const recipeSchema = z
  .object({
    script: z.string().min(1).max(32000),
    parameters: z
      .record(
        z
          .string()
          .regex(/^[A-Z][A-Z0-9_]*$/)
          .refine((k) => !/^(SUB_|BASH|ENV$|PATH$|HOME$|LD_)/.test(k)),
        z.string().max(8000),
      )
      .default({}),
    interpretation: text,
    coverage: text,
    interval_seconds: z.number().int().min(30).max(86400).default(300),
    timeout_seconds: z.number().int().min(1).max(120).default(30),
    history_count: z.number().int().min(0).max(4).default(1),
    evaluation: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("json_equals"),
          path: z.array(z.string()).max(16),
          value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
        })
        .strict(),
      z
        .object({
          kind: z.literal("json_changes"),
          path: z.array(z.string()).max(16),
        })
        .strict(),
      z.object({ kind: z.literal("semantic") }).strict(),
    ]),
  })
  .strict();
export type Recipe = z.infer<typeof recipeSchema>;
export type Run = {
  id: string;
  generation: number;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  output: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  problem?: string;
  classification?: string;
  provenance?: { environment: string; host: string; observer: string; permission_mode: string };
};
export type Collector = {
  token: string;
  generation: number;
  authority: NonNullable<Run["provenance"]>;
  worker?: string;
  heartbeat?: number;
  stopped_at?: number;
  sequence?: number;
  task?: { id: string; sequence?: number; claimed?: string; result?: Run };
};
export type State =
  | "preparing"
  | "watching"
  | "running"
  | "reviewing"
  | "uncertain"
  | "fulfilled"
  | "failed"
  | "expired"
  | "cancelled";
export const terminal = (s: State) =>
  ["fulfilled", "failed", "expired", "cancelled"].includes(s);
export type Record = {
  id: string;
  owner: string;
  project: string;
  environment: string | null;
  mode: Mode;
  request: Request;
  state: State;
  created_at: number;
  expires_at: number | null;
  next_at: number;
  generation: number;
  notifications_cancelled?: boolean;
  stop_pending?: boolean;
  observer?: string;
  launch?: "intent" | "confirmed";
  review_due?: number;
  review_wake?: "pending" | "sending" | "accepted" | "uncertain";
  problem?: string;
  recipe?: Recipe;
  collector?: Collector;
  report_blocked?: boolean;
  revisions: Recipe[];
  runs: Run[];
  baseline?: string;
  last_change_at?: number;
  checks: number;
  observer_turns: number;
  repairs: number;
  activity_seq?: number;
  idle_anchor: number;
  idle_fired: boolean;
  max_anchor: number;
};
export type Finding = {
  id: string;
  subscription_id: string;
  owner: string;
  occurrence: string;
  created_at: number;
  outcome: string;
  summary: string;
  evidence: string;
  delivery: "pending" | "sending" | "accepted" | "uncertain" | "cancelled";
  withdraw_pending?: boolean;
  receipt?: unknown;
  problem?: string;
};
export function validateRequest(mode: Mode, input: unknown): Request {
  const r = requestSchema.parse(input);
  if ("subject" in r && mode === "until" && !r.timeout_minutes)
    throw new Error("until observations require timeout_minutes");
  if (
    "trigger" in r &&
    ((r.trigger.kind === "after" && mode !== "until") ||
      (r.trigger.kind === "interval" && mode !== "changes"))
  )
    throw new Error("after requires until; interval requires changes");
  return r;
}
export function publicRecord(r: Record, debug = false) {
  const { observer, launch, review_wake, recipe, revisions, collector, ...visible } = r;
  return {
    ...visible,
    runs: r.runs
      .slice(-5)
      .map(({ stdout, stderr, ...run }) =>
        debug
          ? { ...run, stdout, stderr }
          : { ...run, provenance: run.provenance ? { ...run.provenance, observer: undefined } : undefined, output: run.output.slice(0, 4000) },
      ),
    interpretation: recipe?.interpretation,
    coverage: recipe?.coverage,
    ...(debug
      ? {
          debug: {
            observer_thread_id: observer,
            launch,
            review_wake,
            recipe,
            revisions,
            collector: collector ? { ...collector, token: undefined, task: collector.task ? { id: collector.task.id, sealed: !!collector.task.result } : undefined } : undefined,
          },
        }
      : {}),
  };
}

// Providers require an object root; the internal union still enforces mutually
// exclusive observation/timing forms rather than permitting mixed requests.
export const requestToolSchema = z
  .object({
    subject: text.optional(),
    notify_when: text.optional(),
    required_evidence: text.optional(),
    trigger: requestSchema.options[1].shape.trigger.optional(),
    message: text.optional(),
    timeout_minutes: z.number().positive().max(525600).optional(),
    delivery: z.enum(["queue", "steer"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success)
      ctx.addIssue({
        code: "custom",
        message:
          "Supply either subject, notify_when, required_evidence; or trigger and message. Do not mix variants.",
      });
  });

export function subscriptionSummary(r: Record) {
  return {
    subscription_id: r.id,
    state: r.state,
    mode: r.mode,
    subject:
      "subject" in r.request ? r.request.subject : r.request.trigger.kind,
    next_at: r.next_at,
    expires_at: r.expires_at,
    checks: r.checks,
    problem: r.problem?.slice(0, 1000),
  };
}
