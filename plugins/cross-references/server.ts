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
  const collector = new AssistantLinkCollector(bb, db, store, (signal) => bb.realtime.publish(REALTIME_CHANNEL, signal));
  for (const event of ["thread.idle", "thread.failed"] as const) {
    bb.events.on(event, ({ thread }) => collector.enqueue(thread.projectId, thread.id, false, true));
  }
  bb.events.on("thread.deleted", ({ thread }) => collector.enqueue(thread.projectId, thread.id, true, true));
  bb.background.service("cross-references-assistant-links", { start: (signal) => collector.start(signal) });

  bb.rpc.register(rpcContract, {
    "crossReferences.describe": () => ({ protocol: CROSS_REFERENCES_PROTOCOL, versions: [1] }),
    applyProjection: (input) => {
      const result = store.applyProjection(input);
      if (result.changed && result.signal !== null) {
        bb.realtime.publish(REALTIME_CHANNEL, result.signal);
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
        collector.enqueue(input.source.keys.project, input.source.keys.thread, false, false, true);
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
