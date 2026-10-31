import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { useEffect, useState } from 'react';
import { z } from 'zod';
import { definePluginApp } from '@get-bb/plugin-sdk/app';
import { registerPresentation, lookupPresentation } from '@phosphorco/bb-context-recognition/presentation';
import { runResultPresentationConformance } from '../src/testing-react.tsx';
const block = { identity: { provider: 'threads', id: 'thr_referenced', kind: 'thread' }, fallback: { kind: 'card', title: 'Thread purpose', description: 'Investigate results', fields: [{ label: 'Status', value: 'Working' }] }, navigation: { kind: 'thread', threadId: 'thr_referenced' }, layout: { preferred: 'compact' }, presentation: { schema: 'kit-visual/thread@1', data: { id: 'thr_referenced' } } };
function options(broken = false) {
  let active = 0;
  function ThreadCard(props) {
    const [title, setTitle] = useState('Loading thread');
    useEffect(() => {
      active++; let live = true; const controller = new AbortController();
      props.owner.call('thread-card', { id: props.identity.id }, controller.signal).then(value => { if (live) setTitle(value.title); }, () => {});
      return () => { live = false; controller.abort(); active--; };
    }, [props.owner, props.identity.id]);
    if (broken) throw Error('Actual fixture renderer failed');
    return React.createElement('article', null, title, React.createElement('button', { onClick: () => props.navigate.toThread(props.identity.id) }, 'Open thread'));
  }
  return { pluginId: 'kit-visual', source: { entry: 'package-self-test-content-script', revision: '1' }, sourcePorts: {}, observeActiveResources: () => active,
    participantFactory(bb) { bb.rpc.register({ 'thread-card': { input: z.strictObject({ id: z.string() }), output: z.object({ title: z.string() }) } }, { 'thread-card': input => { assert.equal(input.id, 'thr_referenced'); return { title: 'Referenced thread card' }; } }); },
    appDefinition: () => definePluginApp(app => { app.contentScripts.register({ id: 'thread-card', mount: context => registerPresentation(context, { schema: 'kit-visual/thread@1', methods: ['thread-card'], label: 'Thread card', decode: data => data && typeof data.id === 'string' ? data : null, load: async () => ThreadCard }) }); }),
    cases: [{ name: 'referent-without-occurrence', loadContent: () => structuredClone(block), expect: { schema: 'kit-visual/thread@1', text: 'Referenced thread card', state: broken ? 'fallback' : 'ready', ...(broken ? { failure: 'render' } : {}) }, modes: ['docked', 'full'], async verify({ element, ownerCalls }) {
      if (broken) return;
      // onReady is a commit observation; wait for the actual owner read separately.
      const end = performance.now() + 500;
      while (!element.textContent.includes('Referenced thread card') && performance.now() < end) { const { act } = await import('react'); await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
      assert.ok(element.textContent.includes('Referenced thread card'));
      assert.ok(ownerCalls.some(call => call.pluginId === 'kit-visual' && call.method === 'thread-card'));
    } }],
  };
}
test('actual app content script, existing CR host and owner handlers render a referent without any source event', async () => {
  const value = options();
  const report = await runResultPresentationConformance(value);
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(lookupPresentation('kit-visual', 'kit-visual/thread@1'), undefined);
  assert.equal(value.observeActiveResources(), 0);
});
test('failing actual renderer preserves data fallback and open-thread navigation, then disposes registration', async () => {
  const report = await runResultPresentationConformance(options(true));
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.ok(report.checks.some(check => check.name.endsWith('disabled-data-navigation') && check.state === 'passed'));
});
test('missing actual content witnesses cannot pass presentation conformance', async () => {
  const value = options(); value.cases = [];
  const report = await runResultPresentationConformance(value); assert.equal(report.passed, false);
});
