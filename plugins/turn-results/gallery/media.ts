import { Store } from '@tanstack/store';
import { z } from 'zod';
import { canonicalByteLength, canonicalJson, sha256Canonical } from '@phosphorco/bb-turn-results';
import type { useSdk } from '@get-bb/plugin-sdk/app';
import type { GalleryObservation } from './index.ts';
import type { ResultIdentity } from '@phosphorco/bb-turn-results';

export interface ImageLease {
  url: string; expiresAtMs: number; targetFingerprint: string; leaseGeneration: string;
}
export interface MediaSnapshot { url: string | null; state: 'idle' | 'loading' | 'ready' | 'error'; error: string | null }
export interface MediaAdoption {
  root: AbortSignal; client: object; generation: number; binding: string;
  live(): boolean; current(): boolean;
  correlate(signal: AbortSignal, speculative: () => boolean): Promise<void>;
}
export interface MediaRequest { key: string; claim?: string; fingerprint: string | null; sha256: string | null;
  dispatched?: boolean; adoption?: MediaAdoption;
  acquire(signal: AbortSignal, speculative?: () => boolean): Promise<ImageLease> }

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

export function nativeImageIdentity(owner: string, identity: ResultIdentity): boolean {
  return owner === 'turn-result-images' && identity.ref.kind === 'bb-native-images/image-generated'
    && identity.artifact.provider === 'bb-native-images' && identity.artifact.kind === 'image'
    && identity.specificity === 'typed' && identity.evidence.basis === 'native-completion';
}
export function initialImageCandidate(row: GalleryObservation): boolean {
  return nativeImageIdentity(row.owner, row.identity) && row.unresolved && row.resolution === null
    && !row.sourceExpired && !row.retracted && row.currentAvailability?.state !== 'unavailable';
}
export interface ImageCorrelation { row: GalleryObservation; publish(): void }

/** One exact Media admission path for visible and speculative owners alike. */
export async function imageMediaRequest(row: GalleryObservation,
  scope: (signal: AbortSignal, read: (signal: AbortSignal) => Promise<unknown>, speculative: () => boolean) => Promise<{ state: 'ready'; value: unknown } | { state: 'capacity' }>,
  plugins: Pick<ReturnType<typeof useSdk>['plugins'], 'callRpc'>,
  correlate?: (signal: AbortSignal, speculative: () => boolean) => Promise<ImageCorrelation>): Promise<MediaRequest | null> {
  const resolution = row.resolution, route = resolution?.route, location = resolution?.provenance.artifactLocation;
  const sha256 = location?.state === 'verified' ? location.sha256 : undefined;
  const initial = initialImageCandidate(row);
  if (row.owner !== 'turn-result-images' || (!sha256 || route?.kind !== 'file') && (!initial || !correlate)) return null;
  const fingerprint = sha256 && route?.kind === 'file' ? await sha256Canonical({ target: route.target, sha256 }) : null;
  const request: MediaRequest = { key: row.key, claim: canonicalJson([row.owner, row.identity]), fingerprint, sha256: sha256 ?? null, async acquire(signal, speculative = () => false) {
    const read = await scope(signal, bounded => {
      bounded.throwIfAborted();
      // Own an already-dispatched response through raw settlement. Retirement
      // can refuse a late GET but cannot claim independent source work stopped.
      request.dispatched = true;
      return plugins.callRpc({ pluginId: row.owner, method: 'turnResultImagesV1Media',
        input: { version: 1, identity: JSON.parse(canonicalJson(row.identity)) }, outputSchema: mediaRaw });
    }, speculative);
    signal.throwIfAborted();
    if (read.state === 'capacity') throw Error('Image verification capacity reached.');
    const output = mediaOutput.parse(read.value);
    if (output.state !== 'ready') throw Error(output.reason);
    const admitted = initial ? await correlate!(signal, speculative) : null;
    signal.throwIfAborted();
    const current = admitted?.row ?? row, target = current.resolution?.route, location = current.resolution?.provenance.artifactLocation;
    if (current.owner !== row.owner || canonicalJson(current.identity) !== canonicalJson(row.identity)
      || target?.kind !== 'file' || location?.state !== 'verified') throw Error('Image binding changed.');
    const expectedSha = location.sha256, expectedFingerprint = await sha256Canonical({ target: target.target, sha256: expectedSha });
    signal.throwIfAborted();
    if (output.image.sha256 !== expectedSha || output.image.width * output.image.height > 16777216
      || output.lease.targetFingerprint !== expectedFingerprint || !output.lease.url.startsWith(`${output.lease.baseUrl}/`)
      || output.lease.expiresAtMs - output.lease.resolvedAt > 120000 || output.lease.expiresAtMs <= output.lease.resolvedAt) throw Error('Image binding changed.');
    // Fill an unknown binding once, after normal source Resolve/Apply/issued
    // Read correlation, before the same host renders its resolved row.
    if (request.fingerprint && (request.fingerprint !== expectedFingerprint || request.sha256 !== expectedSha)) throw Error('Image binding changed.');
    request.fingerprint = expectedFingerprint; request.sha256 = expectedSha;
    admitted?.publish();
    return output.lease;
  } };
  return request;
}

export const MEDIA_LIMITS = Object.freeze({ entries: 64, bytes: 33_554_432, imageBytes: 8_388_608, concurrency: 2, deadlineMs: 7000 });
type MediaDemand = { request: MediaRequest; live: boolean; shown: boolean };
type Entry = { demands: Set<MediaDemand>; wake: (() => void) | null;
  flight: { hold(): boolean; live(): boolean; shed(): boolean; detach(): void } | null; request: MediaRequest; store: Store<MediaSnapshot>; refs: number; visible: number; speculative: number; bytes: number; controller: AbortController | null; attempted: boolean; foregroundAttempt: boolean; foregroundEligible: boolean };

/** A single owner per app generation. TanStack owns notifications; this owner
 * only schedules bounded resources. Loaded blobs survive native row/root churn.
 * No clock polling, durable lease URL, or per-root file read is involved. */
export function createGalleryMedia(ports: MediaPorts) {
  const entries = new Map<string, Entry>();
  let bytes = 0, running = 0, disposed = false, visible = true, queued = false, warming = 0, demands = 0;
  // The private adopter ledger spends the same 128 live-demand bound as the
  // runtime read queue. It contains ownership callbacks, never another cache.
  const demandLimit = 128;
  function changed(entry: Entry, detach = false) {
    if (detach) entry.flight?.detach();
    if (entry.flight && !entry.flight.live()) entry.controller?.abort('scope-retired');
    const wake = entry.wake; entry.wake = null; wake?.();
  }
  function leave(entry: Entry) {
    if (!entry.refs || !entry.visible) {
      entry.flight?.detach();
      if (!entry.flight?.hold()) entry.controller?.abort();
    }
    const wake = entry.wake; entry.wake = null; wake?.();
  }

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
  function checkBinding(previous: MediaRequest, request: MediaRequest) {
    if ((previous.fingerprint !== request.fingerprint || previous.sha256 !== request.sha256)
      && !(previous.claim && previous.claim === request.claim
        && (previous.fingerprint === null && previous.sha256 === null || request.fingerprint === null && request.sha256 === null))) {
      throw new Error('Immutable media binding changed.');
    }
  }
  function renewFailedRequest(entry: Entry, request: MediaRequest) {
    if (entry.controller || entry.store.state.state !== 'error' || !entry.request.claim || entry.request.claim !== request.claim) return;
    checkBinding(entry.request, request);
    // Reentry supplies current correlation ownership, never new target facts.
    // A binding learned before publication/GET failed remains a constraint on
    // an otherwise-unbound candidate's next independently correlated response.
    if (entry.request.fingerprint !== null) {
      request.fingerprint = entry.request.fingerprint; request.sha256 = entry.request.sha256;
    }
    entry.request = request;
  }
  function pump() {
    if (disposed || !visible) return;
    for (const entry of [...entries.values()].sort((a, b) => Number(a.visible <= a.speculative) - Number(b.visible <= b.speculative))) {
      if (!entry.refs || !entry.visible || entry.attempted || entry.controller || entry.store.state.url) continue;
      if (running >= MEDIA_LIMITS.concurrency) {
        // Only useful foreground pressure can retire settled response DATA.
        // Actual raw work, visible proof waiters, active GETs and Blobs retain
        // their ownership. The existing finally returns the media credit.
        if (entry.visible > entry.speculative && (!entry.request.adoption || entry.request.adoption.current())) {
          for (const held of entries.values()) if (held !== entry && held.flight?.shed()) break;
        }
        continue;
      }
      if (entry.request.adoption && !entry.request.adoption.live()) {
        const replacement = [...entry.demands].find(value => value.live && value.shown && value.request.adoption?.live());
        if (!replacement) continue;
        entry.request = replacement.request;
      }
      entry.attempted = true; entry.foregroundEligible = false; entry.foregroundAttempt = entry.visible > entry.speculative;
      const controller = new AbortController(); entry.controller = controller; running++;
      const origin = entry.request, adoption = origin.adoption;
      origin.dispatched = false;
      let detached = false, fetchStarted = false, responseSettled = false, fetchOwner: MediaDemand | null = null;
      const ownerCurrent = () => !!fetchOwner?.live && fetchOwner.shown && !!fetchOwner.request.adoption?.current();
      const sameScope = (demand: MediaDemand) => {
        const next = demand.request.adoption;
        return !!(adoption && demand.live && demand.shown && next && next.root === adoption.root && next.client === adoption.client
          && next.generation === adoption.generation && next.binding === adoption.binding && next.live());
      };
      entry.flight = {
        hold: () => !fetchStarted && origin.dispatched === true && !!adoption?.live(),
        live: () => !adoption || adoption.live() && (!fetchStarted || ownerCurrent()),
        shed() {
          if (controller.signal.aborted || !adoption || !responseSettled || fetchStarted || [...entry.demands].some(sameScope)) return false;
          controller.abort('foreground-pressure'); return true;
        },
        detach() { detached = true; },
      };
      const hardAbort = () => controller.abort('scope-retired');
      adoption?.root.addEventListener('abort', hardAbort, { once: true });
      const signal = controller.signal;
      entry.store.setState(old => ({ ...old, state: 'loading', error: null }));
      const timer = setTimeout(() => controller.abort('deadline'), MEDIA_LIMITS.deadlineMs);
      const current = () => !disposed && !signal.aborted && entries.get(entry.request.key) === entry && entry.controller === controller && entry.flight?.live();
      const check = () => { if (!current()) throw new Error('Image request retired.'); };
      const wait = <T,>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Image request retired.')); };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
      });
      let responseBody: ReadableStream<Uint8Array> | null = null, bodyHandled = false;
      void (async () => {
        const lease = await wait(origin.acquire(signal, () => entry.visible <= entry.speculative)); check();
        responseSettled = true; schedule();
        if (adoption) {
          // A ready lease is still only data. Card-only retirement may leave
          // it owned until a same-scope current consumer independently proves
          // the exact issued row; the original timer and media credit remain.
          for (;;) {
            check();
            if (!adoption.live()) throw Error('Image response scope retired.');
            const demand = [...entry.demands].find(value => sameScope(value) && value.request.adoption!.current());
            if (demand) {
              const next = demand.request.adoption!;
              if (detached || demand.request !== origin) await wait(next.correlate(signal, () => entry.visible <= entry.speculative));
              check();
              if (!adoption.live() || !next.live()) throw Error('Image response scope retired.');
              if (demand.live && demand.shown && next.current()) { fetchOwner = demand; break; }
            }
            await wait(new Promise<void>(resolve => { entry.wake = resolve; }));
          }
        }
        check();
        fetchStarted = true;
        if (!entry.request.fingerprint || !entry.request.sha256 || lease.targetFingerprint !== entry.request.fingerprint || lease.expiresAtMs <= Date.now()
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
        clearTimeout(timer); adoption?.root.removeEventListener('abort', hardAbort);
        entry.wake = null; entry.flight = null;
        if (!bodyHandled) void responseBody?.cancel().catch(() => {});
        controller.abort('completed'); // terminate all transport ownership before freeing a token
        if (entry.controller === controller) entry.controller = null; running--; foregroundDemand(entry); schedule();
      });
    }
  }
  return {
    retain(request: MediaRequest, isVisible = true, speculative = false) {
      if (disposed) throw new Error('Media owner retired.');
      if (demands >= demandLimit) throw Error('Media demand capacity reached.');
      if (speculative && warming >= 2) throw Error('Nearby media capacity reached.');
      let entry = entries.get(request.key);
      if (entry) {
        checkBinding(entry.request, request); renewFailedRequest(entry, request);
        if (!entry.controller && entry.store.state.state === 'idle' && entry.request.adoption && !entry.request.adoption.live()) entry.request = request;
      }
      if (!entry) {
        if (!collect(0, true)) throw new Error('Media entry capacity reached.');
        entry = { demands: new Set(), wake: null, flight: null, request, refs: 0, visible: 0, speculative: 0, bytes: 0, controller: null, attempted: false, foregroundAttempt: false, foregroundEligible: false,
          store: new Store<MediaSnapshot>({ url: null, state: 'idle', error: null }) };
        entries.set(request.key, entry);
      }
      const owned = entry, demand: MediaDemand = { request, live: true, shown: isVisible };
      owned.demands.add(demand); demands++;
      owned.refs++; if (isVisible) owned.visible++;
      if (speculative) { warming++; if (isVisible) owned.speculative++; }
      if (owned.store.state.state === 'idle') owned.attempted = false;
      foregroundDemand(owned); changed(owned); ports.demand?.();
      schedule();
      let live = true, shown = isVisible, optional = speculative;
      return { store: owned.store,
        revalidate() { if (live) { changed(owned); if (!owned.controller) schedule(); } },
        promote() { if (!live || !optional) return; optional = false; warming--; if (shown) owned.speculative--; foregroundDemand(owned); changed(owned); ports.demand?.(); schedule(); },
        visible(next: boolean) { if (!live || shown === next) return; shown = next; demand.shown = next; owned.visible += next ? 1 : -1; if (optional) owned.speculative += next ? 1 : -1; if (!next) changed(owned, true); if (!owned.visible) leave(owned); else if (owned.store.state.state === 'idle') owned.attempted = false; foregroundDemand(owned); changed(owned); ports.demand?.(); schedule(); },
        retry() { if (!live || owned.controller) return; renewFailedRequest(owned, request); owned.attempted = false; schedule(); },
        dispose() { if (!live) return; live = false; demand.live = false; owned.demands.delete(demand); demands--; changed(owned, true); owned.refs--; if (shown) owned.visible--; if (optional) { warming--; if (shown) owned.speculative--; } leave(owned); },
      };
    },
    revalidate() { for (const entry of entries.values()) {
      if (entry.request.adoption && !entry.request.adoption.live()) entry.controller?.abort('scope-retired');
      changed(entry);
    } },
    visible(next: boolean) { if (visible === next) return; visible = next; if (!next) for (const entry of entries.values()) entry.controller?.abort(); else { for (const entry of entries.values()) if (entry.store.state.state === 'idle') entry.attempted = false; schedule(); } },
    stats: () => ({ entries: entries.size, bytes, running }),
    dispose() { if (disposed) return; disposed = true; for (const entry of [...entries.values()]) release(entry); },
  };
}
