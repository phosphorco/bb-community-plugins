import { openTestDatabase } from './sqlite-fixture';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createAdapterHarness, personFixture } from '@phosphorco/bb-identity/testing';
import type { Codec, Json } from '@phosphorco/bb-identity/model';

/** The SDK fake's better-sqlite3 ABI is Node-only. Exercise the same SQL/transaction API with Bun SQLite. */
export function createPeopleHost(options: Parameters<typeof createFakePluginHost>[0]): ReturnType<typeof createFakePluginHost> {
  const install = (bb: BbPluginApi) => { const opened = openTestDatabase(); bb.storage.database = () => opened.db as unknown as ReturnType<BbPluginApi['storage']['database']>; bb.onDispose(opened.close); };
  const wrap = (host: ReturnType<typeof createFakePluginHost>) => {
    const reload = host.harness.lifecycle.reload.bind(host.harness.lifecycle);
    host.harness.lifecycle.reload = async factory => { const next = await reload(bb => { install(bb); return factory(bb); }); wrap(next); return next; };
    return host;
  };
  const host = createFakePluginHost(options); install(host.bb); return wrap(host);
}

/** Public enhanced-host protocol over the public identity adapter harness; no account service or credentials. */
export function multiUserHost() {
  const host = createPeopleHost({ pluginId: 'people-accounts' });
  const inputCodec: Codec<Json> = { decode: value => ({ ok: true, value: value as Json }), encode: value => value };
  const adapter = createAdapterHarness({ mode: 'multi-user', instanceId: 'people-instance', inputCodec });
  adapter.setActor(personFixture({ subject: 'alice', name: 'Same Name' }));
  const people = new Map(['alice', 'bob'].map(subject => [subject, personFixture({ subject, name: 'Same Name' })]));
  const scope = () => { const controller = new AbortController(); return { signal: controller.signal, validate: () => controller.signal.aborted ? { ok: false as const, code: 'invalidated' as const } : { ok: true as const }, release: () => controller.abort() }; };
  const session = async (raw: unknown) => {
    const current = await adapter.upstream.session(raw as Parameters<typeof adapter.upstream.session>[0]);
    return current.status === 'ready' ? { ...current, capabilities: { ...current.capabilities, directory: { search: true, lookup: true } } } : current;
  };
  const record = (subject: string) => { const p = people.get(subject); return p ? { issuer: 'fixture', subject, presentation: p.presentation, status: 'current' as const } : null; };
  const protocol: NonNullable<BbPluginApi['experimental_p6rIdentity']> = {
    version: 1, instanceId: 'people-instance',
    bindInvocation({ handler }) { let retired = false; return { registration: { generation: 'fixture', get status() { return retired ? 'retired' as const : 'active' as const; }, dispose() { retired = true; } }, handler: (...args) => { if (retired) throw new Error('Disposed fixture registration'); return handler({ request: adapter.request(), scope: scope() }, ...args); } }; },
    session, selfProfile: async raw => adapter.upstream.selfProfile(raw as Parameters<typeof adapter.upstream.selfProfile>[0]),
    openRequest: async raw => {
      const opened = await adapter.upstream.openScope(raw as Parameters<typeof adapter.upstream.openScope>[0]); if (!opened.ok) return opened;
      const current = await session(raw); if (current.status !== 'ready') throw new Error('Unavailable fixture');
      const child = scope(); const signal = AbortSignal.any([child.signal, opened.value.signal]);
      return { ok: true, value: { ...opened.value, session: current, signal, scope: { signal, validate: () => signal.aborted ? { ok: false, code: 'invalidated' } : { ok: true }, release: child.release } } };
    },
    accept: async () => ({ status: 'rejected', error: { code: 'unsupported', message: 'Not modeled', retry: 'never' } }),
    lookup: async () => ({ ok: true, value: { status: 'unknown', reason: 'unsupported' } }),
    provenance: async () => ({ ok: true, value: { status: 'unknown', correlation: null, reason: 'fixture' } }),
    historyContributions: async () => ({ ok: true, value: { status: 'unavailable', reason: 'unsupported' } }),
    historyAttempts: async () => ({ ok: true, value: { status: 'unavailable', reason: 'unsupported' } }),
    participants: async () => ({ ok: false, error: { code: 'unsupported', message: 'Not modeled', retry: 'never' } }),
    directorySources: () => [{ issuers: ['fixture'], generation: 'fixture',
      async directory(input: { query: string; limit: number }) { return { ok: true, value: { records: [...people.keys()].map(record).filter(p => p && p.presentation.displayName.toLowerCase().includes(input.query.toLowerCase())).slice(0, input.limit), nextCursor: null, revision: 'directory-1' } }; },
      async lookup(subjects: readonly { issuer: string; subject: string }[]) { return { ok: true, value: { records: subjects.map(s => ({ ...s, record: record(s.subject) })), revision: 'directory-1' } }; },
      person(_issuer: string, subject: string) { const p = people.get(subject); return p ? { ok: true, value: p.identity } : { ok: false, error: { code: 'not-found', message: 'No fixture person', retry: 'never' } }; },
    }],
    forwardRpc: async () => { throw new Error('Not modeled'); }, registerProvider: async () => ({ ok: false, error: { code: 'unsupported', message: 'Not modeled', retry: 'never' } }),
    subscribe: listener => adapter.upstream.subscribe(listener),
  };
  Object.defineProperty(host.bb, 'experimental_p6rIdentity', { value: protocol });
  host.bb.onDispose(() => adapter.dispose());
  return { ...host, adapter, people };
}
