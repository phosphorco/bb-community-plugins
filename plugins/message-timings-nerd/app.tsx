import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./rpc-contract.ts";
import { createDecorations } from "./decorations.ts";
import { findTimingPane } from "./pane.ts";
import "./app.css";

function TimingHeader({ threadId }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [enabled, setEnabled] = useState(true);
  const [state, setState] = useState<"ready" | "partial" | "error" | "unsupported">("ready");
  const refreshRef = useRef<() => void>(() => {});
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let busy = false;
    let pending = false;
    let consecutiveFailures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A header and its timeline share a pane ancestor. Stay within that pane
    // rather than observing/scanning every other thread during streaming.
    const root = buttonRef.current ? findTimingPane(buttonRef.current) : null;
    if (!root) { setState("unsupported"); return; }
    const decorations = createDecorations(root, request);
    function request() {
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
        if (disposed) return;
        consecutiveFailures = 0;
        decorations.update(result.stamps, result.coveredIds);
        setState(result.truncated ? "partial" : "ready");
      } catch {
        if (!disposed) {
          decorations.update([]); setState("error");
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
  }, [threadId, enabled]);

  useRealtime("timings-changed", useCallback((payload: unknown) => {
    if (payload && typeof payload === "object" && "threadId" in payload && payload.threadId === threadId) refreshRef.current();
  }, [threadId]));
  const connection = useRealtimeConnectionState();
  useEffect(() => { if (connection === "connected") refreshRef.current(); }, [connection]);
  const title = !enabled ? "Show message timestamps" : state === "unsupported" ? "Message timestamps are unavailable in this layout." : state === "error" ? "Message timestamps unavailable. Click to retry." : state === "partial"
    ? "Message timestamps (older history is incomplete). Click to hide." : "Hide message timestamps";
  return <button ref={buttonRef} type="button" className="message-timings-nerd__toggle" aria-label={title} title={title} aria-pressed={enabled}
    onClick={() => { if (state === "error") refreshRef.current(); else setEnabled(value => !value); }}>
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></svg>
    {state !== "ready" && <span aria-hidden="true">!</span>}
  </button>;
}

export default definePluginApp(app => {
  app.slots.experimental_threadHeaderAction({ id: "message-timings-nerd", title: "Message Timings Nerd", component: TimingHeader });
});
