import { expect, test } from 'bun:test';
import { bindBbIdentityRpcFoundation } from '../bb-runtime.ts';
const schema = { '~standard': { version: 1, vendor: 'proof', validate: value => ({ value }) } };
const contract = { proof: { input: schema, output: schema } };
function host() {
  const registrations = []; const native = []; const hooks = []; const context = { request: {}, scope: { requestId: 'request' } };
  let failBind = 0; let failRegister = false;
  const raw = {
    version: 1, instanceId: 'persisted-instance', session: async () => undefined, selfProfile: async () => undefined, openRequest: async () => undefined,
    accept: async () => undefined, lookup: async () => undefined, provenance: async () => undefined,
    historyContributions: async () => undefined, historyAttempts: async () => undefined, directorySources: () => [], participants: async () => undefined,
    forwardRpc: async () => undefined, registerProvider: async () => undefined, subscribe: () => () => {},
    bindInvocation({ routeClass, handler }) {
      if (failBind && registrations.length + 1 === failBind) throw Error('bind failed');
      let disposed = false; let count = 0;
      const registration = { generation: `g-${registrations.length}`, get status() { return disposed ? 'retired' : 'active'; }, dispose() { disposed = true; count++; } };
      const bound = input => { if (disposed) throw Error('retired'); return handler(context, input); };
      registrations.push({ registration, bound, routeClass, count: () => count }); return { registration, handler: bound };
    },
  };
  return { raw, native, registrations, hooks, context, set failBind(n) { failBind = n; }, set failRegister(v) { failRegister = v; },
    api: { experimental_p6rIdentity: raw, rpc: { register(c, h) { native.push({ c, h }); if (failRegister) throw Error('native registration failed'); } }, onDispose(f) { hooks.push(f); } } };
}
const handlers = { proof: { origin: 'interactive-user', handle: (input, context) => ({ input, request: context.scope.requestId }) } };
test('RPC foundation preserves native binding and retires only its owned registrations', () => {
  const fake = host(); const result = bindBbIdentityRpcFoundation(fake.api); expect(result.ok).toBe(true); const foundation = result.value;
  expect(foundation.instanceId).toBe('persisted-instance'); expect(foundation.register(contract, handlers).ok).toBe(true);
  expect(fake.native[0].h.proof).toBe(fake.registrations[0].bound); expect(fake.registrations[0].routeClass).toBe('interactive-session');
  expect(fake.native[0].h.proof('hello')).toEqual({ input: 'hello', request: 'request' });
  foundation.dispose(); foundation.dispose(); fake.hooks[0](); expect(fake.registrations[0].count()).toBe(1);
  expect(() => fake.native[0].h.proof('late')).toThrow(); expect(foundation.register(contract, handlers).ok).toBe(false);
});
test('failed batch registration cleans its handles while prior registration remains live', () => {
  const fake = host(); const foundation = bindBbIdentityRpcFoundation(fake.api).value;
  expect(foundation.register(contract, handlers).ok).toBe(true); fake.failRegister = true;
  expect(foundation.register(contract, handlers).ok).toBe(false); expect(fake.registrations[1].count()).toBe(1);
  expect(fake.registrations[0].bound('old')).toEqual({ input: 'old', request: 'request' });
  fake.hooks[0](); expect(fake.registrations[0].count()).toBe(1); expect(fake.registrations[1].count()).toBe(1);
});
test('partial binding and invalid descriptors never leak a usable new registration', () => {
  const fake = host(); const foundation = bindBbIdentityRpcFoundation(fake.api).value;
  expect(foundation.register(contract, {}).ok).toBe(false); expect(fake.registrations).toHaveLength(0);
  expect(foundation.register(contract, { proof: { ...handlers.proof, origin: 'forged' } }).ok).toBe(false);
  fake.failBind = 2;
  expect(foundation.register({ ...contract, other: contract.proof }, { ...handlers, other: handlers.proof }).ok).toBe(false);
  expect(fake.native).toHaveLength(0); expect(fake.registrations[0].count()).toBe(1);
});
test('absence and incompatible enhanced discovery remain distinct', () => {
  const fake = host(); const absent = bindBbIdentityRpcFoundation({ ...fake.api, experimental_p6rIdentity: undefined });
  expect(absent.error.code).toBe('unsupported');
  const bad = bindBbIdentityRpcFoundation({ ...fake.api, experimental_p6rIdentity: { version: 2 } });
  expect(bad.error.code).toBe('incompatible'); expect(fake.hooks).toHaveLength(0);
});
