import { describe, expect, test } from 'bun:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { runPeopleAccountsConformance, rosterEntryFixture } from '@phosphorco/bb-people-accounts/testing';
import { createPeopleAccountsClient } from '@phosphorco/bb-people-accounts/bb';
import { sdkFromFakeHost } from '@phosphorco/bb-people-accounts/testing';
import { RPC_METHODS, type RosterEntryV1 } from '@phosphorco/bb-people-accounts';
import factory from '../server';
import { tokenSlot, parseRoster, tokenConfiguration } from '../model';

const ada = rosterEntryFixture();
const grace = rosterEntryFixture({ personKey: 'opaque:grace', displayName: 'Grace', aliases: { emails: [], nicknames: ['shared'], handles: [] }, githubLogin: 'grace-human', botLogin: 'grace-bot', committer: { name: 'Grace', email: 'grace@example.test' } });
const lin = rosterEntryFixture({ personKey: 'opaque:lin', displayName: 'Lin', aliases: { emails: [], nicknames: ['shared'], handles: [] }, githubLogin: 'lin-human', botLogin: 'lin-bot', committer: null });
const token = 'dummy-conformance-token-never-real';
async function seeded(entries: RosterEntryV1[] = [ada, grace, lin]) {
  const host = createFakePluginHost({ pluginId: 'people-accounts', settings: { roster: JSON.stringify(entries), [tokenSlot(ada.personKey)]: token } });
  await factory(host.bb);
  return host;
}

describe('actual people-accounts factory', () => {
  test('shared bot preserves humans and uses the first configured token in roster order', async () => {
    const sharedGrace = { ...grace, botLogin: ada.botLogin!.toUpperCase() };
    const host = await seeded([ada, sharedGrace]);
    try {
      const client = createPeopleAccountsClient(sdkFromFakeHost(host));
      await host.harness.behavior.setSettings({ [tokenSlot(ada.personKey)]: null, [tokenSlot(grace.personKey)]: 'second-dummy-token' });
      const result = await client.resolve({ inputs: ['ada', 'Grace'] });
      expect(result.results.map(r => r.status)).toEqual(['resolved', 'resolved']);
      expect(result.attribution.assignees).toEqual(['ada-human', 'grace-human']);
      const status = await host.harness.behavior.callRpc('peopleAccountsStatus', null) as { entries: { ownToken: { state: string }; effectiveTokenSupplier: { personKey: string } | null }[] };
      expect(status.entries[0]?.ownToken.state).toBe('missing');
      expect(status.entries[0]?.effectiveTokenSupplier?.personKey).toBe(grace.personKey);
      expect(status.entries[1]?.ownToken.state).toBe('configured');
      expect(result.attribution.coAuthors.map(p => p.email)).toEqual([ada.committer!.email, grace.committer!.email]);
      expect(result.attribution.primary?.person.personKey).toBe(ada.personKey);
      expect(await client.credential(ada.botLogin!)).toMatchObject({ status: 'available', token: 'second-dummy-token' });
      await host.harness.behavior.setSettings({ [tokenSlot(ada.personKey)]: token });
      expect(await client.credential(ada.botLogin!)).toMatchObject({ status: 'available', token });
      const ambiguous = await client.resolve({ inputs: [ada.botLogin!] });
      expect(ambiguous.results[0]?.status).toBe('ambiguous');
    } finally { await host.harness.lifecycle.dispose(); }
  });

  test('maximum-length opaque key still defines a bounded native secret filename', async () => {
    const longKey = 'p'.repeat(512);
    const host = await seeded([{ ...ada, personKey: longKey }]);
    try {
      const slot = tokenSlot(longKey);
      expect(Buffer.byteLength(slot)).toBe(75);
      expect(Object.keys(host.harness.inspection.registrations.settingsDescriptors)).toContain(slot);
    } finally { await host.harness.lifecycle.dispose(); }
  });

  test('factory does not access bind-gated SDK while defining dynamic secrets', async () => {
    const host = createFakePluginHost({ pluginId: 'people-accounts', settings: { roster: JSON.stringify([ada]) } });
    const api = new Proxy(host.bb, { get(target, key, receiver) {
      if (key === 'sdk') throw new Error('SDK not bound during factory');
      return Reflect.get(target, key, receiver);
    } });
    try {
      await factory(api);
      expect(await host.harness.behavior.callRpc('peopleAccountsStatus', null)).toMatchObject({ entries: [expect.objectContaining({ personKey: ada.personKey })] });
    } finally { await host.harness.lifecycle.dispose(); }
  });

  test('cross-field alias collision stays ambiguous and emits no trailer for that name', async () => {
    const host = await seeded([ada, { ...grace, aliases: { emails: [], nicknames: [ada.githubLogin!], handles: [] } }]);
    try {
      const result = await createPeopleAccountsClient(sdkFromFakeHost(host)).resolve({ inputs: [ada.githubLogin!] });
      expect(result.results[0]?.status).toBe('ambiguous');
      expect(result.attribution.primary).toBeNull();
      expect(result.attribution.coAuthors).toEqual([]);
    } finally { await host.harness.lifecycle.dispose(); }
  });

  test('published conformance kit drives real registered handlers', async () => {
    const host = await seeded();
    try {
      const result = await runPeopleAccountsConformance({ host, entry: ada, token, botLoginWithoutToken: grace.botLogin!, ambiguous: { input: 'shared', personKeys: [grace.personKey, lin.personKey] } });
      expect(result.level).toBe('source-conformance');
      expect(result.checks).toContain('ambiguous-never-picks');
    } finally { await host.harness.lifecycle.dispose(); }
  });

  test('ordered mixed inputs keep all resolved humans, skip ambiguity, and do no SDK I/O', async () => {
    const host = await seeded();
    try {
      const client = createPeopleAccountsClient(sdkFromFakeHost(host));
      const result = await client.resolve({ inputs: ['unknown', 'shared', 'Grace', ada.personKey, 'Grace'], participants: ['Seen Person'] });
      expect(result.results.map(r => r.status)).toEqual(['not-found', 'ambiguous', 'resolved', 'resolved', 'resolved']);
      expect(result.attribution.primary?.person.personKey).toBe(grace.personKey);
      expect(result.attribution.primary?.person.personKey).toBe(grace.personKey); // human summary ignores token policy
      expect(result.attribution.assignees).toEqual(['grace-human', 'ada-human']);
      expect(result.attribution.coAuthors.map(p => p.email)).toEqual(['grace@example.test', ada.committer!.email]);
      expect(result.attribution.fallbackReason).toContain('Seen Person');
      expect(host.harness.inspection.sdk.calls).toHaveLength(0);
      const directory = await host.harness.behavior.callRpc('peopleAccountsDirectory', { query: 'ada' });
      expect(directory).toMatchObject({ items: [] });
      expect((await client.resolve({ inputs: ['ada'] })).attribution.primary?.person.personKey).toBe(ada.personKey);
    } finally { await host.harness.lifecycle.dispose(); }
  });

  test('malformed and partly invalid roster never prevent loading or default behavior', async () => {
    for (const raw of ['not-json', '{}', JSON.stringify([ada, { personKey: 'bad', token: token }])]) {
      const host = createFakePluginHost({ pluginId: 'people-accounts', settings: { roster: raw } });
      try {
        await factory(host.bb);
        const status = await host.harness.behavior.callRpc('peopleAccountsStatus', null) as { diagnostics: string[] };
        expect(status.diagnostics.length).toBeGreaterThan(0);
        expect(JSON.stringify(status)).not.toContain(token);
        const result = await createPeopleAccountsClient(sdkFromFakeHost(host)).resolve({ inputs: ['unknown'] });
        expect(result.attribution.primary).toBeNull();
        expect(result.attribution.fallbackReason).toBeTruthy();
      } finally { await host.harness.lifecycle.dispose(); }
    }
  });

  test('missing roster loads, duplicate person keys cannot silently pick, and secret-free status diagnoses', async () => {
    for (const entries of [[], [ada, { ...grace, personKey: ada.personKey }]]) {
      const host = await seeded(entries);
      try {
        const status = await host.harness.behavior.callRpc('peopleAccountsStatus', null) as { entries: unknown[]; diagnostics: string[] };
        expect(status.entries).toEqual([]);
        expect(status.diagnostics.length).toBeGreaterThan(0);
      } finally { await host.harness.lifecycle.dispose(); }
    }
  });

  test('schema follows explicit reload; removal/re-add restores secret and null clears it', async () => {
    let host = await seeded([ada]);
    try {
      const keys = () => Object.keys(host.harness.inspection.registrations.settingsDescriptors);
      await host.harness.behavior.setSettings({ roster: JSON.stringify([ada, grace]) });
      expect(keys()).not.toContain(tokenSlot(grace.personKey));
      expect(await host.harness.behavior.callRpc('peopleAccountsStatus', null)).toMatchObject({ reloadRequired: true, entries: [expect.objectContaining({ personKey: ada.personKey })] });
      host = await host.harness.lifecycle.reload(factory);
      expect(keys()).toContain(tokenSlot(grace.personKey));
      await host.harness.behavior.setSettings({ roster: '[]' });
      host = await host.harness.lifecycle.reload(factory);
      expect(keys()).not.toContain(tokenSlot(ada.personKey));
      await host.harness.behavior.setSettings({ roster: JSON.stringify([{ ...ada, displayName: 'Renamed' }]) });
      host = await host.harness.lifecycle.reload(factory);
      const client = createPeopleAccountsClient(sdkFromFakeHost(() => host));
      expect(await client.credential(ada.botLogin!)).toMatchObject({ status: 'available', token });
      await host.harness.behavior.setSettings({ [tokenSlot(ada.personKey)]: null });
      expect(await client.credential(ada.botLogin!)).toMatchObject({ status: 'unavailable', reason: 'no-credential' });
      expect((await client.roster()).entries[0]?.credential.state).toBe('missing');
      await host.harness.behavior.setSettings({ roster: 'malformed' });
      host = await host.harness.lifecycle.reload(factory);
      expect((await client.roster()).entries).toEqual([]);
    } finally { await host.harness.lifecycle.dispose(); }
  });

  test('token edits update health but public operations never return secrets', async () => {
    const host = await seeded([ada]);
    try {
      await host.harness.behavior.setSettings({ [tokenSlot(ada.personKey)]: 'replacement-dummy' });
      for (const [method, input] of [[RPC_METHODS.roster, { version: 1 }], [RPC_METHODS.resolve, { version: 1, inputs: ['ada-bot', ada.displayName] }], ['peopleAccountsStatus', null]] as const) {
        const value = await host.harness.behavior.callRpc(method, input);
        expect(JSON.stringify(value)).not.toContain('replacement-dummy');
      }
      expect((await host.harness.behavior.runCli(['status'])).stdout).not.toContain('replacement-dummy');
    } finally { await host.harness.lifecycle.dispose(); }
  });
});


test('exact opaque keys win over another person’s alias and accept the full byte bound', async () => {
  const long = { ...ada, personKey: 'é'.repeat(256) };
  const conflicting = { ...grace, aliases: { emails: [], nicknames: [ada.personKey], handles: [] } };
  const host = await seeded([long, ada, conflicting]);
  try {
    const result = await createPeopleAccountsClient(sdkFromFakeHost(host)).resolve({ inputs: [long.personKey, ada.personKey] });
    expect(result.results[0]).toMatchObject({ status: 'resolved', person: { personKey: long.personKey }, matchedBy: 'person-key' });
    expect(result.results[1]).toMatchObject({ status: 'resolved', person: { personKey: ada.personKey }, matchedBy: 'person-key' });
    await expect(createPeopleAccountsClient(sdkFromFakeHost(host)).resolve({ inputs: ['é'.repeat(257)] })).rejects.toThrow();
  } finally { await host.harness.lifecycle.dispose(); }
});

test('roster diagnostics name entry and field format without echoing a supplied secret', () => {
  const bad = { ...ada, committer: { name: 'Ada', email: 'dummy-secret-without-email' } };
  const parsed = parseRoster(JSON.stringify([bad]));
  expect(parsed.diagnostics.join(' ')).toContain('Roster entry 1, committer.email');
  expect(parsed.diagnostics.join(' ')).toContain('email address');
  expect(parsed.diagnostics.join(' ')).not.toContain('dummy-secret-without-email');
  expect(tokenConfiguration(undefined).state).toBe('missing');
  expect(tokenConfiguration('not one word').state).toBe('invalid-format');
});

test('unreadable secret slot remains distinct from missing or invalid format', async () => {
  const host = createFakePluginHost({ pluginId: 'people-accounts', settings: { roster: JSON.stringify([ada]) } });
  const settings: typeof host.bb.settings = { define(descriptors) {
    const handle = host.bb.settings.define(descriptors);
    return Object.keys(descriptors).some(key => key.startsWith('github_pat_')) ? new Proxy(handle, { get(target, key, receiver) {
      if (key === 'get') return async () => { throw new Error('dummy-secret-in-error'); };
      return Reflect.get(target, key, receiver);
    } }) : handle;
  } };
  try {
    await factory(new Proxy(host.bb, { get(target, key, receiver) { return key === 'settings' ? settings : Reflect.get(target, key, receiver); } }));
    const status = await host.harness.behavior.callRpc('peopleAccountsStatus', null) as { entries: { ownToken: { state: string } }[] };
    expect(status.entries[0]?.ownToken.state).toBe('unreadable');
    expect(JSON.stringify(status)).not.toContain('dummy-secret-in-error');
  } finally { await host.harness.lifecycle.dispose(); }
});


test('invalid stored tokens diagnose their slot without leaking values or supplying a credential', async () => {
  const invalid = 'dummy invalid token';
  const host = createFakePluginHost({ pluginId: 'people-accounts', settings: { roster: JSON.stringify([ada]), [tokenSlot(ada.personKey)]: invalid } });
  try {
    await factory(host.bb);
    const status = await host.harness.behavior.callRpc('peopleAccountsStatus', null) as { entries: { ownToken: { state: string; message: string | null }; effectiveTokenSupplier: unknown }[] };
    expect(status.entries[0]?.ownToken.state).toBe('invalid-format');
    expect(status.entries[0]?.ownToken.message).toContain('printable ASCII word');
    expect(status.entries[0]?.effectiveTokenSupplier).toBeNull();
    expect(JSON.stringify(status)).not.toContain(invalid);
    expect(await createPeopleAccountsClient(sdkFromFakeHost(host)).credential(ada.botLogin!)).toMatchObject({ status: 'unavailable', reason: 'no-credential' });
  } finally { await host.harness.lifecycle.dispose(); }
});
