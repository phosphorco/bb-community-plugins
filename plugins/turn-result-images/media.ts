import { posix, win32 } from 'node:path';
import { canonicalJson, sha256Canonical } from '@phosphorco/bb-turn-results';
import type { RegistrationPort } from '@phosphorco/bb-turn-results/bb';
import type { ImageObservationStore } from './store.ts';
import { ImageStoreError } from './store.ts';
import { verifyImage } from './verification.ts';
import type { ImageVerificationPorts } from './verification.ts';
import {
  IMAGE_MEDIA_METHOD, IMAGE_MEDIA_DEADLINE_MS, IMAGE_MEDIA_TTL_MS,
  ImageMediaInputSchema, ImageMediaOutputSchema, decodeImageMediaInput, decodeImageMediaOutput,
} from './media-contract.ts';
import type { ImageMediaInput, ImageMediaOutput } from './media-contract.ts';

export interface ImagePreviewPort {
  create(input: { hostId: string; rootPath: string; ttlMs: number; signal: AbortSignal }): Promise<{ baseUrl: string; expiresAtMs: number }>;
}
export interface ImageMediaPorts {
  store: ImageObservationStore;
  verification: Omit<ImageVerificationPorts, 'materializations'>;
  preview: ImagePreviewPort;
  now(): number;
  /** Shared with resolve: no media-specific extra source lanes. */
  acquire(): (() => void) | null;
}
const unavailable = (reason: string): ImageMediaOutput => ({ version: 1, state: 'unavailable', reason });

/** Source-owned, request-scoped media. No URL cache, renewal timer, detached
 * task, durable write, native fallback or alternate host discovery. Native
 * leases have no public revocation API and expire under their requested TTL.
 */
export function registerImageMedia(bb: RegistrationPort, ports: ImageMediaPorts): { dispose(): void } {
  const lifetime = new AbortController();
  const dispose = () => lifetime.abort();

  async function read(input: ImageMediaInput, signal: AbortSignal, check: () => void): Promise<ImageMediaOutput> {
    check();
    const entry = ports.store.read(input.identity.ref.source);
    if (!entry?.materialization) return unavailable('verified-binding-missing');
    if (canonicalJson(entry.history.identity) !== canonicalJson(input.identity)) return unavailable('source-binding-conflict');
    const binding = entry.materialization;
    // Even a fresh data resolution is not sufficient for a new media lease.
    // Rehash the fixed target on every request; never try current environment.
    const verified = await verifyImage(input.identity, { ...ports.verification,
      materializations: { async read() { check(); return binding; } },
    }, signal);
    check();
    if (verified.state !== 'verified') return unavailable(verified.reason);
    if (!verified.layout || verified.displayUnsupported) return unavailable('dimensions-over-policy');
    const target = binding.target;
    const path = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(target.path) ? win32 : posix;
    const rootPath = path.dirname(target.path), basename = path.basename(target.path);
    // The native route interprets backslashes as separators. Refuse ambiguous
    // paths instead of normalizing the stored immutable target to another file.
    if (!basename || basename === '.' || basename === '..' || /[\\/\p{Cc}]/u.test(basename)
      || path.join(rootPath, basename) !== target.path) return unavailable('unsupported-preview-path');
    const targetFingerprint = await sha256Canonical({ target, sha256: binding.providerSha256 });
    check();
    const lease = await ports.preview.create({ hostId: target.hostId, rootPath, ttlMs: IMAGE_MEDIA_TTL_MS, signal });
    check();
    const resolvedAt = ports.now();
    try {
      // Admission before interpolating SDK-controlled data; failed outputs
      // remain a compact failure and never expose invalid external URLs.
      if (typeof lease.baseUrl !== 'string' || lease.baseUrl.length > 160) return unavailable('invalid-preview-lease');
      return decodeImageMediaOutput({ version: 1, state: 'ready', lease: {
        targetFingerprint, leaseGeneration: crypto.randomUUID(), baseUrl: lease.baseUrl,
        url: `${lease.baseUrl}/${encodeURIComponent(basename)}`, expiresAtMs: lease.expiresAtMs, resolvedAt,
      }, image: { mimeType: 'image/png', width: binding.width, height: binding.height,
        sizeBytes: binding.sizeBytes, sha256: binding.providerSha256 } });
    } catch { return unavailable('invalid-preview-lease'); }
  }

  async function handle(raw: unknown): Promise<ImageMediaOutput> {
    const input = decodeImageMediaInput(raw);
    if (lifetime.signal.aborted) return unavailable('source-disposed');
    const release = ports.acquire();
    if (!release) return unavailable('source-capacity');
    const controller = new AbortController();
    const end = performance.now() + IMAGE_MEDIA_DEADLINE_MS;
    const timeout = () => controller.abort(new DOMException('Image media deadline exceeded', 'TimeoutError'));
    const abort = () => controller.abort(lifetime.signal.reason);
    const check = () => {
      controller.signal.throwIfAborted();
      if (performance.now() >= end) { timeout(); controller.signal.throwIfAborted(); }
    };
    const timer = setTimeout(timeout, IMAGE_MEDIA_DEADLINE_MS);
    lifetime.signal.addEventListener('abort', abort, { once: true });
    let onAbort: () => void = () => {};
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const result = await Promise.race([read(input, controller.signal, check), aborted]);
      check();
      return result;
    } catch (error) {
      if (lifetime.signal.aborted) return unavailable('source-disposed');
      if (controller.signal.aborted) return unavailable('source-timeout');
      if (error instanceof ImageStoreError && error.code === 'capacity') return unavailable('source-key-capacity');
      return unavailable('source-error');
    } finally {
      // Fence any ignored SDK completion before releasing the owned lane.
      controller.abort(); clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      lifetime.signal.removeEventListener('abort', abort);
      release();
    }
  }
  bb.rpc.register({ [IMAGE_MEDIA_METHOD]: { input: ImageMediaInputSchema, output: ImageMediaOutputSchema } },
    { [IMAGE_MEDIA_METHOD]: handle });
  bb.onDispose?.(dispose);
  return { dispose };
}
