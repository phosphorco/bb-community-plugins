import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adaptCompletedEvent } from '@phosphorco/bb-turn-results/events';
import type { NativeHistoryEvent } from '@phosphorco/bb-turn-results/events';
import type { ResultIdentity } from '@phosphorco/bb-turn-results';
import { imageCandidate } from '../recognition.ts';
import { verifyImage, ImagePortError, MAX_IMAGE_BYTES, MAX_IMAGE_BASE64_CHARS, MAX_IMAGE_PIXELS } from '../verification.ts';
import type { ImageMaterialization, ImageVerificationPorts, ImageFileRead } from '../verification.ts';

// An independent 1x1 PNG fixture, never the original masonry bytes.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
const pngBytes = () => Uint8Array.from(atob(PNG), value => value.charCodeAt(0));
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
async function sha(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
function header(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = pngBytes(); const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  let crc = 0xffffffff;
  for (let index = 12; index < 29; index++) { crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  view.setUint32(29, (crc ^ 0xffffffff) >>> 0); return bytes;
}
async function fixture(bytes = pngBytes()) {
  const data = base64(bytes), digest = await sha(bytes), calls: string[] = [];
  const item = { type: 'imageGeneration', id: 'item_1', status: 'completed', path: '/saved/image.png', error: null as string | null,
    transparentBackground: false, result: data };
  const native = { id: 'evt_1', threadId: 'thr_fixture', seq: 1, scope: { kind: 'turn', turnId: 'turn_1' },
    type: 'item/completed', createdAt: 100, data: { item } };
  const selected = await adaptCompletedEvent(native); assert.equal(selected.state, 'admitted');
  if (selected.state !== 'admitted') throw new Error('fixture');
  const identity = imageCandidate(selected.event)!.identity;
  const file: ImageFileRead = { path: item.path, content: data, contentEncoding: 'base64', sha256: digest,
    sizeBytes: bytes.length, mimeType: 'image/png', observedAt: 1000 };
  const reads: { hostId: string; path: string }[] = [];
  const ports: ImageVerificationPorts = {
    materializations: { async read(source, options) { calls.push('materialization'); assert.deepEqual(source, identity.ref.source); assert.equal(options.maxBytes, 8192); return null; } },
    native: { async read(source, options) { calls.push('native'); assert.equal(options.limit, 1); assert.equal(options.maxResultChars, MAX_IMAGE_BASE64_CHARS); return native; } },
    currentHost: { async lookup(threadId) { calls.push('host'); assert.equal(threadId, 'thr_fixture'); return { hostId: 'host-current', observedAt: 900 }; } },
    files: { async read(options) { calls.push('file'); assert.equal(options.maxBytes, MAX_IMAGE_BYTES); reads.push({ hostId: options.hostId, path: options.path }); return file; } },
  };
  return { native, item, identity, file, ports, calls, reads, digest };
}
const signal = () => new AbortController().signal;
async function binding(f: Awaited<ReturnType<typeof fixture>>): Promise<ImageMaterialization> {
  const result = await verifyImage(f.identity, f.ports, signal()); assert.equal(result.state, 'verified');
  if (result.state !== 'verified') throw new Error('binding fixture'); return result.binding;
}

test('fresh source verifies independent provider/file bytes, exact one-host route and unknown origin', async () => {
  const f = await fixture();
  Object.defineProperty(f.item, 'prompt', { enumerable: true, get() { throw new Error('prompt must not be read'); } });
  const result = await verifyImage(f.identity, f.ports, signal());
  assert.equal(result.state, 'verified'); if (result.state !== 'verified') return;
  assert.deepEqual(f.calls, ['materialization', 'native', 'host', 'file']);
  assert.deepEqual(f.reads, [{ hostId: 'host-current', path: '/saved/image.png' }]);
  assert.equal(result.binding.providerSha256, f.digest); assert.equal(result.binding.proof.artifactDigest, f.digest);
  assert.equal(result.binding.nativeCreatedAt, 100); assert.equal(result.binding.verifiedAt, 1000);
  assert.equal(result.provenance.originHost.state, 'unknown');
  assert.deepEqual(result.layout, { width: 1, height: 1 }); assert.equal(result.displayUnsupported, null);
  const wire = JSON.stringify(result);
  assert.equal(wire.includes(PNG), false); assert.equal(wire.includes('contentEncoding'), false);
  assert.equal(wire.includes('prompt'), false);
});

test('wrong source, selected digest/path and pending/error status never access provider bytes or file/host', async () => {
  for (const change of [
    (f: Awaited<ReturnType<typeof fixture>>) => { f.native.id = 'evt_foreign'; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.identity.evidence.selectedDigest = '0'.repeat(64); },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.item.path = '/saved/other.png'; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.item.status = 'pending'; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.item.error = 'failure'; },
  ]) {
    const f = await fixture(); change(f);
    let touched = false;
    const original = f.native.data.item;
    f.native.data.item = new Proxy(original, { getOwnPropertyDescriptor(target, key) {
      if (key === 'result') touched = true; return Reflect.getOwnPropertyDescriptor(target, key);
    } });
    const result = await verifyImage(f.identity, f.ports, signal());
    assert.equal(result.state, 'unrecognized'); assert.equal(touched, false);
    assert.deepEqual(f.calls, ['materialization', 'native']);
  }
});

test('retained/pruned provider evidence cannot become newly verified file bytes', async () => {
  for (const truncated of [true, false]) {
    const f = await fixture();
    if (truncated) (f.item as typeof f.item & { truncation: unknown }).truncation = {
      result: { originalLength: PNG.length * 10, retainedHeadLength: 10, retainedTailLength: 10, truncatedAt: 500 } };
    else delete (f.item as Partial<typeof f.item>).result;
    // Re-recognition can propose the retained selected metadata, but no new file
    // proof can be manufactured without complete provider bytes.
    const adapted = await adaptCompletedEvent(f.native); assert.equal(adapted.state, 'admitted');
    if (adapted.state !== 'admitted') return;
    const identity = imageCandidate(adapted.event)!.identity;
    f.ports.materializations.read = async () => null;
    const result = await verifyImage(identity, f.ports, signal());
    assert.equal(result.state, 'unavailable');
    if (result.state === 'unavailable') { assert.ok(result.historical); assert.equal(result.reason,
      truncated ? 'provider-evidence-truncated' : 'provider-evidence-missing'); }
    assert.equal(f.calls.includes('host'), false); assert.equal(f.calls.includes('file'), false);
  }
});

test('base64 must be complete/canonical and decoded admission rejects >8MiB before allocation', async () => {
  for (const result of [PNG.slice(0, -1), PNG + '\n', `data:image/png;base64,${PNG}`, 'AB==', 'AAF=', 'AA-_', '界界界界', 'A'.repeat(MAX_IMAGE_BASE64_CHARS)]) {
    const f = await fixture(); f.item.result = result;
    const outcome = await verifyImage(f.identity, f.ports, signal());
    assert.equal(outcome.state, 'unavailable');
    assert.equal(f.calls.includes('host'), false); assert.equal(f.calls.includes('file'), false);
  }
});

test('exact8MiB decoded boundary is accepted as header/byte proof, not complete PNG decode proof', async () => {
  const bytes = new Uint8Array(MAX_IMAGE_BYTES); bytes.set(pngBytes());
  const f = await fixture(bytes); const result = await verifyImage(f.identity, f.ports, signal());
  assert.equal(result.state, 'verified'); if (result.state === 'verified') assert.equal(result.binding.sizeBytes, MAX_IMAGE_BYTES);
});

test('file SHA/size/path/mime/encoding/actual bytes are independently checked', async () => {
  const cases: Partial<ImageFileRead>[] = [
    { sha256: '0'.repeat(64) }, { sizeBytes: 1 }, { path: '/wrong.png' },
    { mimeType: 'image/jpeg' }, { contentEncoding: 'utf8' }, { content: PNG.slice(0, -1) },
    { content: base64(header(2, 1)) }, { observedAt: NaN }, { sizeBytes: MAX_IMAGE_BYTES + 1 },
  ];
  for (const change of cases) {
    const f = await fixture(); Object.assign(f.file, change);
    const outcome = await verifyImage(f.identity, f.ports, signal()); assert.equal(outcome.state, 'unavailable');
    assert.equal(f.reads.length, 1);
    if (outcome.state === 'unavailable') assert.equal(outcome.historical?.providerSha256, f.digest);
  }
});

test('PNG signature/IHDR/CRC faults are explicit and unsupported media never claims file readiness', async () => {
  const badCrc = pngBytes(); badCrc[29] = badCrc[29]! ^ 1;
  const wrongSignature = pngBytes(); wrongSignature[0] = 0;
  const invalidMethod = pngBytes(); invalidMethod[26] = 1;
  for (const bytes of [wrongSignature, badCrc, header(0, 1), pngBytes().slice(0, 20), invalidMethod]) {
    const f = await fixture(bytes); const result = await verifyImage(f.identity, f.ports, signal());
    assert.equal(result.state, 'unavailable'); assert.equal(f.calls.includes('host'), false);
  }
});

test('header display bounds preserve verified source facts and file fallback without thumbnail readiness', async () => {
  assert.equal(MAX_IMAGE_PIXELS, 16777216);
  for (const [width, height] of [[32769, 1], [1, 32769], [4097, 4096]]) {
    const f = await fixture(header(width!, height!)); const result = await verifyImage(f.identity, f.ports, signal());
    assert.equal(result.state, 'verified'); if (result.state !== 'verified') return;
    assert.equal(result.binding.width, width); assert.equal(result.binding.height, height);
    assert.equal(result.layout, null); assert.equal(result.displayUnsupported, 'dimensions-over-policy');
    assert.equal(result.route.kind, 'file'); assert.equal(result.binding.nativeCreatedAt, 100);
  }
  const exact = await fixture(header(4096, 4096)); const accepted = await verifyImage(exact.identity, exact.ports, signal());
  assert.equal(accepted.state, 'verified'); if (accepted.state === 'verified') assert.equal(accepted.displayUnsupported, null);
});

test('cached immutable original identity/proof survives source prune; only fixed target is reread', async () => {
  const f = await fixture(); const cached = await binding(f); const first = structuredClone(cached);
  f.calls.length = 0; f.reads.length = 0; f.file.observedAt = 2000;
  f.ports.materializations.read = async () => cached;
  f.ports.native.read = async () => { throw new Error('pruned native must not be needed'); };
  f.ports.currentHost.lookup = async () => { throw new Error('new environment must not be consulted'); };
  const result = await verifyImage(f.identity, f.ports, signal());
  assert.equal(result.state, 'verified'); if (result.state !== 'verified') return;
  assert.equal(result.basis, 'materialization'); assert.deepEqual(result.binding, first);
  assert.equal(result.binding.verifiedAt, 1000); assert.equal(result.observedAt, 2000);
  assert.equal(result.binding.nativeCreatedAt, 100); assert.deepEqual(f.calls, ['file']);
  assert.deepEqual(f.reads, [{ hostId: 'host-current', path: '/saved/image.png' }]);
});

test('cached target is never relocated on offline/missing or changed current host', async () => {
  for (const reason of ['offline', 'missing'] as const) {
    const f = await fixture(), cached = await binding(f); f.calls.length = 0;
    f.ports.materializations.read = async () => cached;
    f.ports.files.read = async options => { f.calls.push(`file:${options.hostId}:${options.path}`); throw new ImagePortError(reason); };
    f.ports.currentHost.lookup = async () => { throw new Error('must not relocate'); };
    const result = await verifyImage(f.identity, f.ports, signal());
    assert.equal(result.state, 'unavailable'); if (result.state === 'unavailable') { assert.equal(result.reason, reason); assert.equal(result.historical?.nativeCreatedAt, 100); }
    assert.deepEqual(f.calls, ['file:host-current:/saved/image.png']);
  }
});

test('changed identity or corrupt cached proof conflicts without any other I/O', async () => {
  for (const mutate of [(record: ImageMaterialization) => { record.identity.artifact.id = 'changed'; },
    (record: ImageMaterialization) => { record.proof.selectedDigest = '0'.repeat(64); },
    (record: ImageMaterialization) => { record.target.path = '/different/saved-path.png'; },
    (record: ImageMaterialization) => { record.nativeCreatedAt = NaN; }]) {
    const f = await fixture(), record = await binding(f); f.calls.length = 0; mutate(record);
    f.ports.materializations.read = async () => record;
    assert.equal((await verifyImage(f.identity, f.ports, signal())).state, 'conflict');
    assert.deepEqual(f.calls, []);
  }
});

test('missing native/current host and native reader failures retain honest availability', async () => {
  const f = await fixture(); f.ports.native.read = async () => null;
  assert.equal((await verifyImage(f.identity, f.ports, signal())).state, 'unavailable');
  const g = await fixture(); g.ports.currentHost.lookup = async () => null;
  const result = await verifyImage(g.identity, g.ports, signal());
  assert.equal(result.state, 'unavailable'); if (result.state === 'unavailable') assert.equal(result.historical?.providerSha256, g.digest);
  assert.equal(g.reads.length, 0);
});

test('preabort and abort-ignoring native/cache/host/file ports cannot start later reads', async () => {
  for (const stage of ['materializations', 'native', 'currentHost', 'files'] as const) {
    const f = await fixture(), controller = new AbortController();
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const ignored = new Promise<never>(resolve => { finish = () => resolve(undefined as never); });
    if (stage === 'currentHost') f.ports.currentHost.lookup = async () => { enter(); return ignored; };
    else if (stage === 'materializations') f.ports.materializations.read = async () => { enter(); return ignored; };
    else if (stage === 'native') f.ports.native.read = async () => { enter(); return ignored; };
    else f.ports.files.read = async () => { enter(); return ignored; };
    const pending = verifyImage(f.identity, f.ports, controller.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await entered; const calls = [...f.calls]; controller.abort(); await rejected; finish();
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(f.calls, calls);
  }
  const f = await fixture(); await assert.rejects(verifyImage(f.identity, f.ports, AbortSignal.abort()), { name: 'AbortError' });
  assert.deepEqual(f.calls, []);
});

test('original seq433 known7f77 digest is metadata-only here; synthetic bytes cannot verify it', async () => {
  const f = await fixture();
  const path = '/home/ubuntu/.codex-subscription-router/accounts/20260918-d77317/codex-home/generated_images/01a188c6-2eeb-7ad0-9097-92045e025287/exec-f0d62fd4-4f3d-4d9f-a921-1c37ec8a75c7.png';
  const native: NativeHistoryEvent = { id: 'evt_iqzg5z3d27', threadId: 'thr_im2hj668sh', seq: 433,
    scope: { kind: 'turn', turnId: 'daa509e06e-t247' }, createdAt: 1793297408982, type: 'item/completed',
    data: { item: { ...f.item, id: 'daa509e06e-i5025', path } } };
  const selected = await adaptCompletedEvent(native); assert.equal(selected.state, 'admitted'); if (selected.state !== 'admitted') return;
  const identity: ResultIdentity = imageCandidate(selected.event)!.identity;
  const known = '7f77a104dbd6ad5bc52df8da9ff183d7a71bb928c2cefe955cbb1489ada0f078';
  const cached: ImageMaterialization = { schema: 1, identity, proof: { kind: 'native-image', source: identity.ref.source,
    selectedDigest: identity.evidence.selectedDigest, artifactDigest: known }, providerSha256: known, path,
    target: { kind: 'host', hostId: 'host_chtdmruc4g', path }, nativeCreatedAt: 1793297408982,
    width: 1536, height: 1024, sizeBytes: 1605232, verifiedAt: 1793297410000 };
  f.ports.materializations.read = async () => cached;
  const fakeOriginalSize = new Uint8Array(1605232); fakeOriginalSize.set(header(1536, 1024));
  f.ports.files.read = async () => ({ ...f.file, path, sha256: known, sizeBytes: 1605232,
    content: base64(fakeOriginalSize), observedAt: 1793297420000 });
  const outcome = await verifyImage(identity, f.ports, signal());
  assert.equal(outcome.state, 'unavailable'); if (outcome.state === 'unavailable') {
    assert.equal(outcome.reason, 'file-digest-mismatch'); assert.equal(outcome.historical?.providerSha256, known);
  }
  // This is intentionally NOT a positive original-byte verification: no actual
  // original file was read, no original bytes supplied, and crypto is not mocked.
});
