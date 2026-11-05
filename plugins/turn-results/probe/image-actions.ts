import { createOriginalImageLease, verifyOriginalImage } from './image.ts';
import type { OriginalImageLease, OriginalImageSdk, OriginalImageTarget } from './image.ts';

/** Request lifetime is the owning pane root, even before React can unmount it. */
export function createProbeImageActions(options: {
  sdk: OriginalImageSdk;
  lifetime: AbortSignal;
  isCurrent: () => boolean;
  open: (target: OriginalImageTarget) => boolean;
  onLease: (lease: OriginalImageLease) => void;
  onStatus: (status: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  let disposed = false;
  let request: AbortController | null = null;
  let busy = false;
  const active = () => !disposed && !options.lifetime.aborted && options.isCurrent();
  return {
    async run(kind: 'load' | 'open'): Promise<void> {
      if (!active() || busy) return;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const signal = AbortSignal.any([options.lifetime, controller.signal]);
      busy = true;
      options.onBusy(true);
      try {
        if (kind === 'load') {
          const result = await createOriginalImageLease(options.sdk, signal);
          if (!active() || signal.aborted) return;
          options.onLease(result);
          options.onStatus('Original file hash verified on bb-machine. Waiting for image load. Historical origin host was not recorded.');
        } else {
          const result = await verifyOriginalImage(options.sdk, signal);
          if (!active() || signal.aborted) return;
          const handled = options.open(result.target);
          if (!active() || signal.aborted) return;
          options.onStatus(handled ? 'Native file preview handled the original explicit-host target.'
            : 'Native file preview did not handle this target. The file route remains available for inspection.');
        }
      } catch {
        if (active() && !signal.aborted) options.onStatus('Original image could not be read or opened. Retry explicitly.');
      } finally {
        if (request === controller) {
          busy = false;
          if (active()) options.onBusy(false);
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      request?.abort();
    },
  };
}
