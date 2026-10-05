import { expect, test } from 'bun:test';
import { createDraftRetirementOwner } from '../draft-retirement-runtime.ts';

const ok = value => ({ ok: true, value });
const failure = { ok: false, error: { code: 'unavailable', message: 'checkpoint failed', retry: 'after-refresh' } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const scope = { address: { instanceId: 'host', pluginId: 'feature', collection: 'sections', recordId: 'one', owner: 'issuer:a' }, actor: 'issuer:a', schemaVersion: 1 };

test('retirement waits only for the same explicit owner, storage and complete resource scope', async () => {
  const owner = createDraftRetirementOwner(); const otherRoot = createDraftRetirementOwner(); const storage = {};
  const task = deferred(); owner.begin(storage, scope, task.promise);
  let finished = false; const same = owner.wait(storage, structuredClone(scope)).then(result => { finished = true; return result; });
  for (const other of [
    { ...scope, address: { ...scope.address, pluginId: 'other-feature' } },
    { ...scope, address: { ...scope.address, collection: 'other-collection' } },
    { ...scope, address: { ...scope.address, recordId: 'other-record' } },
    { ...scope, address: { ...scope.address, owner: 'issuer:b' } },
    { ...scope, actor: 'issuer:b' }, { ...scope, schemaVersion: 2 },
  ]) expect(await owner.wait(storage, other)).toEqual(ok(undefined));
  expect(await owner.wait({}, scope)).toEqual(ok(undefined));
  expect(await otherRoot.wait(storage, scope)).toEqual(ok(undefined));
  expect(finished).toBe(false); task.resolve(ok(undefined));
  expect(await same).toEqual(ok(undefined)); expect(await owner.wait(storage, scope)).toEqual(ok(undefined));
  owner.dispose(); otherRoot.dispose();
});

test('cancelled recovery and provider disposal leave accepted preservation work running', async () => {
  const owner = createDraftRetirementOwner(); const storage = {}; const task = deferred(); let completed = false;
  owner.begin(storage, scope, task.promise.then(result => { completed = true; return result; }));
  const controller = new AbortController(); const cancelled = owner.wait(storage, scope, controller.signal);
  const peer = owner.wait(storage, scope); controller.abort();
  expect(await cancelled).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  expect(completed).toBe(false); owner.dispose();
  expect(await peer).toMatchObject({ ok: false, error: { code: 'disposed' } });
  expect(completed).toBe(false); task.resolve(ok(undefined)); await task.promise; await Promise.resolve();
  expect(completed).toBe(true); owner.dispose();
});

test('failed preservation settles the barrier so durable recovery remains reachable', async () => {
  const owner = createDraftRetirementOwner(); const storage = {}; const first = deferred();
  owner.begin(storage, scope, first.promise); const waiting = owner.wait(storage, scope);
  first.resolve(failure); expect(await waiting).toEqual(ok(undefined));
  const second = deferred(); owner.begin(storage, scope, second.promise);
  let finished = false; const recovery = owner.wait(storage, scope).then(result => { finished = true; return result; });
  await Promise.resolve(); expect(finished).toBe(false);
  second.resolve(ok(undefined)); expect(await recovery).toEqual(ok(undefined)); owner.dispose();
});
