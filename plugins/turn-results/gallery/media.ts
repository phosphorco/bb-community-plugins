import { Store } from '@tanstack/store';

export interface ImageLease {
  url: string; expiresAtMs: number; targetFingerprint: string; leaseGeneration: string;
}
export interface MediaSnapshot { url: string | null; state: 'idle' | 'loading' | 'ready' | 'error'; error: string | null }
export interface MediaRequest { key: string; fingerprint: string; sha256: string; acquire(signal: AbortSignal): Promise<ImageLease> }
export interface MediaPorts {
  fetch(url: string, signal: AbortSignal): Promise<Response>;
  createUrl(blob: Blob): string; revokeUrl(url: string): void;
}
export const MEDIA_LIMITS = Object.freeze({ entries: 64, bytes: 33_554_432, imageBytes: 8_388_608, concurrency: 2, deadlineMs: 7000 });
type Entry = { request: MediaRequest; store: Store<MediaSnapshot>; refs: number; visible: number; bytes: number; controller: AbortController | null; attempted: boolean };

/** A single owner per app generation. TanStack owns notifications; this owner
 * only schedules bounded resources. Loaded blobs survive native row/root churn.
 * No clock polling, durable lease URL, or per-root file read is involved. */
export function createGalleryMedia(ports: MediaPorts) {
  const entries = new Map<string, Entry>();
  let bytes = 0, running = 0, disposed = false, visible = true, queued = false;
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
  function pump() {
    if (disposed || !visible) return;
    for (const entry of entries.values()) {
      if (running >= MEDIA_LIMITS.concurrency) break;
      if (!entry.refs || !entry.visible || entry.attempted || entry.controller || entry.store.state.url) continue;
      entry.attempted = true;
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
        const lease = await wait(entry.request.acquire(signal)); check();
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
          entry.store.setState(old => ({ ...old, state: retired ? 'idle' : 'error', error: retired ? null : signal.reason === 'deadline' ? 'Image serving deadline reached.' : String(error instanceof Error ? error.message : error) }));
        }
      }).finally(() => {
        clearTimeout(timer);
        if (!bodyHandled) void responseBody?.cancel().catch(() => {});
        controller.abort('completed'); // terminate all transport ownership before freeing a token
        if (entry.controller === controller) entry.controller = null; running--; schedule();
      });
    }
  }
  return {
    retain(request: MediaRequest, isVisible = true) {
      if (disposed) throw new Error('Media owner retired.');
      let entry = entries.get(request.key);
      if (entry && (entry.request.fingerprint !== request.fingerprint || entry.request.sha256 !== request.sha256)) throw new Error('Immutable media binding changed.');
      if (!entry) {
        if (!collect(0, true)) throw new Error('Media entry capacity reached.');
        entry = { request, refs: 0, visible: 0, bytes: 0, controller: null, attempted: false,
          store: new Store<MediaSnapshot>({ url: null, state: 'idle', error: null }) };
        entries.set(request.key, entry);
      }
      const owned = entry; owned.refs++; if (isVisible) owned.visible++;
      if (owned.store.state.state === 'idle') owned.attempted = false;
      schedule();
      let live = true, shown = isVisible;
      return { store: owned.store,
        visible(next: boolean) { if (!live || shown === next) return; shown = next; owned.visible += next ? 1 : -1; if (!owned.visible) owned.controller?.abort(); else if (owned.store.state.state === 'idle') owned.attempted = false; schedule(); },
        retry() { if (!live || owned.controller) return; owned.attempted = false; schedule(); },
        dispose() { if (!live) return; live = false; owned.refs--; if (shown) owned.visible--; if (!owned.refs || !owned.visible) owned.controller?.abort(); },
      };
    },
    visible(next: boolean) { if (visible === next) return; visible = next; if (!next) for (const entry of entries.values()) entry.controller?.abort(); else { for (const entry of entries.values()) if (entry.store.state.state === 'idle') entry.attempted = false; schedule(); } },
    stats: () => ({ entries: entries.size, bytes, running }),
    dispose() { if (disposed) return; disposed = true; for (const entry of [...entries.values()]) release(entry); },
  };
}
