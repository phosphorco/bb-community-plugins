/** Data-only wire v1. No React or SDK runtime. */
import { z } from 'zod';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * A detached plain-JSON snapshot, read only through own data descriptors.
 * Accepts null, booleans, strings, finite numbers, dense arrays (every index an
 * own enumerable data property, no other own keys besides `length`) and
 * ordinary objects (Object or null prototype, string keys only, each an own
 * enumerable data property). Never invokes getters, `toJSON`, or other hooks;
 * cycles and anything else throw `TypeError` (a child shared by two parents is
 * copied twice). The result shares nothing with the input.
 *
 * Iterative: no depth limit and no recursion. `maxNodes` (default unbounded)
 * caps the values visited; exceeding it throws `RangeError`. The value is
 * already in memory, and each container's own keys are enumerated before its
 * children are counted, so the bound limits the walk, not prior allocation.
 */
export function plainJsonSnapshot(value: unknown, options: { readonly maxNodes?: number } = {}): JsonValue {
  const maxNodes = options.maxNodes ?? Number.POSITIVE_INFINITY;
  let nodes = 0;
  let result: JsonValue = null;
  type Work = { source: unknown; assign: (snapshot: JsonValue) => void } | { exit: object };
  const work: Work[] = [{ source: value, assign: (snapshot) => { result = snapshot; } }];
  /** Containers on the current path; a shared child reached twice is fine, an ancestor is a cycle. */
  const ancestors = new Set<object>();
  const reserve = (count: number) => {
    nodes += count;
    if (nodes > maxNodes) throw new RangeError('JSON exceeds its node budget.');
  };
  reserve(1);
  while (work.length > 0) {
    const item = work.pop()!;
    if ('exit' in item) { ancestors.delete(item.exit); continue; }
    const { source, assign } = item;
    if (source === null || typeof source === 'boolean' || typeof source === 'string') { assign(source); continue; }
    if (typeof source === 'number') {
      if (!Number.isFinite(source)) throw new TypeError('Non-finite number.');
      assign(source);
      continue;
    }
    if (typeof source !== 'object') throw new TypeError('Not plain JSON.');
    if (ancestors.has(source)) throw new TypeError('Cyclic structures are not JSON.');
    ancestors.add(source);
    // Pushed before the children, so it is popped after all of them.
    work.push({ exit: source });
    const keys = Reflect.ownKeys(source);
    if (Array.isArray(source)) {
      if (Object.getPrototypeOf(source) !== Array.prototype) throw new TypeError('Not a plain array.');
      const length = (Object.getOwnPropertyDescriptor(source, 'length') as PropertyDescriptor).value as number;
      if (keys.length !== length + 1) throw new TypeError('Arrays must be dense with no extra properties.');
      reserve(length);
      const out: JsonValue[] = [];
      for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(source, String(i));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('Arrays must be dense data properties.');
        out.push(null);
        work.push({ source: descriptor.value, assign: (snapshot) => { out[i] = snapshot; } });
      }
      assign(out);
      continue;
    }
    const prototype = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Not a plain object.');
    reserve(keys.length);
    const out: Record<string, JsonValue> = {};
    for (const key of keys) {
      if (typeof key !== 'string') throw new TypeError('Symbol keys are not JSON.');
      const descriptor = Object.getOwnPropertyDescriptor(source, key) as PropertyDescriptor;
      if (!('value' in descriptor) || !descriptor.enumerable) throw new TypeError('Objects must hold enumerable data properties only.');
      // defineProperty keeps a "__proto__" key an ordinary own key.
      const define = (snapshot: JsonValue) => Object.defineProperty(out, key, { value: snapshot, writable: true, enumerable: true, configurable: true });
      define(null);
      work.push({ source: descriptor.value, assign: define });
    }
    assign(out);
  }
  return result;
}

/** Canonical JSON of a plain-JSON snapshot: sorted keys. Throws `TypeError` for anything else. Iterative; no depth limit. */
export function canonicalJson(value: unknown): string {
  return canonicalText(plainJsonSnapshot(value), Number.POSITIVE_INFINITY)!;
}

/**
 * `canonicalJson` within a UTF-8 byte budget: `null` once the text would exceed
 * `maxBytes`. Visits at most `maxBytes` values (every JSON value serializes to
 * at least one byte). Throws `TypeError` for non-JSON input.
 */
export function canonicalJsonWithin(value: unknown, maxBytes: number): string | null {
  let snapshot: JsonValue;
  try { snapshot = plainJsonSnapshot(value, { maxNodes: maxBytes }); } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  return canonicalText(snapshot, maxBytes);
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

/** Iterative canonical serialization; `null` as soon as the byte budget is exceeded. */
function canonicalText(value: JsonValue, maxBytes: number): string | null {
  const parts: string[] = [];
  let bytes = 0;
  const work: ({ text: string } | { value: JsonValue })[] = [{ value }];
  while (work.length > 0) {
    const item = work.pop()!;
    let text: string;
    if ('text' in item) text = item.text;
    else if (item.value === null || typeof item.value !== 'object') text = JSON.stringify(item.value);
    else if (Array.isArray(item.value)) {
      const array = item.value;
      work.push({ text: ']' });
      for (let i = array.length - 1; i >= 0; i--) {
        work.push({ value: array[i]! });
        if (i > 0) work.push({ text: ',' });
      }
      text = '[';
    } else {
      const record = item.value as { [key: string]: JsonValue };
      const keys = Object.keys(record).sort();
      work.push({ text: '}' });
      for (let i = keys.length - 1; i >= 0; i--) {
        work.push({ value: record[keys[i]!]! });
        work.push({ text: `${JSON.stringify(keys[i])}:` });
        if (i > 0) work.push({ text: ',' });
      }
      text = '{';
    }
    bytes += utf8Length(text);
    if (bytes > maxBytes) return null;
    parts.push(text);
  }
  return parts.join('');
}

export const PROTOCOL = 'phosphor.bb-thread-attachments' as const;
export const WIRE_VERSIONS = Object.freeze([1] as const);
export const METHODS = Object.freeze({
  describe: 'threadAttachmentsV1Describe', read: 'threadAttachmentsV1Read',
  observe: 'threadAttachmentsV1Observe', assess: 'threadAttachmentsV1Assess', family: 'threadAttachmentsV1Family', attach: 'threadAttachmentsV1Attach', detach: 'threadAttachmentsV1Detach',
} as const);
export const CHANGED_CHANNEL = 'attachments-changed' as const;
export const LIMITS = Object.freeze({
  readIds: 200, assessIds: 4, familyMembers: 500, inputBytes: 32768, responseBytes: 262144,
  describeBytes: 8192, clientMs: 4500, supplierMs: 3500, supplierReads: 2,
  supplierWrites: 1, supplierObservations: 2, observationMs: 2500, discoveryConcurrency: 4, revisionChars: 128, operationIdChars: 128,
});
/** Native generated IDs; exact match, including prefix and ten-character alphabet. */
export const ThreadIdSchema = z.string().length(14).regex(/^thr_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/);
export const RevisionSchema = z.string().min(1).max(LIMITS.revisionChars).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*(?![\s\S])/);
/** Consumer-generated immutable receipt ID; not an actor or destination. */
export const OperationIdSchema = z.string().min(1).max(LIMITS.operationIdChars).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*(?![\s\S])/);
const unique = <T>(xs: T[]) => new Set(xs).size === xs.length;
export const DescribeEnvelopeSchema = z.object({
  protocol: z.literal(PROTOCOL), versions: z.array(z.number().int().positive()).max(16),
}).passthrough();
export const DescribeV1Schema = DescribeEnvelopeSchema;
export const ReadInputV1Schema = z.strictObject({
  version: z.literal(1), threadIds: z.array(ThreadIdSchema).min(1).max(LIMITS.readIds).refine(unique, 'Duplicate thread IDs'),
});
/** Explicit priority wake. This queues bounded unknown work without assessing on the read path. */
export const AssessInputV1Schema = z.strictObject({
  version: z.literal(1), threadIds: z.array(ThreadIdSchema).min(1).max(LIMITS.assessIds).refine(unique, 'Duplicate assessment IDs'),
});
export const AssessOutputV1Schema = z.object({
  version: z.literal(1), state: z.literal('queued'),
  threadIds: z.array(ThreadIdSchema).min(1).max(LIMITS.assessIds).refine(unique, 'Duplicate assessment IDs'),
}).passthrough();
/** Bounded event-backed wait for one thread, with no history I/O or writes. */
export const ObserveInputV1Schema = z.strictObject({ version: z.literal(1), threadId: ThreadIdSchema });
export const FamilyInputV1Schema = z.strictObject({ version: z.literal(1), threadId: ThreadIdSchema });
const writeFields = { version: z.literal(1), operationId: OperationIdSchema, threadId: ThreadIdSchema, expectedRevision: RevisionSchema };
export const AttachInputV1Schema = z.strictObject({ ...writeFields, leadId: ThreadIdSchema })
  .refine(v => v.threadId !== v.leadId, 'Self-attachment is invalid');
export const DetachInputV1Schema = z.strictObject(writeFields);
/** Evolving output objects retain additive fields; new enum meanings need another wire version. */
export const AttachmentRecordV1Schema = z.object({
  threadId: ThreadIdSchema, state: z.enum(['attached', 'detached', 'none', 'unassessed', 'unavailable']),
  leadId: ThreadIdSchema.nullable(), sourceId: ThreadIdSchema.nullable(),
  provenance: z.enum(['manual', 'automatic']).nullable(), operationId: OperationIdSchema.nullable(),
}).passthrough().superRefine((v, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (v.state === 'attached') {
    if (!v.leadId || !v.sourceId || !v.provenance) fail('Attached record needs lead, source and provenance');
    if (v.threadId === v.leadId || v.threadId === v.sourceId) fail('Attached record cannot refer to itself');
  } else if (v.leadId !== null || v.sourceId !== null) fail('Non-attached record has no lead/source');
  if (v.state === 'detached' && v.provenance !== 'manual') fail('Detached record is manual suppression');
  if (['none', 'unassessed', 'unavailable'].includes(v.state) && (v.provenance !== null || v.operationId !== null)) fail('No decision provenance for unknown/none state');
});
export const ReadOutputV1Schema = z.object({
  version: z.literal(1), revision: RevisionSchema,
  records: z.array(AttachmentRecordV1Schema).min(1).max(LIMITS.readIds).refine(xs => unique(xs.map(x => x.threadId)), 'Duplicate records'),
}).passthrough();
export const FamilyOutputV1Schema = z.object({
  version: z.literal(1), revision: RevisionSchema, leadId: ThreadIdSchema,
  threadIds: z.array(ThreadIdSchema).max(LIMITS.familyMembers).refine(unique, 'Duplicate family members'),
  coverage: z.enum(['complete', 'partial', 'unavailable']),
}).passthrough().refine(v => v.coverage !== 'complete' || v.threadIds.includes(v.leadId), 'Complete family includes its lead');
export const WriteOutputV1Schema = z.object({
  version: z.literal(1), state: z.enum(['applied', 'conflict', 'unavailable']), revision: RevisionSchema, operationId: OperationIdSchema,
}).passthrough();
export type ObserveInputV1 = z.infer<typeof ObserveInputV1Schema>;
export type AssessInputV1 = z.infer<typeof AssessInputV1Schema>;
export type AssessOutputV1 = z.infer<typeof AssessOutputV1Schema>;
export type ReadInputV1 = z.infer<typeof ReadInputV1Schema>;
export type ReadOutputV1 = z.infer<typeof ReadOutputV1Schema>;
export type FamilyInputV1 = z.infer<typeof FamilyInputV1Schema>;
export type FamilyOutputV1 = z.infer<typeof FamilyOutputV1Schema>;
export type AttachInputV1 = z.infer<typeof AttachInputV1Schema>;
export type DetachInputV1 = z.infer<typeof DetachInputV1Schema>;
export type WriteOutputV1 = z.infer<typeof WriteOutputV1Schema>;
export type AttachmentRecordV1 = z.infer<typeof AttachmentRecordV1Schema>;
export type DescribeV1 = z.infer<typeof DescribeV1Schema>;
export function negotiateVersion(envelope: unknown): { version: 1 } | null {
  const parsed = DescribeEnvelopeSchema.safeParse(envelope);
  return parsed.success && parsed.data.versions.includes(1) ? { version: 1 } : null;
}
/** Every requested ID exactly once. Order is supplier-defined. */
export function readViolation(input: ReadInputV1, output: ReadOutputV1): string | null {
  const ids = new Set(input.threadIds);
  return output.records.length !== ids.size || new Set(output.records.map(r => r.threadId)).size !== ids.size || output.records.some(r => !ids.has(r.threadId)) ? 'Read must echo every requested ID exactly once' : null;
}
export function familyViolation(input: FamilyInputV1, output: FamilyOutputV1): string | null {
  return output.coverage === 'complete' && !output.threadIds.includes(input.threadId) ? 'Complete family must contain requested member' : null;
}
export function writeViolation(input: AttachInputV1 | DetachInputV1, output: WriteOutputV1): string | null {
  return input.operationId !== output.operationId ? 'Write must echo immutable operation ID' : null;
}
/** Fresh observations never establish non-execution. Newer decisions may supersede this receipt. */
export function reconcileWrite(input: AttachInputV1 | DetachInputV1, fresh: ReadOutputV1): 'observed' | 'unknown' {
  const record = fresh.records.find(r => r.threadId === input.threadId);
  if (record?.operationId !== input.operationId || record.provenance !== 'manual') return 'unknown';
  return ('leadId' in input ? record.state === 'attached' : record.state === 'detached') ? 'observed' : 'unknown';
}

/** Scheduling acknowledgement echoes exact IDs in request order; it does not prove completed assessment. */
export function assessViolation(input: AssessInputV1, output: AssessOutputV1): string | null {
  return input.threadIds.length !== output.threadIds.length || input.threadIds.some((id, index) => id !== output.threadIds[index])
    ? 'Assess must echo exact requested IDs in request order' : null;
}
