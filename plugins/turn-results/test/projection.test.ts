import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimKey, InputSchemas } from '@phosphorco/bb-turn-results';
import type { ResultIdentity, Resolution } from '@phosphorco/bb-turn-results';
import type { GalleryObservation } from '../gallery/index.ts';
import { projectResults } from '../gallery/projection.ts';
const url = 'https://github.com/a/b/pull/1';
function observation(owner: string, operation = 'open', eventId = 'event'): GalleryObservation {
  const identity: ResultIdentity = { version: 1, ref: { source: { threadId: 'thread', turnId: 'turn', eventId, seq: 1, itemId: 'call', eventType: 'item/completed' }, member: operation, kind: `github/${operation}` },
    artifact: { provider: 'github', id: 'a/b/pull/1', kind: 'pull-request' }, specificity: 'typed',
    equivalence: { namespace: 'github.operation', operationId: operation, member: operation },
    evidence: { basis: 'typed-receipt', sites: [{ eventId, field: 'tool.result', start: 0, end: url.length }], targetUrls: [url], selectedDigest: 'a'.repeat(64) }, lookup: null };
  const resolution: Resolution = { identity, proof: { kind: 'initial-operation', source: identity.ref.source, receiptId: 'receipt', receiptDigest: 'b'.repeat(64), operationId: operation, binderVersion: '1', tool: { pluginId: owner, name: 'publish' } },
    revision: { epoch: 'e', sequence: 1 }, knowledge: 'confirmed', outcomeEvidence: { kind: 'external-success', id: 'receipt', digest: 'b'.repeat(64), recordedAt: 1 },
    availability: { state: 'unknown', asOf: 1, expiresAt: null }, route: { kind: 'url', href: url }, provenance: { originHost: { state: 'unknown', reason: 'not-recorded' }, artifactLocation: { state: 'unknown', reason: 'external' } },
    fallback: { kind: 'card', title: 'a/b#1' }, spans: { width: 1, height: 1 } };
  InputSchemas.resolution.parse(resolution);
  return { key: claimKey(owner, identity.ref), owner, identity, resolution, unresolved: false, firstObservedOrder: 1, corrections: [], sourceExpired: null, retracted: null, freshness: 'fresh', currentAvailability: resolution.availability };
}
test('same PR open and review occurrences remain separate; competing equivalent owners become neutral contention', () => {
  const open = observation('source-a'), review = observation('source-a', 'review', 'later');
  assert.equal(projectResults([open, review]).length, 2);
  const competing = observation('source-b');
  const projection = projectResults([open, competing, review]);
  assert.equal(projection.length, 2); assert.equal(projection[0]!.kind, 'contested');
  if (projection[0]!.kind === 'contested') assert.equal(projection[0]!.rows.length, 2);
  competing.retracted = { revision: { epoch: 'e', sequence: 2 }, reason: 'source correction', supersedesEvidenceDigest: 'b'.repeat(64) };
  assert.equal(projectResults([open, competing])[0]!.kind, 'single');
});
test('generic suppression uses exact same-event site and URL, retains records and restores after source expiry', () => {
  const typed = observation('source-a'), generic = observation('links');
  generic.identity = { ...generic.identity, ref: { ...generic.identity.ref, kind: 'links/url-found', member: 'url:0' }, specificity: 'generic', evidence: { ...generic.identity.evidence, basis: 'text-link' } };
  delete generic.identity.equivalence; generic.resolution = null; generic.key = claimKey('links', generic.identity.ref);
  InputSchemas.identity.parse(generic.identity);
  assert.equal(projectResults([typed, generic]).length, 1); assert.equal(generic.identity.specificity, 'generic');
  typed.sourceExpired = { epoch: 'e', sequence: 2 }; assert.equal(projectResults([typed, generic]).length, 2);
  typed.sourceExpired = null; generic.identity.ref.source.eventId = 'different'; generic.identity.evidence.sites[0]!.eventId = 'different';
  assert.equal(projectResults([typed, generic]).length, 2);
});
