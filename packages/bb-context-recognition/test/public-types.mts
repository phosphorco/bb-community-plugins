// Consumer proof against public emitted declarations. No source aliases.
import {
  LIMITS, METHODS, WIRE_VERSIONS, RESERVED_PROVIDER_PREFIX, UnknownResultSchema,
  DescribeEnvelopeSchema, CapabilitiesV1Schema, LinkifyInputV1Schema, LinkifyOutputV1Schema,
  ResolveInputV1Schema, ResolveOutputV1Schema, ProviderClaimV1Schema,
  canonicalJson, identityKey, checkCandidate, negotiateVersion, arbitrate, nearestSpan,
} from '@phosphorco/bb-context-recognition';
import type {
  DescribeEnvelope, CapabilitiesV1, LinkifyInputV1, LinkifyOutputV1,
  ResolveInputV1, ResolveOutputV1, ProviderClaimV1, TaggedCandidateV1, SourceIdentity, Span,
} from '@phosphorco/bb-context-recognition';
import { registerRecognitionSupplier, createSupplierClient } from '@phosphorco/bb-context-recognition/bb';
import { runSupplierConformance, versionFixtures, arbitrationFixtures, workedExamples } from '@phosphorco/bb-context-recognition/testing';
import type {
  SupplierConformanceOptions, SupplierConformanceReport, ConformanceCheck,
  LinkifyConformanceCase, ResolveConformanceCase, VersionFixture, ArbitrationFixture, WorkedExample,
} from '@phosphorco/bb-context-recognition/testing';

const provider: ProviderClaimV1 = { provider: 'example', kinds: ['item'], specificity: 'typed' };
const source: SourceIdentity = { provider: 'example', id: 'one' };
const input: LinkifyInputV1 = { version: 1, text: 'one', format: 'plain', excluded: [], context: { consumer: { pluginId: 'consumer' }, links: [] } };
const output: LinkifyOutputV1 = { candidates: [{ span: { start: 0, end: 3 }, match: 'one', source, confidence: 'high', provenance: { basis: 'explicit', explanation: 'Literal test.' } }] };
const resolveInput: ResolveInputV1 = { version: 1, detail: 'card', context: { consumer: input.context.consumer }, sources: [source] };
const resolveOutput: ResolveOutputV1 = { resolutions: [{ source, state: 'ready', card: { title: 'one' }, reasons: [] }] };
const capabilities: CapabilitiesV1 = { revision: 'types/1', linkify: { providers: [ProviderClaimV1Schema.parse(provider)] } };
const envelope: DescribeEnvelope = { protocol: 'bb-context-recognition', versions: [1], capabilities };
const tagged: TaggedCandidateV1 = { candidate: output.candidates[0]!, origin: 'contributed', pluginId: 'supplier', specificity: 'typed', providers: ['example'] };
const linkifyCase: LinkifyConformanceCase = { name: 'literal', input, expected: output };
const resolveCase: ResolveConformanceCase = { name: 'card', input: resolveInput, expected: resolveOutput };
const options: SupplierConformanceOptions = {
  pluginId: 'supplier', register(bb) {
    registerRecognitionSupplier(bb, { revision: 'types/1', linkify: { providers: [provider], handler: value => value.text === input.text ? output : { candidates: [] } } });
  }, linkifyCases: [linkifyCase], resolveCases: [resolveCase],
};
const result: Promise<SupplierConformanceReport> = runSupplierConformance(options);
void result.then(report => {
  const proof: 'source-conformance' = report.proof;
  const check: ConformanceCheck | undefined = report.checks[0];
  const state: 'passed' | 'failed' | 'skipped' | undefined = check?.state;
  void [proof, state];
});
const versions: readonly VersionFixture[] = versionFixtures;
const vectors: readonly ArbitrationFixture[] = arbitrationFixtures;
const examples: readonly WorkedExample[] = workedExamples;
const method: 'contextRecognitionDescribe' = METHODS.describe;
const version: 1 = WIRE_VERSIONS[0];
const cap: 65536 = LIMITS.responseBytes;
const prefix: 'bb.' = RESERVED_PROVIDER_PREFIX;
const selected = nearestSpan({ start: 4, end: 5 }, [{ start: 0, end: 3, value: 'before' }]);
const customValue: string | undefined = selected?.value;
const empty: Span | undefined = nearestSpan({ start: 1, end: 2 }, []);
const negotiation = negotiateVersion(envelope);
if (negotiation.state === 'ready') {
  const one: 1 = negotiation.version;
  const claim: ProviderClaimV1 | undefined = negotiation.capabilities.linkify?.providers[0];
  void [one, claim];
} else {
  const reason: 'schema' | 'version' = negotiation.reason;
  void reason;
}
const checked: { valid: boolean; reason?: string } = checkCandidate(output.candidates[0], { text: input.text, excluded: input.excluded, providers: ['example'] });
const arbitrated = arbitrate([tagged], input);
const attribution: string[] | undefined = arbitrated.occurrences[0]?.alsoBy;
const identity: SourceIdentity | undefined = arbitrated.identities[0];
void [versions, vectors, examples, method, version, cap, prefix, customValue, empty, checked, attribution, identity];
void [DescribeEnvelopeSchema.parse(envelope), CapabilitiesV1Schema.parse(capabilities), ProviderClaimV1Schema.parse(provider), LinkifyInputV1Schema.parse(input), LinkifyOutputV1Schema.parse(output), ResolveInputV1Schema.parse(resolveInput), ResolveOutputV1Schema.parse(resolveOutput), UnknownResultSchema.parse({ future: true }), canonicalJson(envelope), identityKey(source), createSupplierClient];
// @ts-expect-error unknown wire stage is not a public detail value
const badInput: ResolveInputV1 = { ...resolveInput, detail: 'body' };
// @ts-expect-error attribution origin is builtin or contributed
const badTag: TaggedCandidateV1 = { ...tagged, origin: 'plugin' };
void [badInput, badTag];
function clientTypes(sdk: Parameters<typeof createSupplierClient>[0]) {
  const client = createSupplierClient(sdk, 'supplier');
  const description: Promise<ReturnType<typeof negotiateVersion>> = client.describe(new AbortController().signal);
  const linkified: Promise<LinkifyOutputV1> = client.linkify(input);
  const resolved: Promise<ResolveOutputV1> = client.resolve(resolveInput);
  const pluginId: string = client.pluginId;
  // @ts-expect-error client inputs use the negotiated v1 shape
  client.linkify({ ...input, version: 2 });
  void [description, linkified, resolved, pluginId];
}
void clientTypes;
