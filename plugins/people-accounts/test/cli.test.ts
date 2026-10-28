import { expect, test } from 'bun:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { rosterEntryFixture } from '@phosphorco/bb-people-accounts/testing';
import factory from '../server';
import { runCli } from '../cli';
import { tokenSlot } from '../model';

const ada = rosterEntryFixture();
test('actual CLI stdout is pure trailers alongside unknown names and stderr explains defaults', async () => {
  const host = createFakePluginHost({ pluginId: 'people-accounts', settings: { roster: JSON.stringify([ada]) } });
  try {
    await factory(host.bb);
    const result = await host.harness.behavior.runCli(['resolve', '--for', 'unknown', '--for', 'ada', '--format', 'trailers']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Co-Authored-By: Ada Fixture <ada.commits@example.test>\n');
    expect(result.stderr).toContain('unknown');
    const unknown = await host.harness.behavior.runCli(['resolve', '--for', 'nobody', '--format', 'trailers']);
    expect(unknown.stdout).toBe('');
    expect(unknown.exitCode).toBe(0);
    const json = await host.harness.behavior.runCli(['resolve', '--for', 'ada']);
    expect(JSON.parse(json.stdout).results[0].status).toBe('resolved');
    const bad = await host.harness.behavior.runCli(['resolve', '--for']);
    expect(bad.exitCode).toBe(1);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('unavailable resolver fails open and trailer mode never emits status text to stdout', async () => {
  const port = { resolve: async () => { throw new Error('transport failure'); }, status: async () => ({ entries: [], diagnostics: [], reloadRequired: false }) };
  const result = await runCli(['resolve', '--for', 'ada', '--format', 'trailers'], port);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBeTruthy();
  const json = await runCli(['resolve', '--for', 'ada'], port);
  expect(JSON.parse(json.stdout!).attribution.fallbackReason).toBeTruthy();
});

test('opaque person keys map distinctly to stable SDK-safe slots', () => {
  expect(tokenSlot('p'.repeat(512))).toHaveLength(75);
  expect(tokenSlot('person:a/b')).toMatch(/^[a-zA-Z0-9_-]+$/);
  expect(tokenSlot('person:a/b')).not.toBe(tokenSlot('person:a_b'));
  expect(tokenSlot('person:é')).not.toBe(tokenSlot('person:e'));
});
