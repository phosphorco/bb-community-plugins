import type { BbPluginApi } from "@get-bb/plugin-sdk";

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

  bb.rpc.register(rpcContract, {
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
    listForwardReferences: (input) => store.listForwardReferences(input),
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
