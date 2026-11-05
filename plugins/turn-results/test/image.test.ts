import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ORIGINAL_IMAGE, IMAGE_DEADLINE_MS, IMAGE_LEASE_TTL_MS,
  verifyOriginalImage, createOriginalImageLease,
} from '../probe/image.ts';
import type { OriginalImageSdk } from '../probe/image.ts';

type ReadResult = Awaited<ReturnType<OriginalImageSdk['files']['read']>>;
const path = `${ORIGINAL_IMAGE.rootPath}/${ORIGINAL_IMAGE.basename}`;
// Synthetic content exercises admission only; it is not original-image proof.
const content = 'A'.repeat(4 * Math.ceil(ORIGINAL_IMAGE.sizeBytes / 3));
function fixture(overrides: Partial<ReadResult> = {}) {
  const calls: { kind: string; args: unknown }[] = [];
  const result: ReadResult = { path, sha256: ORIGINAL_IMAGE.sha256,
    sizeBytes: ORIGINAL_IMAGE.sizeBytes, mimeType: 'image/png',
    contentEncoding: 'base64', content, ...overrides };
  const sdk: OriginalImageSdk = { files: {
    async read(args) { calls.push({ kind: 'read', args }); return result; },
    async createPreview(args) {
      calls.push({ kind: 'lease', args });
      return { baseUrl: '/api/v1/file-previews/test-lease', expiresAtMs: Date.now() + IMAGE_LEASE_TTL_MS };
    },
  } };
  return { sdk, calls };
}

test('one exact host/root/path read; metadata-only current provenance, no lease', async () => {
  assert.equal(ORIGINAL_IMAGE.path, path);
  assert.equal(ORIGINAL_IMAGE.threadId, 'thr_im2hj668sh');
  const { sdk, calls } = fixture();
  const value = await verifyOriginalImage(sdk, new AbortController().signal);
  assert.equal(calls.length, 1);
  const args = calls[0].args as Parameters<OriginalImageSdk['files']['read']>[0];
  assert.equal(args.hostId, ORIGINAL_IMAGE.hostId);
  assert.equal(args.path, path);
  assert.equal(args.rootPath, ORIGINAL_IMAGE.rootPath);
  assert.ok(args.signal instanceof AbortSignal);
  assert.deepEqual(value.target, { kind: 'host', hostId: ORIGINAL_IMAGE.hostId, path });
  assert.equal(value.provenance.artifactLocation.sha256, ORIGINAL_IMAGE.sha256);
  assert.equal(value.provenance.originHost.state, 'unknown');
  assert.equal(JSON.stringify(value).includes('content'), false);
});

for (const [name, overrides] of Object.entries({
  hash: { sha256: '0'.repeat(64) },
  path: { path: '/wrong.png' },
  oversize: { sizeBytes: ORIGINAL_IMAGE.sizeBytes + 1 },
  type: { mimeType: 'text/plain' },
  encoding: { contentEncoding: 'utf8' as const },
  content: { content: 'too short' },
})) {
  test(`rejects ${name} mismatch before lease creation`, async () => {
    const { sdk, calls } = fixture(overrides);
    await assert.rejects(createOriginalImageLease(sdk, new AbortController().signal), /mismatch/);
    assert.deepEqual(calls.map(c => c.kind), ['read']);
  });
}

test('explicit lease call verifies first, requests exact root and 2min TTL, encodes basename', async () => {
  const { sdk, calls } = fixture();
  const value = await createOriginalImageLease(sdk, new AbortController().signal);
  assert.deepEqual(calls.map(c => c.kind), ['read', 'lease']);
  const args = calls[1].args as Parameters<OriginalImageSdk['files']['createPreview']>[0];
  assert.equal(args.hostId, ORIGINAL_IMAGE.hostId);
  assert.equal(args.rootPath, ORIGINAL_IMAGE.rootPath);
  assert.equal(args.ttlMs, 120_000);
  assert.equal(value.url, `/api/v1/file-previews/test-lease/${encodeURIComponent(ORIGINAL_IMAGE.basename)}`);
  assert.equal(value.target.path, path);
  assert.ok(value.expiresAtMs > Date.now());
});

test('pre-aborted call does no I/O', async () => {
  const { sdk, calls } = fixture();
  await assert.rejects(verifyOriginalImage(sdk, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});

test('abort rejects even an SDK that ignores cancellation; late read cannot create lease', async () => {
  const { sdk, calls } = fixture();
  const read = sdk.files.read;
  let finish!: () => void;
  sdk.files.read = args => new Promise(resolve => { finish = () => { void read(args).then(resolve); }; });
  const controller = new AbortController();
  const pending = createOriginalImageLease(sdk, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(c => c.kind), ['read']);
});

test('deadline bounds a hung SDK and aborts its signal, without retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sdk } = fixture();
  let calls = 0;
  let boundedSignal: AbortSignal | undefined;
  sdk.files.read = args => { calls++; boundedSignal = args.signal; return new Promise(() => {}); };
  const pending = verifyOriginalImage(sdk, new AbortController().signal);
  const rejected = assert.rejects(pending, { name: 'TimeoutError' });
  t.mock.timers.tick(IMAGE_DEADLINE_MS);
  await rejected;
  assert.equal(boundedSignal?.aborted, true);
  assert.equal(calls, 1);
});

test('rejects stale completion even before timeout callback runs', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { sdk } = fixture();
  const read = sdk.files.read;
  sdk.files.read = async args => {
    const value = await read(args);
    t.mock.timers.setTime(Date.now() + IMAGE_DEADLINE_MS);
    return value;
  };
  await assert.rejects(verifyOriginalImage(sdk, new AbortController().signal), { name: 'TimeoutError' });
});

test('verification and lease share one total deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sdk } = fixture();
  const read = sdk.files.read;
  sdk.files.read = async args => {
    const value = await read(args);
    t.mock.timers.setTime(Date.now() + IMAGE_DEADLINE_MS - 1);
    return value;
  };
  sdk.files.createPreview = async () => {
    t.mock.timers.setTime(Date.now() + 1);
    return { baseUrl: '/api/v1/file-previews/id', expiresAtMs: Date.now() + IMAGE_LEASE_TTL_MS };
  };
  await assert.rejects(createOriginalImageLease(sdk, new AbortController().signal), { name: 'TimeoutError' });
});

for (const invalid of [
  { baseUrl: 'https://wrong.example/image', expiresAtMs: Date.now() + 120_000 },
  { baseUrl: '/api/v1/file-previews/id?query=1', expiresAtMs: Date.now() + 120_000 },
  { baseUrl: '/api/v1/file-previews/id', expiresAtMs: 0 },
  { baseUrl: '/api/v1/file-previews/id', expiresAtMs: NaN },
]) {
  test(`rejects invalid/expired lease ${invalid.baseUrl} ${invalid.expiresAtMs}`, async () => {
    const { sdk } = fixture();
    sdk.files.createPreview = async () => invalid;
    await assert.rejects(createOriginalImageLease(sdk, new AbortController().signal), /Invalid or expired/);
  });
}

test('lease response after caller abort is rejected', async () => {
  const { sdk } = fixture();
  const controller = new AbortController();
  sdk.files.createPreview = async () => {
    controller.abort();
    return { baseUrl: '/api/v1/file-previews/id', expiresAtMs: Date.now() + 120_000 };
  };
  await assert.rejects(createOriginalImageLease(sdk, controller.signal), { name: 'AbortError' });
});

test('read failure propagates once without lease or retry', async () => {
  const { sdk, calls } = fixture();
  const offline = new Error('host offline');
  let attempts = 0;
  sdk.files.read = async () => { attempts++; throw offline; };
  await assert.rejects(createOriginalImageLease(sdk, new AbortController().signal), e => e === offline);
  assert.equal(attempts, 1);
  assert.equal(calls.length, 0);
});
