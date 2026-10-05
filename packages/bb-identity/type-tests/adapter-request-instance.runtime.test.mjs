import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostAdapter, inspectForkExtension } from '../host-runtime.js';
import { createAdapterHarness } from '../testing-runtime.js';

const codec = { decode: (value) => ({ ok: true, value }), encode: (value) => value };
const persisted = 'persisted-instance';
function protocol(handle) { return { version: 1, instanceId: persisted, bindInvocation: () => ({ registration: { generation: 'g', status: 'active', dispose() {} }, handler() {} }), session: async () => handle.session, selfProfile: async () => ({ ok: false, error: { code: 'unsupported', message: 'x', retry: 'never' } }), openRequest: async () => ({ ok: true, value: handle }), accept: async () => ({ status: 'rejected', error: { code: 'unavailable', message: 'x', retry: 'never' } }), lookup: async () => ({ ok: true, value: { status: 'unknown', reason: 'unsupported' } }), provenance: async () => ({ ok: true, value: { status: 'unknown', correlation: null, reason: 'x' } }), historyContributions: async () => ({ ok: true, value: { status: 'unavailable', reason: 'unsupported' } }), historyAttempts: async () => ({ ok: true, value: { status: 'unavailable', reason: 'unsupported' } }), directorySources: () => [], participants: async () => ({ ok: false, error: { code: 'unsupported', message: 'x', retry: 'never' } }), forwardRpc: async () => undefined, registerProvider: async () => ({ ok: false, error: { code: 'unsupported', message: 'x', retry: 'never' } }), subscribe: () => () => {} }; }
function enhancedHandle(session, released) { const controller = new AbortController(); return { session, signal: controller.signal, validate: () => ({ ok: true, value: undefined }), release: () => released.push(true), scope: { signal: controller.signal, validate: () => ({ ok: true }), release() {} } }; }
test('enhanced open request releases and rejects a persisted-instance mismatch', async () => {
  const harness = createAdapterHarness({ mode: 'multi-user', instanceId: 'upstream', inputCodec: codec }); const ready = await harness.upstream.session(harness.request()); const released = []; const handle = enhancedHandle({ ...ready, instanceId: 'wrong' }, released);
  const host = createHostAdapter({ upstream: harness.upstream, extension: inspectForkExtension(protocol(handle)) }); const result = await host.openPersonRequest(harness.request());
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'incompatible'); assert.equal(released.length, 1);
});
test('enhanced open request yields a valid matching persisted instance without release', async () => {
  const harness = createAdapterHarness({ mode: 'multi-user', instanceId: 'upstream', inputCodec: codec }); const ready = await harness.upstream.session(harness.request()); const released = []; const handle = enhancedHandle({ ...ready, instanceId: persisted }, released);
  const host = createHostAdapter({ upstream: harness.upstream, extension: inspectForkExtension(protocol(handle)) }); const result = await host.openPersonRequest(harness.request());
  assert.equal(result.ok, true); assert.equal(released.length, 0); if (result.ok) result.value.release();
});
