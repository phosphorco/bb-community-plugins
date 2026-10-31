/** Test-only. Drives actual participant factories through the public SDK fake host.
 * This is source conformance on supplied scenarios, never installed/live proof.
 */
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import type { FakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createResultsSupplierClient, createResultsConsumerClient } from './bb.js';
import type { RpcPort } from './bb.js';
import { canonicalJson, canonicalByteLength, LIMITS, METHODS } from './index.js';
import type { RecognizeInput, RecognizeOutput, ResolveInput, ResolveOutput, FeedInput, FeedOutput, InvalidateInput, InvalidateOutput, CapabilitiesV1 } from './index.js';

export interface ConformanceCheck { name: string; state: 'passed' | 'failed' | 'skipped'; required: boolean; detail?: string | undefined }
export interface ConformanceReport { pluginId: string; proof: 'registered-handler-source'; source: { entry: string; revision: string }; passed: boolean; checks: ConformanceCheck[] }
export type ParticipantCleanup = void | (() => void | Promise<void>) | { dispose(): void | Promise<void> };
export interface ParticipantSource<P> {
  pluginId: string; source: { entry: string; revision: string };
  /** The production factory, with source/storage policy ports injected by its owner. */
  participantFactory(bb: FakePluginHost['bb'], sourcePorts: P): ParticipantCleanup | Promise<ParticipantCleanup>;
  sourcePorts: P;
}
export interface ConformanceCase<I, O> {
  name: string; input: I;
  expected?: O | undefined;
  /** Assert source semantics, including actual source receipts where applicable. */
  verify?: ((output: O) => void | Promise<void>) | undefined;
}
export interface SupplierConformanceOptions<P> extends ParticipantSource<P> {
  recognizeCases?: readonly ConformanceCase<RecognizeInput, RecognizeOutput>[] | undefined;
  resolveCases: readonly ConformanceCase<ResolveInput, ResolveOutput>[];
  feedCases?: readonly ConformanceCase<FeedInput, FeedOutput>[] | undefined;
  /** Monotone source-access counter for the real injected ports on these cases.
   * A fixture observation does not prove global JavaScript purity.
   */
  observeSourceAccess?: (() => number) | undefined;
}
export interface ConsumerConformanceOptions<P> extends ParticipantSource<P> {
  invalidateCases: readonly ConformanceCase<InvalidateInput, InvalidateOutput>[];
}
export function assertConformance(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function same(a: unknown, b: unknown) { assertConformance(canonicalJson(a) === canonicalJson(b), 'Canonical source expectation differs.'); }
export async function withConformanceDeadline<T>(run: () => T | Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve().then(run), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Conformance scenario deadline exceeded.')), ms); })]); }
  finally { clearTimeout(timer); }
}
/** Exact target routing around actual registered SDK methods. Fake-host boundary
 * errors expose `code`; translate only documented native boundary codes to the
 * HTTP status/body shape used by production plugins.callRpc. No message parsing.
 */
export interface RegisteredHandlerHost {
  harness: { behavior: { callRpc(method: string, input: unknown): Promise<unknown> } };
}
export function createRegisteredHandlerRpc(host: RegisteredHandlerHost, pluginId: string, onCall?: (call: { pluginId: string; method: string }) => void): RpcPort {
  return { async callRpc(args) {
    assertConformance(args.pluginId === pluginId, 'RPC selected another owner.');
    if (args.signal?.aborted) throw new DOMException('RPC aborted', 'AbortError');
    onCall?.({ pluginId: args.pluginId, method: args.method });
    let result: unknown;
    try { result = await host.harness.behavior.callRpc(args.method, args.input ?? null); }
    catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (typeof code !== 'string' || !['invalid_input', 'invalid_output', 'invalid_json', 'non_json_result', 'unauthenticated', 'unavailable', 'handler_error', 'unknown_method'].includes(code)) throw error;
      const status = code === 'invalid_input' ? 400 : code === 'unauthenticated' ? 401 : code === 'unavailable' ? 503 : code === 'unknown_method' ? 404 : 500;
      throw { status, body: { ok: false, error: { code } } };
    }
    if (args.signal?.aborted) throw new DOMException('RPC aborted', 'AbortError');
    return args.outputSchema.parse(result);
  } };
}
function recording(pluginId: string, source: ConformanceReport['source']) {
  const checks: ConformanceCheck[] = [];
  const check = async (name: string, run: () => unknown | Promise<unknown>, required = true) => {
    try { await withConformanceDeadline(run); checks.push({ name, state: 'passed', required }); }
    catch (error) { checks.push({ name, state: 'failed', required, detail: (error instanceof Error ? error.message : String(error)).slice(0, 512) }); }
  };
  const skip = (name: string, detail: string, required: boolean) => checks.push({ name, state: 'skipped', detail, required });
  return { checks, check, skip, report: (): ConformanceReport => ({ pluginId, source, proof: 'registered-handler-source', passed: checks.length > 0 && checks.every(item => item.state !== 'failed' && (!item.required || item.state === 'passed')), checks }) };
}
async function cleanup(value: ParticipantCleanup): Promise<void> { if (typeof value === 'function') await value(); else if (value) await value.dispose(); }
async function policyCase<I, O>(value: ConformanceCase<I, O>, invoke: (input: I) => Promise<O>): Promise<O> {
  assertConformance(value.expected !== undefined || value.verify, 'A source policy case needs an expected observable.');
  const output = await invoke(structuredClone(value.input));
  canonicalByteLength(output, LIMITS.responseBytes);
  if (value.expected !== undefined) same(output, value.expected);
  await value.verify?.(output);
  return output;
}

export async function runSupplierConformance<P>(options: SupplierConformanceOptions<P>): Promise<ConformanceReport> {
  const record = recording(options.pluginId, options.source);
  const host = createFakePluginHost({ pluginId: options.pluginId });
  const rpc = createRegisteredHandlerRpc(host, options.pluginId);
  let owned: ParticipantCleanup = undefined;
  try {
    await record.check('production-factory-registration', async () => { owned = await options.participantFactory(host.bb, options.sourcePorts); });
    if (record.checks.some(check => check.state === 'failed')) return record.report();
    let capabilities: CapabilitiesV1 | undefined;
    await record.check('describe-negotiation', async () => {
      const result = await createResultsSupplierClient({ plugins: rpc }, options.pluginId).describe();
      assertConformance(result.state === 'ready' && result.capabilities.supplier, 'Factory did not advertise a v1 supplier.');
      capabilities = result.capabilities;
    });
    if (!capabilities?.supplier) return record.report();
    const supplier = capabilities.supplier;
    const client = createResultsSupplierClient({ plugins: rpc }, options.pluginId, { descriptors: supplier.kinds });
    await record.check('describe-tolerates-unknown-input', async () => {
      same(await host.harness.behavior.callRpc(METHODS.describe, null), await host.harness.behavior.callRpc(METHODS.describe, { future: true }));
    });
    if (supplier.recognize) {
      if (!options.recognizeCases?.length) record.skip('recognition-policy-witness', 'No real source recognition cases supplied.', true);
      if (!options.observeSourceAccess) record.skip('recognition-source-access-observation', 'No source-access observer supplied; purity is unobserved.', true);
      for (const value of options.recognizeCases ?? []) await record.check(`recognize:${value.name}`, async () => {
        const before = options.observeSourceAccess?.();
        const first = await policyCase(value, input => client.recognize(input));
        const second = await client.recognize(structuredClone(value.input));
        same(first, second);
        if (before !== undefined) assertConformance(options.observeSourceAccess?.() === before, 'Recognition performed source access on this scenario.');
      });
    } else record.skip('recognition-policy-witness', 'Supplier does not advertise recognition.', false);
    if (!options.resolveCases.length) record.skip('resolution-policy-witness', 'No real source resolution cases supplied.', true);
    for (const value of options.resolveCases) await record.check(`resolve:${value.name}`, () => policyCase(value, input => client.resolve(input)));
    if (supplier.enumerate) {
      if (!options.feedCases?.length) record.skip('feed-policy-witness', 'No source snapshot/change/reset cases supplied.', true);
      for (const value of options.feedCases ?? []) await record.check(`feed:${value.name}`, () => policyCase(value, input => client.enumerate(input)));
    } else record.skip('feed-policy-witness', 'Supplier does not advertise a feed.', false);
    // These malformed calls go through the registered SDK input validator.
    const sample = options.resolveCases[0]?.input;
    if (sample) await record.check('registered-recursive-input-rejection', async () => {
      let rejected = false;
      try { await host.harness.behavior.callRpc(METHODS.resolve, { ...sample, future: true }); }
      catch (error) {
        const e = error as { code?: unknown; name?: unknown; issues?: unknown; body?: { error?: { code?: unknown } } };
        rejected = e.code === 'invalid_input' || e.body?.error?.code === 'invalid_input' || e.name === 'ZodError' && Array.isArray(e.issues) && e.issues.length > 0;
      }
      assertConformance(rejected, 'Malformed input did not yield a validation rejection.');
    });
  } finally { await record.check('factory-disposal', () => cleanup(owned)); await record.check('fake-host-disposal', () => host.harness.lifecycle.dispose()); }
  return record.report();
}

export async function runConsumerConformance<P>(options: ConsumerConformanceOptions<P>): Promise<ConformanceReport> {
  const record = recording(options.pluginId, options.source), host = createFakePluginHost({ pluginId: options.pluginId });
  const rpc = createRegisteredHandlerRpc(host, options.pluginId);
  let owned: ParticipantCleanup = undefined;
  try {
    await record.check('production-factory-registration', async () => { owned = await options.participantFactory(host.bb, options.sourcePorts); });
    if (record.checks.some(check => check.state === 'failed')) return record.report();
    await record.check('consumer-describe-role', async () => {
      const value = await createResultsSupplierClient({ plugins: rpc }, options.pluginId).describe();
      assertConformance(value.state === 'ready' && value.capabilities.consumer, 'Factory did not advertise consumer invalidation.');
    });
    if (!options.invalidateCases.length) record.skip('invalidation-policy-witness', 'No admitted/unadmitted/obsolete source cases supplied.', true);
    const client = createResultsConsumerClient({ plugins: rpc }, options.pluginId);
    for (const value of options.invalidateCases) await record.check(`invalidate:${value.name}`, () => policyCase(value, input => client.invalidate(input)));
  } finally { await record.check('factory-disposal', () => cleanup(owned)); await record.check('fake-host-disposal', () => host.harness.lifecycle.dispose()); }
  return record.report();
}
