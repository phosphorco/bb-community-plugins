import type { IdentityKey } from '@phosphorco/bb-identity/model';
import { locatorKey, type ExternalLocator } from './v2.js';
import { createPeopleAccountsV2Client, type PeopleAccountsV2Sdk } from './v2-bb.js';

/** An adopter supplies its own real registered SDK handlers and fixture identities. */
export async function runPeopleAccountsV2Conformance(options: {
  sdk: PeopleAccountsV2Sdk;
  pluginId: string;
  subjects?: readonly string[];
  personKeys?: readonly IdentityKey[];
  reverse?: ExternalLocator;
}) {
  const client = createPeopleAccountsV2Client(options.sdk, options.pluginId);
  const described = await client.describe();
  if (described.status !== 'ready') throw new Error('v2 conformance: negotiation failed');
  const checks = ['negotiation'];
  if (described.capabilities.identities) {
    const listed = await client.list({ query: '', limit: 50 });
    if (listed.status !== 'page') throw new Error('v2 conformance: listing failed');
    const subjects = options.subjects ?? listed.items.map(i => i.identity.subject);
    if (!subjects.length) throw new Error('v2 conformance: seed at least one identity');
    const results = await client.get({ subjects: [...subjects] });
    if (results.results.some(r => r.status !== 'found')) throw new Error('v2 conformance: seeded identity missing');
    checks.push('public-identities', 'ordered-keyed-lookup');
  }
  if (described.capabilities.links) {
    if (!options.personKeys?.length || !options.reverse) throw new Error('v2 conformance: link owner needs both fixture directions');
    const result = await client.links({ personKeys: [...options.personKeys] });
    if (result.results.some(r => r.status !== 'found')) throw new Error('v2 conformance: seeded links missing');
    const reverse = await client.find({ identity: options.reverse, limit: 50 });
    if (reverse.status !== 'page') throw new Error('v2 conformance: reverse lookup failed');
    for (const row of result.results) {
      if (row.status === 'found' && reverse.nextCursor === null && reverse.coverage === 'complete'
        && row.links.some(link => locatorKey(link.identity) === locatorKey(options.reverse!)
          && !reverse.links.some(found => found.personKey === row.personKey && found.id === link.id))) throw new Error('v2 conformance: reverse lookup lost an association');
    }
    checks.push('forward-links', 'reverse-links');
  }
  return { level: 'source-conformance' as const, pluginId: options.pluginId, checks };
}
