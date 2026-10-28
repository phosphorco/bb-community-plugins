import { expect, test } from 'bun:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { rosterEntryFixture } from '@phosphorco/bb-people-accounts/testing';
import { createPeopleAccountsClient } from '@phosphorco/bb-people-accounts/bb';
import { sdkFromFakeHost } from '@phosphorco/bb-people-accounts/testing';
import { checkGitHubToken, tokenSlot, type AccountFetch } from '../model';
import factory from '../server';
import type { PeopleStatus } from '../rpc-contract';

const ada = rosterEntryFixture();
const token = 'dummy-diagnostics-token';
async function fixture(fetcher: AccountFetch) {
  const host = createFakePluginHost({ pluginId: 'people-accounts', settings: { roster: JSON.stringify([ada]), [tokenSlot(ada.personKey)]: token } });
  await factory(host.bb, { fetcher });
  return host;
}

test('checks are explicit, cached and advisory; errors recover and never echo response bodies/tokens', async () => {
  let calls = 0;
  let fail = false;
  const host = await fixture((async (_url: unknown, init: RequestInit) => {
    calls++;
    expect(init.headers).toMatchObject({ authorization: `Bearer ${token}` });
    return fail ? new Response(JSON.stringify({ message: token }), { status: 401 }) : new Response(JSON.stringify({ login: 'different-bot', ignored: token }), { headers: { 'x-oauth-scopes': 'repo, read:user', 'github-authentication-token-expiration': '2027-01-01 00:00:00 UTC' } });
  }) as AccountFetch);
  try {
    const client = createPeopleAccountsClient(sdkFromFakeHost(host));
    await client.roster(); await client.resolve({ inputs: ['ada'] }); await host.harness.behavior.runCli(['status']);
    expect(calls).toBe(0);
    let status = await host.harness.behavior.callRpc('peopleAccountsCheck', { personKeys: [ada.personKey] }) as PeopleStatus;
    expect(status.entries[0]?.credential).toMatchObject({ state: 'ok', actsAs: 'different-bot', expiresAt: '2027-01-01T00:00:00.000Z', scopes: ['repo', 'read:user'] });
    expect(status.entries[0]?.credential.message).toContain('different account');
    expect(status.entries[0]?.credential.checkedAt).toBeTruthy();
    expect((await client.resolve({ inputs: ['ada'] })).attribution.postAs).toBe(ada.botLogin);
    await host.harness.behavior.runCli(['status']);
    expect(calls).toBe(1);
    fail = true;
    status = await host.harness.behavior.callRpc('peopleAccountsCheck', { personKeys: [ada.personKey] }) as PeopleStatus;
    expect(status.entries[0]?.credential.state).toBe('failing');
    expect(JSON.stringify(status)).not.toContain(token);
    expect((await client.resolve({ inputs: ['ada'] })).attribution.postAs).toBe(ada.botLogin);
    fail = false;
    const cli = await host.harness.behavior.runCli(['status', '--check']);
    expect(JSON.parse(cli.stdout).entries[0].credential.state).toBe('ok');
    expect(cli.stdout).not.toContain(token);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('unadvertised scopes and expiry remain unknown, and malformed/network responses have fixed errors', async () => {
  let mode = 'success';
  const host = await fixture((async () => {
    if (mode === 'network') throw new Error(`transport contains ${token}`);
    return new Response(JSON.stringify(mode === 'success' ? { login: ada.botLogin } : { name: token }));
  }) as AccountFetch);
  try {
    const check = async () => await host.harness.behavior.callRpc('peopleAccountsCheck', { personKeys: [ada.personKey] }) as PeopleStatus;
    expect((await check()).entries[0]?.credential).toMatchObject({ state: 'ok', scopes: null, expiresAt: null });
    mode = 'malformed';
    expect((await check()).entries[0]?.credential.message).toBe('GitHub account response did not include a valid login.');
    mode = 'network';
    const failed = await check();
    expect(failed.entries[0]?.credential.message).toBe('GitHub account check unavailable or timed out.');
    expect(JSON.stringify(failed)).not.toContain(token);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('late diagnostics for an edited token cannot overwrite its current unchecked health', async () => {
  let release!: (response: Response) => void;
  let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const host = await fixture((async () => { started(); return new Promise<Response>(resolve => { release = resolve; }); }) as AccountFetch);
  try {
    const checking = host.harness.behavior.callRpc('peopleAccountsCheck', { personKeys: [ada.personKey] });
    await begun;
    await host.harness.behavior.setSettings({ [tokenSlot(ada.personKey)]: 'new-dummy-token' });
    release(new Response(JSON.stringify({ login: 'stale-bot' })));
    await checking;
    const status = await host.harness.behavior.callRpc('peopleAccountsStatus', null) as PeopleStatus;
    expect(status.entries[0]?.credential).toMatchObject({ state: 'configured', actsAs: null, checkedAt: null });
  } finally { await host.harness.lifecycle.dispose(); }
});


test('ignored abort in fetch and body read still settles at the full-operation deadline', async () => {
  const never = () => new Promise<never>(() => {});
  for (const fetcher of [
    (async () => never()) as AccountFetch,
    (async () => ({ ok: true, json: never })) as unknown as AccountFetch,
  ]) {
    const result = await checkGitHubToken(token, ada.botLogin, fetcher, new AbortController().signal, 5);
    expect(result).toMatchObject({ state: 'failing', message: 'GitHub account check unavailable or timed out.' });
  }
});

test('plugin disposal settles an ignored-abort check without waiting for its network body', async () => {
  let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const host = await fixture((async () => { started(); return new Promise<Response>(() => {}); }) as AccountFetch);
  const checking = host.harness.behavior.callRpc('peopleAccountsCheck', { personKeys: [ada.personKey] }).catch(() => null);
  await begun;
  await host.harness.lifecycle.dispose();
  await checking;
});

test('unrelated token/roster saves preserve checked health and an unchanged-token in-flight result', async () => {
  const second = rosterEntryFixture({ personKey: 'person:other', displayName: 'Other', botLogin: 'other-bot' });
  let release!: (response: Response) => void;
  let started!: () => void;
  let hold = false;
  const host = createFakePluginHost({ pluginId: 'people-accounts', settings: { roster: JSON.stringify([ada, second]), [tokenSlot(ada.personKey)]: token } });
  await factory(host.bb, { fetcher: (async () => {
    if (hold) { started(); return new Promise<Response>(resolve => { release = resolve; }); }
    return new Response(JSON.stringify({ login: ada.botLogin }));
  }) as AccountFetch });
  try {
    const check = () => host.harness.behavior.callRpc('peopleAccountsCheck', { personKeys: [ada.personKey] });
    const checked = await check() as PeopleStatus;
    const before = checked.entries[0]!.credential;
    const descriptor = host.harness.inspection.registrations.settingsDescriptors.githubOrganization!;
    expect(descriptor.label).toBe('GitHub organization');
    expect('default' in descriptor).toBe(false);
    expect(checked.diagnostics.some(message => message.includes('Set the GitHub organization'))).toBe(true);
    await host.harness.behavior.setSettings({ githubOrganization: 'example-team' });
    let organizationStatus = await host.harness.behavior.callRpc('peopleAccountsStatus', null) as PeopleStatus;
    expect(organizationStatus.entries[0]!.credential).toEqual(before);
    expect(organizationStatus.reloadRequired).toBe(false);
    expect(organizationStatus.diagnostics.some(message => message.includes('Set the GitHub organization'))).toBe(false);
    await host.harness.behavior.setSettings({ githubOrganization: '  ' });
    organizationStatus = await host.harness.behavior.callRpc('peopleAccountsStatus', null) as PeopleStatus;
    expect(organizationStatus.entries[0]!.credential).toEqual(before);
    expect(organizationStatus.reloadRequired).toBe(false);
    expect(organizationStatus.diagnostics.some(message => message.includes('Set the GitHub organization'))).toBe(true);
    await host.harness.behavior.setSettings({ [tokenSlot(second.personKey)]: 'other-dummy-token' });
    await host.harness.behavior.setSettings({ roster: JSON.stringify([ada, { ...second, displayName: 'Other renamed' }]) });
    let status = await host.harness.behavior.callRpc('peopleAccountsStatus', null) as PeopleStatus;
    expect(status.entries[0]!.credential).toEqual(before);
    hold = true;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const checking = check();
    await begun;
    await host.harness.behavior.setSettings({ [tokenSlot(second.personKey)]: 'other-replacement-token', roster: JSON.stringify([ada, second]), githubOrganization: 'example-team' });
    release(new Response(JSON.stringify({ login: 'observed-bot' })));
    await checking;
    status = await host.harness.behavior.callRpc('peopleAccountsStatus', null) as PeopleStatus;
    expect(status.entries[0]!.credential.actsAs).toBe('observed-bot');
    await host.harness.behavior.setSettings({ [tokenSlot(ada.personKey)]: 'actual-replacement-token' });
    status = await host.harness.behavior.callRpc('peopleAccountsStatus', null) as PeopleStatus;
    expect(status.entries[0]!.credential).toMatchObject({ state: 'configured', checkedAt: null, actsAs: null });
  } finally { await host.harness.lifecycle.dispose(); }
});
