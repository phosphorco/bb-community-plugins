import type { BbPluginApi } from '@get-bb/plugin-sdk';

/** Development-only oracle; never retarget from the current environment. */
export const ORIGINAL_IMAGE = Object.freeze({
  threadId: 'thr_im2hj668sh',
  hostId: 'host_chtdmruc4g',
  path: '/home/ubuntu/.codex-subscription-router/accounts/20260918-d77317/codex-home/generated_images/01a188c6-2eeb-7ad0-9097-92045e025287/exec-f0d62fd4-4f3d-4d9f-a921-1c37ec8a75c7.png',
  rootPath: '/home/ubuntu/.codex-subscription-router/accounts/20260918-d77317/codex-home/generated_images/01a188c6-2eeb-7ad0-9097-92045e025287',
  basename: 'exec-f0d62fd4-4f3d-4d9f-a921-1c37ec8a75c7.png',
  sha256: '7f77a104dbd6ad5bc52df8da9ff183d7a71bb928c2cefe955cbb1489ada0f078',
  sizeBytes: 1_605_232,
  eventId: 'evt_iqzg5z3d27',
  seq: 433,
  turnId: 'daa509e06e-t247',
});
export const IMAGE_DEADLINE_MS = 5_000;
export const IMAGE_LEASE_TTL_MS = 120_000;
const savedPath = ORIGINAL_IMAGE.path;

// Selected public declarations: no SDK runtime or cross-plugin imports.
export type OriginalImageSdk = {
  files: Pick<BbPluginApi['sdk']['files'], 'read' | 'createPreview'>;
};
export type OriginalImageTarget = {
  kind: 'host'; hostId: string; path: string;
};
export type VerifiedOriginalImage = {
  target: OriginalImageTarget;
  provenance: {
    originHost: { state: 'unknown'; reason: 'not-recorded' };
    artifactLocation: {
      state: 'verified'; source: 'explicit-host-read'; hostId: string;
      path: string; observedAt: number; sha256: string;
    };
  };
  sizeBytes: number;
  mimeType: 'image/png';
};
export type OriginalImageLease = VerifiedOriginalImage & {
  url: string; expiresAtMs: number;
};

async function withDeadline<T>(signal: AbortSignal, work: (
  boundedSignal: AbortSignal, check: () => void,
) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const deadline = Date.now() + IMAGE_DEADLINE_MS;
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(
    new DOMException('Original image probe deadline exceeded', 'TimeoutError'),
  ), IMAGE_DEADLINE_MS);
  const check = () => {
    signal.throwIfAborted();
    controller.signal.throwIfAborted();
    if (Date.now() >= deadline) throw new DOMException('Stale image probe result', 'TimeoutError');
  };
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work(controller.signal, check), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

async function verify(sdk: OriginalImageSdk, signal: AbortSignal, check: () => void): Promise<VerifiedOriginalImage> {
  check();
  const result = await sdk.files.read({
    hostId: ORIGINAL_IMAGE.hostId, path: savedPath,
    rootPath: ORIGINAL_IMAGE.rootPath, signal,
  });
  check();
  if (result.sha256 !== ORIGINAL_IMAGE.sha256) throw new Error('Original image SHA-256 mismatch');
  // The public read API has no byte-limit argument. These are post-parse
  // admission limits, not a transport allocation cap. Never retain content.
  if (result.path !== savedPath || result.sizeBytes !== ORIGINAL_IMAGE.sizeBytes ||
      result.mimeType !== 'image/png' || result.contentEncoding !== 'base64' ||
      typeof result.content !== 'string' ||
      result.content.length !== 4 * Math.ceil(ORIGINAL_IMAGE.sizeBytes / 3)) {
    throw new Error('Original image metadata or content size mismatch');
  }
  const target: OriginalImageTarget = { kind: 'host', hostId: ORIGINAL_IMAGE.hostId, path: savedPath };
  return {
    target, sizeBytes: result.sizeBytes, mimeType: 'image/png',
    provenance: {
      originHost: { state: 'unknown', reason: 'not-recorded' },
      artifactLocation: { state: 'verified', source: 'explicit-host-read',
        hostId: target.hostId, path: target.path, observedAt: Date.now(), sha256: result.sha256 },
    },
  };
}

/** One explicit read, no retries; callers own cancellation and result lifetime. */
export function verifyOriginalImage(sdk: OriginalImageSdk, signal: AbortSignal): Promise<VerifiedOriginalImage> {
  return withDeadline(signal, (boundedSignal, check) => verify(sdk, boundedSignal, check));
}

/** Call ONLY from a later explicitly authorized UI button. Allocates a lease.
 * No automatic calls, renewal, navigation, or retries belong in this module.
 * Verification is an observation, not an immutable snapshot of future GET bytes.
 */
export function createOriginalImageLease(sdk: OriginalImageSdk, signal: AbortSignal): Promise<OriginalImageLease> {
  return withDeadline(signal, async (boundedSignal, check) => {
    const verified = await verify(sdk, boundedSignal, check);
    check();
    const lease = await sdk.files.createPreview({
      hostId: ORIGINAL_IMAGE.hostId, rootPath: ORIGINAL_IMAGE.rootPath,
      ttlMs: IMAGE_LEASE_TTL_MS, signal: boundedSignal,
    });
    check();
    // Public installed server returns an origin-relative native lease base URL.
    if (!/^\/api\/v1\/file-previews\/[A-Za-z0-9-]+$/.test(lease.baseUrl) ||
        !Number.isFinite(lease.expiresAtMs) || lease.expiresAtMs <= Date.now()) {
      throw new Error('Invalid or expired original image lease');
    }
    return { ...verified, url: `${lease.baseUrl}/${encodeURIComponent(ORIGINAL_IMAGE.basename)}`,
      expiresAtMs: lease.expiresAtMs };
  });
}
