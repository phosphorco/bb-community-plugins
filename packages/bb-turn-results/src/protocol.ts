import { canonicalJson, LIMITS } from './bounds.js';
import { CapabilitiesV1Schema, DescribeEnvelopeSchema, RecognizeInputSchema, RecognizeOutputSchema, FeedInputSchema, FeedOutputSchema, decodeInput, decodeOutput, IdentifierSchema, DigestSchema } from './schemas.js';
import type { RecognizeInput, CapabilitiesV1, KindDescriptor, RecognizeOutput, FeedInput, FeedOutput, ResultIdentity, Candidate } from './types.js';
import { selectedEvidenceDigest } from './events.js';
import type { EventEnvelope } from './events.js';
import { sourceRefEqual, canonicalTargetUrl, sha256Canonical, ResultsContractError } from './identity.js';
import { z } from 'zod';

export type VersionNegotiation = { state: 'ready'; version: 1; capabilities: CapabilitiesV1 } | { state: 'incompatible'; reason: 'envelope' | 'version' | 'capabilities' };
export function negotiateVersion(raw: unknown, supported: readonly number[] = [1]): VersionNegotiation {
  let envelope: z.infer<typeof DescribeEnvelopeSchema>;
  try { envelope = decodeOutput(DescribeEnvelopeSchema, raw); } catch { return { state: 'incompatible', reason: 'envelope' }; }
  if (!supported.includes(1) || !envelope.versions.includes(1)) return { state: 'incompatible', reason: 'version' };
  const parsed = CapabilitiesV1Schema.safeParse(envelope.capabilities);
  return parsed.success ? { state: 'ready', version: 1, capabilities: parsed.data } : { state: 'incompatible', reason: 'capabilities' };
}
export async function validateRecognizeInput(raw: unknown): Promise<RecognizeInput> {
  const input = decodeInput(RecognizeInputSchema, raw);
  for (const event of input.events) {
    if (await selectedEvidenceDigest(event) !== event.selectedDigest) throw new ResultsContractError('invalid-input', 'Selected event digest does not match its bounded evidence.');
  }
  return input;
}
function incompatible(message: string): never { throw new ResultsContractError('incompatible', message); }
function checkDescriptor(identity: ResultIdentity, descriptors?: readonly KindDescriptor[]) {
  if (!descriptors) return;
  const descriptor = descriptors.find(value => value.kind === identity.ref.kind);
  if (!descriptor || descriptor.specificity !== identity.specificity || identity.equivalence && !descriptor.equivalenceNamespaces.includes(identity.equivalence.namespace)) incompatible('Claim kind/classification/equivalence was not advertised.');
}
function selectedField(event: EventEnvelope, field: ResultIdentity['evidence']['sites'][number]['field']): string | null {
  if (field === 'image.path') return event.item.type === 'imageGeneration' ? event.item.path : null;
  if (field === 'command.output') return event.item.type === 'commandExecution' ? event.item.output : null;
  return event.item.type === 'toolCall' ? event.item.result : null;
}
function containsUrl(text: string, url: string): boolean {
  // A generic site normally equals the URL. Typed sites can include surrounding
  // receipt text; try both raw tokens and a terminal punctuation-free token.
  const target = canonicalTargetUrl(url);
  const candidates = [text, ...text.matchAll(/https?:\/\/[^\s<>"'\\]+/gi)].map(value => typeof value === 'string' ? value : value[0]);
  return candidates.some(candidate => [candidate, candidate.replace(/[),.;\]}]+$/, '')].some(value => { try { return canonicalTargetUrl(value) === target; } catch { return false; } }));
}
export function checkCandidate(candidate: Candidate, event: EventEnvelope, descriptors?: readonly KindDescriptor[]): void {
  const identity = candidate.identity;
  if (!sourceRefEqual(identity.ref.source, event.source) || identity.evidence.selectedDigest !== event.selectedDigest) incompatible('Candidate differs from its admitted source event/digest.');
  checkDescriptor(identity, descriptors);
  const basis = identity.evidence.basis;
  if (basis === 'native-completion' && event.item.type !== 'imageGeneration' || basis === 'command-output' && event.item.type !== 'commandExecution' || basis === 'typed-receipt' && event.item.type !== 'toolCall' || basis === 'text-link' && event.item.type === 'imageGeneration') incompatible('Evidence basis does not match native variant.');
  if (identity.specificity === 'generic' && basis !== 'text-link') incompatible('Generic claims cannot assert typed receipt semantics.');
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const site of identity.evidence.sites) {
    const text = selectedField(event, site.field);
    const key = canonicalJson(site);
    if (site.eventId !== event.source.eventId || text === null || site.end > text.length || seen.has(key)) incompatible('Evidence site is outside the exact selected field or duplicated.');
    seen.add(key); fields.push(text.slice(site.start, site.end));
  }
  if (basis === 'text-link' && (!fields.length || !identity.evidence.targetUrls.length)) incompatible('Generic link needs its exact site and URL.');
  if (basis === 'text-link' && fields.some(text => !identity.evidence.targetUrls.some(url => { try { return canonicalTargetUrl(text) === canonicalTargetUrl(url); } catch { return false; } }))) incompatible('Generic link site must select the URL itself.');
  if (identity.evidence.targetUrls.some(url => !fields.some(text => containsUrl(text, url)))) incompatible('Target URL does not occur in selected evidence sites.');
}
export async function correlateRecognizeOutput(request: RecognizeInput, raw: unknown, descriptors?: readonly KindDescriptor[]): Promise<RecognizeOutput> {
  const input = await validateRecognizeInput(request);
  const output = decodeOutput(RecognizeOutputSchema, raw);
  if (output.candidates.length > input.page.limit || output.page.state === 'continued' && output.page.nextCursor === input.page.cursor) incompatible('Recognition exceeded page count or repeated its cursor.');
  const events = new Map(input.events.map(event => [event.source.eventId, event]));
  const seen = new Set<string>();
  let previousSeq = -1;
  for (const candidate of output.candidates) {
    const event = events.get(candidate.identity.ref.source.eventId);
    if (!event) incompatible('Recognition returned a foreign event.');
    checkCandidate(candidate, event, descriptors);
    const key = canonicalJson(candidate.identity.ref);
    if (seen.has(key) || candidate.identity.ref.source.seq < previousSeq) incompatible('Recognition duplicated a claim or returned nonascending source order.');
    seen.add(key); previousSeq = candidate.identity.ref.source.seq;
  }
  return output;
}
export async function correlateFeedOutput(request: FeedInput, raw: unknown, descriptors?: readonly KindDescriptor[]): Promise<FeedOutput> {
  const input = decodeInput(FeedInputSchema, request);
  const output = decodeOutput(FeedOutputSchema, raw);
  if (output.state === 'reset') return output;
  if (output.rows.length > input.limit || !output.settled && output.nextCursor === input.cursor) incompatible('Feed exceeded page count or did not progress.');
  let last = -1;
  for (const row of output.rows) {
    const ref = row.kind === 'upsert' ? row.value.identity.ref : row.ref;
    const revision = row.kind === 'upsert' ? row.value.revision : row.revision;
    if (ref.source.threadId !== input.threadId || input.range && (ref.source.seq < input.range.fromSeq || ref.source.seq > input.range.throughSeq)) incompatible('Feed row is outside requested origin scope.');
    if (revision.epoch !== output.epoch) incompatible('Feed row belongs to another epoch.');
    if (output.phase === 'changes' && (revision.sequence <= last || revision.sequence > output.throughRevision)) incompatible('Changes must have strictly ascending bounded journal revisions.');
    last = revision.sequence;
    if (row.kind === 'upsert') checkDescriptor(row.value.identity, descriptors);
    else if (descriptors && !descriptors.some(value => value.kind === ref.kind)) incompatible('Feed change kind was not advertised.');
  }
  return output;
}
const recognitionCursorSchema = z.strictObject({ version: z.literal(1), revision: IdentifierSchema, inputDigest: DigestSchema, afterOrdinal: z.number().int().min(0).max(LIMITS.membersPerEvent * LIMITS.eventsPerRecognize) });
export type RecognitionCursor = z.infer<typeof recognitionCursorSchema>;
export async function recognitionWindowDigest(request: RecognizeInput): Promise<string> {
  const input = await validateRecognizeInput(request);
  return sha256Canonical({ context: input.context, events: input.events }, LIMITS.inputBytes);
}
export function encodeRecognitionCursor(cursor: RecognitionCursor): string { return canonicalJson(recognitionCursorSchema.parse(cursor), LIMITS.cursorBytes); }
export function decodeRecognitionCursor(raw: string, expected: Pick<RecognitionCursor, 'revision' | 'inputDigest'>): RecognitionCursor {
  if (new TextEncoder().encode(raw).byteLength > LIMITS.cursorBytes) throw new ResultsContractError('invalid-input', 'Recognition cursor exceeds byte bound.');
  const cursor = recognitionCursorSchema.parse(JSON.parse(raw));
  if (cursor.revision !== expected.revision || cursor.inputDigest !== expected.inputDigest) throw new ResultsContractError('invalid-input', 'Recognition cursor belongs to another revision/window.');
  return cursor;
}
