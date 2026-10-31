import { z } from 'zod';
import type { SourceRef } from './types.js';
import { canonicalJson, canonicalByteLength, LIMITS } from './bounds.js';

export const EVENT_TEXT_BYTES = 16_384;
export const EVENT_BYTES = 65_536;
export const EVENT_WINDOW_BYTES = 262_144;
const encoder = new TextEncoder();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const validUnicode = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);
const bounded = (bytes: number) => z.string().refine(s => s.length <= bytes && validUnicode(s) && encoder.encode(s).length <= bytes);
const id = bounded(LIMITS.identifierBytes).refine(s => s.length > 0 && !/\p{Cc}/u.test(s));
const pathText = bounded(LIMITS.pathBytes).refine(s => s.length > 0 && !/\p{Cc}/u.test(s));
// Private structural copy; the root SourceRef schema remains authoritative.
const sourceSchema = z.strictObject({ threadId: id, turnId: id, eventId: id,
  seq: integer, itemId: id, eventType: z.literal('item/completed') });
const statusSchema = z.enum(['pending', 'completed', 'failed', 'interrupted']);
const nativeTruncationSchema = z.strictObject({ originalLength: integer,
  retainedHeadLength: integer, retainedTailLength: integer, truncatedAt: integer });
const textInfoSchema = z.strictObject({
  format: z.enum(['text', 'json', 'absent', 'omitted']),
  originalLength: integer.nullable(), originalBytes: integer.nullable(), retainedBytes: integer,
  adapterTruncated: z.boolean(), nativeTruncation: nativeTruncationSchema.nullable(),
  omissionReason: z.enum(['structured-over-budget', 'invalid-structured-result']).nullable(),
});
const itemBase = { id, status: statusSchema, error: bounded(EVENT_TEXT_BYTES).nullable() };
const itemSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...itemBase, type: z.literal('imageGeneration'),
    path: pathText.nullable(), transparentBackground: z.boolean() }),
  z.strictObject({ ...itemBase, type: z.literal('commandExecution'),
    command: bounded(EVENT_TEXT_BYTES), cwd: pathText,
    output: bounded(EVENT_TEXT_BYTES).nullable(), exitCode: z.number().int().safe().nullable() }),
  z.strictObject({ ...itemBase, type: z.literal('toolCall'), server: id.nullable(),
    name: id, result: bounded(EVENT_TEXT_BYTES).nullable() }),
]);
const textShape = { error: textInfoSchema.optional(), path: textInfoSchema.optional(),
  command: textInfoSchema.optional(), cwd: textInfoSchema.optional(), output: textInfoSchema.optional(),
  server: textInfoSchema.optional(), name: textInfoSchema.optional(), result: textInfoSchema.optional() };
const selectedSchema = z.strictObject({ source: sourceSchema, createdAt: integer,
  item: itemSchema, context: z.strictObject({ parentToolCallId: id.nullable(), hostId: z.null() }),
  text: z.strictObject(textShape), omitted: z.array(z.enum(['prompt', 'result', 'arguments'])).max(3),
});
type Selected = z.infer<typeof selectedSchema>;
/** Strict recursively because the host passes these as recognize INPUT. */
export const EventEnvelopeSchema = selectedSchema.extend({ selectedDigest: z.string().regex(/^[a-f0-9]{64}$/u) })
  .superRefine((event, ctx) => {
    if (event.source.itemId !== event.item.id) ctx.addIssue({ code: 'custom', message: 'Source item identity mismatch.' });
    let bytes = 0;
    for (const key of ['error', 'path', 'command', 'cwd', 'output', 'server', 'name', 'result'] as const) {
      const value = (event.item as unknown as Record<string, unknown>)[key];
      if (typeof value === 'string') bytes += encoder.encode(value).length;
    }
    if (bytes > EVENT_TEXT_BYTES) ctx.addIssue({ code: 'custom', message: 'Combined selected text exceeds event budget.' });
    const expected = event.item.type === 'imageGeneration' ? ['path', 'error', 'result']
      : event.item.type === 'commandExecution' ? ['cwd', 'error', 'command', 'output'] : ['name', 'server', 'error', 'result'];
    if (Object.keys(event.text).sort().join(',') !== expected.sort().join(',')) {
      ctx.addIssue({ code: 'custom', message: 'Selected text metadata fields mismatch.' });
    }
    for (const key of Object.keys(event.text) as (keyof typeof event.text)[]) {
      const info = event.text[key]!;
      const value = (event.item as unknown as Record<string, unknown>)[key];
      if (info.format === 'text' || info.format === 'json') {
        if (typeof value !== 'string' || encoder.encode(value).length !== info.retainedBytes ||
            info.originalLength === null || info.originalLength < value.length ||
            info.adapterTruncated !== (info.originalLength > value.length) ||
            info.format === 'json' && info.adapterTruncated || info.omissionReason !== null) {
          ctx.addIssue({ code: 'custom', message: 'Selected text metadata is inconsistent.' });
        }
      } else if (value != null || info.retainedBytes !== 0 || info.adapterTruncated) {
        ctx.addIssue({ code: 'custom', message: 'Omitted text metadata is inconsistent.' });
      }
    }
  });
export type EventEnvelope = Omit<z.infer<typeof EventEnvelopeSchema>, 'source'> & { source: SourceRef };

/** Structural subset of public stored history rows; raw provider items are not rows. */
export interface NativeHistoryEvent {
  readonly id?: unknown; readonly threadId?: unknown; readonly seq?: unknown;
  readonly scope?: unknown; readonly createdAt?: unknown; readonly type?: unknown; readonly data?: unknown;
}
export type EventDiagnostic = { state: 'unsupported' | 'oversized' | 'unscoped';
  eventId: string | null; seq: number | null; reason: string };
export type AdaptCompletedEventResult = { state: 'admitted'; event: EventEnvelope; bytes: number } | EventDiagnostic;
export type AdaptCompletedEventOptions = { maxEventBytes?: number };

// Select ONLY named own data properties. In particular never enumerate raw items
// or execute getters (image prompt/result can be huge or deliberately inaccessible).
function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
const safeId = (value: unknown): string | null => id.safeParse(value).success ? value as string : null;
const safeSeq = (value: unknown): number | null => integer.safeParse(value).success ? value as number : null;
function limit(value: number | undefined, fallback: number, ceiling: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > ceiling) throw new RangeError('Invalid event admission budget.');
  return result;
}
class SelectionFailure extends Error {
  constructor(readonly kind: 'unsupported' | 'oversized', message: string) { super(message); }
}
function checkPath(value: unknown, nullable: boolean): void {
  if (nullable && value === null) return;
  if (typeof value !== 'string') throw new SelectionFailure('unsupported', 'invalid-native-path');
  if (value.length > LIMITS.pathBytes || encoder.encode(value).length > LIMITS.pathBytes) {
    throw new SelectionFailure('oversized', 'native-path-over-budget');
  }
  if (!pathText.safeParse(value).success) throw new SelectionFailure('unsupported', 'invalid-native-path');
}
type NativeTruncation = z.infer<typeof nativeTruncationSchema>;
type TextInfo = z.infer<typeof textInfoSchema>;
function nativeTruncation(item: unknown, key: string): NativeTruncation | null {
  const raw = property(property(item, 'truncation'), key);
  if (raw === undefined) return null;
  const parsed = nativeTruncationSchema.safeParse({ originalLength: property(raw, 'originalLength'),
    retainedHeadLength: property(raw, 'retainedHeadLength'), retainedTailLength: property(raw, 'retainedTailLength'),
    truncatedAt: property(raw, 'truncatedAt') });
  if (!parsed.success || parsed.data.retainedHeadLength + parsed.data.retainedTailLength > parsed.data.originalLength) {
    throw new SelectionFailure('unsupported', 'invalid-native-truncation');
  }
  return parsed.data;
}
function prefix(text: string, budget: number): string {
  // At most 16Ki UTF-16 units are examined/encoded, never the full huge input.
  let end = Math.min(text.length, budget);
  if (end && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
  let low = 0, high = end;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(text.slice(0, middle)).length <= budget) low = middle;
    else high = middle - 1;
  }
  if (low && /[\uD800-\uDBFF]/u.test(text[low - 1]!)) low--;
  return text.slice(0, low);
}

/** Digest payload: ALL selected fields, excluding only selectedDigest itself.
 * Exact evidence sites address item.path / item.output / item.result UTF-16 spans.
 * No original image bytes, prompts or arguments participate in this digest.
 */
export function selectedEvidence(event: EventEnvelope): Selected {
  return { source: event.source, createdAt: event.createdAt, item: event.item,
    context: event.context, text: event.text, omitted: event.omitted };
}
export async function selectedEvidenceDigest(event: EventEnvelope): Promise<string> {
  return digest(selectedEvidence(event));
}
async function digest(selected: Selected): Promise<string> {
  const bytes = encoder.encode(canonicalJson(selected, EVENT_BYTES));
  const value = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, '0')).join('');
}

export async function adaptCompletedEvent(input: NativeHistoryEvent,
  options: AdaptCompletedEventOptions = {}): Promise<AdaptCompletedEventResult> {
  const maxBytes = limit(options.maxEventBytes, EVENT_BYTES, EVENT_BYTES);
  const eventId = safeId(property(input, 'id')), seq = safeSeq(property(input, 'seq'));
  const diagnostic = (state: EventDiagnostic['state'], reason: string): EventDiagnostic => ({ state, eventId, seq, reason });
  if (property(input, 'type') !== 'item/completed') return diagnostic('unsupported', 'not-item-completed');
  const scope = property(input, 'scope');
  const turnId = safeId(property(scope, 'turnId'));
  if (property(scope, 'kind') !== 'turn' || !turnId) return diagnostic('unscoped', 'missing-native-turn-scope');
  const threadId = safeId(property(input, 'threadId')), createdAt = safeSeq(property(input, 'createdAt'));
  const item = property(property(input, 'data'), 'item');
  const itemId = safeId(property(item, 'id'));
  if (!eventId || seq === null || !threadId || createdAt === null || !itemId) return diagnostic('unsupported', 'invalid-native-identity');
  const kind = property(item, 'type');
  if (kind !== 'imageGeneration' && kind !== 'commandExecution' && kind !== 'toolCall') return diagnostic('unsupported', 'unsupported-native-item');
  const status = statusSchema.safeParse(property(item, 'status'));
  if (!status.success) return diagnostic('unsupported', 'unsupported-native-status');
  const parent = property(item, 'parentToolCallId');
  if (parent !== undefined && !safeId(parent)) return diagnostic('unsupported', 'invalid-parent-tool-id');
  const text: Selected['text'] = {};
  let remaining = EVENT_TEXT_BYTES;
  function selectText(key: keyof Selected['text'], raw: unknown, native: NativeTruncation | null = null,
    required = false, exact = false): string | null {
    if (raw === undefined || raw === null) {
      if (required) throw new SelectionFailure('unsupported', 'missing-selected-text');
      text[key] = { format: 'absent', originalLength: null, originalBytes: null, retainedBytes: 0,
        adapterTruncated: false, nativeTruncation: native, omissionReason: null };
      return null;
    }
    if (typeof raw !== 'string') throw new SelectionFailure('unsupported', 'invalid-selected-text');
    // Exact path/name fields must not turn into misleading truncated targets.
    const value = prefix(raw, remaining);
    if (!validUnicode(value)) throw new SelectionFailure('unsupported', 'invalid-selected-unicode');
    const adapterTruncated = value.length !== raw.length;
    if (exact && adapterTruncated) throw new SelectionFailure('oversized', 'exact-field-over-budget');
    const retainedBytes = encoder.encode(value).length;
    const originalBytes = raw.length <= EVENT_TEXT_BYTES ? encoder.encode(raw).length : null;
    text[key] = { format: 'text', originalLength: raw.length, originalBytes, retainedBytes,
      adapterTruncated, nativeTruncation: native, omissionReason: null };
    remaining -= retainedBytes;
    return value;
  }
  try {
    let selectedItem: Selected['item'];
    const base = { id: itemId, status: status.data };
    if (kind === 'imageGeneration') {
      const path = property(item, 'path');
      checkPath(path, true);
      const selectedPath = selectText('path', path, null, false, true);
      const error = selectText('error', property(item, 'error'));
      const transparentBackground = property(item, 'transparentBackground');
      if (typeof transparentBackground !== 'boolean') throw new SelectionFailure('unsupported', 'invalid-image-metadata');
      // Native result truncation metadata is selected without touching result.
      text.result = { format: 'omitted', originalLength: null, originalBytes: null, retainedBytes: 0,
        adapterTruncated: false, nativeTruncation: nativeTruncation(item, 'result'), omissionReason: null };
      selectedItem = { ...base, type: kind, path: selectedPath, error, transparentBackground };
    } else if (kind === 'commandExecution') {
      const cwd = property(item, 'cwd');
      checkPath(cwd, false);
      const selectedCwd = selectText('cwd', cwd, null, true, true)!;
      const error = selectText('error', property(item, 'error'));
      const command = selectText('command', property(item, 'command'), null, true)!;
      const output = selectText('output', property(item, 'aggregatedOutput'), nativeTruncation(item, 'aggregatedOutput'));
      const exit = property(item, 'exitCode');
      if (exit !== undefined && exit !== null && (typeof exit !== 'number' || !Number.isSafeInteger(exit))) throw new SelectionFailure('unsupported', 'invalid-exit-code');
      selectedItem = { ...base, type: kind, cwd: selectedCwd, error, command, output, exitCode: exit as number | null | undefined ?? null };
    } else {
      const name = property(item, 'tool'), server = property(item, 'server');
      if (!safeId(name) || server !== undefined && !safeId(server)) throw new SelectionFailure('unsupported', 'invalid-tool-name');
      const selectedName = selectText('name', name, null, true, true)!;
      const selectedServer = selectText('server', server, null, false, true);
      const error = selectText('error', property(item, 'error'));
      const rawResult = property(item, 'result');
      const native = nativeTruncation(item, 'result');
      let result: string | null;
      if (rawResult === undefined || typeof rawResult === 'string') {
        result = selectText('result', rawResult, native);
      } else {
        try {
          const json = canonicalJson(rawResult, Math.max(1, remaining));
          const bytes = encoder.encode(json).length;
          if (bytes > remaining) throw new SelectionFailure('oversized', 'structured-over-budget');
          remaining -= bytes;
          result = json;
          text.result = { format: 'json', originalLength: json.length, originalBytes: bytes,
            retainedBytes: bytes, adapterTruncated: false, nativeTruncation: native, omissionReason: null };
        } catch (error) {
          result = null;
          text.result = { format: 'omitted', originalLength: null, originalBytes: null, retainedBytes: 0,
            adapterTruncated: false, nativeTruncation: native,
            omissionReason: error instanceof Error && ('code' in error && error.code === 'over-budget' || error instanceof SelectionFailure) ? 'structured-over-budget' : 'invalid-structured-result' };
        }
      }
      selectedItem = { ...base, type: kind, server: selectedServer, name: selectedName, error, result };
    }
    const selected: Selected = { source: { threadId, turnId, eventId, seq, itemId, eventType: 'item/completed' },
      createdAt, item: selectedItem, context: { parentToolCallId: parent as string | undefined ?? null, hostId: null },
      text, omitted: kind === 'imageGeneration' ? ['result', 'prompt'] : kind === 'toolCall' ? ['arguments'] : [] };
    // Reserve the fixed digest field before hashing. Never hash rejected input.
    canonicalByteLength({ ...selected, selectedDigest: '0'.repeat(64) }, maxBytes);
    const event = EventEnvelopeSchema.parse({ ...selected, selectedDigest: await digest(selected) }) as EventEnvelope;
    return { state: 'admitted', event, bytes: canonicalByteLength(event, maxBytes) };
  } catch (error) {
    if (error instanceof SelectionFailure) return diagnostic(error.kind, error.message);
    if (error instanceof Error && 'code' in error && error.code === 'over-budget') return diagnostic('oversized', 'selected-event-over-budget');
    if (error instanceof z.ZodError) return diagnostic('unsupported', 'invalid-selected-event');
    throw error;
  }
}

export type EventWindowOptions = { threadId: string; afterSeq: number; maxEvents?: number;
  maxBytes?: number; maxEventBytes?: number };
export type EventWindow = { events: EventEnvelope[]; diagnostics: EventDiagnostic[];
  afterSeq: number; nextInputIndex: number; state: 'complete' | 'continued';
  reason: 'event-limit' | 'byte-limit' | 'unreliable-sequence' | 'foreign-thread' | 'unscoped' | null;
  bytes: number };
/** Prefix only. Caller must atomically persist admitted events/diagnostic gaps
 * and afterSeq; returned debt never authorizes skipping an unconsumed suffix.
 * Input allocation belongs to the native transport, not this pure selector.
 */
export async function buildEventWindow(inputs: readonly NativeHistoryEvent[], options: EventWindowOptions): Promise<EventWindow> {
  if (!safeId(options.threadId) || safeSeq(options.afterSeq) === null) throw new RangeError('Invalid native window scope.');
  const maxEvents = limit(options.maxEvents, LIMITS.eventsPerRecognize, LIMITS.eventsPerRecognize);
  const maxBytes = limit(options.maxBytes, EVENT_WINDOW_BYTES, EVENT_WINDOW_BYTES);
  const maxEventBytes = limit(options.maxEventBytes, EVENT_BYTES, EVENT_BYTES);
  const result: EventWindow = { events: [], diagnostics: [], afterSeq: options.afterSeq,
    nextInputIndex: 0, state: 'complete', reason: null, bytes: 0 };
  const charge = (events: EventEnvelope[], diagnostics: EventDiagnostic[], afterSeq: number, nextInputIndex: number) =>
    canonicalByteLength({ events, diagnostics, afterSeq, nextInputIndex, state: 'continued',
      reason: 'unreliable-sequence', bytes: EVENT_WINDOW_BYTES }, EVENT_WINDOW_BYTES);
  result.bytes = charge([], [], result.afterSeq, 0);
  const stop = (reason: NonNullable<EventWindow['reason']>) => { result.state = 'continued'; result.reason = reason; };
  if (result.bytes > maxBytes) throw new RangeError('Window budget cannot hold metadata.');
  for (let index = 0; index < inputs.length; index++) {
    if (index >= maxEvents) { stop('event-limit'); break; }
    const row = inputs[index]!;
    const seq = safeSeq(property(row, 'seq'));
    if (seq === null || seq <= result.afterSeq || !safeId(property(row, 'id'))) { stop('unreliable-sequence'); break; }
    if (property(row, 'threadId') !== options.threadId) { stop('foreign-thread'); break; }
    const scope = property(row, 'scope');
    if (property(scope, 'kind') !== 'turn' || !safeId(property(scope, 'turnId'))) { stop('unscoped'); break; }
    let adapted = await adaptCompletedEvent(row, { maxEventBytes });
    if (adapted.state === 'unscoped') { stop('unscoped'); break; }
    if (adapted.state === 'admitted') {
      // A singleton that cannot fit any empty window becomes an explicit gap;
      // aggregate prefix pressure alone must instead leave the event as debt.
      let singletonBytes = EVENT_WINDOW_BYTES + 1;
      try { singletonBytes = charge([adapted.event], [], seq, index + 1); } catch { /* over cap */ }
      if (singletonBytes > maxBytes) adapted = { state: 'oversized', eventId: adapted.event.source.eventId,
        seq, reason: 'selected-event-over-window-budget' };
    }
    const events = adapted.state === 'admitted' ? [...result.events, adapted.event] : result.events;
    const diagnostics = adapted.state !== 'admitted' ? [...result.diagnostics, adapted] : result.diagnostics;
    let bytes: number;
    try { bytes = charge(events, diagnostics, seq, index + 1); }
    catch { stop('byte-limit'); break; }
    if (bytes > maxBytes) { stop('byte-limit'); break; }
    result.events = events; result.diagnostics = diagnostics; result.afterSeq = seq;
    result.nextInputIndex = index + 1; result.bytes = bytes;
  }
  return result;
}
