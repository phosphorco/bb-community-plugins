import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, act, StrictMode, useEffect, useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { registerPresentation } from '@phosphorco/bb-context-recognition/presentation';
import type { PresentationComponent, PresentationPropsV1 } from '@phosphorco/bb-context-recognition/presentation';
import type { PresentationHostProps } from '@phosphorco/bb-context-recognition/react';
import { createWindowCanvasOwner } from '../gallery/canvas-owner.ts';
import { createPresentationLifetime } from '../gallery/presentation-lifetime.ts';
import { HostedCanvas } from '../gallery/presentation.ts';

const priority = (order: number, dialog = false) => ({ order, visible: true, focused: false, dialog, activation: 0 });
const pluginId = 'presentation-fixture', schema = 'presentation-fixture/card@1';
const source = { provider: pluginId, id: 'artifact:unchanged', kind: 'artifact' };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function fixture() {
  const dom = new JSDOM('<div id="root"></div>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true,
      value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : (dom.window as unknown as Record<string, unknown>)[key] });
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  let unmounted = false, generation = 0, live = 0, peak = 0, setups = 0, cleanups = 0, rpc = 0, navigation = 0;
  const captured: PresentationPropsV1[] = [], disposers: (() => void)[] = [];
  const owner = createWindowCanvasOwner({ retirementMs: 30 });
  const scopes: ReturnType<typeof createPresentationLifetime>[] = [];
  const sdk = { plugins: { callRpc: async () => { rpc++; return {}; } } } as unknown as PresentationHostProps['sdk'];
  const props: PresentationHostProps = { sdk, stamp: { pluginId, schema, data: { text: 'data only' } }, identity: source,
    readyPlugins: new Set([pluginId]), mode: 'docked', revision: 'r1', size: { maxWidth: 400, maxHeight: 300, preferredHeight: 240 },
    consumer: { pluginId: 'turn-results', surface: 'inline' },
    navigate: { toThread() { navigation++; }, openUrl() { navigation++; }, openFile() { navigation++; return true; } },
    requestFull() { navigation++; }, refresh() { navigation++; }, fallback: h('span', { 'data-fallback': '' }, 'Data card') };
  function View(p: PresentationPropsV1) {
    captured.push(p);
    useEffect(() => { live++; setups++; peak = Math.max(peak, live); return () => { live--; cleanups++; }; }, []);
    return h('div', { 'data-canvas': '', 'data-mode': p.mode }, 'Pure canvas');
  }
  function register(load: () => Promise<PresentationComponent> = async () => View) {
    const dispose = registerPresentation({ pluginId, generation: ++generation, signal: new AbortController().signal },
      { schema, methods: [], decode: data => data, load });
    disposers.push(dispose); return dispose;
  }
  function scope(key: string, order: number, dialog = false) {
    const controller = new AbortController(), request = owner.request(key, priority(order, dialog));
    const lifetime = createPresentationLifetime(request, { signal: controller.signal, current: () => true });
    scopes.push(lifetime); return { lifetime, controller, request };
  }
  async function render(children: ReactNode) { await act(async () => { root.render(children); await tick(); }); }
  function canvas(s: ReturnType<typeof scope>, extra: Partial<PresentationHostProps> = {}) {
    return h(HostedCanvas, { key: scopes.indexOf(s.lifetime), ...props, ...extra, lifetime: s.lifetime });
  }
  return { dom, root, owner, props, captured, register, scope, canvas, render,
    counts: () => ({ live, peak, setups, cleanups, rpc, navigation }),
    async unmount() { if (!unmounted) { unmounted = true; await act(async () => { root.unmount(); await tick(); }); } },
    async dispose() {
      await act(async () => { owner.dispose(); await tick(); }); await this.unmount();
      for (const s of scopes) s.dispose();
      for (const d of disposers.reverse()) d();
      dom.window.close(); for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('real public host: four resources, pending passive cleanup and held actual root disposal block fifth', async () => {
  const f = await fixture();
  const roots = Array.from({ length: 5 }, () => {
    const container = f.dom.window.document.createElement('div'); f.dom.window.document.body.append(container); return createRoot(container);
  });
  let firstUnmounted = false;
  try {
    f.register(); const scopes = Array.from({ length: 5 }, (_, i) => f.scope(`pane/${i}`, i)), fifth = scopes[4]!;
    await act(async () => { roots.forEach((root, i) => root.render(f.canvas(scopes[i]!))); await tick(); });
    assert.equal(f.counts().live, 4); assert.equal(f.counts().rpc, 0);
    const old = f.captured[0]!; let finish!: () => void;
    await act(async () => {
      finish = scopes[0]!.lifetime.beginRootDisposal();
      assert.equal(scopes[0]!.request.getSnapshot().signal!.aborted, true);
      old.navigate.toThread('thread'); old.navigate.openUrl('https://example.com'); old.navigate.openFile({ kind: 'thread-storage', threadId: 'thr_fixture', path: 'a' }); old.requestFull!(); old.refresh!();
      assert.equal(f.counts().navigation, 0);
      // Real React cleanup is pending: all four resources are still physically live.
      assert.equal(f.counts().live, 4); assert.equal(fifth.request.getSnapshot().state, 'queued');
      assert.equal(f.owner.counts().occupied, 4); await tick();
    });
    assert.equal(f.counts().live, 3); assert.equal(fifth.request.getSnapshot().state, 'queued');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 45)); });
    assert.equal(scopes[0]!.request.getSnapshot().state, 'stalled'); assert.equal(f.owner.counts().occupied, 4);
    assert.equal(f.counts().peak, 4); assert.ok(f.dom.window.document.querySelector('[data-fallback]'));
    await act(async () => { roots[0]!.unmount(); firstUnmounted = true; await tick(); });
    assert.equal(fifth.request.getSnapshot().state, 'queued');
    await act(async () => { finish(); await tick(); }); // Exact root disposal now acknowledged.
    assert.equal(f.counts().live, 4); assert.equal(fifth.request.getSnapshot().state, 'granted'); assert.equal(f.counts().peak, 4);
    await act(async () => { f.owner.dispose(); roots.slice(1).forEach(root => root.unmount()); await tick(); });
    roots.length = 1;
    await f.owner.whenDrained(); assert.equal(f.owner.counts().occupied, 0); assert.equal(f.counts().setups, f.counts().cleanups);
  } finally {
    await act(async () => { roots.forEach((root, i) => { if (i !== 0 || !firstUnmounted) root.unmount(); }); await tick(); });
    await f.dispose();
  }
});

test('StrictMode cleanup replay cannot acknowledge or retire a live lease; root acknowledgement waits for real cleanup', async () => {
  const f = await fixture();
  try {
    f.register(); const s = f.scope('strict', 0), lease = s.request.getSnapshot().lease!;
    await f.render(h(StrictMode, null, f.canvas(s)));
    assert.equal(s.request.getSnapshot().lease, lease); assert.equal(lease.signal.aborted, false); assert.equal(f.counts().live, 1);
    await act(async () => {
      const finish = s.lifetime.beginRootDisposal(); finish();
      assert.equal(f.owner.counts().occupied, 1); await tick();
    });
    await f.unmount(); await f.owner.whenDrained(); assert.equal(f.counts().live, 0); assert.equal(f.owner.counts().occupied, 0);
    assert.equal(f.counts().setups, f.counts().cleanups);
  } finally { await f.dispose(); }
});

test('retirement waits past child passive cleanup; layout cleanup cannot mount a fifth resource', async () => {
  const f = await fixture(); let check = false, checking = true;
  try {
    function WithCleanup(p: PresentationPropsV1) {
      useLayoutEffect(() => () => { if (checking) { check = true; assert.equal(f.owner.counts().occupied, 4); assert.equal(f.owner.counts().granted, 3); } }, []);
      useEffect(() => () => { if (checking) assert.equal(f.owner.counts().occupied, 4); }, []);
      return h('div', null, p.identity.id);
    }
    f.register(async () => WithCleanup); const scopes = Array.from({ length: 4 }, (_, i) => f.scope(`p/${i}`, i));
    await f.render(scopes.map(s => f.canvas(s)));
    let fifth!: ReturnType<typeof f.scope>;
    await act(async () => { fifth = f.scope('dialog', 8, true); await tick(); });
    await f.render([...scopes, fifth].map(s => f.canvas(s)));
    assert.equal(check, true); assert.equal(fifth.request.getSnapshot().state, 'granted');
  } finally { checking = false; await f.dispose(); }
});

test('registry/revision/retry/readiness/hide transitions release old subtree before admitting replacement', async () => {
  const f = await fixture();
  try {
    const staleDispose = f.register(), s = f.scope('one', 0); await f.render(f.canvas(s)); let lease = s.request.getSnapshot().lease!;
    for (const extra of [{ revision: 'r2' }, { revision: 'r2', retryKey: 1 }, { mode: 'full' as const }]) {
      await f.render(f.canvas(s, extra)); assert.notEqual(s.request.getSnapshot().lease, lease); lease = s.request.getSnapshot().lease!;
      assert.equal(f.counts().live, 1); assert.equal(f.counts().peak, 1);
    }
    await act(async () => { f.register(); await tick(); });
    assert.notEqual(s.request.getSnapshot().lease, lease); lease = s.request.getSnapshot().lease!;
    await act(async () => { staleDispose(); await tick(); }); assert.equal(s.request.getSnapshot().lease, lease);
    await f.render(f.canvas(s, { readyPlugins: new Set() })); assert.equal(f.counts().live, 0); assert.equal(f.owner.counts().occupied, 0);
    await f.render(f.canvas(s)); assert.equal(f.counts().live, 1);
    await act(async () => { f.owner.setHidden(true); await tick(); }); assert.equal(f.counts().live, 0); assert.equal(f.owner.counts().occupied, 0);
    await act(async () => { f.owner.setHidden(false); await tick(); }); assert.equal(f.counts().live, 1);
    assert.equal(f.counts().rpc, 0);
  } finally { await f.dispose(); }
});

test('never-ready lazy import does not require onReady to retire; late load cannot publish', async () => {
  const f = await fixture();
  try {
    let resolve!: (view: PresentationComponent) => void, ready = 0;
    f.register(() => new Promise(r => { resolve = r; })); const s = f.scope('lazy', 0);
    await f.render(f.canvas(s, { onReady: () => { ready++; } }));
    assert.equal(ready, 0); assert.equal(f.counts().live, 0); assert.equal(f.owner.counts().occupied, 1);
    await act(async () => { s.controller.abort(); await tick(); }); await f.owner.whenDrained();
    await act(async () => { resolve(() => h('div', null, 'Late canvas')); await tick(); });
    assert.equal(f.owner.counts().occupied, 0); assert.equal(ready, 0); assert.doesNotMatch(f.dom.window.document.body.textContent!, /Late canvas/);
  } finally { await f.dispose(); }
});

test('never-committed root needs actual disposal acknowledgement; stale generation cannot affect successor', async () => {
  const f = await fixture();
  try {
    f.register(); const old = f.scope('same-key', 0), lease = old.request.getSnapshot().lease!;
    const next = f.scope('same-key', 0); await f.render(f.canvas(next));
    assert.equal(lease.signal.aborted, true); assert.equal(f.owner.counts().occupied, 2);
    const finish = old.lifetime.beginRootDisposal(); old.lifetime.dispose();
    await act(async () => { await tick(); }); assert.equal(f.owner.counts().occupied, 2);
    await act(async () => { finish(); await tick(); }); assert.equal(f.owner.counts().occupied, 1);
    assert.equal(old.request.acknowledgeRetired(lease), false); assert.equal(next.request.getSnapshot().state, 'granted');
    old.controller.abort(); assert.equal(next.request.getSnapshot().signal!.aborted, false);
  } finally { await f.dispose(); }
});


test('registry replacement fences captured callbacks synchronously before React commit', async () => {
  const f = await fixture();
  try {
    f.register(); const s = f.scope('registry', 0); await f.render(f.canvas(s));
    const captured = f.captured.at(-1)!, old = s.request.getSnapshot().lease!;
    await act(async () => {
      f.register();
      captured.navigate.toThread('thr_fixture'); captured.requestFull!(); captured.refresh!();
      assert.equal(f.counts().navigation, 0); assert.equal(old.signal.aborted, true);
      await tick();
    });
    assert.equal(f.counts().live, 1); assert.equal(f.counts().peak, 1);
    f.captured.at(-1)!.navigate.toThread('thr_fixture'); assert.equal(f.counts().navigation, 1);
  } finally { await f.dispose(); }
});

test('one dialog includes held retiring dialog; dock/full transfer cannot overlap resources', async () => {
  const f = await fixture();
  try {
    f.register(); const first = f.scope('dialog/old', 10, true); await f.render(f.canvas(first, { mode: 'full' }));
    let next!: ReturnType<typeof f.scope>, finish!: () => void;
    await act(async () => {
      finish = first.lifetime.beginRootDisposal(); next = f.scope('dialog/new', 0, true); await tick();
    });
    await f.render([f.canvas(first, { mode: 'full' }), f.canvas(next, { mode: 'full' })]);
    assert.equal(f.counts().live, 0); assert.equal(next.request.getSnapshot().state, 'queued'); assert.equal(f.owner.counts().dialogs, 1);
    await act(async () => { finish(); await tick(); });
    assert.equal(f.counts().live, 1); assert.equal(f.owner.counts().dialogs, 1); assert.equal(f.counts().peak, 1);
    await act(async () => { next.request.update(priority(0)); await tick(); });
    await f.render(f.canvas(next)); assert.equal(f.owner.counts().dialogs, 0); assert.equal(f.counts().live, 1); assert.equal(f.counts().peak, 1);
  } finally { await f.dispose(); }
});

test('missing registration parks without restart loop and a public registration wakes the same request', async () => {
  const f = await fixture();
  try {
    const s = f.scope('unregistered', 0); await f.render(f.canvas(s));
    assert.equal(f.counts().live, 0); assert.equal(f.owner.counts().occupied, 0); assert.equal(s.request.getSnapshot().state, 'queued');
    await act(async () => { f.register(); await tick(); });
    assert.equal(f.counts().live, 1); assert.equal(s.request.getSnapshot().state, 'granted');
  } finally { await f.dispose(); }
});

test('public generic failure fallback and explicit retry preserve data and use a new lease', async () => {
  const f = await fixture(), originalError = console.error;
  try {
    let broken = true, ready = 0, diagnostics = 0;
    f.register(async () => () => { if (broken) throw new Error('Expected fixture renderer failure'); return h('div', null, 'Recovered pure card'); });
    console.error = () => {}; // React logs the deliberately caught boundary error.
    const s = f.scope('failure', 0), props = { onReady: () => { ready++; }, onDiagnostic: () => { diagnostics++; } };
    await f.render(f.canvas(s, props)); const lease = s.request.getSnapshot().lease!;
    assert.match(f.dom.window.document.body.textContent!, /Data card/); assert.match(f.dom.window.document.body.textContent!, /Hosted view failed/);
    assert.equal(ready, 0); assert.equal(diagnostics, 1);
    broken = false; await f.render(f.canvas(s, { ...props, retryKey: 1 }));
    assert.notEqual(s.request.getSnapshot().lease, lease); assert.match(f.dom.window.document.body.textContent!, /Recovered pure card/);
    assert.doesNotMatch(f.dom.window.document.body.textContent!, /Hosted view failed/); assert.equal(ready, 1); assert.equal(f.counts().rpc, 0);
  } finally { console.error = originalError; await f.dispose(); }
});
