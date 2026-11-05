import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { PluginBrowserBbSdk } from '@get-bb/plugin-sdk/app';
import type { AttachmentRecordV1, ObserveInputV1, AssessInputV1, AssessOutputV1, ReadInputV1, ReadOutputV1, FamilyInputV1, FamilyOutputV1, AttachInputV1, DetachInputV1, WriteOutputV1 } from '../src/index.js';
import { createThreadAttachmentsClient, createThreadAttachmentsSupplierHandlers, threadAttachmentsRpcContract } from '../src/bb.js';
import type { AttachmentsConformanceCase } from '../src/testing.js';
declare const server: BbPluginApi['sdk'];
declare const browser: PluginBrowserBbSdk;
const serverClient = createThreadAttachmentsClient(server, 'supplier');
const browserClient = createThreadAttachmentsClient(browser, 'supplier');
const serverIdle: Promise<void> = serverClient.whenIdle();
const browserIdle: Promise<void> = browserClient.whenIdle(new AbortController().signal);
void [serverIdle, browserIdle];
// Frontend dispatchers need only a callRpc transport, with no SDK runtime/list methods.
createThreadAttachmentsClient({ plugins: { callRpc: server.plugins.callRpc } }, 'supplier');
type Invocation = { actualActor: string };
declare const record: AttachmentRecordV1;
const handlers = createThreadAttachmentsSupplierHandlers<Invocation>({
 observe: input => ({ version: 1, revision: 'r1', records: [{ ...record, threadId: input.threadId }] }),
 assess: input => ({ version: 1, state: 'queued', threadIds: input.threadIds }),
 read: (input, context) => {
  const _actor: string = context.rpcContext.actualActor;
  return { version: 1, revision: 'r1', records: input.threadIds.map(threadId => ({ ...record, threadId })) };
 },
 family: input => ({ version: 1, revision: 'r1', leadId: input.threadId, threadIds: [input.threadId], coverage: 'complete' }),
 attach: input => ({ version: 1, state: 'applied', revision: 'r2', operationId: input.operationId }),
 detach: input => ({ version: 1, state: 'applied', revision: 'r2', operationId: input.operationId }),
});
const _case: AttachmentsConformanceCase = { name: 'public-client', run: async client => { await client.describe(); } };
void [serverClient, browserClient, handlers, threadAttachmentsRpcContract, _case];
export type PublicDTOs = ObserveInputV1 | AssessInputV1 | AssessOutputV1 | ReadInputV1 | ReadOutputV1 | FamilyInputV1 | FamilyOutputV1 | AttachInputV1 | DetachInputV1 | WriteOutputV1;
