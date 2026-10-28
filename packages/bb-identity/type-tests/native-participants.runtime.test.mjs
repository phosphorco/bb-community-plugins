/** Actual public /bb binding with structural public SDK native ports; synthetic, no live-host claim. */
import { expect, test } from 'bun:test';
import { bindBbIdentity } from '@phosphorco/bb-identity/bb';
import { identityRpcMethods, identityRoutes } from '../rpc-routes-runtime.ts';

const ok = value => ({ ok: true, value });
const unavailable = () => ok({ status: 'unavailable', reason: 'missing-history' });
const person = name => ({ evidence: 'provider-verified', identity: { kind: 'person', key: `person:${name}`, issuer: 'retained-provider', subject: name }, presentation: { displayName: name, handle: `${name}@example.test`, avatarUrl: null } });
const cole = person('Cole');
cole.identity.key = 'p6r-person:v1:identity-boundaries%2Ftailnet:7687404831074587';
cole.identity.issuer = 'identity-boundaries/tailnet'; cole.identity.subject = '7687404831074587';
const machine = { evidence: 'machine', identity: { kind: 'machine', key: 'machine:bb', instanceId: 'instance', hostId: 'host' }, presentation: { displayName: 'BB machine', handle: null, avatarUrl: null } };
const editor = person('editor'), mentioned = person('mentioned');
const external = { evidence: 'integration-asserted', identity: { kind: 'external', key: 'external:slack:U1', pluginId: 'slack', subject: 'U1' }, presentation: { displayName: 'Slack sender', handle: 'sender', avatarUrl: null } };
const mention = actor => ({ identity: actor.identity, presentation: actor.presentation, source: { pluginId: 'former-provider', generation: 'retired-generation' } });
const event = (seq, authors = [cole], editors, mentions) => ({ id: `evt-${seq}`, threadId: 'target', seq, type: 'client/turn/requested', data: { requestId: `request-${seq}`, ...(authors === undefined ? {} : { p6rAuthors: authors }), ...(editors === undefined ? {} : { p6rEditors: editors }), ...(mentions === undefined ? {} : { p6rMentionedTargets: mentions }) } });
const member = actor => ({ p6rPrincipalKey: actor.identity.key, p6rIdentityKind: actor.identity.kind, p6rDisplayName: actor.presentation.displayName, p6rImageUrl: actor.presentation.avatarUrl });
const contribution = (id, author = external, latestEditor = editor) => ({ reference: { threadId: 'target', contributionId: id }, author: { kind: author.identity.kind, actor: author }, latestEditor, acceptedAt: '2026-10-27T00:00:00.000Z', mentionedPeople: [] });
const page = (items, nextCursor = null, status = 'known') => ok({ status, items, nextCursor, traversal: nextCursor ? 'continued' : 'complete', missing: [] });
const deferred = () => { let resolve; const promise = new Promise(next => { resolve = next; }); return { promise, resolve }; };

function fixture({ rows = [event(1)], members = [cole], history = unavailable, sdkDelay = 0 } = {}) {
  const calls = { events: [], facets: [], history: [], brokenParticipants: 0, providers: 0, eventBytes: 0 };
  const handlers = new Map(), disposers = [];
  const protocol = {
    version: 1, instanceId: 'instance',
    bindInvocation({ handler }) { return { registration: { generation: 'rpc', status: 'active', dispose() {} }, handler: input => { const controller = new AbortController(); return handler({ request: {}, scope: { signal: controller.signal, release() { controller.abort(); } } }, input); } }; },
    async session() { return { status: 'unavailable', instanceId: 'instance', error: { code: 'unavailable', message: 'no actor needed', retry: 'never' } }; },
    async openRequest() { throw Error('participants must not resolve current person'); }, async selfProfile() { throw Error('participants must not resolve current profile'); },
    async accept() { throw Error('read only'); }, async lookup() { throw Error('read only'); }, async provenance() { throw Error('read only'); },
    async historyContributions(query, options) { calls.history.push({ ...query, signal: options?.signal }); return history(query, options); },
    async historyAttempts() { throw Error('unneeded attempts'); },
    directorySources() { calls.providers++; throw Error('historical actors must not resolve providers'); },
    async participants() { calls.brokenParticipants++; return ok({ items: [], nextCursor: null, revision: 'broken', coverage: 'partial-history' }); },
    async forwardRpc() { return null; }, async registerProvider() { throw Error('no provider needed'); }, subscribe() { return () => {}; },
  };
  const threads = {
    async send() { throw Error('read only'); },
    async facetParticipants(args) {
      calls.facets.push(args);
      if (sdkDelay) await new Promise(resolve => setTimeout(resolve, sdkDelay));
      const all = f.members.map(actor => actor.p6rPrincipalKey ? actor : member(actor));
      const offset = Number(args.cursor ?? 0), profiles = all.slice(offset, offset + args.pageSize);
      return { profiles: structuredClone(profiles), totalCount: all.length, nextCursor: offset + profiles.length < all.length ? String(offset + profiles.length) : null };
    },
    events: { async list(args) {
      calls.events.push(args);
      if (Number(args.limit) > 100) throw Error('Thread event limit cannot exceed 100');
      if (sdkDelay) await new Promise(resolve => setTimeout(resolve, sdkDelay));
      const sorted = f.rows.filter(row => row.seq > Number(args.afterSeq ?? 0) && row.seq < Number(args.beforeSeq ?? Number.MAX_SAFE_INTEGER)).sort((a, b) => args.order === 'desc' ? b.seq - a.seq : a.seq - b.seq);
      const result = structuredClone(sorted.slice(0, Number(args.limit)));
      calls.eventBytes += new TextEncoder().encode(JSON.stringify(result)).byteLength;
      return result;
    } },
  };
  const f = { rows, members, calls, threads, protocol };
  const bb = { pluginId: 'consumer', experimental_p6rIdentity: protocol, sdk: { threads, plugins: { async callRpc() {} } }, rpc: { register(contract, wrapped) { for (const key of Object.keys(contract)) handlers.set(key, wrapped[key]); } }, realtime: { publish() {} }, onDispose(fn) { disposers.push(fn); } };
  f.bb = bb;
  f.bind = () => { const result = bindBbIdentity(bb); expect(result.ok).toBe(true); return result.value; };
  f.rpc = input => handlers.get(identityRpcMethods[identityRoutes.participants])(input);
  f.list = (binding, input = {}) => binding.background(invocation => binding.endpoint.participants(invocation, { threadId: 'target', limit: 100, ...input }));
  f.preview = (binding, limit = 1) => binding.background(invocation => binding.endpoint.participantPreviews(invocation, { threadIds: ['target'], perThreadLimit: limit }));
  f.disposePlugin = () => disposers.forEach(fn => fn());
  return f;
}

test('129 native-only requests retain Cole with no contributions through public /bb and exact roster key; bounded cost', async () => {
  // Match the reported source family: a person at the start and recent history,
  // machine requests between, with no contribution records or current provider.
  const rows = Array.from({ length: 129 }, (_, i) => event(i + 1, i === 0 || i === 128 ? [cole] : [machine]));
  const f = fixture({ rows, members: [machine, cole], sdkDelay: 2 }); const binding = f.bind();
  try {
    const started = performance.now();
    const result = await f.rpc({ threadId: 'target', limit: 100 });
    const elapsedMs = performance.now() - started;
    expect(result).toMatchObject({ ok: true, value: { items: [{ identity: cole.identity, presentation: cole.presentation, roles: ['author'] }, { identity: machine.identity, roles: ['author'] }], coverage: 'partial-history', nextCursor: null } });
    expect(f.calls.events).toHaveLength(4); expect(f.calls.facets).toHaveLength(1); expect(f.calls.history).toHaveLength(0);
    expect(f.calls.brokenParticipants).toBe(0); expect(f.calls.providers).toBe(0);
    expect(elapsedMs).toBeLessThan(5000);
    console.info(`native participant fixture: 129 requests, ${f.calls.events.length + f.calls.facets.length} SDK calls, ${f.calls.history.length} history calls, ${elapsedMs.toFixed(2)}ms (synthetic ports; 2ms/call injected latency)`);
    expect(f.calls.events[1]).toMatchObject({ order: 'asc', beforeSeq: '130', afterSeq: '0', limit: '100', types: ['client/turn/requested'] });
  } finally { binding.dispose(); }
});

test('author ordering uses first authorship rather than mention order; roles deduplicate and machine stays separate', async () => {
  const later = person('later');
  const f = fixture({ rows: [event(1, [machine, cole, cole], [editor], [mention(later), mention(mentioned), mention(cole)]), event(2, [later], [cole], [mention(cole)])], members: [later, mentioned, editor, machine, cole] });
  const binding = f.bind();
  try {
    const result = await f.list(binding); expect(result.ok).toBe(true);
    expect(result.value.items.map(item => item.identity.key)).toEqual([machine, cole, later, editor, mentioned].map(actor => actor.identity.key));
    expect(result.value.items.find(item => item.identity.key === cole.identity.key).roles).toEqual(['author', 'editor', 'mentioned']);
    expect(result.value.items.find(item => item.identity.key === mentioned.identity.key).roles).toEqual(['mentioned']);
    expect(f.calls.providers).toBe(0);
  } finally { binding.dispose(); }
});

test('events and memberships beyond the first/last window are paged, with stable output cursors and bounded previews', async () => {
  const actors = Array.from({ length: 205 }, (_, i) => person(`p${i}`));
  const rows = Array.from({ length: 405 }, (_, i) => event(i * 3 + 1, [actors[i % actors.length]]));
  const f = fixture({ rows, members: actors.slice().reverse() }); const binding = f.bind();
  try {
    const result = await f.list(binding, { limit: 100 }); expect(result.ok).toBe(true);
    expect(result.value.items).toHaveLength(100); expect(result.value.items[0].identity).toEqual(actors[0].identity);
    const next = await f.list(binding, { limit: 100, cursor: result.value.nextCursor });
    expect(next.value.revision).toBe(result.value.revision); expect(next.value.items[0].identity).toEqual(actors[100].identity);
    const last = await f.list(binding, { limit: 100, cursor: next.value.nextCursor });
    expect(last.value.items).toHaveLength(5); expect(last.value.items[4].identity).toEqual(actors[204].identity); expect(last.value.nextCursor).toBeNull();
    const preview = await f.preview(binding); expect(preview.value[0]).toMatchObject({ hasMore: true, participants: [{ identity: actors[0].identity }] });
    expect(f.calls.events.filter(call => call.order === 'asc').slice(0, 5).map(call => call.afterSeq)).toEqual(['0', '298', '598', '898', '1198']);
    expect(f.calls.facets.slice(0, 3).map(call => call.cursor)).toEqual([undefined, '100', '200']);
    expect(f.calls.history).toHaveLength(0);
    const changed = structuredClone(f.rows[1]); changed.data.p6rAuthors = [actors[204]]; f.rows[1] = changed;
    expect(await f.list(binding, { limit: 100, cursor: result.value.nextCursor })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await f.list(binding, { limit: 50, cursor: result.value.nextCursor })).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    expect(await binding.background(invocation => binding.endpoint.participants(invocation, { threadId: 'other', limit: 100, cursor: result.value.nextCursor }))).toMatchObject({ ok: false });
  } finally { binding.dispose(); }
});

test('external author/editor contribution evidence shares the native reader and exhausts every contribution page', async () => {
  const secondEditor = person('secondEditor');
  const f = fixture({ rows: [event(1, [cole]), { ...event(2), data: { requestId: 'request-2' } }], members: [cole, external, editor, secondEditor], history: query => query.eventId === 'evt-1' ? page([]) : query.cursor ? page([contribution('c2', external, secondEditor)]) : page([contribution('c1')], 'history-next') });
  const binding = f.bind();
  try {
    const result = await f.list(binding); expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ coverage: 'complete-history', items: [{ identity: cole.identity, roles: ['author'] }, { identity: external.identity, presentation: external.presentation, roles: ['author'] }, { identity: editor.identity, roles: ['editor'] }, { identity: secondEditor.identity, roles: ['editor'] }] });
    expect(f.calls.history.map(call => [call.eventId, call.cursor])).toEqual([['evt-1', undefined], ['evt-2', undefined], ['evt-2', 'history-next']]);
    expect(f.calls.brokenParticipants).toBe(0);
  } finally { binding.dispose(); }
});

test('recorded asserted person triggers shared contribution evidence without current-provider admission', async () => {
  const asserted = { ...cole, evidence: 'integration-asserted' };
  const f = fixture({ rows: [event(1, [asserted])], history: () => page([]) }); const binding = f.bind();
  try {
    expect(await f.list(binding)).toMatchObject({ ok: true, value: { items: [{ identity: cole.identity, presentation: cole.presentation, roles: ['author'] }], coverage: 'complete-history' } });
    expect(f.calls.history).toHaveLength(1); expect(f.calls.providers).toBe(0);
  } finally { binding.dispose(); }
});

test('facet-only membership and missing contribution evidence keep known Cole with partial coverage and no guessed role', async () => {
  const f = fixture({ members: [cole, external, editor] }); const binding = f.bind();
  try {
    expect(await f.list(binding)).toMatchObject({ ok: true, value: { items: [{ identity: cole.identity, roles: ['author'] }], coverage: 'partial-history' } });
    expect((await f.list(binding)).value.items).toHaveLength(1);
  } finally { binding.dispose(); }
});

for (const field of ['facetParticipants', 'events']) test(`missing required ${field} capability errors without the broken delegation`, async () => {
  const f = fixture(); delete f.threads[field]; const binding = f.bind();
  try { expect(await f.list(binding)).toMatchObject({ ok: false, error: { code: 'unsupported' } }); expect(f.calls.brokenParticipants).toBe(0); }
  finally { binding.dispose(); }
});

for (const [name, mutate, message] of [
  ['malformed author', f => { f.rows[0].data.p6rAuthors = [{ ...cole, identity: { ...cole.identity, subject: '' } }]; }, 'Malformed native actor snapshot.'],
  ['malformed editor', f => { f.rows[0].data.p6rEditors = [{ ...editor, presentation: { displayName: 2 } }]; }, 'Malformed native actor snapshot.'],
  ['malformed mention', f => { f.rows[0].data.p6rMentionedTargets = [{ ...mention(mentioned), source: null }]; }, 'Malformed native participant mentions.'],
  ['membership kind mismatch', f => { f.members = [{ ...member(cole), p6rIdentityKind: 'external' }]; }, 'Participant identity kind disagrees with native membership.'],
  ['invalid exact key', f => { f.members = [{ ...member(cole), p6rPrincipalKey: '\u0000' }]; }, 'Malformed native participant member key.'],
  ['nonadvancing events', f => { f.rows = [event(1), event(1)]; }, 'Native participant events are not strictly ordered within their cutoff.'],
]) test(`${name} fails at the source boundary`, async () => {
  const f = fixture(); mutate(f); const binding = f.bind();
  try { const result = await f.list(binding); expect(result.ok).toBe(false); expect(result.error.message).toBe(message); expect(f.calls.brokenParticipants).toBe(0); }
  finally { binding.dispose(); }
});

test('append during traversal preserves the cutoff authors and downgrades coverage without rereading history', async () => {
  const asserted = { ...cole, evidence: 'integration-asserted' };
  const f = fixture({ rows: [event(1, [asserted])], history: () => page([]) });
  const original = f.threads.events.list; let appended = false;
  f.threads.events.list = async args => { const result = await original(args); if (args.order === 'asc' && !appended) { appended = true; f.rows.push(event(2, [machine])); f.members.push(machine); } return result; };
  const binding = f.bind();
  try {
    const result = await f.list(binding); expect(result).toMatchObject({ ok: true, value: { items: [{ identity: cole.identity, roles: ['author'] }], coverage: 'partial-history' } });
    expect(result.value.items).toHaveLength(1); expect(f.calls.events).toHaveLength(3); expect(f.calls.history).toHaveLength(1);
  } finally { binding.dispose(); }
});

test('append invalidates a continuation rather than mixing snapshot pages', async () => {
  const f = fixture({ rows: [event(1, [cole, machine])], members: [cole, machine] }); const binding = f.bind();
  try {
    const first = await f.list(binding, { limit: 1 }); f.rows.push(event(2, [editor])); f.members.push(editor);
    expect(await f.list(binding, { limit: 1, cursor: first.value.nextCursor })).toMatchObject({ ok: false, error: { code: 'conflict' } });
  } finally { binding.dispose(); }
});

for (const stage of ['events', 'facets', 'history']) test(`teardown cancels an in-flight ${stage} read even if the port ignores its signal`, async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ members: [cole, external], history: async () => { entered.resolve(); return gate.promise; } });
  if (stage === 'events') f.threads.events.list = async args => { f.calls.events.push(args); entered.resolve(); return gate.promise; };
  if (stage === 'facets') f.threads.facetParticipants = async args => { f.calls.facets.push(args); entered.resolve(); return gate.promise; };
  const binding = f.bind(); const pending = f.list(binding); await entered.promise; f.disposePlugin();
  const result = await pending; expect(result).toMatchObject({ ok: false, error: { code: 'expired' } });
  const captured = [...f.calls.events, ...f.calls.facets, ...f.calls.history].at(-1); expect(captured.signal.aborted).toBe(true);
  const reads = f.calls.events.length + f.calls.facets.length + f.calls.history.length;
  gate.resolve(stage === 'history' ? page([contribution('late')]) : []); await Promise.resolve();
  expect(f.calls.events.length + f.calls.facets.length + f.calls.history.length).toBe(reads);
});

test('caller cancellation settles immediately and launches no later source read', async () => {
  const f = fixture(); const binding = f.bind(); let signal; const entered = deferred(), gate = deferred();
  f.threads.events.list = async args => { signal = args.signal; entered.resolve(); return gate.promise; };
  const controller = new AbortController();
  // The public participant reader is connected through the endpoint; its invocation
  // signal is owned by the /bb registered scope (as in the real SDK dispatcher).
  let release;
  f.protocol.bindInvocation = ({ handler }) => ({ registration: { generation: 'cancel', status: 'active', dispose() {} }, handler: input => { release = () => controller.abort(); return handler({ request: {}, scope: { signal: controller.signal, release() {} } }, input); } });
  binding.dispose(); const rebound = f.bind();
  try {
    const pending = f.rpc({ threadId: 'target', limit: 100 }); await entered.promise; release();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } }); expect(signal.aborted).toBe(true);
    gate.resolve([]); expect(f.calls.facets).toHaveLength(0);
  } finally { rebound.dispose(); }
});

test('the obsolete protocol participant method is neither required nor used', async () => {
  const f = fixture(); delete f.protocol.participants; const binding = f.bind();
  try { expect(await f.list(binding)).toMatchObject({ ok: true, value: { items: [{ identity: cole.identity, roles: ['author'] }] } }); }
  finally { binding.dispose(); }
});

test('a valid native snapshot survives a temporarily incomplete facet projection with partial coverage', async () => {
  const f = fixture({ members: [] }); const binding = f.bind();
  try { expect(await f.list(binding)).toMatchObject({ ok: true, value: { items: [{ identity: cole.identity, roles: ['author'] }], coverage: 'partial-history' } }); }
  finally { binding.dispose(); }
});

test('a contribution outage preserves decoded native authors rather than returning another empty answer', async () => {
  const f = fixture({ members: [cole, external], history: () => ({ ok: false, error: { code: 'unavailable', message: 'outage', retry: 'after-reconnect' } }) }); const binding = f.bind();
  try { expect(await f.list(binding)).toMatchObject({ ok: true, value: { items: [{ identity: cole.identity, roles: ['author'] }], coverage: 'partial-history' } }); }
  finally { binding.dispose(); }
});

test('unattributed requests with known empty contribution results do not establish complete history', async () => {
  const f = fixture({ rows: [{ ...event(1), data: { requestId: 'request-1' } }], members: [], history: () => page([]) }); const binding = f.bind();
  try { expect(await f.list(binding)).toMatchObject({ ok: true, value: { items: [], coverage: 'partial-history' } }); }
  finally { binding.dispose(); }
});

for (const [name, history] of [
  ['nonadvancing', () => page([contribution('c1')], 'same')],
  ['invalid traversal', () => ok({ status: 'known', items: [], missing: [], traversal: 'continued', nextCursor: null })],
  ['foreign thread', () => page([{ ...contribution('c1'), reference: { threadId: 'another', contributionId: 'c1' } }])],
  ['malformed external editor', () => page([{ ...contribution('c1'), latestEditor: { ...editor, presentation: { displayName: null } } }])],
]) test(`${name} contribution evidence fails clearly`, async () => {
  const f = fixture({ members: [cole, external], history }); const binding = f.bind();
  try { expect(await f.list(binding)).toMatchObject({ ok: false, error: { code: 'incompatible' } }); }
  finally { binding.dispose(); }
});

test('membership cursors cannot loop indefinitely', async () => {
  const f = fixture(); f.threads.facetParticipants = async () => ({ profiles: [member(cole)], totalCount: 3, nextCursor: 'loop' }); const binding = f.bind();
  try { expect(await f.list(binding)).toMatchObject({ ok: false, error: { code: 'incompatible' } }); }
  finally { binding.dispose(); }
});

test('native event page budget bounds traversal and never labels a truncated source complete', async () => {
  const f = fixture(); const binding = f.bind();
  f.threads.events.list = async args => {
    if (args.order === 'desc') return [event(20000)];
    const start = Number(args.afterSeq); return Array.from({ length: 100 }, (_, i) => event(start + i + 1));
  };
  try { expect(await f.list(binding)).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } }); }
  finally { binding.dispose(); }
});

test('rewind during traversal retains observed authors but cannot claim complete history', async () => {
  const asserted = { ...cole, evidence: 'integration-asserted' };
  const f = fixture({ rows: [event(1, [asserted])], history: () => page([]) });
  const original = f.threads.events.list;
  f.threads.events.list = async args => { const result = await original(args); if (args.order === 'asc') f.rows = [{ ...event(1, [machine]), id: 'evt-rewritten' }]; return result; };
  const binding = f.bind();
  try { expect(await f.list(binding)).toMatchObject({ ok: true, value: { items: [{ identity: cole.identity, roles: ['author'] }], coverage: 'partial-history' } }); }
  finally { binding.dispose(); }
});

test('unexplained person facet editors trigger contribution enrichment even with fully decoded native authors', async () => {
  const f = fixture({ rows: [event(1)], members: [cole, editor], history: () => page([contribution('c-person', cole, editor)]) }); const binding = f.bind();
  try {
    expect(await f.list(binding)).toMatchObject({ ok: true, value: { items: [{ identity: cole.identity, roles: ['author'] }, { identity: editor.identity, roles: ['editor'] }], coverage: 'complete-history' } });
    expect(f.calls.history).toHaveLength(1);
  } finally { binding.dispose(); }
});


test('enhanced public /bb binding defers the load-gated SDK getter until a participant operation', async () => {
  const f = fixture(); const sdk = f.bb.sdk; let bound = false, reads = 0;
  Object.defineProperty(f.bb, 'sdk', { get() { reads++; if (!bound) throw Error('SDK unavailable before factory bind'); return sdk; } });
  const binding = f.bind();
  expect(reads).toBe(0);
  bound = true;
  try {
    expect(await f.list(binding)).toMatchObject({ ok: true, value: { items: [{ identity: cole.identity, roles: ['author'] }] } });
    expect(reads).toBe(1);
    binding.dispose(); bound = false;
    await expect(f.list(binding)).rejects.toThrow('Identity binding is disposed.');
    expect(reads).toBe(1);
  } finally { binding.dispose(); }
});

test('contribution mention identity must match the full retained identity for its exact key', async () => {
  const value = { ...contribution('c1', cole, null), mentionedPeople: [{ ...cole.identity, subject: 'different-person' }] };
  const f = fixture({ members: [cole, external], history: () => page([value]) }); const binding = f.bind();
  try { expect(await f.list(binding)).toMatchObject({ ok: false, error: { code: 'incompatible', message: 'Contribution mention disagrees with the retained identity for its member key.' } }); }
  finally { binding.dispose(); }
});


test('global role priority places later editors before earlier mentioned-only people across output pages', async () => {
  const f = fixture({ rows: [event(1, [cole], undefined, [mention(mentioned)]), event(2, [cole], [editor])], members: [mentioned, editor, cole] }); const binding = f.bind();
  try {
    const first = await f.list(binding, { limit: 2 });
    expect(first.value.items.map(item => item.identity.key)).toEqual([cole.identity.key, editor.identity.key]);
    const second = await f.list(binding, { limit: 2, cursor: first.value.nextCursor });
    expect(second.value.items.map(item => item.identity.key)).toEqual([mentioned.identity.key]);
  } finally { binding.dispose(); }
});


test('durable asserted person is retained when only its external sender is present in facets', async () => {
  const asserted = { ...cole, evidence: 'integration-asserted' };
  const value = { ...contribution('c1', external, null), personAttribution: asserted };
  const f = fixture({ rows: [{ ...event(1), data: { requestId: 'request-1' } }], members: [external], history: () => page([value]) }); const binding = f.bind();
  try {
    const result = await f.list(binding);
    expect(result).toMatchObject({ ok: true, value: { items: [{ identity: external.identity, roles: ['author'] }, { identity: cole.identity, presentation: cole.presentation, roles: ['author'] }], coverage: 'partial-history' } });
    expect(result.value.items).toHaveLength(2); expect(f.calls.providers).toBe(0);
  } finally { binding.dispose(); }
});

test('129 mixed requests disclose sequential contribution cost separately from full event payload transfer', async () => {
  const rows = Array.from({ length: 129 }, (_, i) => ({ ...event(i + 1, i === 0 ? [cole] : [machine]), data: { ...event(i + 1, i === 0 ? [cole] : [machine]).data, input: [{ type: 'text', text: 'x'.repeat(1500), mentions: [] }] } }));
  const f = fixture({ rows, members: [cole, machine, external, editor], sdkDelay: 2, history: async query => {
    await new Promise(resolve => setTimeout(resolve, 2));
    return page(query.eventId === 'evt-129' ? [contribution('c-external')] : []);
  } }); const binding = f.bind();
  try {
    const started = performance.now(), result = await f.list(binding), elapsedMs = performance.now() - started;
    expect(result.ok).toBe(true); expect(result.value.items.map(item => item.identity.key)).toEqual([cole, machine, external, editor].map(actor => actor.identity.key));
    expect(result.value.coverage).toBe('complete-history');
    expect(f.calls.events).toHaveLength(4); expect(f.calls.facets).toHaveLength(1); expect(f.calls.history).toHaveLength(129);
    const actorBytes = new TextEncoder().encode(JSON.stringify(rows.map(row => row.data.p6rAuthors))).byteLength;
    expect(f.calls.eventBytes).toBeGreaterThan(actorBytes + 129 * 1500);
    expect(elapsedMs).toBeLessThan(5000);
    console.info(`mixed participant fixture: 129 requests, 5 SDK calls, 129 history calls, ${elapsedMs.toFixed(2)}ms; ${f.calls.eventBytes} full synthetic event-response bytes vs ${actorBytes} author-array bytes (2ms/call injected; no live network measurement)`);
  } finally { binding.dispose(); }
});

test('cancellation during mixed-history enrichment stops future probes after the third request', async () => {
  const entered = deferred(), gate = deferred();
  const rows = Array.from({ length: 129 }, (_, i) => event(i + 1, i === 0 ? [cole] : [machine]));
  const f = fixture({ rows, members: [cole, machine, external], history: async () => {
    if (f.calls.history.length === 3) { entered.resolve(); return gate.promise; }
    return page([]);
  } }); const binding = f.bind();
  const pending = f.list(binding); await entered.promise; f.disposePlugin();
  expect(await pending).toMatchObject({ ok: false, error: { code: 'expired' } });
  expect(f.calls.history).toHaveLength(3); expect(f.calls.history.at(-1).signal.aborted).toBe(true);
  gate.resolve(page([contribution('late')])); await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.calls.history).toHaveLength(3); expect(f.calls.events).toHaveLength(3); // Final head never starts.
});
