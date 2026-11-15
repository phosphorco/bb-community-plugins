import { afterAll, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { registerPeopleAccountsV2 } from '@phosphorco/bb-people-accounts/v2/bb';
import { createFakePluginHost, createFakeSdk } from '@get-bb/plugin-sdk/testing';
import { z } from 'zod';
import { pluginIdV2Schema } from '@phosphorco/bb-people-accounts/v2';
import { boundFixture, until } from './native-fixture';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://people.test/', pretendToBeVisual: true });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Event', 'MouseEvent', 'Node', 'MutationObserver'] as const) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : name === 'document' ? dom.window.document : dom.window[name] });
}
previous.set('IS_REACT_ACT_ENVIRONMENT', Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
const { act } = await import('react'); const { fireEvent } = await import('@testing-library/react');
const { loadPluginApp, renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const app = await loadPluginApp(() => import('../app.tsx'));
afterAll(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test('actual links settings uses native state with zero suppliers, retains unavailable links and never grants authority', async () => {
  const f = await boundFixture();
  const calls: string[] = [];
  const rpc = Object.fromEntries(f.host.harness.inspection.registrations.rpcMethods.map(method => [method, async (input: unknown) => { calls.push(method); return f.host.harness.behavior.callRpc(method, input); }]));
  const slot = renderSlot(app.settingsSections[1]!, {}, { pluginId: 'people-accounts', rpc, realtimeConnectionState: 'connected', sdk: { plugins: { list: async () => ({ plugins: [] }) } } });
  try {
    await slot.findByText('No account links for this person.');
    await act(async () => { fireEvent.change(slot.getByLabelText('Supplier ID'), { target: { value: 'source' } }); fireEvent.change(slot.getByLabelText('Account subject'), { target: { value: 'workspace/opaque:user' } }); slot.getByRole('button', { name: 'Add known link' }).click(); });
    await slot.findByText('workspace/opaque:user');
    await act(async () => { await until(() => (f.host.bb.storage.database().prepare('SELECT COUNT(*) AS count FROM people_links_index').get() as { count: number }).count === 1); });
    expect(slot.container.textContent).toContain('Supplier unavailable or not discovered. This link is retained.');
    expect(calls.some(method => method.startsWith('peopleAccountsV1'))).toBe(false);
    const alice = f.host.people.get('alice')!.identity.key;
    const linked = await f.v2.links({ personKeys: [alice] }); expect(linked.results[0]).toMatchObject({ status: 'found', links: [{ identity: { pluginId: 'source', subject: 'workspace/opaque:user' } }] });
    expect(JSON.stringify(linked)).not.toContain('allowEmail');
    await act(async () => slot.getByRole('button', { name: 'Remove link source/workspace/opaque:user' }).click());
    await act(async () => { await until(() => (f.host.bb.storage.database().prepare('SELECT COUNT(*) AS count FROM people_links_index').get() as { count: number }).count === 0); });
  } finally { slot.lifecycle.unmount(); await f.close(); }
});

test('listed suppliers remain separate by namespace; explicit search preserves partial results and failures', async () => {
  const f = await boundFixture(); const source = createFakePluginHost({ pluginId: 'source' }); let fail = false; let requests = 0; let held = false; let release = () => {};
  registerPeopleAccountsV2(source.bb, { identities: {
    async list(input) { requests++; if (fail) throw new Error('Controlled source outage'); if (input.query === 'held') { held = true; await new Promise<void>(r => { release = r; }); } return { version: 2, status: 'page', query: input.query, revision: 'directory-1', items: (input.query === 'held' ? ['stale'] : ['one', 'two']).map(subject => ({ identity: { pluginId: pluginIdV2Schema.parse('source'), subject }, presentation: { displayName: 'Same Name', handle: null } })), nextCursor: null, coverage: 'partial' }; },
    async get(input) { return { version: 2, results: input.subjects.map(subject => ({ subject, status: 'missing' })) }; },
  } });
  const rpc = Object.fromEntries(f.host.harness.inspection.registrations.rpcMethods.map(method => [method, (input: unknown) => f.host.harness.behavior.callRpc(method, input)]));
  const supplierSdk = createFakeSdk({ pluginId: 'people-accounts' });
  supplierSdk.harness.stub('plugins.list', async () => ({ plugins: [{ id: 'source', status: 'running' }, { id: 'broken', status: 'running' }] }));
  supplierSdk.harness.stub('plugins.callRpc', async raw => { const input = z.object({ pluginId: z.string(), method: z.string(), input: z.unknown() }).parse(raw); if (input.pluginId !== 'source') throw new Error('Absent supplier'); return source.harness.behavior.callRpc(input.method, input.input); });
  const slot = renderSlot(app.settingsSections[1]!, {}, { pluginId: 'people-accounts', rpc, realtimeConnectionState: 'connected', sdk: { plugins: { list: supplierSdk.sdk.plugins.list, callRpc: supplierSdk.sdk.plugins.callRpc } } });
  try {
    await slot.findByRole('option', { name: 'source' }); expect(requests).toBe(0);
    await act(async () => fireEvent.change(slot.getByLabelText('Account supplier'), { target: { value: 'source' } }));
    await act(async () => slot.getByRole('button', { name: 'Search accounts' }).click());
    await slot.findByRole('button', { name: 'Link source/one' }); expect(slot.getAllByText('Same Name').length).toBeGreaterThanOrEqual(2);
    expect(slot.container.textContent).toContain('partial coverage'); expect(slot.container.textContent).toContain('broken: unavailable');
    fail = true; await act(async () => slot.getByRole('button', { name: 'Search accounts' }).click()); await slot.findByText('Could not read this supplier. Stored links remain unchanged.');
    fail = false; await act(async () => slot.getByRole('button', { name: 'Search accounts' }).click()); await slot.findByRole('button', { name: 'Link source/two' }); expect(slot.queryByText('Could not read this supplier. Stored links remain unchanged.')).toBeNull();
    await act(async () => { fireEvent.change(slot.getByLabelText('Find an account'), { target: { value: 'held' } }); });
    await act(async () => slot.getByRole('button', { name: 'Search accounts' }).click()); await until(() => held);
    await act(async () => { fireEvent.change(slot.getByLabelText('Find an account'), { target: { value: 'fresh' } }); });
    await act(async () => slot.getByRole('button', { name: 'Search accounts' }).click()); await slot.findByRole('button', { name: 'Link source/one' });
    await act(async () => { release(); await new Promise(r => setTimeout(r, 5)); });
    expect(slot.queryByRole('button', { name: 'Link source/stale' })).toBeNull();
  } finally { release(); slot.lifecycle.unmount(); await f.close(); await source.harness.lifecycle.dispose(); }
});
