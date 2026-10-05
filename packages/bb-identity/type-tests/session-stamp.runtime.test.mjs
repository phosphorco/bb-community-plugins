import { expect, test } from 'bun:test';
import { idCodec } from '../model-runtime.ts';
import { stateCodecs } from '../state-service-runtime.ts';

const codec = idCodec('server-session');
const stamps = [
  'singleton:portable-instance',
  `p6r-session:v1:${encodeURIComponent('p6r-person:v1:tailscale:123456')}:provider%3Ageneration`,
  `p6r-session:v1:${encodeURIComponent('p6r-machine:v1:p6r%3Ainstance:server')}:machine`,
  `p6r-session:v1:${encodeURIComponent('issuer:' + 'a'.repeat(500))}:generation`,
];
for (const stamp of stamps) test(`opaque session round-trips (${stamp.length} bytes)`, () => {
  expect(codec.decode(stamp)).toEqual({ ok: true, value: stamp });
  const codecs = stateCodecs({ decode: value => ({ ok: true, value }), encode: value => value });
  const mutation = { kind: 'replace', address: { instanceId: 'instance', pluginId: 'plugin', owner: 'person:cole', collection: 'sections', recordId: 'sidebar' }, expected: { actor: 'person:cole', session: stamp }, expectedVersion: { epoch: 'epoch', sequence: 0 }, ownerSession: 'owner-session', operationId: 'operation', localGeneration: 1, schemaVersion: 1, value: [] };
  expect(codecs.mutation.decode(codecs.mutation.encode(mutation))).toEqual({ ok: true, value: mutation });
});
test('invalid session tokens stay rejected and other identifier rules do not widen', () => {
  for (const value of ['', null, 42, 'a\nb', 'a\u0000b', 'a b', 'a'.repeat(4097)]) expect(codec.decode(value).ok).toBe(false);
  expect(idCodec('plugin').decode('plugin%3Aname').ok).toBe(false);
});
