import assert from 'node:assert/strict';
import { chromium, type Browser } from '@playwright/test';

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
async function phase<T>(name: string, work: Promise<T>, timeoutMs = 15_000): Promise<T> {
  process.stdout.write(`identity browser phase: ${name}\n`);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms during ${name}.`)), timeoutMs); }),
    ]);
  } finally { if (timer !== null) clearTimeout(timer); }
}

const built = await Bun.build({
  entrypoints: [new URL('./identity-browser-app.tsx', import.meta.url).pathname],
  target: 'browser', format: 'iife',
});
if (!built.success || built.outputs.length !== 1) {
  throw new Error(`Browser probe bundle failed: ${built.logs.map(log => log.message).join('\n')}`);
}
const script = await built.outputs[0].text();
const html = '<!doctype html><html><body><div id="root-a"></div><div id="root-b"></div><div id="root-held-provider"></div><script src="/identity-browser-app.js"></script></body></html>';
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (path === '/identity-browser-app.js') return new Response(script, { headers: { 'content-type': 'application/javascript; charset=utf-8' } });
    return new Response('Not found', { status: 404 });
  },
});
let browser: Browser | null = null;
try {
  browser = await phase('Chromium launch', chromium.launch());
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await phase('loopback navigation', page.goto(server.url.toString()));
  await phase('IndexedDB React mount', page.locator('#identity-browser-root[data-state="ready"]').waitFor({ timeout: 12_000 }));
  assert.equal(await page.evaluate(() => window.__bbIdentityBrowser?.mounted()), true);
  assert.equal(await page.evaluate(() => window.__bbIdentityBrowser?.readProbe()), 1);

  await phase('root A native liveness', page.locator('output[data-root="a"][data-live="true"][data-rpc-version="0"]').waitFor({ timeout: 12_000 }));
  await phase('root B native liveness', page.locator('output[data-root="b"][data-live="true"][data-rpc-version="0"]').waitFor({ timeout: 12_000 }));
  await phase('state binding mount', page.locator('output[data-state-binding="true"][data-binding-id]:not([data-binding-id="0"])').waitFor({ timeout: 12_000 }));
  const initial = required(await page.evaluate(() => window.__bbIdentityBrowser?.identityStats()), 'Missing browser identity stats.');
  assert.equal(initial.a.active, 1); assert.equal(initial.b.active, 1);
  assert.deepEqual(initial.discarded, { version: 0, bootstrap: 0, subscriptions: 0, unsubscriptions: 0, active: 0, stateSaves: 0, live: false });
  assert.ok(initial.a.subscriptions >= 2 && initial.a.unsubscriptions >= 1, 'StrictMode must replace the discarded realtime subscription.');
  assert.ok(initial.a.bootstrap >= 2 && initial.b.bootstrap >= 2, 'Each live root must bootstrap through the SDK hook seam.');
  assert.equal(initial.a.live, true); assert.equal(initial.b.live, true);

  const stateInitial = required(await page.evaluate(() => window.__bbIdentityBrowser?.stateBindingStats()), 'Missing mounted state binding.');
  assert.equal(stateInitial.dirty, false);
  assert.ok(stateInitial.owner !== null, `Mounted state binding did not obtain an owner: ${JSON.stringify(stateInitial)}`);
  assert.equal(await page.evaluate(() => window.__bbIdentityBrowser?.editStateBinding()), true);
  await phase('state binding dirty edit', page.locator('output[data-state-binding="true"][data-state-dirty="true"]').waitFor({ timeout: 12_000 }));
  for (let render = 1; render <= 10; render++) {
    await page.evaluate(() => window.__bbIdentityBrowser?.rerenderSameRpc());
    await phase(`inline callback rerender ${render}`, page.locator(`main[data-harness-renders="${render}"]`).waitFor({ timeout: 12_000 }));
    const rerendered = required(await page.evaluate(() => window.__bbIdentityBrowser?.stateBindingStats()), 'Missing state binding after inline callback rerender.');
    assert.equal(rerendered.bindingId, stateInitial.bindingId);
    assert.equal(rerendered.dirty, true);
  }
  assert.equal(await page.evaluate(() => window.__bbIdentityBrowser?.resetDefaultView()), true, 'Default Context view actions must be callable.');

  assert.equal(await page.evaluate(() => window.__bbIdentityBrowser?.failStateBinding()), true);
  await phase('first committed preservation failure', page.waitForFunction(() => (window.__bbIdentityBrowser?.stateBindingStats()?.failures.length ?? 0) === 1, undefined, { timeout: 12_000 }));
  const firstFailure = required(await page.evaluate(() => window.__bbIdentityBrowser?.stateBindingStats()), 'Missing first preservation failure.');
  assert.equal(firstFailure.failureCallbacks, 1); assert.equal(firstFailure.failures[0]?.frozen, true);
  const staleGeneration = required(firstFailure.failures[0], 'Missing first failure generation.').generation;
  assert.equal(await page.evaluate(() => window.__bbIdentityBrowser?.failStateBinding()), true);
  await phase('newer committed preservation failure', page.waitForFunction(() => (window.__bbIdentityBrowser?.stateBindingStats()?.failures.length ?? 0) === 2, undefined, { timeout: 12_000 }));
  const twoFailures = required(await page.evaluate(() => window.__bbIdentityBrowser?.stateBindingStats()), 'Missing newer preservation failure.');
  assert.equal(twoFailures.failureCallbacks, 2); assert.ok(twoFailures.failures.every(failure => failure.frozen));
  const newerGeneration = required(twoFailures.failures.at(-1), 'Missing newer failure generation.').generation;
  assert.equal(await page.evaluate(generation => window.__bbIdentityBrowser?.acknowledgeFailure(generation), staleGeneration), true);
  const acknowledged = required(await page.evaluate(() => window.__bbIdentityBrowser?.stateBindingStats()), 'Missing failures after acknowledgement.');
  assert.deepEqual(acknowledged.failures.map(failure => failure.generation), [newerGeneration], 'Stale acknowledgement may not clear a newer preservation failure.');
  assert.equal(await page.evaluate(() => window.__bbIdentityBrowser?.editStateBinding()), true, 'The current binding must remain usable after failure acknowledgement.');

  await page.evaluate(() => window.__bbIdentityBrowser?.rerenderSameRpc());
  await phase('same-RPC rerender', page.locator('main[data-harness-renders="11"]').waitFor({ timeout: 12_000 }));
  const stable = required(await page.evaluate(() => window.__bbIdentityBrowser?.identityStats()), 'Missing stable browser identity stats.');
  assert.deepEqual(stable.a, initial.a); assert.deepEqual(stable.b, initial.b);

  await page.evaluate(() => window.__bbIdentityBrowser?.replaceRootARpc());
  await phase('root A RPC replacement', page.locator('output[data-root="a"][data-live="true"][data-rpc-version="1"]').waitFor({ timeout: 12_000 }));
  const replaced = required(await page.evaluate(() => window.__bbIdentityBrowser?.identityStats()), 'Missing replacement browser identity stats.');
  assert.equal(replaced.a0.active, 0); assert.equal(replaced.a0.subscriptions, replaced.a0.unsubscriptions);
  assert.equal(replaced.a0.live, false, 'The old client may not remain authoritative after RPC replacement.');
  assert.equal(replaced.a1.active, 1); assert.ok(replaced.a1.bootstrap >= 2); assert.equal(replaced.a1.live, true);
  assert.deepEqual(replaced.b, initial.b, 'Root B must not subscribe or bootstrap when root A replaces its RPC.');

  await phase('explicit borrowed clients start', page.evaluate(() => window.__bbIdentityBrowser?.mountHeldProvider()));
  await phase('mounted Provider binding', page.waitForFunction(() => {
    const stats = window.__bbIdentityBrowser?.mountedProviderStats();
    return stats?.mounts === 1 && stats.disposals === 0 && stats.owner !== null;
  }, undefined, { timeout: 12_000 }));
  assert.equal(await page.evaluate(() => window.__bbIdentityBrowser?.beginMountedProviderSwitch()), true);
  await phase('held feature draft write begins', page.evaluate(() => window.__bbIdentityBrowser?.waitForMountedProviderWrite()));
  await phase('same Provider successor binding', page.waitForFunction(() => {
    const stats = window.__bbIdentityBrowser?.mountedProviderStats();
    return stats?.mounts === 1 && stats.disposals === 0 && stats.owner !== null;
  }, undefined, { timeout: 12_000 }));
  assert.equal(await page.evaluate(() => window.__bbIdentityBrowser?.startMountedProviderRecovery()), true);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  assert.deepEqual(await page.evaluate(() => window.__bbIdentityBrowser?.mountedProviderRecovery()), { status: 'pending' }, 'Successor recovery must remain pending across a browser task before release.');
  await page.evaluate(() => window.__bbIdentityBrowser?.releaseMountedProviderWrite());
  await phase('mounted Provider recovery settles', page.waitForFunction(() => window.__bbIdentityBrowser?.mountedProviderRecovery().status === 'success', undefined, { timeout: 12_000 }));
  const recovered = required(await page.evaluate(() => window.__bbIdentityBrowser?.mountedProviderRecovery()), 'Missing mounted Provider recovery result.');
  assert.equal(recovered.status, 'success');
  if (recovered.status === 'success') assert.deepEqual(recovered.desired, ['browser-state-value']);
  const retainedProvider = required(await page.evaluate(() => window.__bbIdentityBrowser?.mountedProviderStats()), 'Missing mounted Provider stats.');
  assert.equal(retainedProvider.mounts, 1); assert.equal(retainedProvider.disposals, 0); assert.ok(retainedProvider.owner !== null);
  await page.evaluate(() => window.__bbIdentityBrowser?.disposeMountedProvider());
  await phase('mounted Provider disposal', page.waitForFunction(() => window.__bbIdentityBrowser?.mountedProviderStats().disposals === 1, undefined, { timeout: 12_000 }));

  await page.evaluate(() => window.__bbIdentityBrowser?.disposeRootA());
  await phase('root A disposal', page.locator('#root-a output').waitFor({ state: 'detached', timeout: 12_000 }));
  await phase('feature draft preservation', page.waitForFunction(async () => (await window.__bbIdentityBrowser?.stateDraftCount() ?? 0) === 1, undefined, { timeout: 12_000 }));
  const disposed = required(await page.evaluate(() => window.__bbIdentityBrowser?.identityStats()), 'Missing disposed browser identity stats.');
  assert.equal(disposed.a1.active, 0); assert.equal(disposed.a1.subscriptions, disposed.a1.unsubscriptions);
  assert.equal(disposed.a1.live, false); assert.equal(disposed.b.active, 1); assert.equal(disposed.b.live, true);
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);

  await phase('page reload', page.reload());
  await phase('reload IndexedDB React mount', page.locator('#identity-browser-root[data-state="ready"]').waitFor({ timeout: 12_000 }));
  assert.equal(await page.evaluate(() => window.__bbIdentityBrowser?.readProbe()), 1);
  process.stdout.write('identity browser: React StrictMode and generic draft-state lifetime passed\n');
} finally {
  try { await phase('Chromium close', browser?.close() ?? Promise.resolve(), 5_000); }
  finally { server.stop(true); }
}
