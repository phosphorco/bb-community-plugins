import type Database from "better-sqlite3";
import type { AdmissionClientV1 } from "@phosphorco/bb-message-admission/bb";
import { canonical } from "../contracts/hash.ts";
import { canonicalJson, SubmissionV1Schema, PublicationRefSchema, type SubmissionV1 } from "@phosphorco/bb-message-admission/protocol";
import {
  DECISION_PAGE_BYTES, DECISION_ROW_BYTES, decisionRowSchema, decisionPolicySchema,
  decisionNativeRecordSchema, publicPublicationSchema, recentDecisionsInputSchema, recentDecisionsSchema,
  type DecisionRow, type RecentDecisionsInput,
} from "./decisions-contract.ts";

const FROZEN_BYTES = 1024 * 1024;
const text = (error: unknown) => {
  const value = error instanceof Error ? error.message : String(error);
  return value.length <= 2000 ? value : value.slice(0, 1980) + " [truncated]";
};
function parseJson(bytes: string, phase: string): unknown {
  try { return JSON.parse(bytes); }
  catch { throw Error(`${phase} is invalid JSON. Raw policy/configuration bytes are excluded from diagnostics.`); }
}
function diagnostic(error: unknown): string {
  // Zod diagnostics expose paths/codes, never an invalid input value. JSON
  // parser errors are replaced at the precise phase above: V8 may quote input.
  if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues))
    return error.issues.slice(0, 8).map(issue => `${issue.path.join(".") || "binding"}: ${issue.code}`).join("; ").slice(0, 2000);
  return text(error);
}
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
type Row = { cursor: string; id: string; state: string; reason: string | null; frozen: string | null; evaluation: string | null };

// Deliberately independent of createAdmissionLedger: constructing that writer
// fences prior generations. This path contains SELECTs only, including after
// reload before the first new evaluator callback has initialized a ledger.
export async function listRecentDecisions(
  db: Database.Database, input: RecentDecisionsInput,
  getClient: () => Promise<AdmissionClientV1>,
) {
  const { limit, before, assessmentId } = recentDecisionsInputSchema.parse(input);
  const coverage = "MR evaluator callbacks retained here" as const;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mr_admissions'").get())
    return recentDecisionsSchema.parse({ coverage, retention: "no-retained-callbacks", rows: [], nextCursor: null });
  const columns = `CAST(rowid AS TEXT) cursor,id,state,
    CASE WHEN length(reason)>2000 THEN substr(reason,1,1980)||' [truncated]' ELSE reason END reason,
    CASE WHEN length(CAST(frozen AS BLOB))<=${FROZEN_BYTES} THEN frozen ELSE NULL END frozen,
    CASE WHEN length(CAST(evaluation AS BLOB))<=${DECISION_ROW_BYTES} THEN evaluation ELSE NULL END evaluation`;
  const retained = (assessmentId
    ? db.prepare(`SELECT ${columns} FROM mr_admissions WHERE id=? LIMIT 1`).all(assessmentId)
    : before
    ? db.prepare(`SELECT ${columns} FROM mr_admissions WHERE rowid<CAST(? AS INTEGER) ORDER BY rowid DESC LIMIT ?`).all(before, limit + 1)
    : db.prepare(`SELECT ${columns} FROM mr_admissions ORDER BY rowid DESC LIMIT ?`).all(limit + 1)) as Row[];
  const page = retained.slice(0, limit);
  const bindings = new Map<string, SubmissionV1>();
  const rowBudget = Math.min(DECISION_ROW_BYTES, Math.floor((DECISION_PAGE_BYTES - 4096) / limit));
  const rows: DecisionRow[] = page.map(row => {
    const result: DecisionRow = {
      cursor: row.cursor, assessmentId: row.id.slice(0, 256),
      local: { state: row.state.slice(0, 200), reason: row.reason, evaluation: null },
      operation: null, submission: null, rawOriginal: null,
      frozenPublication: null, frozenPolicy: null, diagnostics: [],
      native: { state: "unknown", reason: "Frozen native binding is unavailable; no native identity was inferred.", record: null },
    };
    try {
      if (!row.frozen) throw Error("Frozen binding exceeds the read budget.");
      const frozen = parseJson(row.frozen, "Frozen journal") as { binding?: { submission?: unknown; publication?: unknown }; policyBytes?: unknown };
      // Canonical parsing rejects ambiguous/noncanonical historical bindings.
      canonicalJson(frozen, FROZEN_BYTES); // finite plain JSON and public depth bound
      if (canonical(frozen) !== row.frozen) throw Error("Frozen JSON does not match the feature journal's canonical encoding.");
      const submission = SubmissionV1Schema.parse(frozen.binding?.submission);
      const publication = PublicationRefSchema.parse(frozen.binding?.publication);
      if (publication.providerId !== "message-rules") throw Error("Frozen publication is not a Message Rules publication.");
      result.operation = submission.operation;
      bindings.set(row.cursor, submission);
      result.frozenPublication = publication;
      const { rawInput, ...metadata } = submission;
      result.submission = metadata;
      const raw = canonicalJson(rawInput, FROZEN_BYTES);
      result.rawOriginal = { text: raw.slice(0, 8192), bytes: Buffer.byteLength(raw), truncated: raw.length > 8192 };
      try {
        // Only named policy metadata is returned. Never expose connection or
        // the complete policy bytes, even on a malformed historical record.
        if (typeof frozen.policyBytes !== "string") throw Error("Frozen policy bytes are missing.");
        result.frozenPolicy = decisionPolicySchema.parse(parseJson(frozen.policyBytes, "Frozen policy"));
      } catch (error) { result.diagnostics.push("Frozen policy metadata unavailable: " + diagnostic(error)); }
    } catch (error) { result.diagnostics.push("Incomplete or malformed frozen binding: " + diagnostic(error)); }
    if (row.evaluation) {
      try { result.local.evaluation = decisionRowSchema.shape.local.shape.evaluation.parse(parseJson(row.evaluation, "Local evaluation")); }
      catch (error) { result.diagnostics.push("Local evaluation unavailable: " + diagnostic(error)); }
    } else result.diagnostics.push("No local evaluation retained within the read budget.");
    // A large original/policy must not hide the stable row cursor or suggest
    // local success. The operation/ref can still support authoritative lookup.
    if (size(result) > rowBudget / 2) {
      result.rawOriginal = null; result.local.evaluation = null;
      result.diagnostics.push("Raw original and local evaluation omitted to fit this page's response budget.");
    }
    if (size(result) > rowBudget / 2) {
      result.frozenPolicy = null;
      result.diagnostics.push("Frozen group/version metadata exceeds this page's detail budget.");
    }
    if (size(result) > rowBudget / 2) {
      result.submission = null;
      result.diagnostics.push("Submission details exceed this page's response budget; operation and publication identity retained.");
    }
    return result;
  });
  // At most one public read per returned, valid binding; four in flight.
  // No recheck, evaluate, feedback, publication, transport or paid work.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (next < rows.length) {
      const row = rows[next++]!;
      if (!row.operation) continue;
      try {
        const client = await getClient();
        const lookup = await client.lookupOperation({ version: 1, operation: row.operation });
        if (!lookup.record) {
          row.native = { state: "missing", reason: "Native operation is missing; local evaluation does not prove an outcome.", record: null };
          continue;
        }
        const record = lookup.record;
        const original = bindings.get(row.cursor)!;
        if (record.kind !== "submission" || record.requestFingerprint !== original.requestFingerprint ||
          record.original?.originalId !== original.original.originalId || record.original?.revision !== original.original.revision)
          throw Error("Native operation does not match the frozen submission identity.");
        const { publication, ...fields } = record;
        row.native = { state: "found", reason: null, record: decisionNativeRecordSchema.parse({
          ...fields, publication: publication ? publicPublicationSchema.parse(publication) : null,
        }) };
        if (size(row) > rowBudget)
          row.native = { state: "unavailable", reason: `Native record exceeds this page's response budget. No partial native outcome is presented. ${assessmentId ? "Exact detail exceeds the 256 KiB row limit." : "Read this callback alone with assessmentId and limit:1 for a larger detail budget (up to 256 KiB)."}`, record: null };
      } catch (error) { row.native = { state: "unavailable", reason: text(error), record: null }; }
    }
  }));
  return recentDecisionsSchema.parse({ coverage, retention: "present", rows,
    nextCursor: retained.length > limit ? rows.at(-1)!.cursor : null });
}
