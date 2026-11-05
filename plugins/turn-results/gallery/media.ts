import { Store } from '@tanstack/store';
import { z } from 'zod';
import { canonicalByteLength, canonicalJson, sha256Canonical } from '@phosphorco/bb-turn-results';
import type { useSdk } from '@get-bb/plugin-sdk/app';
import type { GalleryObservation } from './index.ts';

export interface ImageLease {
  url: string; expiresAtMs: number; targetFingerprint: string; leaseGeneration: string;
}
export interface MediaSnapshot { url: string | null; state: 'idle' | 'loading' | 'ready' | 'error'; error: string | null }
export interface MediaRequest { key: string; fingerprint: string; sha256: string; acquire(signal: AbortSignal, speculative?: () => boolean): Promise<ImageLease> }
export interface MediaPorts {
  fetch(url: string, signal: AbortSignal): Promise<Response>;
  createUrl(blob: Blob): string; revokeUrl(url: string): void;
  demand?(): void;
}
const mediaRaw = z.unknown().transform(value => { canonicalByteLength(value, 16384); return value; });
const mediaOutput = z.discriminatedUnion('state', [
  z.object({ version: z.literal(1), state: z.literal('unavailable'), reason: z.string().max(128) }),
  z.object({ version: z.literal(1), state: z.literal('ready'), lease: z.object({
    targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/), leaseGeneration: z.string().max(128),
    baseUrl: z.string().regex(/^\/api\/v1\/file-previews\/[A-Za-z0-9-]{1,128}$/), url: z.string().max(4096),
    expiresAtMs: z.number().int().nonnegative(), resolvedAt: z.number().int().nonnegative(),
  }), image: z.object({ mimeType: z.literal('image/png'), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().min(1).max(32768), height: z.number().int().min(1).max(32768), sizeBytes: z.number().int().min(1).max(8388608) }) }),
]);

/** One exact Media admission path for visible and speculative owners alike. */
export async function imageMediaRequest(row: GalleryObservation,
  scope: (signal: AbortSignal, read: (signal: AbortSignal) => Promise<unknown>, speculative: () => boolean) => Promise<{ state: 'ready'; value: unknown } | { state: 'capacity' }>,
  plugins: Pick<ReturnType<typeof useSdk>['plugins'], 'callRpc'>): Promise<MediaRequest | null> {
  const resolution = row.resolution, route = resolution?.route, location = resolution?.provenance.artifactLocation;
  const sha256 = location?.state === 'verified' ? location.sha256 : undefined;
  if (!sha256 || route?.kind !== 'file' || row.owner !== 'turn-result-images') return null;
  const fingerprint = await sha256Canonical({ target: route.target, sha256 });
  return { key: row.key, fingerprint, sha256, async acquire(signal, speculative = () => false) {
    const read = await scope(signal, bounded => {
      bounded.throwIfAborted();
      // Own an already-dispatched response through raw settlement. Retirement
      // can refuse a late GET but cannot claim independent source work stopped.
      return plugins.callRpc({ pluginId: row.owner, method: 'turnResultImagesV1Media',
        input: { version: 1, identity: JSON.parse(canonicalJson(row.identity)) }, outputSchema: mediaRaw });
    }, speculative);
    signal.throwIfAborted();
    if (read.state === 'capacity') throw Error('Image verification capacity reached.');
    const output = mediaOutput.parse(read.value);
    if (output.state !== 'ready') throw Error(output.reason);
    if (output.image.sha256 !== sha256 || output.image.width * output.image.height > 16777216
      || output.lease.targetFingerprint !== fingerprint || !output.lease.url.startsWith(`${output.lease.baseUrl}/`)
      || output.lease.expiresAtMs - output.lease.resolvedAt > 120000 || output.lease.expiresAtMs <= output.lease.resolvedAt) throw Error('Image binding changed.');
    return output.lease;
  } };
}

export const MEDIA_LIMITS = Object.freeze({ entries: 64, bytes: 33_554_432, imageBytes: 8_388_608, concurrency: 2, deadlineMs: 7000 });
type Entry = { request: MediaRequest; store: Store<MediaSnapshot>; refs: number; visible: number; speculative: number; bytes: number; controller: AbortController | null; attempted: boolean; foregroundAttempt: boolean; foregroundEligible: boolean };

/** A single owner per app generation. TanStack owns notifications; this owner
 * only schedules bounded resources. Loaded blobs survive native row/root churn.
 * No clock polling, durable lease URL, or per-root file read is involved. */
export function createGalleryMedia(ports: MediaPorts) {
  const entries = new Map<string, Entry>();
  let bytes = 0, running = 0, disposed = false, visible = true, queued = false, warming = 0;
  function release(entry: Entry) {
    entry.controller?.abort();
    const url = entry.store.state.url;
    if (url) ports.revokeUrl(url);
    bytes -= entry.bytes;
    entries.delete(entry.request.key);
  }
  function collect(needed = 0, adding = false) {
    for (const entry of entries.values()) {
      if ((!adding || entries.size < MEDIA_LIMITS.entries) && bytes + needed <= MEDIA_LIMITS.bytes) break;
      if (!entry.refs && !entry.controller) release(entry);
    }
    return (!adding || entries.size < MEDIA_LIMITS.entries) && bytes + needed <= MEDIA_LIMITS.bytes;
  }
  function schedule() {
    if (queued || disposed || !visible) return;
    queued = true;
    queueMicrotask(() => { queued = false; pump(); });
  }
  function foregroundDemand(entry: Entry) {
    if (disposed || entries.get(entry.request.key) !== entry || entry.visible <= entry.speculative) return;
    // A foreground owner of a still-running response joins that attempt; it
    // cannot abort/reissue it or reserve another automatic attempt on failure.
    if (entry.controller) { entry.foregroundAttempt = true; return; }
    if (entry.foregroundEligible && entry.store.state.state === 'error') {
      entry.foregroundEligible = false; entry.attempted = false;
    }
  }
  function pump() {
    if (disposed || !visible) return;
    for (const entry of [...entries.values()].sort((a, b) => Number(a.visible <= a.speculative) - Number(b.visible <= b.speculative))) {
      if (running >= MEDIA_LIMITS.concurrency) break;
      if (!entry.refs || !entry.visible || entry.attempted || entry.controller || entry.store.state.url) continue;
      entry.attempted = true; entry.foregroundEligible = false; entry.foregroundAttempt = entry.visible > entry.speculative;
      const controller = new AbortController(); entry.controller = controller; running++;
      const signal = controller.signal;
      entry.store.setState(old => ({ ...old, state: 'loading', error: null }));
      const timer = setTimeout(() => controller.abort('deadline'), MEDIA_LIMITS.deadlineMs);
      const current = () => !disposed && !signal.aborted && entries.get(entry.request.key) === entry && entry.controller === controller;
      const check = () => { if (!current()) throw new Error('Image request retired.'); };
      const wait = <T,>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Image request retired.')); };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
      });
      let responseBody: ReadableStream<Uint8Array> | null = null, bodyHandled = false;
      void (async () => {
        const lease = await wait(entry.request.acquire(signal, () => entry.visible <= entry.speculative)); check();
        if (lease.targetFingerprint !== entry.request.fingerprint || lease.expiresAtMs <= Date.now()
          || !/^\/api\/v1\/file-previews\/[a-zA-Z0-9-]+\/[^/?#]+$/.test(lease.url)) throw new Error('Image serving target changed.');
        const fetching = ports.fetch(lease.url, signal).then(response => {
          // A port may resolve despite cancellation, after our waiter retired.
          // Dispose that late transport body without decoding or publishing it.
          if (!current()) void response.body?.cancel().catch(() => {});
          return response;
        });
        const response = await wait(fetching);
        responseBody = response.body; check();
        if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/png') throw new Error('Image serving is unavailable.');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > MEDIA_LIMITS.imageBytes)) throw new Error('Image exceeds display capacity.');
        if (!response.body) throw new Error('Image response has no body.');
        const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
        let count = 0;
        try {
          for (;;) {
            const part = await wait(reader.read()); check();
            if (part.done) break;
            count += part.value.byteLength;
            if (count > MEDIA_LIMITS.imageBytes) throw new Error('Image exceeds display capacity.');
            chunks.push(new Uint8Array(part.value));
          }
        } finally { bodyHandled = true; void reader.cancel().catch(() => {}); reader.releaseLock(); }
        check();
        if (!count || !collect(count)) throw new Error('Image display capacity reached.');
        const blob = new Blob(chunks, { type: 'image/png' });
        const data = await wait(blob.arrayBuffer()); check();
        const digest = await wait(crypto.subtle.digest('SHA-256', data)); check();
        const sha256 = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
        if (sha256 !== entry.request.sha256) throw new Error('Served image no longer matches the verified result.');
        if (!collect(count)) throw new Error('Image display capacity reached.');
        const url = ports.createUrl(blob);
        if (!current()) { ports.revokeUrl(url); return; }
        entry.bytes = count; bytes += count;
        entry.store.setState(() => ({ url, state: 'ready', error: null }));
      })().catch(error => {
        if (!disposed && entries.get(entry.request.key) === entry && entry.controller === controller) {
          const retired = signal.aborted && signal.reason !== 'deadline';
          if (retired) entry.attempted = false;
          entry.foregroundEligible = !retired && !entry.foregroundAttempt;
          entry.store.setState(old => ({ ...old, state: retired ? 'idle' : 'error', error: retired ? null : signal.reason === 'deadline' ? 'Image serving deadline reached.' : String(error instanceof Error ? error.message : error) }));
        }
      }).finally(() => {
        clearTimeout(timer);
        if (!bodyHandled) void responseBody?.cancel().catch(() => {});
        controller.abort('completed'); // terminate all transport ownership before freeing a token
        if (entry.controller === controller) entry.controller = null; running--; foregroundDemand(entry); schedule();
      });
    }
  }
  return {
    retain(request: MediaRequest, isVisible = true, speculative = false) {
      if (disposed) throw new Error('Media owner retired.');
      if (speculative && warming >= 2) throw Error('Nearby media capacity reached.');
      let entry = entries.get(request.key);
      if (entry && (entry.request.fingerprint !== request.fingerprint || entry.request.sha256 !== request.sha256)) throw new Error('Immutable media binding changed.');
      if (!entry) {
        if (!collect(0, true)) throw new Error('Media entry capacity reached.');
        entry = { request, refs: 0, visible: 0, speculative: 0, bytes: 0, controller: null, attempted: false, foregroundAttempt: false, foregroundEligible: false,
          store: new Store<MediaSnapshot>({ url: null, state: 'idle', error: null }) };
        entries.set(request.key, entry);
      }
      const owned = entry; owned.refs++; if (isVisible) owned.visible++;
      if (speculative) { warming++; if (isVisible) owned.speculative++; }
      if (owned.store.state.state === 'idle') owned.attempted = false;
      foregroundDemand(owned); ports.demand?.();
      schedule();
      let live = true, shown = isVisible, optional = speculative;
      return { store: owned.store,
        promote() { if (!live || !optional) return; optional = false; warming--; if (shown) owned.speculative--; foregroundDemand(owned); ports.demand?.(); schedule(); },
        visible(next: boolean) { if (!live || shown === next) return; shown = next; owned.visible += next ? 1 : -1; if (optional) owned.speculative += next ? 1 : -1; if (!owned.visible) owned.controller?.abort(); else if (owned.store.state.state === 'idle') owned.attempted = false; foregroundDemand(owned); ports.demand?.(); schedule(); },
        retry() { if (!live || owned.controller) return; owned.attempted = false; schedule(); },
        dispose() { if (!live) return; live = false; owned.refs--; if (shown) owned.visible--; if (optional) { warming--; if (shown) owned.speculative--; } if (!owned.refs || !owned.visible) owned.controller?.abort(); },
      };
    },
    visible(next: boolean) { if (visible === next) return; visible = next; if (!next) for (const entry of entries.values()) entry.controller?.abort(); else { for (const entry of entries.values()) if (entry.store.state.state === 'idle') entry.attempted = false; schedule(); } },
    stats: () => ({ entries: entries.size, bytes, running }),
    dispose() { if (disposed) return; disposed = true; for (const entry of [...entries.values()]) release(entry); },
  };
}
