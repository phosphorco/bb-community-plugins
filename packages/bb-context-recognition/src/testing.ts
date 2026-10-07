/** DOM-free source conformance against real registered supplier handlers.
 * This proves in-process source behavior, not host admission, network or live proof.
 */
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import type { FakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createSupplierClient } from './bb.js';
import type { SupplierClient } from './bb.js';
import {
  LIMITS, METHODS, RESERVED_PROVIDER_PREFIX, UnknownResultSchema,
  LinkifyInputV1Schema, ResolveInputV1Schema, canonicalJson, checkCandidate, identityKey,
} from './index.js';
import type { LinkifyInputV1, LinkifyOutputV1, ResolveInputV1, ResolveOutputV1, TaggedCandidateV1, SourceIdentity } from './index.js';
import versions from '../fixtures/versions.json' with { type: 'json' };
import arbitration from '../fixtures/arbitration.json' with { type: 'json' };
import examples from '../fixtures/worked-examples.json' with { type: 'json' };

export interface VersionFixture {
  name: string;
  envelope: unknown;
  expected: ReturnType<typeof import('./index.js').negotiateVersion>;
}
export interface ArbitrationFixture {
  name: string;
  text: string;
  excluded: { start: number; end: number }[];
  tagged: TaggedCandidateV1[];
  expected: ReturnType<typeof import('./index.js').arbitrate>;
}
export interface WorkedExample {
  name: string;
  input: LinkifyInputV1;
  output: LinkifyOutputV1;
  generic?: LinkifyOutputV1['candidates'][number];
  expectedPrimaryProvider?: string;
  expectedFallbackProvider?: string;
  excludedInput?: LinkifyInputV1;
  resolution?: ResolveOutputV1['resolutions'][number];
  resolutions?: ResolveOutputV1['resolutions'];
  contributedCopyDropped?: boolean;
}
/** Raw JSON files ship in fixtures/ for consumers in any repository or language. */
export const versionFixtures = versions as unknown as readonly VersionFixture[];
export const arbitrationFixtures = arbitration as unknown as readonly ArbitrationFixture[];
export const workedExamples = examples as unknown as readonly WorkedExample[];

export interface LinkifyConformanceCase {
  name?: string;
  input: LinkifyInputV1;
  /** Optional supplier-policy witness, compared as canonical JSON after decode. */
  expected?: LinkifyOutputV1;
}
export interface ResolveConformanceCase {
  name?: string;
  input: ResolveInputV1;
  expected?: ResolveOutputV1;
}
export interface SupplierConformanceOptions {
  pluginId: string;
  /** Install the same registration that the plugin's production factory uses. */
  register(bb: FakePluginHost['bb']): void | Promise<void>;
  linkifyCases?: readonly LinkifyConformanceCase[];
  resolveCases?: readonly ResolveConformanceCase[];
}
export interface ConformanceCheck {
  name: string;
  state: 'passed' | 'failed' | 'skipped';
  detail?: string;
}
export interface SupplierConformanceReport {
  pluginId: string;
  proof: 'source-conformance';
  passed: boolean;
  checks: ConformanceCheck[];
}

const reasonCodes = new Set(['not-found', 'forbidden', 'unauthenticated', 'rate-limited', 'timeout', 'source-error', 'unsupported', 'stale', 'informational']);
function requireCheck(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  requireCheck(canonicalJson(actual) === canonicalJson(expected), message);
}
function object(value: unknown): Record<string, unknown> {
  requireCheck(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  return value as Record<string, unknown>;
}
/** A deadline also bounds suppliers that ignore AbortSignal. Late rejection is observed. */
async function bounded<T>(ms: number, invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Supplier exceeded ${ms}ms deadline`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

/** Runs all applicable checks, reporting failures without hiding later failures.
 * Empty stages are explicit skips. Supply real policy cases to prove recognition
 * and resolution of your plugin's identities; automatic empty-input probes alone
 * cannot establish those policies or the absence of I/O inside a handler.
 */
export async function runSupplierConformance(options: SupplierConformanceOptions): Promise<SupplierConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const report = (): SupplierConformanceReport => ({ pluginId: options.pluginId, proof: 'source-conformance', passed: checks.every(c => c.state !== 'failed'), checks });
  const check = async (name: string, run: () => Promise<void> | void) => {
    try { await run(); checks.push({ name, state: 'passed' }); }
    catch (error) { checks.push({ name, state: 'failed', detail: error instanceof Error ? error.message : String(error) }); }
  };
  const skip = (name: string, detail: string) => checks.push({ name, state: 'skipped', detail });
  const host = createFakePluginHost({ pluginId: options.pluginId });
  let raw: unknown;
  // This SDK transport reaches the fake host's registered methods and applies
  // the supplied output schema, just as the public SDK does. No handler copies.
  const sdk = { plugins: {
    async callRpc(args: { pluginId: string; method: string; input?: unknown; outputSchema: { '~standard': { validate(value: unknown): unknown } }; signal?: AbortSignal }) {
      requireCheck(args.pluginId === options.pluginId, 'Client targeted another plugin');
      requireCheck(!args.signal?.aborted, 'Call started with an aborted signal');
      const value = await host.harness.behavior.callRpc(args.method, args.input ?? null);
      raw = value;
      const result = await args.outputSchema['~standard'].validate(value) as { value?: unknown; issues?: unknown };
      requireCheck(!result.issues, 'SDK output schema rejected result');
      return result.value;
    },
  } } as unknown as Parameters<typeof createSupplierClient>[0];
  const client: SupplierClient = createSupplierClient(sdk, options.pluginId);
  const rawCall = (method: string, input: unknown, ms: number) => bounded(ms, signal => (sdk as unknown as { plugins: { callRpc(args: { pluginId: string; method: string; input: unknown; outputSchema: typeof UnknownResultSchema; signal: AbortSignal }): Promise<unknown> } }).plugins.callRpc({ pluginId: options.pluginId, method, input, outputSchema: UnknownResultSchema, signal }));
  const rejects = async (method: string, input: unknown, ms: number) => {
    try { await rawCall(method, input, ms); }
    catch (error) {
      // A fault or timeout is not evidence of strict input rejection.
      const e = error as { code?: string; body?: { error?: { code?: string } }; name?: string; issues?: unknown };
      const validationIssues = e.name === 'ZodError' && Array.isArray(e.issues) && e.issues.length > 0 && e.issues.every(issue => issue && typeof issue.code === 'string' && typeof issue.message === 'string' && Array.isArray(issue.path));
      requireCheck(e.code === 'invalid_input' || e.body?.error?.code === 'invalid_input' || validationIssues, 'Malformed input failed without a validation error');
      return;
    }
    throw new Error('Registered method accepted malformed input');
  };
  const context: LinkifyInputV1['context'] = { consumer: { pluginId: 'conformance-consumer' }, links: [] };
  try {
    await check('registration', () => bounded(LIMITS.describeMs, async () => { await options.register(host.bb); }));
    if (checks.some(c => c.state === 'failed')) return report();
    let negotiation: Awaited<ReturnType<SupplierClient['describe']>> | undefined;
    await check('describe-negotiation', async () => {
      negotiation = await bounded(LIMITS.describeMs, signal => client.describe(signal));
      requireCheck(negotiation.state === 'ready', `Describe did not negotiate v1: ${canonicalJson(negotiation)}`);
    });
    if (!negotiation || negotiation.state !== 'ready') return report();
    const capabilities = negotiation.capabilities;
    await check('describe-claims', () => {
      for (const stage of [capabilities.linkify, capabilities.resolve]) {
        for (const claim of stage?.providers ?? []) requireCheck(!claim.provider.startsWith(RESERVED_PROVIDER_PREFIX), `Contributed supplier claims reserved provider ${claim.provider}`);
      }
    });
    await check('describe-ignores-input', async () => {
      const baseline = await rawCall(METHODS.describe, null, LIMITS.describeMs);
      equal(await rawCall(METHODS.describe, { futureField: true }, LIMITS.describeMs), baseline, 'Describe changed with ignored input');
    });
    if (capabilities.linkify) {
      if (!options.linkifyCases?.length) skip('linkify-policy-cases', 'No supplier-owned recognition policy witnesses supplied');
      const providers = capabilities.linkify.providers.map(c => c.provider);
      const empty: LinkifyInputV1 = { version: 1, text: '', format: 'plain', excluded: [], context };
      const cases: LinkifyConformanceCase[] = [...(options.linkifyCases ?? []), { name: 'no-git-empty-links', input: empty }];
      // Exercise every supplied text without a repository or existing links too.
      for (const [i, c] of (options.linkifyCases ?? []).entries()) {
        const { git: _git, ...noGit } = c.input.context;
        cases.push({ name: `${c.name ?? i}-no-git`, input: { ...c.input, context: noGit } });
        cases.push({ name: `${c.name ?? i}-empty-links`, input: { ...c.input, context: { ...c.input.context, links: [] } } });
      }
      for (const [i, c] of cases.entries()) await check(`linkify:${c.name ?? i}`, async () => {
        LinkifyInputV1Schema.parse(c.input);
        const output = await bounded(LIMITS.linkifyMs, signal => client.linkify(c.input, signal));
        const first = canonicalJson(raw);
        requireCheck(new TextEncoder().encode(first).length <= LIMITS.responseBytes, 'Response bytes exceed limit');
        const spans = new Set<string>();
        let previous: { start: number; end: number } | undefined;
        for (const candidate of output.candidates) {
          const eligibility = checkCandidate(candidate, { text: c.input.text, excluded: c.input.excluded, providers, context: c.input.context });
          requireCheck(eligibility.valid, `Ineligible candidate: ${eligibility.reason ?? 'unknown'}`);
          requireCheck(!candidate.source.provider.startsWith(RESERVED_PROVIDER_PREFIX), 'Contributed candidate uses reserved provider');
          const key = canonicalJson(candidate.span);
          requireCheck(!spans.has(key), 'More than one candidate per span'); spans.add(key);
          requireCheck(!previous || previous.start < candidate.span.start || (previous.start === candidate.span.start && previous.end <= candidate.span.end), 'Candidates are not sorted by (start,end)');
          requireCheck(candidate.provenance.basis === 'explicit' || candidate.confidence !== 'high', 'Inferred candidate has high confidence');
          previous = candidate.span;
        }
        await bounded(LIMITS.linkifyMs, signal => client.linkify(c.input, signal));
        requireCheck(first === canonicalJson(raw), 'Repeated canonical output differs');
        if (c.expected) equal(output, c.expected, 'Linkify policy witness differs');
      });
      for (const [name, input] of [
        ['unknown-field', { ...empty, futureField: true }],
        ['nested-field', { ...empty, context: { ...context, futureField: true } }],
        ['version', { ...empty, version: 2 }],
        ['oversized-text', { ...empty, text: 'x'.repeat(LIMITS.textChars + 1) }],
        ['excluded-order', { ...empty, text: 'abc', excluded: [{ start: 2, end: 3 }, { start: 0, end: 1 }] }],
      ] as const) await check(`linkify-strict:${name}`, () => rejects(METHODS.linkify, input, LIMITS.linkifyMs));
    } else {
      skip('linkify', 'Supplier does not advertise linkify');
      if (options.linkifyCases?.length) await check('linkify-cases-applicable', () => { throw new Error('Cases supplied for an unadvertised stage'); });
    }
    if (capabilities.resolve) {
      if (!options.resolveCases?.length) skip('resolve-policy-cases', 'No supplier-owned resolution policy witnesses supplied');
      const provider = capabilities.resolve.providers[0]!.provider;
      const sources: SourceIdentity[] = [{ provider, id: 'conformance-unknown-identity' }];
      const base: ResolveInputV1 = { version: 1, context: { consumer: context.consumer }, sources, detail: 'label' };
      const cases: ResolveConformanceCase[] = [...(options.resolveCases ?? []), { name: 'unknown-identity-label', input: base }];
      for (const [i, c] of (options.resolveCases ?? []).entries()) if (c.input.detail === 'card') cases.push({ name: `${c.name ?? i}-label`, input: { ...c.input, detail: 'label' } });
      for (const [i, c] of cases.entries()) await check(`resolve:${c.name ?? i}`, async () => {
        ResolveInputV1Schema.parse(c.input);
        const output = await bounded(LIMITS.resolveMs, signal => client.resolve(c.input, signal));
        requireCheck(new TextEncoder().encode(canonicalJson(raw)).length <= LIMITS.responseBytes, 'Response bytes exceed limit');
        const requested = new Set(c.input.sources.map(identityKey)), seen = new Set<string>();
        for (const value of object(raw).resolutions as unknown[]) {
          const r = object(value);
          for (const reason of r.reasons as unknown[]) requireCheck(reasonCodes.has(String(object(reason).code)), 'Supplier emitted an unknown reason code');
        }
        for (const resolution of output.resolutions) {
          const key = identityKey(resolution.source);
          requireCheck(requested.has(key), 'Resolution does not echo a requested identity');
          requireCheck(!seen.has(key), 'Duplicate resolution identity'); seen.add(key);
          requireCheck(!resolution.card || (c.input.detail === 'card' && resolution.state === 'ready'), 'Card returned for label detail or non-ready state');
        }
        // Omission is allowed: it is a transient consumer outcome, not a negative.
        if (c.expected) equal(output, c.expected, 'Resolve policy witness differs');
      });
      for (const [name, input] of [
        ['unknown-field', { ...base, futureField: true }],
        ['nested-field', { ...base, context: { ...base.context, git: {} } }],
        ['version', { ...base, version: 2 }],
        ['source-unknown-field', { ...base, sources: [{ ...sources[0], futureField: true }] }],
        ['duplicate-different-kind', { ...base, sources: [{ ...sources[0], kind: 'issue' }, { ...sources[0], kind: 'pull-request' }] }],
        ['empty-sources', { ...base, sources: [] }],
        ['duplicate-sources', { ...base, sources: [...sources, ...sources] }],
        ['too-many-sources', { ...base, sources: Array.from({ length: LIMITS.identitiesPerResolve + 1 }, (_, i) => ({ provider, id: String(i) })) }],
        ['detail', { ...base, detail: 'body' }],
      ] as const) await check(`resolve-strict:${name}`, () => rejects(METHODS.resolve, input, LIMITS.resolveMs));
    } else {
      skip('resolve', 'Supplier does not advertise resolve');
      if (options.resolveCases?.length) await check('resolve-cases-applicable', () => { throw new Error('Cases supplied for an unadvertised stage'); });
    }
  } finally {
    await host.harness.lifecycle.dispose();
  }
  return report();
}

/** Isolates only the presentation realm; never changes the production registry slot. */
export function createIsolatedPresentationRealm(): {restore():void} {
 const key=Symbol.for('phosphor.bb-context-recognition.presentations');
 const scope=globalThis as Record<symbol,unknown>;
 const descriptor=Object.getOwnPropertyDescriptor(scope,key);
 Object.defineProperty(scope,key,{configurable:true,writable:true,value:{}});
 let restored=false;
 return {restore(){if(restored)return;restored=true;if(descriptor)Object.defineProperty(scope,key,descriptor);else delete scope[key];}};
}
export interface PresentationFixture {name:string;value:unknown;valid:boolean}
export const presentationFixtures:readonly PresentationFixture[]=Object.freeze([
 {name:'versioned plan',value:{schema:'plan-graph/plan@1',data:{id:'env_example:plans/x.plan.pkl'}},valid:true},
 {name:'no major zero',value:{schema:'plan-graph/plan@0',data:{}},valid:false},
 {name:'no uppercase namespace',value:{schema:'Plan-graph/plan@1',data:{}},valid:false},
 {name:'no slash path nesting',value:{schema:'plan-graph/nested/plan@1',data:{}},valid:false},
 {name:'utf8 bytes bounded',value:{schema:'plan-graph/plan@1',data:'界'.repeat(1366)},valid:false},
]);
