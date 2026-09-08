import type { BbPluginApi } from "@get-bb/plugin-sdk";

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
  });
}
