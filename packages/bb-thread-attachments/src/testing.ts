/** DOM-free independent consumer over the adopter's actual registered RPCs.
 * This is source conformance, never proof of host loading, network or UI.
 * SDK/testing is runtime-required only for this optional public entry.
 */
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createThreadAttachmentsClient, type ThreadAttachmentsClient } from './bb.js';
import { METHODS, LIMITS } from './index.js';

export interface AttachmentsConformanceCase {
 readonly name: string;
 /** Use the public client against real authority handlers and feature-owned fixtures.
  * Throw on any failed expectation. Cases run in order, sharing authority state.
  * Required adopter witnesses include durable reload, manual suppression, CAS,
  * flattened family, incomplete coverage, family-wide attach, and assessment
  * priority/deduplication without fact overwrites.
  */
 run(client: ThreadAttachmentsClient): void | Promise<void>;
}
export interface AttachmentsConformanceOptions {
 readonly pluginId: string;
 register(bb: ReturnType<typeof createFakePluginHost>['bb']): void | Promise<void>;
 readonly cases: readonly AttachmentsConformanceCase[];
}
export interface AttachmentsConformanceReport {
 readonly pluginId: string;
 readonly proof: 'source-conformance';
 readonly passed: boolean;
 readonly checks: readonly { name: string; state: 'passed' | 'failed' | 'skipped'; detail?: string }[];
}
export async function runThreadAttachmentsSupplierConformance(options: AttachmentsConformanceOptions): Promise<AttachmentsConformanceReport> {
 const checks: { name: string; state: 'passed' | 'failed' | 'skipped'; detail?: string }[] = [];
 const check = async (name: string, run: () => void | Promise<void>) => {
  try { await run(); checks.push({ name, state: 'passed' }); }
  catch (error) { checks.push({ name, state: 'failed', detail: error instanceof Error ? error.message : String(error) }); }
 };
 const host = createFakePluginHost({ pluginId: options.pluginId });
 const sdk = { plugins: { async callRpc(args: { pluginId: string; method: string; input?: unknown; signal?: AbortSignal }) {
  if (args.pluginId !== options.pluginId) throw new Error('Independent consumer targeted a different plugin');
  return host.harness.behavior.callRpc(args.method, args.input ?? null, { experimental_caller: { kind: 'plugin', pluginId: 'attachments-independent-consumer' } });
 } } } as Parameters<typeof createThreadAttachmentsClient>[0];
 const client = createThreadAttachmentsClient(sdk, options.pluginId);
 await check('registration', () => options.register(host.bb));
 const report = (): AttachmentsConformanceReport => ({ pluginId: options.pluginId, proof: 'source-conformance', passed: checks.every(c => c.state === 'passed'), checks });
 if (checks.some(c => c.state === 'failed')) return report();
 await check('describe-negotiation', async () => { if (!(await client.describe())) throw new Error('Authority does not support v1'); });
 const reject = async (method: string, input: unknown) => {
  try { await host.harness.behavior.callRpc(method, input); }
  catch { return; }
  throw new Error(`Authority accepted invalid input for ${method}`);
 };
 await check('strict-input-and-bounds', async () => {
  const threadId = 'thr_23456789ab', leadId = 'thr_zyxwvutsrq';
  await reject(METHODS.read, { version: 1, threadIds: [threadId], extra: true });
  await reject(METHODS.read, { version: 1, threadIds: [] });
  await reject(METHODS.read, { version: 1, threadIds: Array(LIMITS.readIds + 1).fill(threadId) });
  await reject(METHODS.read, { version: 1, threadIds: [threadId, threadId] });
  await reject(METHODS.read, { version: 1, threadIds: ['thr_0123456789'] });
  await reject(METHODS.assess, { version: 1, threadIds: [], });
  await reject(METHODS.assess, { version: 1, threadIds: [threadId, threadId] });
  await reject(METHODS.assess, { version: 1, threadIds: Array(LIMITS.assessIds + 1).fill(threadId) });
  await reject(METHODS.assess, { version: 1, threadIds: ['thr_0123456789'] });
  await reject(METHODS.assess, { version: 1, threadIds: [threadId], actor: 'forged' });
  await reject(METHODS.assess, { version: 2, threadIds: [threadId] });
  await reject(METHODS.observe, { version: 1, threadId, actor: 'forged' });
  await reject(METHODS.observe, { version: 2, threadId });
  await reject(METHODS.observe, { version: 1, threadId: 'thr_0123456789' });
  await reject(METHODS.family, { version: 2, threadId });
  await reject(METHODS.family, { version: 1, threadId, actor: 'forged' });
  await reject(METHODS.attach, { version: 1, threadId, leadId, operationId: 'op-1', expectedRevision: 'r1', actor: 'forged' });
  await reject(METHODS.attach, { version: 1, threadId, leadId: threadId, operationId: 'op-1', expectedRevision: 'r1' });
  await reject(METHODS.detach, { version: 1, threadId, operationId: 'op-1', expectedRevision: 'r1', extra: true });
 });
 await check('assessment-queue-acknowledgement', async () => {
  await client.assess({ version: 1, threadIds: ['thr_23456789ab', 'thr_zyxwvutsrq'] });
 });
 await check('bounded-observation-snapshot', async () => {
  await client.observe({ version: 1, threadId: 'thr_23456789ab' });
 });
 if (!options.cases.length) checks.push({ name: 'independent-consumer-witness', state: 'skipped', detail: 'No authority-owned behavioral fixtures supplied' });
 for (const c of options.cases) await check(`case:${c.name}`, () => c.run(client));
 return report();
}
