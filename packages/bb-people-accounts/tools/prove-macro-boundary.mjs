/** Explicit, read-only compatibility probe. Never installs or loads a live plugin. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, posix } from 'node:path';
import { parseArgs } from 'node:util';
import { linksRecordSchema } from '../dist/v2.js';

const { values } = parseArgs({ options: { 'plugins-repo': { type: 'string' }, revision: { type: 'string' } } });
assert(values['plugins-repo'] && /^[a-f0-9]{40}$/.test(values.revision ?? ''), 'Supply a repository and an exact source commit');
const repo = resolve(values['plugins-repo']);
const hashes = {};
Bun.plugin({ name: 'readonly-macro-boundary-proof', setup(build) {
  build.onResolve({ filter: /^macro-proof:/ }, ({ path }) => ({ path: path.slice(12), namespace: 'macro-proof' }));
  build.onLoad({ filter: /.*/, namespace: 'macro-proof' }, ({ path }) => {
    assert(['email-access.ts', 'capabilities.ts', 'contract.ts'].includes(path), 'Only the selected pure modules are loaded');
    const source = execFileSync('git', ['show', `${values.revision}:plugins/rosetta-macro/${path}`], { cwd: repo, encoding: 'utf8' });
    hashes[path] = createHash('sha256').update(source).digest('hex');
    return { contents: source.replace(/(from\s+["'])\.\/([^"']+)/g, (_m, before, relative) => `${before}macro-proof:${posix.normalize(posix.join(posix.dirname(path), relative))}`), loader: 'ts', resolveDir: resolve(import.meta.dir, '..') };
  });
} });
globalThis.fetch = async () => { throw new Error('Compatibility proof forbids network access'); };
const policy = await import('macro-proof:email-access.ts');
const { resolveMacroActor } = await import('macro-proof:capabilities.ts');
const { validateDiscussion } = await import('macro-proof:contract.ts');
const now = 2_000_000_000_000;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const installation = { origin: 'https://macro.example.invalid', botId: id(2), actingUser: 'macro|fixture@example.invalid' };
const invocation = { threadId: 'thread-fixture', projectId: 'project-fixture', experimental_turnId: 'turn-fixture', experimental_callId: 'call-fixture' };
const source = { eventId: 'event-fixture', eventType: 'message.mentioned', destination: { origin: installation.origin, botId: installation.botId, parent: { type: 'document', id: id(1) }, rootId: id(3) }, messageId: id(3), eventContent: null, sender: installation.actingUser };
const message = { id: id(3), parent: source.destination.parent, thread_id: null, sender_id: installation.actingUser, content: 'Synthetic @Rosetta request', mentions: [{ entity_type: 'bot', entity_id: `bot|${id(2)}` }], created_at: new Date(now - 1000).toISOString(), updated_at: new Date(now - 1000).toISOString() };
const discussion = { state: { root_id: id(3), resolved: false }, root: message, replies: [] };
const row = { id: id(4), status: 'active', turn_id: invocation.experimental_turnId, thread_id: invocation.threadId, project_id: invocation.projectId, source: JSON.stringify(source), operation_id: 'operation-fixture', acting_user: installation.actingUser, message_id: id(3), revision: validateDiscussion(source, discussion).revision, created_at: now - 1000 };
const external = { author: { kind: 'external', actor: { identity: { pluginId: 'rosetta-macro', subject: `${installation.origin}/user/${installation.actingUser}` } } } };
const provenance = { status: 'known', correlation: { threadId: invocation.threadId, turnId: invocation.experimental_turnId, toolCallId: invocation.experimental_callId }, contributions: [external] };
const base = { installation, invocation, provenance, requests: [row], readDiscussion: async () => structuredClone(discussion), now: () => now };
const fresh = await policy.emailAccessForInvocation(base); assert.equal(fresh.kind, 'email');
const person = { author: { kind: 'person', actor: { identity: { kind: 'person', key: 'person-fixture' } } } };
const personProvenance = { ...provenance, contributions: [person] };
const records = linksRecordSchema.parse({ links: [{ id: 'link-a', identity: { pluginId: 'rosetta-macro', subject: `${installation.origin}/user/${installation.actingUser}` } }] });
assert.equal(records.links.length, 1);
assert.equal(resolveMacroActor(personProvenance, invocation, installation.origin, { people: { 'person-fixture': installation.actingUser }, projects: {} }), installation.actingUser);
const cases = {
  linked_outside_macro: { provenance: personProvenance },
  grouped: { provenance: { ...provenance, contributions: [external, external] } },
  expired: { requests: [{ ...row, created_at: now - 1_800_001 }] },
  edited: { requests: [{ ...row, revision: 'edited' }] },
  wrong_actor_after_relink: { installation: { ...installation, actingUser: 'macro|other@example.invalid' } },
  wrong_chat: { invocation: { ...invocation, threadId: 'other' } },
  deleted: { readDiscussion: async () => ({ ...discussion, state: { ...discussion.state, deleted_at: 'deleted' } }) },
  source_unavailable: { readDiscussion: async () => { throw new Error('synthetic unavailable'); } },
};
for (const [name, variation] of Object.entries(cases)) assert.equal((await policy.emailAccessForInvocation({ ...base, ...variation })).kind, 'shared', name);
const stored = { facts: JSON.stringify({ ...installation, access: { kind: 'email', requestId: row.id } }) };
assert.equal(policy.canReadStoredCall(stored, { ...installation, emailAccess: { kind: 'shared' } }, now), false);
assert.equal(policy.canReadStoredCall(stored, { ...installation, emailAccess: fresh }, now), true);
assert.equal(policy.canReadStoredCall(stored, { ...installation, actingUser: 'macro|other@example.invalid', emailAccess: { ...fresh, actingUser: 'macro|other@example.invalid' } }, now), false);
assert.equal(policy.canReadStoredCall({ facts: JSON.stringify({ ...installation, access: { kind: 'shared' } }) }, { ...installation, emailAccess: { kind: 'shared' } }, now), true);
assert.equal(JSON.parse(policy.emailRequestHeader(fresh, now)).expires_at_ms, now + 175_000);
console.log(JSON.stringify({ passed: true, level: 'actual-export-synthetic-probe', revision: values.revision, refusals: Object.keys(cases), sharedActorSelection: true, savedMailAdmission: true, source_sha256: hashes, limits: 'No live plugin, native search service, mailbox, deployment or chat/model history was read or changed.' }, null, 2));
