import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";

import type {
  AttachmentSnapshot,
  Resource,
} from "./attachment-contract.ts";
import type { rpcContract } from "./rpc-contract.ts";

type PickerThread = {
  id: string;
  projectId: string;
  title: string;
  detail?: string;
  archived: boolean;
};

const MAX_SEARCH_RESULTS = 24;

function threadKey(projectId: string, threadId: string): string {
  return `${projectId}\u0000${threadId}`;
}

function targetThread(target: Resource): { projectId: string; threadId: string } | null {
  if (target.provider !== "bb" || Object.keys(target.keys).length !== 2) return null;
  const projectId = target.keys.project;
  const threadId = target.keys.thread;
  return typeof projectId === "string" && typeof threadId === "string"
    ? { projectId, threadId }
    : null;
}

function threadResource(thread: PickerThread): Resource {
  return {
    provider: "bb",
    keys: { project: thread.projectId, thread: thread.id },
    presentation: {
      label: thread.title,
      detail: `Project ${thread.projectId}`,
    },
  };
}

function useMachineMonitorAttachments() {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [snapshot, setSnapshot] = useState<AttachmentSnapshot | null>(null);
  const snapshotRef = useRef<AttachmentSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const requestSequence = useRef(0);
  const mounted = useRef(true);
  const initialized = useRef(false);
  const inFlight = useRef(false);
  const refreshPending = useRef(false);

  const applySnapshot = useCallback((next: AttachmentSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const refresh = useCallback(async () => {
    refreshPending.current = true;
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      while (refreshPending.current && mounted.current) {
        refreshPending.current = false;
        const sequence = ++requestSequence.current;
        try {
          const next = await rpcRef.current.call("getAttachments");
          if (mounted.current && sequence === requestSequence.current) {
            applySnapshot(next);
            setError(null);
            setStale(false);
            setLoading(false);
          }
        } catch (cause) {
          if (mounted.current && sequence === requestSequence.current) {
            setError(cause instanceof Error ? cause.message : "Could not read saved thread links.");
            setLoading(false);
          }
        }
      }
    } finally {
      inFlight.current = false;
      if (refreshPending.current && mounted.current) void refresh();
    }
  }, [applySnapshot]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void refresh();
  }, [refresh]);

  useRealtime("machine-monitor-attachments", useCallback(() => {
    void refresh();
  }, [refresh]));

  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (connection === "reconnecting") {
      setStale(true);
      previousConnection.current = connection;
      return;
    }
    if (connection === "connected" && previousConnection.current !== "connected") void refresh();
    previousConnection.current = connection;
  }, [connection, refresh]);

  const replace = useCallback(async (targets: Resource[]) => {
    const current = snapshotRef.current;
    if (current == null) return;
    const sequence = ++requestSequence.current;
    setError(null);
    try {
      const result = await rpcRef.current.call("replaceAttachments", {
        expectedSourceRevision: current.sourceRevision,
        targets,
      });
      if (!mounted.current || sequence !== requestSequence.current) return;
      if (result.outcome === "cas-mismatch") {
        setError("These saved links changed in another window. The latest list is shown below.");
        await refresh();
        return;
      }
      applySnapshot(result);
    } catch (cause) {
      if (mounted.current && sequence === requestSequence.current) {
        setError(cause instanceof Error ? cause.message : "Could not save this thread link.");
      }
      throw cause;
    }
  }, [applySnapshot, refresh]);

  return { snapshot, loading, error, stale, replace };
}

const PERSONAL_PROJECT_ID = "proj_personal";

function threadHref(projectId: string, threadId: string): string {
  const encodedProjectId = encodeURIComponent(projectId);
  const encodedThreadId = encodeURIComponent(threadId);
  return projectId === PERSONAL_PROJECT_ID
    ? `/threads/${encodedThreadId}`
    : `/projects/${encodedProjectId}/threads/${encodedThreadId}`;
}

function ThreadLink({ projectId, threadId, label }: { projectId: string; threadId: string; label: string }) {
  const navigate = useBbNavigate();
  return (
    <a
      className="machine-monitor__reference-link"
      href={threadHref(projectId, threadId)}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate.toThread(threadId);
      }}
    >
      {label}
    </a>
  );
}

function ThreadPicker({
  attached,
  disabled,
  onAdd,
}: {
  attached: ReadonlySet<string>;
  disabled: boolean;
  onAdd: (thread: PickerThread) => Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const searchId = `machine-monitor-thread-search-${useId().replaceAll(":", "")}`;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickerThread[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSequence = useRef(0);
  const selectionSequence = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      searchSequence.current += 1;
      selectionSequence.current += 1;
    };
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    const sequence = ++searchSequence.current;
    if (trimmed.length < 2) {
      setResults([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    const timer = setTimeout(() => {
      void rpcRef.current.call("searchThreads", { query: trimmed }).then((response) => {
        if (!mounted.current || sequence !== searchSequence.current) return;
        setResults(response.threads.slice(0, MAX_SEARCH_RESULTS));
        setSearching(false);
      }).catch((cause) => {
        if (!mounted.current || sequence !== searchSequence.current) return;
        setResults([]);
        setSearching(false);
        setSearchError(cause instanceof Error ? cause.message : "Could not search BB threads.");
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  const select = async (id: string) => {
    const sequence = ++selectionSequence.current;
    if (!mounted.current) return;
    setSelectingId(id);
    setSearchError(null);
    try {
      const thread = await rpcRef.current.call("getThread", { threadId: id });
      if (!mounted.current || sequence !== selectionSequence.current) return;
      await onAdd(thread);
    } catch (cause) {
      if (mounted.current && sequence === selectionSequence.current) {
        setSearchError(cause instanceof Error ? cause.message : "Could not attach this thread.");
      }
    } finally {
      if (mounted.current && sequence === selectionSequence.current) setSelectingId(null);
    }
  };

  return (
    <div className="machine-monitor__reference-picker">
      <label htmlFor={searchId}>Add a BB thread</label>
      <input
        id={searchId}
        type="search"
        value={query}
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by title or message…"
        aria-describedby={`${searchId}-help`}
      />
      <p id={`${searchId}-help`} className="machine-monitor__reference-help">
        Search uses a bounded set of active and archived threads. Type at least two characters.
      </p>
      {searching && <p className="machine-monitor__reference-status" role="status">Searching threads…</p>}
      {searchError != null && <p className="machine-monitor__reference-error" role="alert">{searchError}</p>}
      {!searching && query.trim().length >= 2 && results.length === 0 && searchError == null && <p className="machine-monitor__reference-status">No matching threads.</p>}
      {results.length > 0 && (
        <ul className="machine-monitor__reference-search-results">
          {results.map((thread) => {
            const key = threadKey(thread.projectId, thread.id);
            const isAttached = attached.has(key);
            return (
              <li key={key}>
                <span>
                  <strong>{thread.title}</strong>
                  <small>{thread.archived ? "Archived" : "Active"}{thread.detail == null ? ` · Project ${thread.projectId}` : ` · ${thread.detail}`}</small>
                </span>
                <button
                  type="button"
                  className="machine-monitor__reference-add"
                  disabled={disabled || isAttached || selectingId !== null}
                  onClick={() => void select(thread.id)}
                  aria-label={isAttached ? `${thread.title} is already linked` : `Link ${thread.title}`}
                >
                  {isAttached ? "Linked" : selectingId === thread.id ? "Adding…" : "Link"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function attachmentStatusText(snapshot: AttachmentSnapshot): string {
  switch (snapshot.status.state) {
    case "synced": return "Saved locally and shared with Cross References.";
    case "pending": return "Saved locally. Sharing with Cross References will finish shortly.";
    case "degraded": return "Saved locally. Cross References is unavailable; sharing will retry when it returns.";
    case "blocked": return "Saved locally, but Cross References could not accept the latest update.";
  }
}

export function MachineMonitorReferences() {
  const { snapshot, loading, error, stale, replace } = useMachineMonitorAttachments();
  const [saving, setSaving] = useState(false);
  const targets = snapshot?.targets ?? [];
  const attached = new Set(targets.flatMap((target) => {
    const thread = targetThread(target);
    return thread == null ? [] : [threadKey(thread.projectId, thread.threadId)];
  }));

  const add = async (thread: PickerThread) => {
    if (snapshot == null || attached.has(threadKey(thread.projectId, thread.id))) return;
    setSaving(true);
    try {
      await replace([...snapshot.targets, threadResource(thread)]);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (target: Resource) => {
    setSaving(true);
    try {
      await replace(targets.filter((candidate) => candidate !== target));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="machine-monitor__references" aria-labelledby="machine-monitor-references-title">
      <header>
        <div>
          <h2 id="machine-monitor-references-title">Linked threads</h2>
          <p>Keep the BB threads that explain or repair this deployment machine close at hand.</p>
        </div>
        <span className="machine-monitor__reference-count" aria-label={`${targets.length} linked thread${targets.length === 1 ? "" : "s"}`}>{targets.length}</span>
      </header>
      {loading && snapshot == null && <p className="machine-monitor__reference-status" role="status">Loading saved thread links…</p>}
      {snapshot != null && <p className={`machine-monitor__reference-status machine-monitor__reference-status--${snapshot.status.state}`} role="status">{attachmentStatusText(snapshot)}</p>}
      {stale && <p className="machine-monitor__reference-status" role="status">The connection is recovering; this list may be briefly out of date.</p>}
      {error != null && <p className="machine-monitor__reference-error" role="alert">{error}</p>}
      {targets.length === 0 && snapshot != null && <p className="machine-monitor__reference-empty">No threads linked yet.</p>}
      {targets.length > 0 && (
        <ul className="machine-monitor__reference-list">
          {targets.map((target) => {
            const thread = targetThread(target);
            if (thread == null) return null;
            return (
              <li key={threadKey(thread.projectId, thread.threadId)}>
                <span>
                  <ThreadLink projectId={thread.projectId} threadId={thread.threadId} label={target.presentation.label} />
                  <small>{target.presentation.detail ?? `Project ${thread.projectId}`}</small>
                </span>
                <button
                  type="button"
                  className="machine-monitor__reference-remove"
                  disabled={saving}
                  onClick={() => { void remove(target).catch(() => undefined); }}
                  aria-label={`Remove ${target.presentation.label}`}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ThreadPicker attached={attached} disabled={saving || snapshot == null} onAdd={add} />
    </section>
  );
}
