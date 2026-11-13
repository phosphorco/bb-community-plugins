// Independent PR12 review regressions; retain adversarial await ordering.
import { expect, test } from 'bun:test';
import { createIdentityClient, createIdentityFetchConnection, createIdentityClientTransport } from '../client-runtime.ts';
import { createNativeIdentityConnection } from '../bb-client-connection-runtime.ts';
const ok=value=>({ok:true,value});
const session=(actor='a')=>({status:'ready',instanceId:'instance',mode:'multi-user',stamp:actor+'1',actor:{identity:{kind:'person',key:'issuer:'+actor,issuer:'issuer',subject:actor},presentation:{displayName:actor,handle:null,avatarUrl:null},evidence:'provider-verified'},capabilities:{requestIdentity:'host-resolved',acceptance:'transactional-check',forwarding:'host-bound',directory:{search:false,lookup:false},participants:false,externalSend:'structured',toolProvenance:'causal',operationLookup:true}});
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{resolve,reject,promise};};
const delayMicrotasks=(n,fn)=>{if(n)queueMicrotask(()=>delayMicrotasks(n-1,fn));else fn();};
test('native: a direct B bootstrap between client verification and commit retires A',async()=>{
 const verify=deferred(),direct=deferred();let call=0;const ready=[];
 const native=createNativeIdentityConnection({realtimeState:'connected',rpc:{call:async()=>{call++;if(call===1)return ok(session());return call===2?verify.promise:direct.promise;}}});
 await native.connection.revalidateSession();const client=createIdentityClient({connection:native.connection});
 client.subscribe(()=>{if(client.getSnapshot().status==='ready')ready.push({actor:client.getSnapshot().actor.identity.key,generation:native.connection.getHealth().generation});});
 try{
  const refresh=client.start();const directBootstrap=native.connection.request('bb-identity/v1/bootstrap',{});
  verify.resolve(ok(session()));delayMicrotasks(4,()=>direct.resolve(ok(session('b'))));
  const result=await refresh;await directBootstrap;
  expect(result.ok).toBe(false);
  expect(ready).toEqual([]);
  expect(client.currentSession().ok).toBe(false);
 }finally{client.dispose();native.dispose();}
});
test('fetch: a direct B bootstrap retires an older pending A verification',async()=>{
 const root=new AbortController(),held=deferred();let calls=0;
 const connection=createIdentityFetchConnection({endpoint:new URL('https://fixture.invalid/http/'),signal:root.signal,fetch:async()=>{calls++;return new Response(JSON.stringify(calls===2?await held.promise:ok(session(calls===1?'a':'b'))));}});
 const client=createIdentityClient({connection});
 try{
  await connection.revalidateSession();const pending=client.start();
  expect((await createIdentityClientTransport(connection).bootstrap()).value.actor.identity.key).toBe('issuer:b');
  held.resolve(ok(session()));
  expect((await pending).ok).toBe(false);
  expect(client.currentSession().ok).toBe(false);
 }finally{client.dispose();connection.dispose();root.abort();}
});
test('fetch: rejection of an invalidated A flight cannot demote already recovered B',async()=>{
 const root=new AbortController(),held=deferred();let calls=0;
 const connection=createIdentityFetchConnection({endpoint:new URL('https://fixture.invalid/http/'),signal:root.signal,fetch:async url=>{if(!String(url).endsWith('bootstrap'))throw Error('identity route failed');calls++;return new Response(JSON.stringify(calls===2?await held.promise:ok(session(calls===1?'a':'b'))));}});
 const client=createIdentityClient({connection});
 try{
  await client.start();const old=connection.revalidateSession();
  await expect(connection.request('bb-identity/v1/selfProfile',{})).rejects.toThrow();
  await client.refresh();for(let i=0;i<30;i++)await Promise.resolve();expect(client.currentSession().value.actor.identity.key).toBe('issuer:b');
  held.reject(Error('old verification failed'));expect((await old).ok).toBe(false);
  expect(client.currentSession()).toMatchObject({ok:true,value:{actor:{identity:{key:'issuer:b'}}}});
 }finally{client.dispose();connection.dispose();root.abort();}
});

function directFixture(kind) {
  let response = ok(session());
  const held = new Map();
  const root = new AbortController();
  const read = async method => {
    const route = method.endsWith('bootstrap') ? 'bootstrap' : method.includes('selfProfile') ? 'profile' : 'state';
    const gate = held.get(route);
    if (gate) { held.delete(route); return gate.promise; }
    return response;
  };
  const native = kind === 'native' ? createNativeIdentityConnection({ realtimeState: 'connected', rpc: { call: read } }) : null;
  const connection = native?.connection ?? createIdentityFetchConnection({
    endpoint: new URL('https://fixture.invalid/http/'), signal: root.signal,
    fetch: async url => new Response(JSON.stringify(await read(String(url)))),
  });
  const client = createIdentityClient({ connection });
  return { connection, client, transport: createIdentityClientTransport(connection),
    respond(value) { response = value; },
    hold(route = 'bootstrap') { const gate = deferred(); held.set(route, gate); return gate; },
    close() { client.dispose(); connection.dispose(); root.abort(); },
  };
}
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

for (const kind of ['native', 'fetch']) {
  test(`${kind}: first direct authority retires a pending verification even without earlier verified facts`, async () => {
    const f = directFixture(kind);
    try {
      const gate = f.hold(); const pending = f.client.start();
      f.respond(ok(session('b')));
      expect((await f.transport.bootstrap()).value.actor.identity.key).toBe('issuer:b');
      gate.resolve(ok(session('a')));
      expect((await pending).ok).toBe(false);
      expect(f.client.currentSession().ok).toBe(false);
    } finally { f.close(); }
  });

  test(`${kind}: same-stamp capability reload retires returned and pending handoffs without retiring unchanged state work`, async () => {
    const f = directFixture(kind);
    try {
      const verified = await f.connection.revalidateSession();
      const state = f.hold('state');
      const stateRequest = f.connection.request('bb-identity/v1/state/save', {});
      const verification = f.hold(); const pending = f.connection.revalidateSession();
      const next = session(); next.capabilities.directory.lookup = true;
      f.respond(ok(next));
      const direct = await f.transport.bootstrap();
      expect(direct.value.capabilities.directory.lookup).toBe(true);
      expect(f.connection.getHealth().generation).not.toBe(verified.value.generation);
      verification.resolve(ok(session()));
      expect((await pending).ok).toBe(false);
      state.resolve(ok({ unchanged: true }));
      expect(await stateRequest).toEqual(ok({ unchanged: true }));
      await f.client.start(); await settle();
      expect(f.client.currentSession().value.capabilities.directory.lookup).toBe(true);
    } finally { f.close(); }
  });

  for (const denial of ['error', 'nonready', 'malformed']) {
    test(`${kind}: direct ${denial} bootstrap retires old authority and recovery reads afresh`, async () => {
      const f = directFixture(kind);
      try {
        const verified = await f.connection.revalidateSession();
        const gate = f.hold(); const pending = f.client.start();
        const error = { code: 'unauthenticated', message: 'direct access denied', retry: 'after-refresh' };
        f.respond(denial === 'error' ? { ok: false, error } : denial === 'nonready' ? ok({ status: 'unauthenticated', error }) : ok({ malformed: true }));
        const direct = await f.transport.bootstrap();
        expect(!direct.ok || direct.value.status !== 'ready').toBe(true);
        expect(f.connection.getHealth().identity.status).toBe('unavailable');
        expect(f.connection.getHealth().generation).not.toBe(verified.value.generation);
        gate.resolve(ok(session()));
        expect((await pending).ok).toBe(false);
        expect(f.client.currentSession().ok).toBe(false);
        f.respond(ok(session('b'))); await f.client.refresh(); await settle();
        expect(f.client.currentSession().value.actor.identity.key).toBe('issuer:b');
      } finally { f.close(); }
    });
  }

  test(`${kind}: rejected old direct route cannot demote recovered B`, async () => {
    const f = directFixture(kind);
    try {
      await f.client.start();
      const gate = f.hold('profile'); const old = f.connection.request('bb-identity/v1/selfProfile', {});
      f.respond(ok(session('b'))); await f.transport.bootstrap();
      await f.client.refresh(); await settle();
      gate.reject(Error('old direct request failed'));
      await expect(old).rejects.toThrow('old direct request failed');
      expect(f.client.currentSession()).toMatchObject({ ok: true, value: { actor: { identity: { key: 'issuer:b' } } } });
    } finally { f.close(); }
  });

  test(`${kind}: obsolete verification rejection after direct B cannot replace B health`, async () => {
    const f = directFixture(kind);
    try {
      await f.client.start();
      const gate = f.hold(); const old = f.connection.revalidateSession();
      f.respond(ok(session('b'))); await f.transport.bootstrap();
      await f.client.refresh(); await settle();
      gate.reject(Error('obsolete verification failed'));
      expect((await old).ok).toBe(false);
      expect(f.client.currentSession()).toMatchObject({ ok: true, value: { actor: { identity: { key: 'issuer:b' } } } });
    } finally { f.close(); }
  });
}

for (const kind of ['native', 'fetch']) test(`${kind}: an older direct A response cannot supersede the newer direct B bootstrap`, async () => {
  const f = directFixture(kind);
  try {
    await f.client.start();
    const gate = f.hold(); const old = f.transport.bootstrap();
    f.respond(ok(session('b'))); await f.transport.bootstrap();
    await f.client.refresh(); await settle();
    gate.resolve(ok(session('a')));
    expect((await old).ok).toBe(false);
    expect(f.client.currentSession()).toMatchObject({ ok: true, value: { actor: { identity: { key: 'issuer:b' } } } });
  } finally { f.close(); }
});
