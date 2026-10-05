import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createAdapterHarness } from '../testing-runtime.ts';
import { createHostAdapter, inspectForkExtension } from '../host-runtime.ts';
import { createIdentityServer } from '../server-runtime.ts';
import { bindBbIdentityRpcFoundation } from '../bb-runtime.ts';
import { createIdentityStateRpcBridge, identityStateRpcMethods } from '../state-rpc-runtime.ts';
const ok = value => ({ ok: true, value });
const error = code => ({ ok: false, error: { code, message: code, retry: 'never' } });
const codec = { decode: value => typeof value === 'string' ? ok(value) : error('invalid-input'), encode: value => value };
const def = { collection: 'preferences', schemaVersion: 1, codec, initialValue: () => '', equal: (a,b) => a === b };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
async function fixture(readPolicy) {
  const h = createAdapterHarness({ mode: 'multi-user', instanceId: 'persisted-state', pluginId: 'feature', inputCodec: codec });
  const native = {}; let current; let released = 0; let pauseOpen = null;
  const protocol = { version: 1, instanceId: 'persisted-state',
    bindInvocation: ({ handler }) => ({ registration: { generation: 'g', status: 'active', dispose() {} }, handler: value => handler({ request: current, scope: {} }, value) }),
    session: h.upstream.session, selfProfile: h.upstream.selfProfile,
    async openRequest(context) { if (pauseOpen) { const gate = pauseOpen; pauseOpen = null; gate.entered.resolve(); await gate.release.promise; } const opened = await h.upstream.openScope(context); if (!opened.ok) return opened;
      return ok({ ...opened.value, scope: { requestId: context.id, generation: 'g', signal: opened.value.signal, validate: () => ({ ok: true }), release() {} }, release() { released++; opened.value.release(); } }); },
    accept: async () => error('unsupported'), lookup: async () => ok({ status: 'unknown', reason: 'unsupported' }), provenance: async () => ok({ status: 'unknown', correlation: null, reason: 'unused' }),
    historyContributions: async () => ok({ status: 'unavailable', reason: 'unsupported' }), historyAttempts: async () => ok({ status: 'unavailable', reason: 'unsupported' }),
    participants: async () => error('unsupported'), forwardRpc: async () => undefined, registerProvider: async () => error('unsupported'), subscribe: () => () => {}, directorySources: () => [],
  };
  const rpc = bindBbIdentityRpcFoundation({ experimental_p6rIdentity: protocol, onDispose() {}, rpc: { register(c, handlers) { for (const name of Object.keys(c)) { if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(name)) throw Error('invalid native method'); native[name] = handlers[name]; } } } }).value;
  const host = createHostAdapter({ upstream: h.upstream, extension: inspectForkExtension(protocol) }); const server = createIdentityServer({ host: { ...host, directory: { ...host.directory, getMany: async ({ keys }) => ok(keys.map(key => ({ status: 'found', profile: { identity: { kind: 'person', key, issuer: 'fixture', subject: key }, presentation: { displayName: key, handle: null, avatarUrl: null } } }))) } } });
  const published = []; const bridge = createIdentityStateRpcBridge({ rpc, server, pluginId: host.pluginId, publish: e => published.push(e) }).value;
  const session = await server.session(h.request()); const expected = { actor: session.actor.identity.key, session: session.stamp };
  const address = { instanceId: server.instanceId, pluginId: host.pluginId, collection: 'preferences', recordId: 'appearance', owner: expected.actor };
  const db = new Database(':memory:'); db.exec('CREATE TABLE state (id INTEGER PRIMARY KEY, value TEXT)'); let commits = 0; let paused = null;
  const storage = { boundary: 'same-process-synchronous', receiptRetentionMs: 60000,
    async read(a) { const row = db.query('SELECT value FROM state WHERE id=1').get(); return ok(row ? { status: 'present', envelope: JSON.parse(row.value) } : { status: 'empty', address: a, version: { epoch: 'empty', sequence: 0 } }); },
    async commit({ mutation, validateAtCommit }) { commits++; if (paused) { const gate=paused; paused=null; gate.entered.resolve(); await gate.release.promise; }
      return db.transaction(() => { const live=validateAtCommit(); if(!live.ok) return live; const envelope={ address: mutation.address, version:{epoch:'empty',sequence:1},schemaVersion:1,value:mutation.value,lastEditedBy:live.value };
        db.query('INSERT OR REPLACE INTO state VALUES (1,?)').run(JSON.stringify(envelope)); return ok({status:'saved', envelope, operationId:mutation.operationId}); }).immediate(); },
    async reconcile() { return ok({status:'unknown',reason:'expired'}); },
  };
  const resource = { pluginId: host.pluginId, definition: def }; const registered=bridge.register({resource,storage,policy:{kind:'self-only'},readPolicy}); expect(registered.ok).toBe(true);
  return { bridge, rpc, server, db, h, published, registered:registered.value, storage, resource, expected, address, get released(){return released;}, get commits(){return commits;},
    pauseCommit(){paused={entered:deferred(),release:deferred()};return paused;}, pauseOpen(){pauseOpen={entered:deferred(),release:deferred()};return pauseOpen;},
    request(action, input) { current = h.request(); const request=current; return { request, result:native[identityStateRpcMethods[`bb-identity/v1/state/${action}`]](input) }; },
    mutation(value='dark'){return {kind:'replace',address:{...address},expected:{...expected},expectedVersion:{epoch:'empty',sequence:0},ownerSession:'owner-1',localGeneration:1,operationId:'operation-1',schemaVersion:1,value};},
    close(){bridge.dispose();rpc.dispose();server.dispose();host.dispose();db.close();},
  };
}
test('native dotted state routes load and save through a real issued target and SQLite commit', async () => {
  const f=await fixture(); try {
    const load=await f.request('load',{address:f.address,expected:f.expected}).result; expect(load).toMatchObject({ok:true,value:{status:'empty'}});
    const saved=await f.request('save',f.mutation()).result; expect(saved.ok).toBe(true); expect(saved.value.envelope.value).toBe('dark'); expect(saved.value.envelope.lastEditedBy.identity.key).toBe(f.expected.actor);
    expect(f.published).toHaveLength(1); expect(f.released).toBe(2); const read=await f.request('load',{address:f.address,expected:f.expected}).result; expect(read.value.envelope.value).toBe('dark');
  } finally { f.close(); }
});
test('foreign address, stale expectation, wrong value and owner never reach commit', async () => {
  const f=await fixture(); try {
    for(const patch of [{address:{...f.address,pluginId:'other'}},{address:{...f.address,instanceId:'other'}},{address:{...f.address,collection:'other'}},{expected:{...f.expected,session:'stale'}},{address:{...f.address,owner:'other-person'}},{value:42}]){
      const r=await f.request('save',{...f.mutation(),...patch}).result; expect(r.ok).toBe(false);
    }
    expect(f.commits).toBe(0); expect(f.db.query('SELECT * FROM state').all()).toHaveLength(0);
    expect(f.bridge.register({resource:f.resource,storage:f.storage,policy:{kind:'self-only'}}).ok).toBe(false);
  } finally { f.close(); }
});
test('host-encoded stamps reach exact session comparison, not slug rejection', async () => {
  const f = await fixture();
  try {
    const expected = { ...f.expected, session: 'p6r-session:v1:person%3Acole:provider%3Ageneration' };
    for (const action of ['load', 'save', 'reconcile']) {
      const result = await f.request(action, { ...f.mutation(), expected }).result;
      expect(result.ok).toBe(false);
      expect(result.error.code).not.toBe('invalid-input');
    }
    expect(f.commits).toBe(0);
  } finally { f.close(); }
});
test('resource retirement fences a paused commit and old cleanup cannot remove replacement', async () => {
  const f=await fixture(); try {
    const gate=f.pauseCommit(); const pending=f.request('save',f.mutation()); await gate.entered.promise; f.registered.dispose();
    const next=f.bridge.register({resource:f.resource,storage:f.storage,policy:{kind:'self-only'}}); expect(next.ok).toBe(true); f.registered.dispose(); gate.release.resolve();
    expect((await pending.result).ok).toBe(false); expect(f.db.query('SELECT * FROM state').all()).toHaveLength(0);
    expect((await f.request('save',f.mutation()).result).ok).toBe(true); expect(f.published).toHaveLength(1);
  } finally { f.close(); }
});
test('mutation is captured before admission await and request abort fences transaction', async () => {
  const f=await fixture(); try {
    const gate=f.pauseOpen(); const mutation=f.mutation(); const pending=f.request('save',mutation); await gate.entered.promise;
    mutation.value='changed'; mutation.address.owner='changed'; gate.release.resolve(); const saved=await pending.result; expect(saved.ok).toBe(true); expect(saved.value.envelope.value).toBe('dark');
    const commit=f.pauseCommit(); const aborted=f.request('save',f.mutation('later')); await commit.entered.promise; f.h.abort(aborted.request); commit.release.resolve(); expect((await aborted.result).ok).toBe(false);
    expect(JSON.parse(f.db.query('SELECT value FROM state').get().value).value).toBe('dark');
  } finally { f.close(); }
});

test('collaborator reads do not grant collaborator writes and default reads stay self-only', async () => {
  for (const readPolicy of [undefined, {kind:'collaborators'}]) {
    const f=await fixture(readPolicy); try {
      const foreignAddress={...f.address,owner:'other-person'};
      const read=await f.request('load',{address:foreignAddress,expected:f.expected}).result;
      expect(read.ok).toBe(readPolicy !== undefined);
      if(read.ok) expect(read.value.address.owner).toBe('other-person');
      const write=await f.request('save',{...f.mutation(),address:foreignAddress}).result;
      expect(write.ok).toBe(false); expect(f.commits).toBe(0);
      expect(f.db.query('SELECT * FROM state').all()).toHaveLength(0);
    } finally { f.close(); }
  }
});
