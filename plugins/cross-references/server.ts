import { registerCrossReferencesProducer } from '@phosphorco/bb-cross-references/bb';
import { producerDescribe, canonicalizeIdentity } from '@phosphorco/bb-cross-references';
import { registerCrossReferencesV2 } from '@phosphorco/bb-cross-references/bb';
import { MENTIONS_V2_CHANNEL } from '@phosphorco/bb-cross-references';
import { createMentionReader, mentionsChangedSignal } from './mention-query.ts';
import { createMentionLookup } from './mention-lookup.ts';
import { CROSS_REFERENCES_PROTOCOL } from "@phosphorco/bb-cross-references";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { AssistantLinkCollector } from "./assistant-link-collector.ts";
import { createLinkChecker, firstUniqueLinks } from "./link-status.ts";
import { rpcContract } from "./rpc-contract.ts";
import { CrossReferenceStore, crossReferencesMigrations, enableForeignKeys } from "./store.ts";

export const REALTIME_CHANNEL = "cross-references-changed";

export default function crossReferencesPlugin(bb: BbPluginApi): void {
  const db = bb.storage.database();
  // This must happen before the migration helper and before any registration
  // can expose a partially constrained database.
  enableForeignKeys(db);
  bb.storage.migrate(db, [...crossReferencesMigrations]);
  const store = new CrossReferenceStore(db);
  store.pruneUnsafeUrlResources();
  const checkLink = createLinkChecker();
  const reader=createMentionReader(db);
  const collector = new AssistantLinkCollector(bb, db, store, (signal,source) => {
    bb.realtime.publish(REALTIME_CHANNEL,signal);
    bb.realtime.publish(MENTIONS_V2_CHANNEL,mentionsChangedSignal(db,source,signal));
  });
  const lookup=createMentionLookup({snapshot:()=>collector.lookupSnapshot(),getThread:(id,signal)=>bb.sdk.threads.get({threadId:id,signal}),
    ...(bb.server?.experimental_appUrl?{appUrl:bb.server.experimental_appUrl}:{})});
  registerCrossReferencesV2(bb,{crossReferencesV2ListMentions:input=>reader.read(input),crossReferencesV2ResolveLookup:lookup});
  registerCrossReferencesProducer(bb,{
    'crossReferencesProducer.describe':producerDescribe,
    crossReferencesProducerV1GetState:input=>store.getProducerState(input),
    crossReferencesProducerV1Apply:input=>{
      const result=store.applyProducer(input);
      if(result.signal){bb.realtime.publish(REALTIME_CHANNEL,result.signal);bb.realtime.publish(MENTIONS_V2_CHANNEL,mentionsChangedSignal(db,{provider:input.projection.source.provider,keys:input.projection.source.keys},result.signal));}
      return result.response;
    },
    crossReferencesProducerV1ReportStatus:input=>{
      const result=store.reportProducerStatus(input);
      if(result.changed){const state=result.response.state;bb.realtime.publish(MENTIONS_V2_CHANNEL,{version:2,producerPluginId:'thread-brief',sourceIdentityDigest:canonicalizeIdentity(input.source).identityDigest,graphRevision:state.projection?.revision??0,evidenceRevision:state.evidence?.graphRevision??null,affectedIdentityDigests:(state.projection?.targets??[]).map(t=>canonicalizeIdentity({provider:t.provider,keys:t.keys}).identityDigest),scopeListClipped:false});}
      return result.response;
    },
  });
  for (const event of ["thread.idle", "thread.failed"] as const) {
    bb.events.on(event, ({ thread }) => collector.enqueue(thread.projectId, thread.id, false, true, 1));
  }
  bb.events.on("thread.deleted", ({ thread }) => collector.enqueue(thread.projectId, thread.id, true, true, 1));
  // A staged candidate may be discarded without onDispose. The collector's
  // service lifetime owns SDK subscriptions, so factory registration creates none.
  bb.onDispose(()=>collector.dispose());
  bb.background.service("cross-references-assistant-links", { start: (signal) => collector.start(signal) });

  bb.rpc.register(rpcContract, {
    "crossReferences.describe": () => ({ protocol: CROSS_REFERENCES_PROTOCOL, versions: [1,2] }),
    applyProjection: (input) => {
      const result = store.applyProjection(input);
      if (result.changed && result.signal !== null) {
        bb.realtime.publish(REALTIME_CHANNEL, result.signal);
        bb.realtime.publish(MENTIONS_V2_CHANNEL,mentionsChangedSignal(db,{provider:input.source.provider,keys:input.source.keys},result.signal));
      }
      return {
        outcome: result.outcome,
        currentRevision: result.currentRevision,
        currentDigest: result.currentDigest,
      };
    },
    getProjection: (input) => store.getProjection(input),
    listBacklinks: (input) => store.listBacklinks(input),
    listForwardReferences: (input) => {
      if (input.source.provider === "bb" && input.source.keys.project !== undefined && input.source.keys.thread !== undefined) {
        collector.enqueue(input.source.keys.project, input.source.keys.thread, false, false, 2);
      }
      return store.listForwardReferences(input);
    },
    checkForwardReferences: async (input) => {
      // Read the active edge index instead of trusting client-provided URLs.
      // The exact same ten-destination cap and checker semantics as Thread
      // Links prevent a compact References view from becoming a crawler.
      const { rows } = store.listForwardReferences({ ...input, pageSize: 100 });
      const links = rows.flatMap((row) => row.target.presentation.url === undefined
        ? []
        : [{ url: row.target.presentation.url }]);
      return Promise.all(firstUniqueLinks(links).map((link) => checkLink(link.url)));
    },
  });
}
