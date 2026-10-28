import { afterAll, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { PeopleStatus } from '../rpc-contract';
import { STATUS_CHANNEL } from '../rpc-contract';
import { rosterEntryFixture, healthFixture } from '@phosphorco/bb-people-accounts/testing';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://people-accounts.test/', pretendToBeVisual: true });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent', 'Node', 'MutationObserver'] as const) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : name === 'document' ? dom.window.document : dom.window[name] });
}
previous.set('IS_REACT_ACT_ENVIRONMENT', Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
const { act } = await import('react');
const { loadPluginApp, renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const app = await loadPluginApp(() => import('../app.tsx'));
afterAll(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const baseline = (): PeopleStatus => ({ entries: [{ ...rosterEntryFixture(), credential: healthFixture() }], diagnostics: [], reloadRequired: false });

test('settings mounts cached summary only; checks and directory search require deliberate actions', async () => {
  let snapshot = baseline();
  let checks = 0;
  let searches = 0;
  const settings = { githubOrganization: '' };
  const slot = renderSlot(app.settingsSections[0]!, {}, { pluginId: 'people-accounts', settings, realtimeConnectionState: 'connected', rpc: {
    peopleAccountsStatus: () => snapshot,
    peopleAccountsCheck: () => { checks++; snapshot = { ...snapshot, entries: snapshot.entries.map(row => ({ ...row, credential: healthFixture({ state: 'ok', actsAs: 'different-bot', checkedAt: '2026-10-27T10:00:00Z', scopes: null }) })) }; return snapshot; },
    peopleAccountsDirectory: () => { searches++; return { items: [], reason: null, truncated: false }; },
  } });
  try {
    await slot.findByText('Ada Fixture');
    expect(slot.queryByRole('link', { name: 'Create PAT for @ada-bot' })).toBeNull();
    expect(slot.container.textContent).toContain('Set the GitHub organization');
    settings.githubOrganization = 'example-team';
    await slot.behavior.setRealtimeConnectionState('reconnecting');
    await slot.behavior.setRealtimeConnectionState('connected');
    expect(checks).toBe(0); expect(searches).toBe(0);
    expect(app.settingsSections).toHaveLength(1);
    expect(app.contentScripts).toHaveLength(0);
    expect(app.navPanels).toHaveLength(0);
    await act(async () => { slot.getByRole('button', { name: 'Run checks' }).click(); });
    expect(checks).toBe(1);
    await slot.findByText(/Token belongs to @different-bot; roster expects @ada-bot/);
    const link = slot.getByRole('link', { name: 'Create PAT for @ada-bot' });
    const pat = new URL(link.getAttribute('href')!);
    expect(pat.searchParams.get('target_name')).toBe('example-team');
    expect(pat.searchParams.get('pull_requests')).toBe('write');
    expect(pat.searchParams.get('contents')).toBe('read');
    expect(pat.searchParams.get('name')!.length).toBeLessThanOrEqual(40);
    expect(slot.container.textContent).toContain('your own row');
    expect(slot.container.textContent).toContain('Be signed in to GitHub as @ada-bot');
    expect(slot.container.textContent).toContain('resource owner example-team');
    settings.githubOrganization = 'another-team';
    await slot.behavior.setRealtimeConnectionState('reconnecting');
    await slot.behavior.setRealtimeConnectionState('connected');
    expect(new URL(slot.getByRole('link', { name: 'Create PAT for @ada-bot' }).getAttribute('href')!).searchParams.get('target_name')).toBe('another-team');
    expect(slot.container.textContent).toContain('resource owner another-team');
    settings.githubOrganization = '  ';
    await slot.behavior.setRealtimeConnectionState('reconnecting');
    await slot.behavior.setRealtimeConnectionState('connected');
    expect(slot.queryByRole('link', { name: 'Create PAT for @ada-bot' })).toBeNull();
    expect(slot.container.textContent).toContain('Set the GitHub organization');
    expect(checks).toBe(1);
    expect(slot.container.textContent).toContain('unknown (GitHub may omit these for fine-grained tokens)');
    const disclosure = slot.getByText('Find a person key');
    await act(async () => { disclosure.click(); });
    await act(async () => { slot.getByRole('button', { name: 'Search directory' }).click(); });
    expect(searches).toBe(1);
    await slot.findByText(/No matching people found/);
    await slot.behavior.setRealtimeConnectionState('reconnecting');
    await slot.behavior.setRealtimeConnectionState('connected');
    expect(checks).toBe(1); expect(searches).toBe(1);
  } finally { slot.lifecycle.unmount(); }
});

function recoveryClock() {
  let now = 0, sequence = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const originalSet = window.setTimeout;
  const originalClear = window.clearTimeout;
  window.setTimeout = ((run: () => void, delay = 0) => { const id = ++sequence; timers.set(id, { at: now + delay, run }); return id; }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof window.clearTimeout;
  return {
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]);
        await act(async () => { next[1].run(); });
      }
      now = end;
    },
    restore() { window.setTimeout = originalSet; window.clearTimeout = originalClear; },
  };
}

test('failed summary retries automatically, preserves content, stays quiet 30s and recovers unchanged', async () => {
  const clock = recoveryClock();
  let fail = false, reads = 0;
  const slot = renderSlot(app.settingsSections[0]!, {}, { pluginId: 'people-accounts', realtimeConnectionState: 'connected', rpc: {
    peopleAccountsStatus: () => { reads++; if (fail) throw new Error('controlled failure'); return baseline(); },
    peopleAccountsCheck: () => { throw new Error('unexpected automatic check'); },
  } });
  try {
    await slot.findByText('Ada Fixture');
    fail = true;
    await slot.behavior.emitRealtime(STATUS_CHANNEL, {});
    expect(slot.container.querySelector('[data-read-status]')).toBeNull();
    expect(slot.container.textContent).toContain('Ada Fixture');
    await clock.advance(30_000);
    expect(reads).toBeGreaterThan(2);
    expect(slot.container.textContent).toContain('Retrying automatically');
    fail = false;
    await clock.advance(1000);
    expect(slot.container.querySelector('[data-read-status]')).toBeNull();
    expect(slot.container.textContent).toContain('Ada Fixture');
    const recoveredReads = reads;
    await clock.advance(60_000);
    expect(reads).toBe(recoveredReads);
  } finally { slot.lifecycle.unmount(); clock.restore(); }
});

test('failed summary pauses recovery while hidden and unmount cancels retries', async () => {
  const clock = recoveryClock();
  let reads = 0;
  const slot = renderSlot(app.settingsSections[0]!, {}, { pluginId: 'people-accounts', realtimeConnectionState: 'connected', rpc: {
    peopleAccountsStatus: () => { reads++; throw new Error('controlled failure'); },
  } });
  try {
    await act(async () => {});
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    const hiddenReads = reads;
    await clock.advance(60_000);
    expect(reads).toBe(hiddenReads);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(reads).toBeGreaterThan(hiddenReads);
    slot.lifecycle.unmount();
    const unmountedReads = reads;
    await clock.advance(60_000);
    expect(reads).toBe(unmountedReads);
  } finally { slot.lifecycle.unmount(); Reflect.deleteProperty(document, 'visibilityState'); clock.restore(); }
});

test('late summary from an unmounted resource cannot replace a newly mounted summary', async () => {
  let release!: (value: PeopleStatus) => void;
  const pending = new Promise<PeopleStatus>(resolve => { release = resolve; });
  const old = renderSlot(app.settingsSections[0]!, {}, { pluginId: 'people-accounts', rpc: { peopleAccountsStatus: () => pending } });
  await act(async () => {});
  old.lifecycle.unmount();
  const current = renderSlot(app.settingsSections[0]!, {}, { pluginId: 'people-accounts', rpc: { peopleAccountsStatus: () => baseline() } });
  try {
    await current.findByText('Ada Fixture');
    await act(async () => { release({ ...baseline(), entries: [{ ...baseline().entries[0]!, displayName: 'Stale Person' }] }); });
    expect(current.queryByText('Stale Person')).toBeNull();
    expect(current.container.textContent).toContain('Ada Fixture');
  } finally { current.lifecycle.unmount(); }
});

test('reload failure remains visible after unrelated summary refresh', async () => {
  const slot = renderSlot(app.settingsSections[0]!, {}, { pluginId: 'people-accounts', realtimeConnectionState: 'connected', rpc: {
    peopleAccountsStatus: () => baseline(),
  }, sdk: { plugins: { reload: async () => { throw new Error('reload failed'); } } } });
  try {
    await slot.findByText('Ada Fixture');
    await act(async () => { slot.getByRole('button', { name: 'Reload settings' }).click(); });
    await slot.findByText(/Could not reload people accounts/);
    expect(slot.inspection.sdkCalls.some(call => call.method === 'plugins.reload')).toBe(true);
    await slot.behavior.emitRealtime(STATUS_CHANNEL, {});
    expect(slot.container.textContent).toContain('Could not reload people accounts');
  } finally { slot.lifecycle.unmount(); }
});
