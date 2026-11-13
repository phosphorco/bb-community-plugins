import { z } from "zod";
import {
  IdSchema, OperationKeySchema, OperationRecordV1Schema, PublicationRefSchema,
  PublicationV1Schema, SubmissionV1Schema,
} from "@phosphorco/bb-message-admission/protocol";
import { GroupSchema } from "../contracts/model.ts";

export const DECISION_PAGE_BYTES = 512 * 1024;
export const DECISION_ROW_BYTES = 256 * 1024;
export const decisionCursorSchema = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => BigInt(value) <= 9223372036854775807n, "Invalid row cursor.");
export const recentDecisionsInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(25).default(10),
  before: decisionCursorSchema.optional(),
  assessmentId: IdSchema.optional(),
}).refine(value => !value.assessmentId || (value.limit === 1 && !value.before),
  "Exact assessment lookup requires limit:1 and no cursor.");
// Explicit projections of the public models, never publication snapshotBytes.
export const publicPublicationSchema = PublicationV1Schema.omit({ snapshotBytes: true }).strip();
const { publication: _publication, ...nativeFields } = OperationRecordV1Schema.shape;
export const decisionNativeRecordSchema = z.object({
  ...nativeFields, publication: publicPublicationSchema.nullable(),
}).strip();
export const decisionPolicySchema = z.object({
  evaluatorVersion: z.string(), catalogRevision: z.number().int().nonnegative(),
  catalogBasis: z.string(), groups: z.array(GroupSchema),
});
export const decisionRowSchema = z.strictObject({
  cursor: decisionCursorSchema, assessmentId: z.string().max(256),
  local: z.strictObject({
    state: z.string().max(200), reason: z.string().nullable(),
    // Feature evaluation is diagnostic only; it never proves native finality.
    evaluation: z.object({
      version: z.string(), inputHash: z.string(), policy: z.enum(["allow", "reject", "unknown"]),
      rules: z.array(z.object({
        id: z.string(), title: z.string(), revision: z.number(), status: z.string(),
        reason: z.string().optional(), observations: z.record(z.string(), z.unknown()),
        applies: z.boolean().optional(), action: z.string().optional(),
      })),
      advice: z.array(z.object({ text: z.string(), ruleIds: z.array(z.string()) })),
      errors: z.array(z.string()),
    }).nullable(),
  }),
  operation: OperationKeySchema.nullable(),
  submission: SubmissionV1Schema.omit({ rawInput: true }).nullable(),
  rawOriginal: z.strictObject({ text: z.string().max(8192), bytes: z.number().int().nonnegative(), truncated: z.boolean() }).nullable(),
  frozenPublication: PublicationRefSchema.nullable(),
  frozenPolicy: decisionPolicySchema.nullable(),
  diagnostics: z.array(z.string().max(2000)).max(12),
  native: z.strictObject({
    state: z.enum(["found", "missing", "unavailable", "unknown"]),
    reason: z.string().max(2000).nullable(), record: decisionNativeRecordSchema.nullable(),
  }),
});
export const recentDecisionsSchema = z.strictObject({
  coverage: z.literal("MR evaluator callbacks retained here"),
  retention: z.enum(["present", "no-retained-callbacks"]),
  rows: z.array(decisionRowSchema).max(25),
  nextCursor: decisionCursorSchema.nullable(),
}).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= DECISION_PAGE_BYTES,
  "Recent decisions exceed the response budget.");
export type RecentDecisionsInput = z.input<typeof recentDecisionsInputSchema>;
export type RecentDecisions = z.infer<typeof recentDecisionsSchema>;
export type DecisionRow = z.infer<typeof decisionRowSchema>;

// The public protocol's finite-JSON validator is a z.custom. Export its JSON
// vocabulary for RPC discovery while retaining the exact runtime validators
// (including the official native codec and response-byte checks).
const exportSchema = () => z.toJSONSchema(recentDecisionsSchema, {
  unrepresentable: "any",
  override({ zodSchema, jsonSchema }) {
    if (zodSchema._zod.def.type === "custom") {
      jsonSchema.type = ["null", "boolean", "number", "string", "array", "object"];
      jsonSchema.description = "Finite plain JSON; validated by the public admission codec.";
    }
  },
});
export const recentDecisionsRpcSchema = {
  "~standard": {
    ...recentDecisionsSchema["~standard"],
    jsonSchema: { input: exportSchema, output: exportSchema },
  },
};
