import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountProbePane } from '../probe/pane.ts';
import { createProbeImageActions } from '../probe/image-actions.ts';
import { ORIGINAL_IMAGE } from '../probe/image.ts';
import type { OriginalImageSdk } from '../probe/image.ts';
import type { Anchor } from '../probe/anchor.ts';
const anchor: Anchor = { threadId: ORIGINAL_IMAGE.threadId, turnId: ORIGINAL_IMAGE.turnId,
  rowId: 'original-terminal-row', sourceSeqStart: 432, sourceSeqEnd: 435, historySnapshot: 's' };
const content = 'A'.repeat(4 * Math.ceil(ORIGINAL_IMAGE.sizeBytes / 3));
for (const retirement of ['stop', 'replacement', 'row-removal'] as const) {
  for (const kind of ['load', 'open'] as const) {
    for (const ignoresAbort of [false, true]) {
      test(`${retirement}: ${kind} held read (${ignoresAbort ? 'ignores' : 'honors'} abort) cannot advance before deferred unmount`, async () => {
        const dom = new JSDOM('<div data-thread-window><div data-timeline-row-list="top-level"><div data-timeline-row-id="original-terminal-row"><p>Native</p></div></div><i id="sentinel"></i></div>');
        const saved = { document: globalThis.document, Element: globalThis.Element,
          MutationObserver: globalThis.MutationObserver, queueMicrotask: globalThis.queueMicrotask };
        const deferred: (() => void)[] = [];
        Object.assign(globalThis, { document: dom.window.document, Element: dom.window.Element,
          MutationObserver: dom.window.MutationObserver, queueMicrotask: (task: () => void) => { deferred.push(task); } });
        let releaseRead!: () => void;
        let readSignal: AbortSignal | undefined;
        let leases = 0, opens = 0, publications = 0, disposals = 0, mounts = 0;
        let pending: Promise<void> = Promise.resolve();
        const sdk: OriginalImageSdk = { files: {
          read: args => new Promise((resolve, reject) => {
            readSignal = args.signal;
            if (!ignoresAbort) args.signal?.addEventListener('abort', () => reject(args.signal!.reason), { once: true });
            releaseRead = () => resolve({ path: ORIGINAL_IMAGE.path, sha256: ORIGINAL_IMAGE.sha256,
              sizeBytes: ORIGINAL_IMAGE.sizeBytes, mimeType: 'image/png', contentEncoding: 'base64', content });
          }),
          async createPreview() { leases++; return { baseUrl: '/api/v1/file-previews/test', expiresAtMs: Date.now() + 120000 }; },
        } };
        const sentinel = document.getElementById('sentinel')!;
        const mount: Parameters<typeof mountProbePane>[2] = (_host, isCurrent, lifetime) => {
          mounts++;
          const actions = createProbeImageActions({ sdk, isCurrent, lifetime,
            open: () => { opens++; return true; }, onLease: () => { publications++; },
            onStatus: () => { publications++; }, onBusy: () => { publications++; } });
          if (mounts === 1) pending = actions.run(kind);
          return { dispose() { disposals++; actions.dispose(); } };
        };
        const handle = mountProbePane(sentinel, anchor, mount, () => {});
        let successor: ReturnType<typeof mountProbePane> | undefined;
        try {
          assert.equal(readSignal?.aborted, false);
          if (retirement === 'stop') handle.dispose();
          if (retirement === 'replacement') successor = mountProbePane(sentinel, anchor, mount, () => {});
          if (retirement === 'row-removal') {
            document.querySelector('[data-timeline-row-id]')!.remove();
            // MutationObserver schedules the production reconciliation; execute that
            // boundary but deliberately hold its deferred React unmount callback.
            await Promise.resolve();
            assert.ok(deferred.length > 0);
            deferred.shift()!();
          }
          assert.equal(readSignal?.aborted, true, 'pane retirement aborts without waiting for React cleanup');
          assert.equal(disposals, 0, 'unmount remains deferred');
          const beforeRelease = publications;
          releaseRead();
          await pending;
          await Promise.resolve();
          assert.equal(leases, 0, 'retired verification cannot start a serving lease');
          assert.equal(opens, 0, 'retired verification cannot navigate');
          assert.equal(publications, beforeRelease, 'no stale result/status/busy publication');
          // The first pending callback is the old root disposal, not native state.
          while (deferred.length) deferred.shift()!();
          assert.equal(disposals, 1);
          handle.dispose(); // stale/double disposal cannot retire successor
          assert.equal(disposals, 1);
          successor?.dispose();
          while (deferred.length) deferred.shift()!();
          assert.equal(disposals, mounts);
        } finally {
          handle.dispose(); successor?.dispose();
          while (deferred.length) deferred.shift()!();
          Object.assign(globalThis, saved);
          dom.window.close();
        }
      });
    }
  }
}
