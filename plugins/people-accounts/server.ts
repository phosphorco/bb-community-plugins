import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { bindBbIdentity } from '@phosphorco/bb-identity/bb';
import { registerPeopleAccountsV2 } from '@phosphorco/bb-people-accounts/v2/bb';
import { registerLegacyGitHub } from './legacy-github';
import { LinksStore } from './links-store';
import { linksResource } from './links-model';
import type { AccountFetch } from './model';
import type { AtomicStateStorage } from '@phosphorco/bb-identity/state';
import type { LinksRecord } from '@phosphorco/bb-people-accounts/v2';
import type { LinksReaderV2 } from '@phosphorco/bb-people-accounts/v2/bb';

const unavailableReader: LinksReaderV2 = {
  async links(input) { return { version: 2, results: input.personKeys.map(personKey => ({ personKey, status: 'unavailable' as const })) }; },
  async find(input) { return { version: 2, status: 'unavailable', identity: input.identity }; },
};

export default async function peopleAccounts(bb: BbPluginApi, options: { fetcher?: AccountFetch } = {}) {
  const bound = bindBbIdentity(bb);
  await registerLegacyGitHub(bb, bound, options);
  if (!bound.ok) {
    registerPeopleAccountsV2(bb, { links: unavailableReader });
    return;
  }
  let store: AtomicStateStorage<LinksRecord> & { reader: LinksReaderV2 };
  try { store = new LinksStore(bb.storage.database(), bound.value.server.instanceId); }
  catch (error) {
    // An unavailable generic store must neither invent empty links nor retire healthy legacy v1 routes.
    const failure = { ok: false as const, error: { code: 'unavailable' as const, message: `Account links storage is unavailable: ${error instanceof Error ? error.message : 'Unknown storage failure'}. Correct storage and reload People Accounts to retry initialization.`, retry: 'after-reconnect' as const } };
    store = { boundary: 'same-process-synchronous', receiptRetentionMs: 30 * 24 * 60 * 60 * 1000,
      read: async () => failure, commit: async () => failure, reconcile: async () => failure, reader: unavailableReader };
  }
  const registered = bound.value.state.register({ resource: linksResource, storage: store,
    policy: { kind: 'collaborators' }, readPolicy: { kind: 'collaborators' } });
  if (!registered.ok) throw new Error(registered.error.message);
  registerPeopleAccountsV2(bb, { links: store.reader });
}
