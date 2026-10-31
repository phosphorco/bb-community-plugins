import type { BbPluginApi, StandardSchemaV1 } from '@get-bb/plugin-sdk';
import type { ZodType } from 'zod';
import type { GalleryPage } from './gallery/index.ts';
import { canonicalByteLength } from '@phosphorco/bb-turn-results';
import { registerTurnResultsParticipant } from '@phosphorco/bb-turn-results/bb';
import { createGalleryIndex } from './gallery/index.ts';
import { GALLERY_METHODS, PendingGallerySchema, PendingGalleryOutputSchema, ReadGallerySchema, StageGallerySchema, ApplyGallerySchema, KnownGallerySchema, KnownGalleryOutputSchema, GalleryRawSchema } from './gallery/rpc.ts';

function standard<T>(schema: ZodType<T>): StandardSchemaV1<unknown, T> {
  return { '~standard': { version: 1, vendor: 'turn-results-gallery',
    jsonSchema: { input: () => schema.toJSONSchema({ io: 'input', unrepresentable: 'any' }), output: () => schema.toJSONSchema({ io: 'output', unrepresentable: 'any' }) },
    validate(raw) {
      try { canonicalByteLength(raw, 262144); } catch { return { issues: [{ message: 'RPC input exceeds admission bounds.' }] }; }
      const result = schema.safeParse(raw);
      return result.success ? { value: result.data } : { issues: result.error.issues.map(issue => ({ message: issue.message })) };
    },
  } };
}

export default function turnResultsPlugin(bb: BbPluginApi): void {
  const index = createGalleryIndex(bb.storage.database());
  registerTurnResultsParticipant(bb, { pluginId: 'turn-results',
    capabilities: { revision: 'gallery-1', consumer: { invalidate: true } },
    invalidate(input) {
      const stage = index.readStage(input.threadId, input.supplierPluginId, 'source-invalidation');
      const result = index.applyPage({ threadId: input.threadId, owner: input.supplierPluginId, changes: [],
        stage: { id: 'source-invalidation', expectedVersion: stage?.version ?? null,
          value: { stage: 'feed', cursor: null, status: 'ready', debt: { revision: { epoch: input.revision.epoch, sequence: input.revision.sequence } } } } });
      if (result.state !== 'committed' && result.state !== 'unchanged') return { state: 'not-admitted' };
      bb.realtime.publish('results-changed', { threadId: input.threadId });
      return { state: 'dirty' };
    },
  });
  for (const event of ['thread.active', 'thread.idle', 'thread.failed', 'thread.deleted'] as const) {
    bb.events.on(event, ({ thread }) => {
      if (event === 'thread.deleted') index.deleteThread(thread.id, 32);
      bb.realtime.publish('results-changed', { threadId: thread.id });
    });
  }
  bb.rpc.register({
    [GALLERY_METHODS.pending]: { input: standard(PendingGallerySchema), output: standard(PendingGalleryOutputSchema) },
    [GALLERY_METHODS.known]: { input: standard(KnownGallerySchema), output: standard(KnownGalleryOutputSchema) },
    [GALLERY_METHODS.read]: { input: standard(ReadGallerySchema), output: standard(GalleryRawSchema) },
    [GALLERY_METHODS.stage]: { input: standard(StageGallerySchema), output: standard(GalleryRawSchema) },
    [GALLERY_METHODS.apply]: { input: standard(ApplyGallerySchema), output: standard(GalleryRawSchema) },
  }, {
    [GALLERY_METHODS.pending]: input => index.readPending(input),
    [GALLERY_METHODS.known]: input => index.knownIdentities(input.threadId, input.owner, input.refs),
    [GALLERY_METHODS.read]: input => {
      const options = { limit: 8, now: Date.now(), ...(input.after ? { after: input.after } : {}) };
      const page = input.turnId ? index.readTurn(input.threadId, input.turnId, options) : index.readThread(input.threadId, options);
      // Prefix reduction retains exact keyset continuation; no silent suffix skip.
      while (page.rows.length) {
        try { canonicalByteLength(page, 65536); break; }
        catch { const removed = page.rows.pop()!; const last = page.rows[page.rows.length - 1];
          page.next = last ? { seq: last.identity.ref.source.seq, key: last.key } : { seq: removed.identity.ref.source.seq, key: '' }; }
      }
      return { page, coverage: index.coverage(input.threadId) };
    },
    [GALLERY_METHODS.stage]: input => index.readStage(input.threadId, input.owner, input.id),
    [GALLERY_METHODS.apply]: input => {
      canonicalByteLength(input, 262144);
      // Input schema validated the complete page. JSON strips optional undefined
      // fields before the index's independent canonical raw admission.
      return index.applyPage(JSON.parse(JSON.stringify(input)) as GalleryPage);
    },
  });
}
