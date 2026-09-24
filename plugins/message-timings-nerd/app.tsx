import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./rpc-contract.ts";
import { createDecorations } from "./decorations.ts";
import { findTimingPane } from "./pane.ts";
import "./app.css";

function TimingMount({ threadId }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const refreshRef = useRef<() => void>(() => {});
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [attempt, setAttempt] = useState(0);
  const retryCount = useRef(0);
  useEffect(() => {
    let disposed = false;
    let failed = false;
    let busy = false;
    let pending = false;
    let consecutiveFailures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A header and its timeline share a pane ancestor. Stay within that pane
    // rather than observing/scanning every other thread during streaming.
    const root = anchorRef.current ? findTimingPane(anchorRef.current) : null;
    if (!root) return;
    const decorations = createDecorations(root, request, () => {
      failed = true;
      clearTimeout(timer);
      console.warn("Message timings could not decorate this timeline; retrying a bounded number of times.");
      if (retryCount.current < 2) {
        retryCount.current++;
        timer = setTimeout(() => setAttempt(value => value + 1), 10_000);
      }
    });
    function request() {
      if (failed) return;
      pending = true;
      if (disposed || document.hidden || busy || timer != null) return;
      // Coalesce simultaneous row mounts and lifecycle signals. No polling.
      timer = setTimeout(() => { timer = undefined; void load(); }, 2_100);
    }
    async function load() {
      if (disposed || busy || document.hidden) return;
      busy = true; pending = false;
      try {
        const result = await rpcRef.current.call("timings", { threadId });
        if (disposed || failed) return;
        consecutiveFailures = 0;
        decorations.update(result.stamps, result.coveredIds, result.historyStartId);
        if (!failed) retryCount.current = 0;
      } catch {
        if (!disposed) {
          // A failed read must not remove stable footers or change row heights.
          // Same-bundle reloads can retain this frontend while replacing the
          // backend handle. Recover one transient read without a polling loop.
          if (++consecutiveFailures === 1) pending = true;
        }
      } finally {
        busy = false;
        if (!disposed && pending) request();
      }
    }
    function visible() { if (!document.hidden) request(); }
    refreshRef.current = request;
    document.addEventListener("visibilitychange", visible);
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
      decorations.dispose();
      document.removeEventListener("visibilitychange", visible);
      refreshRef.current = () => {};
    };
  }, [threadId, attempt]);

  useRealtime("timings-changed", useCallback((payload: unknown) => {
    if (payload && typeof payload === "object" && "threadId" in payload && payload.threadId === threadId) refreshRef.current();
  }, [threadId]));
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previousConnection.current !== "connected") refreshRef.current();
    previousConnection.current = connection;
  }, [connection]);
  return <span ref={anchorRef} data-message-timings-nerd-mount="" hidden aria-hidden="true" />;
}

export default definePluginApp(app => {
  app.slots.experimental_threadHeaderAction({ id: "message-timings-nerd", title: "Message timings", component: TimingMount });
});
