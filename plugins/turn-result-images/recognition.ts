import {
  InputSchemas, LIMITS, ResultsContractError, canonicalByteLength,
  validateRecognizeInput, recognitionWindowDigest, decodeRecognitionCursor,
  encodeRecognitionCursor, correlateRecognizeOutput,
} from '@phosphorco/bb-turn-results';
import type { Candidate, EventEnvelope, KindDescriptor, RecognizeInput, RecognizeOutput, ResultIdentity, SourceRef } from '@phosphorco/bb-turn-results';

export const IMAGE_REVISION = 'native-images-v1';
export const IMAGE_PROVIDER = 'bb-native-images';
export const IMAGE_KIND = 'bb-native-images/image-generated';
export const IMAGE_EQUIVALENCE_NAMESPACE = 'bb-native-images.operation';
const descriptor: KindDescriptor = {
  kind: IMAGE_KIND, namespace: IMAGE_PROVIDER, neutralLabel: 'Image', confirmedLabel: 'Image generated',
  specificity: 'typed', memberVersion: 'native-single-image/1', equivalenceNamespaces: [IMAGE_EQUIVALENCE_NAMESPACE],
};
Object.freeze(descriptor.equivalenceNamespaces);
export const IMAGE_KIND_DESCRIPTOR = Object.freeze(descriptor);

export function imageIdentity(source: SourceRef, selectedDigest: string, path: string): ResultIdentity {
  return InputSchemas.identity.parse({
    version: 1, ref: { source, member: 'image:0', kind: IMAGE_KIND },
    artifact: { provider: IMAGE_PROVIDER, id: source.eventId, kind: 'image' }, specificity: 'typed',
    equivalence: { namespace: IMAGE_EQUIVALENCE_NAMESPACE, operationId: source.eventId, member: 'image' },
    evidence: { basis: 'native-completion', selectedDigest,
      sites: [{ eventId: source.eventId, field: 'image.path', start: 0, end: path.length }], targetUrls: [] }, lookup: null,
  });
}

/** Only a completed, nonerror native image supplies this occurrence. No prompt,
 * provider result, current environment or historical execution host is inferred.
 */
export function imageCandidate(event: EventEnvelope): Candidate | null {
  const item = event.item;
  if (item.type !== 'imageGeneration' || item.status !== 'completed' || item.error !== null || !item.path) return null;
  const source = event.source;
  return { identity: imageIdentity(source, event.selectedDigest, item.path) };
}

/** Pure bounded paging over actual admitted native image occurrences. Cursor
 * binds the full selected window/context and source revision, not arrival time.
 */
export async function recognizeImages(request: RecognizeInput): Promise<RecognizeOutput> {
  const input = await validateRecognizeInput(request);
  const inputDigest = await recognitionWindowDigest(input);
  const candidates = input.events.flatMap(event => { const candidate = imageCandidate(event); return candidate ? [candidate] : []; });
  const after = input.page.cursor === null ? 0 : decodeRecognitionCursor(input.page.cursor,
    { revision: IMAGE_REVISION, inputDigest }).afterOrdinal;
  if (after > candidates.length) throw new ResultsContractError('invalid-input', 'Image cursor exceeds its finite source window.');
  const pageCandidates: Candidate[] = [];
  function output(count: number, items: Candidate[]): RecognizeOutput {
    const through = after + count;
    return { candidates: items, page: through < candidates.length
      ? { state: 'continued', nextCursor: encodeRecognitionCursor({ version: 1, revision: IMAGE_REVISION, inputDigest, afterOrdinal: through }) }
      : { state: 'complete', nextCursor: null } };
  }
  for (let index = after; index < candidates.length && pageCandidates.length < input.page.limit; index++) {
    const next = [...pageCandidates, candidates[index]!];
    try { canonicalByteLength(output(next.length, next), LIMITS.responseBytes); }
    catch {
      if (!pageCandidates.length) throw new ResultsContractError('incompatible', 'A single image identity exceeds the response budget.');
      break;
    }
    pageCandidates.push(candidates[index]!);
  }
  const result = output(pageCandidates.length, pageCandidates);
  return correlateRecognizeOutput(input, result, [IMAGE_KIND_DESCRIPTOR]);
}
