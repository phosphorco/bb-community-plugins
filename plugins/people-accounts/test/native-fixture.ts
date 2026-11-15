import { z } from 'zod';
import { createIdentityClient, createIdentityConnection, createIdentityView, bindIdentityState } from '@phosphorco/bb-identity/client';
import { createPeopleAccountsV2Client } from '@phosphorco/bb-people-accounts/v2/bb';
import { multiUserHost } from './host-fixture';
import { linksResource } from '../links-model';
import factory from '../server';
export async function boundFixture() {
  const host = multiUserHost(); const events = new Set<(payload: unknown) => void>();
  const publish = host.bb.realtime.publish.bind(host.bb.realtime);
  host.bb.realtime.publish = (channel, payload) => { publish(channel, payload); if (channel === 'bb-identity/v1') for (const listener of events) listener(payload); };
  await factory(host.bb);
  const connection = createIdentityConnection({
    request: (method, input) => host.harness.behavior.callRpc(method.replace('bb-identity/v1/', 'bb-identity.v1.').replaceAll('/', '.'), input),
    subscribe: listener => { events.add(listener); return () => events.delete(listener); },
    getHealth: () => ({ generation: 0, identity: { status: 'healthy' }, state: { status: 'healthy' } }), subscribeHealth: () => () => {},
    revalidate: async () => ({ ok: true, value: undefined }),
  });
  const client = createIdentityClient({ connection }); const started = await client.start(); if (!started.ok) throw new Error(started.error.message);
  const view = createIdentityView({ client });
  const binding = bindIdentityState({ client, view, resource: linksResource, recordId: 'links', target: 'viewed-subject', editPolicy: 'collaborators', initializeEmpty: false, onConflict: () => ({ kind: 'needs-review', reason: 'Compare links' }) });
  host.harness.inspection.sdk.stub('plugins.callRpc', async raw => { const input = z.object({ pluginId: z.literal('people-accounts'), method: z.string(), input: z.unknown() }).parse(raw); return host.harness.behavior.callRpc(input.method, input.input); });
  const sdk = host.bb.sdk;
  const v2 = createPeopleAccountsV2Client(sdk, 'people-accounts');
  return { host, client, connection, view, binding, v2, sdk, async close() { binding.dispose(); view.dispose(); client.dispose(); connection.dispose(); await host.harness.lifecycle.dispose(); } };
}
export async function until(predicate: () => boolean) { const end = Date.now() + 2000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for native binding'); await new Promise(r => setTimeout(r, 2)); } }
