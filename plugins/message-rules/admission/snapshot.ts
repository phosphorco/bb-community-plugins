import { z } from "zod";
import { parseDocument } from "yaml";
import { ConnectionSchema, GroupSchema, RuleSchema, VERSION, migrateRule } from "../contracts/model.ts";
import { canonical } from "../contracts/hash.ts";
import type { Store } from "../state/store.ts";

// These are feature-owned policy bytes inside native's immutable publication.
// Native owns the publication pointer/CAS and supplies these exact bytes back.
export const admissionSnapshotSchema = z.object({
  format: z.literal(1),
  evaluatorVersion: z.literal(VERSION),
  catalogRevision: z.number().int().nonnegative(),
  catalogBasis: z.string().min(1),
  groups: z.array(GroupSchema),
  rules: z.array(RuleSchema),
  connection: ConnectionSchema,
}).strict();
export type AdmissionSnapshot = z.infer<typeof admissionSnapshotSchema>;
export function policyBytes(project: NonNullable<ReturnType<Store["get"]>>, basis: string) {
  return canonical(admissionSnapshotSchema.parse({
    format: 1, evaluatorVersion: VERSION, catalogRevision: project.revision,
    catalogBasis: basis, groups: project.groups, rules: project.rules.map(migrateRule),
    connection: project.config.connection,
  }));
}
export function readPolicyBytes(bytes: string): AdmissionSnapshot {
  // JSON.parse alone silently accepts duplicate fields. A publication is exact
  // data, so ambiguity is a configuration error before any paid invocation.
  const unique = parseDocument(bytes, { uniqueKeys: true });
  if (unique.errors.length) throw Error("Ambiguous Message Rules publication JSON.");
  const snapshot = admissionSnapshotSchema.parse(JSON.parse(bytes));
  const groups = new Set(snapshot.groups.map(g => g.id));
  if (groups.size !== snapshot.groups.length || new Set(snapshot.rules.map(r => r.id)).size !== snapshot.rules.length)
    throw Error("Duplicate published group/rule identity.");
  if (snapshot.rules.some(r => !groups.has(r.groupId)))
    throw Error("Published rule has no saved group.");
  return snapshot;
}
