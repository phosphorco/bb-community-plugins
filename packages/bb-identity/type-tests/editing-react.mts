import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const built = await Bun.build({ entrypoints: [new URL('./editing-react-app.tsx', import.meta.url).pathname], target: 'browser', format: 'iife' });
if (!built.success) throw new Error(built.logs.map(value => value.message).join('\n'));
const script = await built.outputs[0]!.text();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new URL(request.url).pathname === '/app.js' ? new Response(script, { headers: { 'content-type': 'application/javascript' } }) : new Response('<div id="root"></div><script src="/app.js"></script>', { headers: { 'content-type': 'text/html' } }) });
let browser;
try {
  browser = await chromium.launch(); const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url.toString()); await page.locator('[data-testid="editor"][data-status="loaded"]').waitFor();
  const owner = await page.locator('[data-testid="editor"]').getAttribute('data-owner');
  assert.equal(await page.evaluate(() => window.editingProbe.edit('A')), true);
  assert.equal(await page.evaluate(() => window.editingProbe.flush()), false);
  assert.equal(await page.evaluate(() => window.editingProbe.edit('B')), true);
  for (let i = 1; i <= 5; i++) { await page.evaluate(() => window.editingProbe.rerender()); await page.locator(`main[data-render="${i}"]`).waitFor(); assert.equal(await page.locator('[data-testid="editor"]').getAttribute('data-owner'), owner); }
  await page.evaluate(() => { window.editingProbe.fail(); window.editingProbe.target('map-2'); });
  await page.locator('[data-testid="editor"][data-map="map-2"][data-status="loaded"]').waitFor(); await page.locator('[data-testid="failures"]', { hasText: '1' }).waitFor();
  const stats = await page.evaluate(() => window.editingProbe.stats()) as { state: { scope: { target: { mapId: string } } }; failures: { generation: number; draft: { target: { mapId: string }; draft: { desired: string; inFlight: { value: string } } } }[] };
  assert.equal(stats.state.scope.target.mapId, 'map-2'); assert.equal(stats.failures[0]!.draft.target.mapId, 'map-1');
  assert.equal(stats.failures[0]!.draft.draft.desired, 'B'); assert.equal(stats.failures[0]!.draft.draft.inFlight.value, 'A');
  assert.equal(await page.evaluate(generation => window.editingProbe.acknowledge(generation), stats.failures[0]!.generation), true);
  assert.equal(await page.evaluate(() => window.editingProbe.edit('C')), true); assert.deepEqual(errors, []);
  process.stdout.write('editing browser: StrictMode, semantic target/callback identity, unknown A/type B, full Provider failure export passed\n');
} finally { await browser?.close(); server.stop(true); }
