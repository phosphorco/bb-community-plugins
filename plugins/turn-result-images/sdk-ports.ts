import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { ImageSupplierPorts } from './supplier.ts';
import { MAX_IMAGE_BASE64_CHARS, ImagePortError } from './verification.ts';
import type { ImagePreviewPort } from './media.ts';

export type ImageSdk = {
  threads: Pick<BbPluginApi['sdk']['threads'], 'get' | 'events'>;
  environments: Pick<BbPluginApi['sdk']['environments'], 'get'>;
  files: Pick<BbPluginApi['sdk']['files'], 'read'>;
};
/** Pass only explicit source-owned host/root/TTL. Public SDK has no preview
 * revocation method; cancellation fences local completion, native TTL retires
 * any lease already created remotely.
 */
export function createImagePreviewPort(sdk: { files: Pick<BbPluginApi['sdk']['files'], 'createPreview'> }): ImagePreviewPort {
  return { async create(input) {
    input.signal.throwIfAborted();
    const result = await sdk.files.createPreview(input);
    input.signal.throwIfAborted();
    return result;
  } };
}
/** One exact row, one current host candidate, one explicit-host file read. SDK
 * results are already parsed: all size checks are post-parse admission only.
 */
export function createImageVerificationPorts(sdk: ImageSdk, now = Date.now): ImageSupplierPorts['verification'] {
  return {
    native: { async read(source, { signal }) {
      signal.throwIfAborted();
      const rows = await sdk.threads.events.list({ threadId: source.threadId,
        ...(source.seq === 0 ? { beforeSeq: '1', order: 'desc' as const }
          : { afterSeq: String(source.seq - 1), order: 'asc' as const }),
        limit: '1', types: ['item/completed'], signal });
      signal.throwIfAborted();
      const row = rows[0];
      if (rows.length !== 1 || !row || row.id !== source.eventId || row.seq !== source.seq || row.threadId !== source.threadId) return null;
      // Do not enumerate/clone provider payload before selected-field validation.
      return row;
    } },
    currentHost: { async lookup(threadId, { signal }) {
      signal.throwIfAborted();
      const thread = await sdk.threads.get({ threadId, signal }); signal.throwIfAborted();
      if (!thread.environmentId) return null;
      const environment = await sdk.environments.get({ environmentId: thread.environmentId, signal }); signal.throwIfAborted();
      return { hostId: environment.hostId, observedAt: now() };
    } },
    files: { async read({ hostId, path, signal, maxBytes }) {
      signal.throwIfAborted();
      const file = await sdk.files.read({ hostId, path, signal }); signal.throwIfAborted();
      if (file.sizeBytes > maxBytes || file.content.length > MAX_IMAGE_BASE64_CHARS) throw new ImagePortError('unsupported');
      return { path: file.path, content: file.content, contentEncoding: file.contentEncoding,
        sha256: file.sha256, sizeBytes: file.sizeBytes, ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }), observedAt: now() };
    } },
  };
}
