/**
 * @phosphorco/bb-thread-membership/testing — supplier conformance (DOM-free).
 * Drives the supplier's REAL registered handlers through the SDK fake plugin
 * host. Source conformance only: it says nothing about host discovery,
 * loading, network or what a live source currently contains.
 */
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createThreadMembershipClient, MembershipCallError } from './bb.js';
import { LIMITS, METHODS, canonicalJson, type JsonValue, type PageOutputV1 } from './index.js';

export interface MembershipConformanceCase {
  readonly name: string;
  readonly scope: JsonValue;
  /** Expected outcome. `members` lists every expected thread id across all pages, in any order. */
  readonly expect:
    | { readonly state: 'ready'; readonly members?: readonly string[]; readonly coverage?: 'complete' | 'partial' | 'unknown' }
    | { readonly state: 'stale-scope' | 'not-found' | 'unavailable' | 'unsupported' };
  /** Page size used to force multi-page reads; default 2. */
  readonly pageSize?: number;
}

export interface MembershipConformanceOptions {
  readonly pluginId: string;
  /** The plugin's real registration, given the fake host's `bb`. */
  register(bb: ReturnType<typeof createFakePluginHost>['bb']): void | Promise<void>;
  readonly cases: readonly MembershipConformanceCase[];
}

export interface MembershipConformanceReport {
  readonly pluginId: string;
  readonly proof: 'source-conformance';
  readonly passed: boolean;
  readonly checks: readonly { name: string; state: 'passed' | 'failed' | 'skipped'; detail?: string }[];
}

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runThreadMembershipSupplierConformance(options: MembershipConformanceOptions): Promise<MembershipConformanceReport> {
  const checks: { name: string; state: 'passed' | 'failed' | 'skipped'; detail?: string }[] = [];
  const check = async (name: string, run: () => Promise<void> | void) => {
    try { await run(); checks.push({ name, state: 'passed' }); }
    catch (error) { checks.push({ name, state: 'failed', detail: error instanceof Error ? error.message : String(error) }); }
  };
  const report = (): MembershipConformanceReport => ({ pluginId: options.pluginId, proof: 'source-conformance', passed: checks.every((c) => c.state !== 'failed'), checks });
  const host = createFakePluginHost({ pluginId: options.pluginId });
  const sdk = { plugins: {
    async callRpc(args: { pluginId: string; method: string; input?: unknown; outputSchema: { '~standard': { validate(value: unknown): unknown } }; signal?: AbortSignal }) {
      require(args.pluginId === options.pluginId, 'Client targeted another plugin');
      const value = await host.harness.behavior.callRpc(args.method, args.input ?? null, { experimental_caller: { kind: 'plugin', pluginId: 'conformance-consumer' } });
      const result = await args.outputSchema['~standard'].validate(value) as { value?: unknown; issues?: unknown };
      require(!result.issues, 'SDK output schema rejected result');
      return result.value;
    },
  } } as unknown as Parameters<typeof createThreadMembershipClient>[0];
  const client = createThreadMembershipClient(sdk, options.pluginId);

  await check('registration', () => options.register(host.bb));
  if (checks.some((c) => c.state === 'failed')) return report();
  await check('describe-negotiation', async () => require((await client.describe())?.version === 1, 'Describe did not negotiate v1'));
  const rejects = async (input: unknown, why: string) => {
    try { await host.harness.behavior.callRpc(METHODS.page, input); } catch { return; }
    throw new Error(`Page accepted ${why}`);
  };
  await check('strict-input', async () => {
    await rejects({ scope: null, cursor: null, limit: 1, extra: true }, 'an unknown field');
    await rejects({ scope: null, cursor: null, limit: 0 }, 'limit 0');
    await rejects({ scope: null, cursor: null, limit: LIMITS.pageMembers + 1 }, 'an oversized limit');
    await rejects({ scope: { big: 'x'.repeat(LIMITS.scopeBytes) }, cursor: null, limit: 1 }, 'an oversized scope');
  });
  if (options.cases.length === 0) checks.push({ name: 'cases', state: 'skipped', detail: 'No supplier-owned membership witnesses supplied' });
  for (const c of options.cases) {
    await check(`case:${c.name}`, async () => {
      const seen = new Set<string>();
      let revision: string | null = null, cursor: string | null = null, last: PageOutputV1 | null = null;
      for (let pages = 0; ; pages += 1) {
        require(pages < 1000, 'Paging did not terminate');
        let page: PageOutputV1;
        try {
          page = await client.page({ scope: c.scope, cursor, limit: c.pageSize ?? 2, expectRevision: revision });
        } catch (error) {
          throw new Error(`Page failed: ${error instanceof MembershipCallError ? error.kind : String(error)}`);
        }
        last = page;
        if (page.state !== 'ready') break;
        require(revision === null || page.revision === revision, 'Revision changed across pages of a stable source');
        revision = page.revision;
        for (const m of page.members) {
          require(!seen.has(m.threadId), `Member ${m.threadId} repeated across pages`);
          seen.add(m.threadId);
        }
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      require(last !== null, 'No page');
      require(last.state === c.expect.state, `Expected ${c.expect.state}, got ${last.state}`);
      if (c.expect.state === 'ready' && last.state === 'ready') {
        if (c.expect.members) require(canonicalJson([...seen].sort()) === canonicalJson([...c.expect.members].sort()), `Members ${canonicalJson([...seen].sort())} differ from expected`);
        if (c.expect.coverage) require(last.coverage.state === c.expect.coverage, `Coverage ${last.coverage.state} differs from expected ${c.expect.coverage}`);
      }
    });
  }
  return report();
}
