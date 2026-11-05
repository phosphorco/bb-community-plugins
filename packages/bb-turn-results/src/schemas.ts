/** Recursive strict inputs and recursive additive outputs. Admission precedes decoding. */
import { z } from 'zod';
import { SourceIdentitySchema as CrIdentitySchema, PresentationSchemaIdSchema } from '@phosphorco/bb-context-recognition';
import { canonicalJson, canonicalByteLength, LIMITS, resolveOutcomeBudget, utf8Bytes } from './bounds.js';
import { EventEnvelopeSchema } from './events.js';
import type { JsonValue, ResultsSourceFault } from './types.js';
import type { SourceRef, ClaimRef, EvidenceSite, Equivalence, ResultIdentity, SourceRevision, ResultProof, FileIdentity, ReferenceNavigation, ResultRoute, RouteProvenance, FallbackCanvas, PresentationRefV1, LayoutHints, ContentPresentation, ContentBlock, Resolution, Candidate, ResolveOutcome, FeedChange, FeedOutput, CapabilitiesV1, RecognizeInput, RecognizeOutput, ResolveInput, ResolveOutput, FeedInput, InvalidateInput, InvalidateOutput } from './types.js';

export const PROTOCOL = 'bb-turn-results' as const;
export const WIRE_VERSIONS = Object.freeze([1] as const);
export const METHODS = Object.freeze({ describe: 'turnResultsDescribe', recognize: 'turnResultsV1Recognize', resolve: 'turnResultsV1Resolve', enumerate: 'turnResultsV1Enumerate', invalidate: 'turnResultsV1Invalidate' } as const);
export const UnknownResultSchema = z.unknown(); // Identity schema: never strips before byte admission.
export const SOURCE_FAULT_BYTES = 512;
/** Raw fault admission must precede this additive DTO normalization. */
export const ResultsSourceFaultSchema: z.ZodType<ResultsSourceFault> = z.object({
  protocol: z.literal('bb-turn-results-fault'), version: z.literal(1),
  method: z.enum(Object.values(METHODS)),
  code: z.enum(['timeout', 'incompatible', 'aborted', 'stale', 'source-error']),
});
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = safeInteger.min(1);
const noControl = (v: string) => !/\p{Cc}/u.test(v) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
const boundedText = (max: number, nonempty = false) => z.string().min(nonempty ? 1 : 0).max(max).refine(v => utf8Bytes(v) <= max && noControl(v), 'Expected bounded well-formed plain text.');
export const IdentifierSchema = boundedText(LIMITS.identifierBytes, true);
export const PluginIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const NamespaceSchema = z.string().max(128).regex(/^[a-z][a-z0-9-]{0,31}(\.[a-z][a-z0-9-]{0,31}){0,3}$/);
export const KindSchema = z.string().max(161).regex(/^[a-z][a-z0-9-]{0,31}(\.[a-z][a-z0-9-]{0,31}){0,3}\/[a-z][a-z0-9-]{0,31}$/);
export const MemberSchema = z.string().min(1).max(LIMITS.memberBytes).regex(/^[A-Za-z0-9._:-]+$/);
export const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const PathSchema = boundedText(LIMITS.pathBytes, true);
/** Navigation accepts absolute credential-free HTTP(S) destinations only. */
export const SafeUrlSchema = PathSchema.refine(value => {
  if (/[\s\\]/u.test(value) || !/^https?:\/\//i.test(value)) return false;
  try { const u = new URL(value); return !!u.hostname && !u.username && !u.password && ['http:', 'https:'].includes(u.protocol); } catch { return false; }
}, 'Expected a credential-free HTTP(S) URL.');
/** Native serving leases may be origin-relative. Never used as operation identity. */
export const MediaHrefSchema = z.union([SafeUrlSchema, PathSchema.refine(value => value.startsWith('/') && !value.startsWith('//') && !/[\s\\]/u.test(value) && !/^\/%(?:2f|5c)/i.test(value))]);
const cursor = boundedText(LIMITS.cursorBytes, true);
const reason = boundedText(256, true);
const title = boundedText(256, true);
const description = boundedText(1024);
function boundedJson(maxBytes: number, depth: number = LIMITS.canonicalDepth) {
  return z.custom<JsonValue>(value => { try { canonicalJson(value, maxBytes, depth); return true; } catch { return false; } }, 'Expected bounded JSON data.');
}
function charge(maxBytes: number) {
  return (value: unknown, ctx: z.RefinementCtx) => {
    try { canonicalByteLength(value, maxBytes); } catch { ctx.addIssue({ code: 'custom', message: `Canonical JSON exceeds ${maxBytes} bytes or is not JSON.` }); }
  };
}

export interface WireSchemas {
  source: z.ZodType<SourceRef>; ref: z.ZodType<ClaimRef>; site: z.ZodType<EvidenceSite>; equivalence: z.ZodType<Equivalence>;
  identity: z.ZodType<ResultIdentity>; revision: z.ZodType<SourceRevision>; proof: z.ZodType<ResultProof>; file: z.ZodType<FileIdentity>;
  referenceNavigation: z.ZodType<ReferenceNavigation>; route: z.ZodType<ResultRoute>; provenance: z.ZodType<RouteProvenance>;
  fallback: z.ZodType<FallbackCanvas>; presentation: z.ZodType<PresentationRefV1>; layout: z.ZodType<LayoutHints>;
  content: z.ZodType<ContentPresentation>; contentBlock: z.ZodType<ContentBlock>; resolution: z.ZodType<Resolution>;
  candidate: z.ZodType<Candidate>; resolveOutcome: z.ZodType<ResolveOutcome>; feedChange: z.ZodType<FeedChange>;
  feedOutput: z.ZodType<FeedOutput>; capabilities: z.ZodType<CapabilitiesV1>;
}
function wire(additive: boolean): WireSchemas {
  // Additive DTO decoding accepts then discards unknown extensions AFTER raw
  // admission. The normalized v1 identity is what callers persist and echo into
  // recursively strict v1 requests; unknown extensions cannot rename a claim.
  function object<S extends z.ZodRawShape>(shape: S) { return additive ? z.object(shape) : z.strictObject(shape); }
  const source = object({ threadId: IdentifierSchema, turnId: IdentifierSchema, eventId: IdentifierSchema, seq: safeInteger, itemId: IdentifierSchema, eventType: z.literal('item/completed') });
  const ref = object({ source, member: MemberSchema, kind: KindSchema });
  const site = object({ eventId: IdentifierSchema, field: z.enum(['tool.result', 'command.output', 'image.path']), start: safeInteger, end: safeInteger }).refine(v => v.end > v.start, 'Evidence span must be nonempty.');
  const equivalence = object({ namespace: NamespaceSchema, operationId: IdentifierSchema, member: MemberSchema });
  const artifact = (additive ? CrIdentitySchema : CrIdentitySchema.strict()).refine(v => noControl(v.id), 'Artifact id must be well-formed Unicode.');
  const identity = object({ version: z.literal(1), ref, artifact, equivalence: equivalence.optional(), specificity: z.enum(['typed', 'generic']),
    evidence: object({ basis: z.enum(['typed-receipt', 'native-completion', 'command-output', 'text-link']), sites: z.array(site).max(LIMITS.evidenceSites), targetUrls: z.array(SafeUrlSchema).max(LIMITS.targetUrls), selectedDigest: DigestSchema }),
    lookup: boundedJson(LIMITS.lookupBytes),
  }).superRefine(charge(LIMITS.identityBytes));
  const revision = object({ epoch: boundedText(128, true), sequence: safeInteger });
  const proof = z.discriminatedUnion('kind', [
    object({ kind: z.literal('native-image'), source, selectedDigest: DigestSchema, artifactDigest: DigestSchema.optional() }),
    object({ kind: z.literal('native-command'), source, selectedDigest: DigestSchema, exitCode: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(), assertion: z.enum(['address-observed', 'command-succeeded', 'artifact-reported']) }).refine(v => v.assertion !== 'command-succeeded' || v.exitCode === 0, 'Command success requires exit code zero.'),
    object({ kind: z.literal('native-tool-observation'), source, selectedDigest: DigestSchema, tool: object({ server: IdentifierSchema, name: IdentifierSchema }), assertion: z.enum(['link-observed', 'artifact-reported']) }),
    object({ kind: z.literal('initial-operation'), source, receiptId: IdentifierSchema, receiptDigest: DigestSchema, operationId: IdentifierSchema, binderVersion: IdentifierSchema, tool: object({ pluginId: PluginIdSchema, name: IdentifierSchema }) }),
  ]);
  const file = z.discriminatedUnion('kind', [
    object({ kind: z.literal('host'), hostId: IdentifierSchema, path: PathSchema }),
    object({ kind: z.literal('workspace'), environmentId: IdentifierSchema, path: PathSchema }),
    object({ kind: z.literal('thread-storage'), threadId: IdentifierSchema, path: PathSchema }),
  ]);
  const referenceNavigation = z.discriminatedUnion('kind', [
    object({ kind: z.literal('file'), target: file }), object({ kind: z.literal('url'), href: SafeUrlSchema }),
    object({ kind: z.literal('thread'), threadId: IdentifierSchema }),
  ]);
  const route = z.discriminatedUnion('kind', [
    ...referenceNavigation.options,
    object({ kind: z.literal('source'), threadId: IdentifierSchema, eventId: IdentifierSchema, seq: safeInteger }),
    object({ kind: z.literal('unavailable'), reason }),
  ]);
  const provenance = object({
    originHost: z.discriminatedUnion('state', [object({ state: z.literal('recorded'), hostId: IdentifierSchema, sourceEventId: IdentifierSchema, capturedAt: safeInteger }), object({ state: z.literal('unknown'), reason: z.enum(['not-recorded', 'unverifiable']) })]),
    artifactLocation: z.discriminatedUnion('state', [
      object({ state: z.literal('verified'), target: file, observedAt: safeInteger, basis: z.enum(['explicit-host-read', 'source-owned-receipt']), sha256: DigestSchema.optional() }),
      object({ state: z.literal('candidate'), hostId: IdentifierSchema, observedAt: safeInteger, basis: z.enum(['current-thread-environment', 'current-storage-location']) }),
      object({ state: z.literal('unknown'), reason }),
    ]),
  });
  const media = object({ href: MediaHrefSchema, expiresAt: safeInteger, width: positiveInteger.max(32768).optional(), height: positiveInteger.max(32768).optional() });
  const fallback = z.discriminatedUnion('kind', [
    object({ kind: z.literal('image'), title, alt: boundedText(1024, true), media: media.optional() }),
    object({ kind: z.literal('file'), title, description: description.optional(), media: media.optional() }),
    object({ kind: z.literal('link'), title, description: description.optional(), media: media.optional() }),
    object({ kind: z.literal('preview'), title, description: description.optional(), media: media.optional() }),
    object({ kind: z.literal('card'), title, description: description.optional(), fields: z.array(object({ label: boundedText(64, true), value: boundedText(512) })).max(8).optional() }),
  ]);
  const presentation = object({ schema: PresentationSchemaIdSchema, data: boundedJson(LIMITS.presentationBytes, LIMITS.presentationDepth) });
  const layout = object({ preferred: z.enum(['compact', 'expanded', 'full-width']), aspectRatio: z.number().finite().min(0.05).max(20).optional() });
  const contentShape = { fallback, presentation: presentation.optional(), layout: layout.optional() };
  const content = object(contentShape);
  const contentBlock = object({ identity: artifact, navigation: referenceNavigation.optional(), ...contentShape });
  const outcomeEvidence = object({ kind: z.enum(['observation', 'external-success', 'definite-failure']), id: IdentifierSchema, digest: DigestSchema, recordedAt: safeInteger });
  const resolution = object({ identity, proof, revision, knowledge: z.enum(['pending', 'unknown', 'confirmed', 'failed']), outcomeEvidence: outcomeEvidence.nullable(), sourceState: boundedJson(LIMITS.sourceStateBytes).optional(),
    availability: object({ state: z.enum(['available', 'unavailable', 'unknown']), asOf: safeInteger, expiresAt: safeInteger.nullable(), reason: reason.optional() }),
    route, provenance, ...contentShape,
    spans: object({ width: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), height: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }),
    correction: object({ supersedesEvidenceDigest: DigestSchema, reason }).optional(),
  }).superRefine((v, ctx) => {
    // Known fields define the semantic source. Additive metadata does not rename it.
    const sameSource = (a: z.infer<typeof source>, b: z.infer<typeof source>) => ['threadId', 'turnId', 'eventId', 'seq', 'itemId', 'eventType'].every(key => a[key as keyof typeof a] === b[key as keyof typeof b]);
    if (!sameSource(v.proof.source, v.identity.ref.source)) ctx.addIssue({ code: 'custom', path: ['proof', 'source'], message: 'Proof source differs from claim source.' });
    if (v.proof.kind !== 'initial-operation' && v.proof.selectedDigest !== v.identity.evidence.selectedDigest) ctx.addIssue({ code: 'custom', path: ['proof', 'selectedDigest'], message: 'Selected evidence digest differs.' });
    const basis = v.identity.evidence.basis;
    const generic = v.identity.specificity === 'generic';
    const compatible = v.proof.kind === 'initial-operation' ? !generic && basis === 'typed-receipt'
      : v.proof.kind === 'native-image' ? !generic && basis === 'native-completion'
      : v.proof.kind === 'native-command' ? (basis === 'command-output' || basis === 'text-link')
        && (!generic || basis === 'text-link' && v.proof.assertion === 'address-observed')
      : (basis === 'typed-receipt' || basis === 'text-link')
        && (!generic || basis === 'text-link' && v.proof.assertion === 'link-observed');
    if (!compatible) ctx.addIssue({ code: 'custom', path: ['proof'], message: 'Proof does not establish this identity specificity/evidence basis.' });
    if (v.knowledge === 'confirmed' || v.knowledge === 'failed') {
      if (!v.outcomeEvidence) ctx.addIssue({ code: 'custom', path: ['outcomeEvidence'], message: 'Terminal knowledge requires outcome evidence.' });
      else {
        const expected = v.knowledge === 'failed' ? 'definite-failure' : v.proof.kind === 'initial-operation' ? 'external-success' : 'observation';
        if (v.outcomeEvidence.kind !== expected) ctx.addIssue({ code: 'custom', path: ['outcomeEvidence', 'kind'], message: 'Outcome evidence does not establish this knowledge.' });
      }
    }
    if (v.route.kind === 'source' && (v.route.threadId !== v.identity.ref.source.threadId || v.route.eventId !== v.identity.ref.source.eventId || v.route.seq !== v.identity.ref.source.seq)) ctx.addIssue({ code: 'custom', path: ['route'], message: 'Source navigation must match the occurrence.' });
    if (v.availability.expiresAt !== null && v.availability.expiresAt < v.availability.asOf) ctx.addIssue({ code: 'custom', path: ['availability'], message: 'Expiry precedes observation.' });
  });
  const candidate = object({ identity });
  const correlation = { requestIndex: safeInteger.max(LIMITS.identitiesPerResolve - 1), identityDigest: DigestSchema };
  const resolveOutcome = z.discriminatedUnion('state', [
    object({ ...correlation, state: z.literal('resolved'), value: resolution }),
    object({ ...correlation, state: z.literal('unavailable'), reason }),
    object({ ...correlation, state: z.literal('unrecognized'), reason }),
    object({ ...correlation, state: z.literal('budget-deferred'), neededBytes: positiveInteger.max(resolveOutcomeBudget(1)) }),
    object({ ...correlation, state: z.literal('oversized'), reason: z.literal('resolved-entry-over-cap'), neededBytes: positiveInteger.min(resolveOutcomeBudget(1) + 1) }),
  ]);
  const feedChange = z.discriminatedUnion('kind', [
    object({ kind: z.literal('upsert'), value: resolution }),
    object({ kind: z.literal('source-expired'), ref, revision }),
    object({ kind: z.literal('retract'), ref, revision, supersedesEvidenceDigest: DigestSchema, reason }),
  ]);
  const feedOutput = z.discriminatedUnion('state', [
    object({ state: z.literal('page'), epoch: boundedText(128, true), phase: z.enum(['snapshot', 'changes']), throughRevision: safeInteger, rows: z.array(feedChange).max(32), nextCursor: cursor, settled: z.boolean(), coverage: object({ retainedFrom: safeInteger.nullable(), unplaced: safeInteger, complete: z.boolean() }) }),
    object({ state: z.literal('reset'), epoch: boundedText(128, true), reason: additive ? reason.transform(v => (['expired', 'epoch-changed', 'retention-gap'] as const).find(x => x === v) ?? 'source-error' as const) : z.enum(['expired', 'epoch-changed', 'retention-gap']), restartCursor: z.null(), retainedFrom: safeInteger.nullable() }),
  ]);
  const descriptor = object({ kind: KindSchema, namespace: NamespaceSchema, neutralLabel: boundedText(64, true), confirmedLabel: boundedText(64, true), specificity: z.enum(['typed', 'generic']), memberVersion: IdentifierSchema, equivalenceNamespaces: z.array(NamespaceSchema).max(16) }).refine(v => v.kind.split('/')[0] === v.namespace, 'Kind namespace differs from descriptor namespace.');
  const capabilities = object({ revision: IdentifierSchema,
    supplier: object({ kinds: z.array(descriptor).min(1).max(32).refine(v => new Set(v.map(x => x.kind)).size === v.length, 'Duplicate kind descriptor.'), recognize: z.boolean(), resolve: z.literal(true), enumerate: z.boolean() }).optional(),
    consumer: object({ invalidate: z.literal(true) }).optional(),
  }).refine(v => !!v.supplier || !!v.consumer, 'Participant must have a role.');
  return { source, ref, site, equivalence, identity, revision, proof, file, referenceNavigation, route, provenance, fallback, presentation, layout, content, contentBlock, resolution, candidate, resolveOutcome, feedChange, feedOutput, capabilities };
}
export const InputSchemas = wire(false);
export const OutputSchemas = wire(true);
export const SourceRefSchema = OutputSchemas.source;
export const ResultIdentitySchema = OutputSchemas.identity;
export const ResolutionSchema = OutputSchemas.resolution;
export const ContentPresentationSchema = OutputSchemas.content;
export const ContentBlockSchema = OutputSchemas.contentBlock;
export const CapabilitiesV1Schema = OutputSchemas.capabilities;
export const DescribeEnvelopeSchema = z.object({ protocol: z.literal(PROTOCOL), versions: z.array(positiveInteger.max(1000)).max(16), capabilities: z.unknown() }).passthrough().refine(v => Object.hasOwn(v, 'capabilities'), 'Capabilities field is required.');
const range = z.strictObject({ fromSeq: safeInteger, throughSeq: safeInteger }).refine(v => v.fromSeq <= v.throughSeq, 'Range is reversed.');
export const RecognitionContextSchema = z.strictObject({ consumer: z.strictObject({ pluginId: PluginIdSchema, surface: IdentifierSchema }), threadId: IdentifierSchema, range, projectId: IdentifierSchema.optional(), environmentId: IdentifierSchema.optional(), routeContext: z.strictObject({ currentHostId: IdentifierSchema, observedAt: safeInteger }).optional() });
export const RecognizeInputSchema: z.ZodType<RecognizeInput> = z.strictObject({ version: z.literal(1), context: RecognitionContextSchema, events: z.array(EventEnvelopeSchema).max(LIMITS.eventsPerRecognize), page: z.strictObject({ cursor: cursor.nullable(), limit: positiveInteger.max(LIMITS.candidatesPerPage) }) }).superRefine((v, ctx) => {
  let last = -1;
  for (const [i, event] of v.events.entries()) {
    if (event.source.threadId !== v.context.threadId || event.source.seq < v.context.range.fromSeq || event.source.seq > v.context.range.throughSeq || event.source.seq <= last) ctx.addIssue({ code: 'custom', path: ['events', i], message: 'Events must be in the requested thread/range and strictly ascending.' });
    last = event.source.seq;
  }
});
export const RecognizeOutputSchema: z.ZodType<RecognizeOutput> = z.object({ candidates: z.array(OutputSchemas.candidate).max(LIMITS.candidatesPerPage), page: z.object({ nextCursor: cursor.nullable(), state: z.enum(['complete', 'continued', 'truncated']), reason: reason.optional() }).passthrough() }).passthrough().superRefine((v, ctx) => {
  if (v.page.state === 'continued' && (!v.page.nextCursor || !v.candidates.length) || v.page.state !== 'continued' && v.page.nextCursor !== null || v.page.state === 'truncated' && !v.page.reason) ctx.addIssue({ code: 'custom', path: ['page'], message: 'Continuation must progress; terminal pages need null cursor and truncation needs reason.' });
});
export const ResolveInputSchema: z.ZodType<ResolveInput> = z.strictObject({ version: z.literal(1), threadId: IdentifierSchema, items: z.array(InputSchemas.identity).min(1).max(LIMITS.identitiesPerResolve), maxOutcomeBytes: positiveInteger }).superRefine((v, ctx) => {
  if (v.maxOutcomeBytes !== resolveOutcomeBudget(v.items.length)) ctx.addIssue({ code: 'custom', path: ['maxOutcomeBytes'], message: 'Outcome budget must match request count.' });
  if (v.items.some(item => item.ref.source.threadId !== v.threadId)) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Identity belongs to another thread.' });
  if (new Set(v.items.map(item => canonicalJson(item))).size !== v.items.length) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Duplicate requested identity.' });
});
export const ResolveOutputSchema: z.ZodType<ResolveOutput> = z.object({ resolutions: z.array(OutputSchemas.resolveOutcome).max(LIMITS.identitiesPerResolve) }).passthrough();
export const FeedInputSchema: z.ZodType<FeedInput> = z.strictObject({ version: z.literal(1), threadId: IdentifierSchema, range: range.nullable(), cursor: cursor.nullable(), limit: positiveInteger.max(32) });
export const FeedOutputSchema = OutputSchemas.feedOutput;
export const InvalidateInputSchema: z.ZodType<InvalidateInput> = z.strictObject({ version: z.literal(1), supplierPluginId: PluginIdSchema, threadId: IdentifierSchema, revision: InputSchemas.revision, affected: z.union([z.literal('thread'), z.array(InputSchemas.ref).min(1).max(32)]) }).refine(v => v.affected === 'thread' || v.affected.every(ref => ref.source.threadId === v.threadId), 'Affected claims must match thread.');
export const InvalidateOutputSchema: z.ZodType<InvalidateOutput> = z.object({ state: z.enum(['dirty', 'not-admitted', 'obsolete']) }).passthrough();
/** Call before schema parsing, including for all additive unknown output fields. */
export function decodeOutput<T>(schema: z.ZodType<T>, raw: unknown): T { canonicalJson(raw, LIMITS.responseBytes); return schema.parse(raw); }
export function decodeInput<T>(schema: z.ZodType<T>, raw: unknown): T { canonicalJson(raw, LIMITS.inputBytes); return schema.parse(raw); }
