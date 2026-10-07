import { useCallback, useMemo, useRef, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { LinkedReferences, type ReferencesApi } from "@phosphorco/bb-cross-references/react";
import "@phosphorco/bb-cross-references/styles.css";

import { MAX_ATTACHMENT_TARGETS, type AttachmentSnapshot } from "./attachment-contract.ts";
import type { rpcContract } from "./rpc-contract.ts";

function referenceSnapshot(snapshot: AttachmentSnapshot): Awaited<ReturnType<ReferencesApi["get"]>> {
  return {
    revision: snapshot.sourceRevision,
    targets: snapshot.targets,
    status: { state: snapshot.status.state, error: snapshot.status.lastError },
  };
}

export function MachineMonitorReferences() {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const connection = useRealtimeConnectionState();
  const navigate = useBbNavigate();
  const [refreshToken, setRefreshToken] = useState(0);

  useRealtime("machine-monitor-attachments", useCallback(() => {
    setRefreshToken((token) => token + 1);
  }, []));

  const api = useMemo<ReferencesApi>(() => ({
    get: async () => referenceSnapshot(await rpcRef.current.call("getAttachments")),
    replace: async (revision, targets) => {
      const result = await rpcRef.current.call("replaceAttachments", {
        expectedSourceRevision: revision,
        targets,
      });
      return {
        ...referenceSnapshot(result),
        outcome: result.outcome === "cas-mismatch" ? "cas-mismatch" : "applied",
      };
    },
    search: (query) => rpcRef.current.call("searchThreads", { query }),
    thread: (threadId) => rpcRef.current.call("getThread", { threadId }),
  }), []);

  return (
    <LinkedReferences
      ownerKey="machine-monitor:fleet"
      api={api}
      connection={connection}
      refreshToken={refreshToken}
      navigateThread={(threadId) => navigate.toThread(threadId)}
      description="Keep the BB threads and external resources that explain or repair this fleet close at hand."
      maxTargets={MAX_ATTACHMENT_TARGETS}
    />
  );
}
