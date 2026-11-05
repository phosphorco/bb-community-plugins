/** Test-only real content-script/CR host composition. No new presentation realm. */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { installTestPluginRuntime, loadPluginApp, mountPluginContentScripts } from '@get-bb/plugin-sdk/testing/app';
import type { PluginAppSource, MountedPluginContentScripts } from '@get-bb/plugin-sdk/testing/app';
import { PresentationHost } from '@phosphorco/bb-context-recognition/react';
import { lookupPresentation } from '@phosphorco/bb-context-recognition/presentation';
import { createIsolatedPresentationRealm } from '@phosphorco/bb-context-recognition/testing';
import { ContentBlockSchema, decodeOutput } from './index.js';
import type { ContentBlock } from './index.js';
import { createResultsSupplierClient, navigateResult } from './bb.js';
import type { ResultNavigationPort, ResultsSupplierClient } from './bb.js';
import { createRegisteredHandlerRpc, assertConformance, withConformanceDeadline } from './testing.js';
import type { ParticipantSource, ParticipantCleanup, ConformanceReport, ConformanceCheck } from './testing.js';

export interface ResultPresentationCase {
  name: string;
  /** Read from the production source handler, or stamp an actual referent block.
   * No fabricated tool occurrence is needed for a context/reference consumer.
   */
  loadContent(client: ResultsSupplierClient): ContentBlock | Promise<ContentBlock>;
  expect: { schema: string; text?: string | undefined } & ({ state: 'ready' } | { state: 'fallback'; failure: 'decode' | 'render' });
  modes?: readonly ('docked' | 'full')[] | undefined;
  verify?: ((tools: { element: HTMLElement; ownerCalls: readonly { pluginId: string; method: string }[] }) => void | Promise<void>) | undefined;
}
export interface ResultPresentationConformanceOptions<P> extends ParticipantSource<P> {
  appDefinition: PluginAppSource;
  cases: readonly ResultPresentationCase[];
  /** Actual supplier resource owner instrumentation; absent means unobserved. */
  observeActiveResources?: (() => number) | undefined;
}
export async function runResultPresentationConformance<P>(options: ResultPresentationConformanceOptions<P>): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const check = async (name: string, run: () => unknown | Promise<unknown>, required = true) => {
    try { await withConformanceDeadline(run); checks.push({ name, state: 'passed', required }); }
    catch (error) { checks.push({ name, state: 'failed', required, detail: (error instanceof Error ? error.message : String(error)).slice(0, 512) }); }
  };
  const realm = createIsolatedPresentationRealm();
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://conformance.invalid/' });
  const scope = globalThis as unknown as Record<string, unknown>;
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT', '__bbPluginRuntime'];
  const saved = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const host = createFakePluginHost({ pluginId: options.pluginId });
  let owned: ParticipantCleanup = undefined, mounted: MountedPluginContentScripts | undefined;
  let root: ReturnType<typeof createRoot> | undefined;
  const calls: { pluginId: string; method: string }[] = [];
  const rpc = createRegisteredHandlerRpc(host, options.pluginId, call => calls.push(call));
  // Keep the selected SDK's full plugins port; replace only its cross-plugin
  // transport with the real registered-handler fake host path.
  const sdk = { plugins: new Proxy(host.bb.sdk.plugins, { get(target, key, receiver) { return key === 'callRpc' ? rpc.callRpc.bind(rpc) : Reflect.get(target, key, receiver); } }) };
  const actions: string[] = [];
  const navigation: ResultNavigationPort = { experimental_openFilePreview: () => { actions.push('file'); return true; }, openUrl: () => { actions.push('url'); return true; }, toThread: () => { actions.push('thread'); } };
  const consumerNavigation = { toThread: navigation.toThread, openUrl: (url: string) => { navigation.openUrl(url); }, openFile: (target: Parameters<ResultNavigationPort['experimental_openFilePreview']>[0]['target']) => navigation.experimental_openFilePreview({ target, location: null }) };
  async function unmount() { if (root) { const current = root; root = undefined; await act(async () => current.unmount()); } }
  try {
    for (const key of globals.slice(0, 6)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[key] });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
    installTestPluginRuntime();
    await check('production-factory-and-content-script', async () => {
      owned = await options.participantFactory(host.bb, options.sourcePorts);
      mounted = await mountPluginContentScripts(await loadPluginApp(options.appDefinition), { pluginId: options.pluginId, generation: 1 });
    });
    assertConformance(!checks.some(item => item.state === 'failed'), 'Production factory/content script failed.');
    if (!options.cases.length) checks.push({ name: 'presentation-policy-witness', state: 'skipped', required: true, detail: 'No actual content source cases supplied.' });
    for (const scenario of options.cases) {
      let block: ContentBlock | undefined;
      await check(`${scenario.name}:content`, async () => {
        block = decodeOutput(ContentBlockSchema, await scenario.loadContent(createResultsSupplierClient({ plugins: rpc }, options.pluginId)));
        assertConformance(block.presentation?.schema === scenario.expect.schema, 'Source did not supply the expected existing CR presentation.');
        assertConformance(lookupPresentation(options.pluginId, scenario.expect.schema), 'Actual app content script did not register the presentation.');
      });
      if (!block?.presentation) continue;
      const content = block;
      const fallback = createElement('div', { 'data-results-fallback': '' }, content.fallback.title,
        content.navigation ? createElement('button', { onClick: () => navigateResult(navigation, content.navigation!) }, 'Open content') : null);
      const props = { sdk, stamp: { pluginId: options.pluginId, ...content.presentation! }, identity: content.identity,
        consumer: { pluginId: 'conformance-consumer', surface: 'content-block' }, size: { maxWidth: 600, maxHeight: 400, preferredHeight: 240 }, navigate: consumerNavigation, fallback };
      for (const mode of scenario.modes ?? ['docked', 'full']) await check(`${scenario.name}:${mode}`, async () => {
        try {
          let ready = false; const diagnostics: { stage: string }[] = [];
          root = createRoot(dom.window.document.getElementById('root')!);
          await act(async () => root!.render(createElement(PresentationHost, { ...props, mode, readyPlugins: new Set([options.pluginId]), onReady: () => { ready = true; }, onDiagnostic: diagnostic => diagnostics.push(diagnostic) })));
          const element = dom.window.document.getElementById('root')!;
          const end = performance.now() + 2000;
          const waiting = () => scenario.expect.state === 'ready'
            ? !ready || !!scenario.expect.text && !element.textContent?.includes(scenario.expect.text)
            : scenario.expect.failure === 'render' && !diagnostics.some(value => value.stage === 'render');
          while (waiting() && performance.now() < end && !(scenario.expect.state === 'ready' && diagnostics.length)) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
          if (scenario.expect.state === 'ready') {
            assertConformance(ready && !diagnostics.length && !element.querySelector('[data-results-fallback]'), 'Hosted component did not become ready.');
            assertConformance(element.querySelector(`[data-bb-plugin="${options.pluginId}"]`), 'Hosted component has no owner-scoped root.');
            if (scenario.expect.text) assertConformance(element.textContent?.includes(scenario.expect.text), 'Actual component-specific content was not rendered.');
          } else {
            if (scenario.expect.failure === 'render') assertConformance(diagnostics.some(value => value.stage === 'render'), 'No actual render/loader failure observed.');
            else {
              let failedDecode = false;
              try { failedDecode = lookupPresentation(options.pluginId, content.presentation!.schema)?.decode(content.presentation!.data) === null; } catch { failedDecode = true; }
              assertConformance(failedDecode, 'No actual decoder failure observed.');
            }
            assertConformance(element.querySelector('[data-results-fallback]'), 'Failure lost the data fallback.');
            if (content.navigation) { const count = actions.length; element.querySelector<HTMLButtonElement>('[data-results-fallback] button')!.click(); assertConformance(actions.length === count + 1, 'Failed canvas lost data navigation.'); }
          }
          await scenario.verify?.({ element, ownerCalls: calls });
        } finally { await unmount(); }
      });
      await check(`${scenario.name}:disabled-data-navigation`, async () => {
        try {
          const before = calls.length;
          root = createRoot(dom.window.document.getElementById('root')!);
          await act(async () => root!.render(createElement(PresentationHost, { ...props, mode: 'docked', readyPlugins: new Set<string>() })));
          assertConformance(dom.window.document.querySelector('[data-results-fallback]'), 'Disabled supplier did not restore fallback.');
          const button = dom.window.document.querySelector<HTMLButtonElement>('[data-results-fallback] button');
          if (content.navigation) { const count = actions.length; button!.click(); assertConformance(actions.length === count + 1, 'Data fallback navigation did not work.'); }
          assertConformance(calls.length === before, 'Disabled presentation called owner RPC.');
        } finally { await unmount(); }
      });
      if (options.observeActiveResources) await check(`${scenario.name}:actual-resources-retired`, () => assertConformance(options.observeActiveResources!() === 0, 'Supplier resources survived unmount/disable.'));
    }
    await check('content-script-disposal', async () => {
      await mounted?.lifecycle.dispose();
      for (const scenario of options.cases) assertConformance(!lookupPresentation(options.pluginId, scenario.expect.schema), 'App disposal left its registration active.');
    });
    if (!options.observeActiveResources) checks.push({ name: 'actual-resource-owner', state: 'skipped', required: false, detail: 'Actual resource owner not instrumented; GPU/context/RAF lifecycle remains unobserved.' });
  } catch (error) { checks.push({ name: 'presentation-setup', state: 'failed', required: true, detail: (error instanceof Error ? error.message : String(error)).slice(0, 512) }); }
  finally {
    await check('owned-root-disposal', unmount);
    await check('owned-script-disposal', () => mounted?.lifecycle.dispose());
    await check('owned-factory-disposal', async () => { if (typeof owned === 'function') await owned(); else if (owned) await owned.dispose(); });
    await check('fake-host-disposal', () => host.harness.lifecycle.dispose());
    dom.window.close(); realm.restore();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete scope[key]; }
  }
  return { pluginId: options.pluginId, source: options.source, proof: 'registered-handler-source', passed: checks.length > 0 && checks.every(item => item.state !== 'failed' && (!item.required || item.state === 'passed')), checks };
}
