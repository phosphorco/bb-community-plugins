/** Bounded canonical JSON and exact Resolve admission; no SDK/React imports. */
export const LIMITS = Object.freeze({
  inputBytes: 262_144, eventBytes: 65_536, eventTextBytes: 16_384,
  responseBytes: 65_536, resolveEnvelopeBytes: 1_024, compactOutcomeBytes: 512,
  identitiesPerResolve: 32, galleryResolveBatch: 8, identityBytes: 4_096,
  lookupBytes: 1_024, sourceStateBytes: 1_024, presentationBytes: 4_096,
  presentationDepth: 8, canonicalDepth: 32, eventsPerRecognize: 32,
  candidatesPerPage: 64, membersPerEvent: 65_536, evidenceSites: 16, targetUrls: 8,
  identifierBytes: 256, pathBytes: 4_096, memberBytes: 128, keyBytes: 1_024,
  cursorBytes: 512, describeMs: 500, recognizeMs: 500, resolveMs: 1_500,
  supplierResolveMs: 1_300, feedMs: 1_500, requestLanes: 4, sliceMs: 6_000,
} as const);
export class JsonAdmissionError extends TypeError {
  readonly code: 'invalid-json' | 'over-budget' | 'over-depth';
  constructor(code: 'invalid-json' | 'over-budget' | 'over-depth', message: string) {
    super(message); this.name = 'JsonAdmissionError'; this.code = code;
  }
}
const encoder = new TextEncoder();
export const utf8Bytes = (value: string): number => encoder.encode(value).byteLength;

/** UTF-16-sorted object keys, original array order; bounds include JSON escaping.
 * Input transport JSON is already parsed: this cannot bound pre-parse allocation.
 */
function encodeCanonical(value: unknown, maxBytes: number, maxDepth: number, retain: boolean): { text: string; bytes: number } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new RangeError('Invalid canonical JSON budget.');
  }
  const stack = new Set<object>();
  const chunks: string[] = [];
  let bytes = 0;
  const invalid = () => { throw new JsonAdmissionError('invalid-json', 'Expected plain finite JSON data.'); };
  function push(text: string) {
    bytes += utf8Bytes(text);
    if (bytes > maxBytes) throw new JsonAdmissionError('over-budget', 'Canonical JSON exceeds byte budget.');
    if (retain) chunks.push(text);
  }
  function string(text: string) {
    // Encoded JSON is never smaller than this UTF-16 length. Reject huge source
    // strings before allocating their escaped representation.
    if (text.length + 2 > maxBytes - bytes) throw new JsonAdmissionError('over-budget', 'Canonical JSON exceeds byte budget.');
    if (retain) { push(JSON.stringify(text)); return; }
    // Measure escaping and Unicode without allocating a full escaped string.
    let size = 2;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) size += 2;
      else if (code < 32) size += 6;
      else if (code < 128) size++;
      else if (code < 2048) size += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { size += 4; i++; }
      else if (code >= 0xd800 && code <= 0xdfff) size += 6;
      else size += 3;
      if (bytes + size > maxBytes) throw new JsonAdmissionError('over-budget', 'Canonical JSON exceeds byte budget.');
    }
    bytes += size;
  }
  function visit(item: unknown, depth: number): void {
    if (depth > maxDepth) throw new JsonAdmissionError('over-depth', 'Canonical JSON exceeds nesting budget.');
    if (item === null || typeof item === 'boolean') { push(JSON.stringify(item)); return; }
    if (typeof item === 'string') { string(item); return; }
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(); push(JSON.stringify(item)); return; }
    if (typeof item !== 'object' || item === null) return invalid();
    if (stack.has(item)) return invalid();
    stack.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > maxBytes) throw new JsonAdmissionError('over-budget', 'Canonical JSON exceeds byte budget.');
        push('[');
        for (let i = 0; i < item.length; i++) {
          const property = Object.getOwnPropertyDescriptor(item, String(i));
          if (!property || !('value' in property)) return invalid();
          if (i) push(',');
          visit(property.value, depth + 1);
        }
        push(']'); return;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) return invalid();
      if (Object.getOwnPropertySymbols(item).length) return invalid();
      push('{');
      const keys = Object.keys(item).sort();
      for (let i = 0; i < keys.length; i++) {
        if (i) push(',');
        const key = keys[i]!;
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (!property || !('value' in property)) return invalid();
        string(key); push(':'); visit(property.value, depth + 1);
      }
      push('}');
    } finally { stack.delete(item); }
  }
  visit(value, 0);
  return { text: chunks.join(''), bytes };
}
export function canonicalJson(value: unknown, maxBytes: number = LIMITS.responseBytes,
  maxDepth: number = LIMITS.canonicalDepth): string {
  return encodeCanonical(value, maxBytes, maxDepth, true).text;
}
export function canonicalByteLength(value: unknown, maxBytes: number = LIMITS.responseBytes): number {
  return encodeCanonical(value, maxBytes, LIMITS.canonicalDepth, false).bytes;
}
export function resolveOutcomeBudget(count: number): number {
  if (!Number.isInteger(count) || count < 1 || count > LIMITS.identitiesPerResolve) {
    throw new RangeError('Resolve count must be1..32.');
  }
  return Math.floor((LIMITS.responseBytes - LIMITS.resolveEnvelopeBytes) / count);
}
/** Ordered original request indexes; never repeat an impossible parent batch. */
export function splitDeferredIndices(indices: readonly number[], parentCount: number): number[][] {
  resolveOutcomeBudget(parentCount);
  for (let i = 0; i < indices.length; i++) {
    if (!Number.isInteger(indices[i]) || indices[i]! < 0 || indices[i]! >= parentCount
      || i > 0 && indices[i]! <= indices[i - 1]!) throw new RangeError('Deferred indexes must be ordered, unique and in scope.');
  }
  if (!indices.length) return [];
  if (parentCount === 1) throw new RangeError('Singleton cannot defer; resolve or park oversized.');
  if (indices.length === 1) return [[indices[0]!]];
  const middle = Math.floor(indices.length / 2);
  return [indices.slice(0, middle), indices.slice(middle)];
}
