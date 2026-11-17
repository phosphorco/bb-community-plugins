import { createLinksResource, externalLocatorSchema, personKeyV2Schema, type LinksRecord } from '../dist/types/v2.js';
import { createPeopleAccountsV2Client, registerPeopleAccountsV2 } from '../dist/types/v2-bb.js';
import type { StateResource } from '@phosphorco/bb-identity/state';
import type { BbPluginApi } from '@get-bb/plugin-sdk';

const resource: StateResource<LinksRecord> = createLinksResource('people-accounts');
const identity = externalLocatorSchema.parse({ pluginId: 'supplier', subject: 'workspace/user' });
function compile(bb: BbPluginApi) {
  const client = createPeopleAccountsV2Client(bb.sdk, 'people-accounts');
  void client.links({ personKeys: [personKeyV2Schema.parse('opaque-key')] });
  void client.find({ identity, limit: 10 });
  // @ts-expect-error Display names are not branded person references.
  void client.links({ personKeys: ['Example Name'] });
  // @ts-expect-error No credentials are exposed by this API.
  void client.credential('account');
  registerPeopleAccountsV2(bb, { identities: {
    async list(i) { return { version: 2, status: 'page', query: i.query, revision: 'r', items: [], nextCursor: null, coverage: 'complete' }; },
    async get(i) { return { version: 2, results: i.subjects.map(subject => ({ subject, status: 'missing' })) }; },
  } });
  return resource;
}
void compile;
