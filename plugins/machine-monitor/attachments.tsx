import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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
const MAX_REFERENCE_INPUT_LENGTH = 2_048;
const SENSITIVE_URL_PARAMETERS = new Set([
  "access_token", "api_key", "apikey", "authorization", "code", "cookie",
  "id_token", "password", "passwd", "refresh_token", "secret", "session",
  "sessionid", "sid", "sig", "signature", "token", "x-amz-credential",
  "x-amz-security-token", "x-amz-signature", "x-goog-credential",
  "x-goog-signature", "x-ms-signature",
]);

function targetThread(target: Resource): { projectId: string; threadId: string } | null {
  if (target.provider !== "bb" || Object.keys(target.keys).length !== 2) return null;
  const projectId = target.keys.project;
  const threadId = target.keys.thread;
  return typeof projectId === "string" && typeof threadId === "string"
    ? { projectId, threadId }
    : null;
}

function targetUrl(target: Resource): string | null {
  return target.provider === "url" && Object.keys(target.keys).length === 1
    && typeof target.keys.href === "string" && target.presentation.url === target.keys.href
    ? target.keys.href
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

function resourceKey(resource: Resource): string {
  return JSON.stringify([resource.provider, Object.entries(resource.keys).sort(([left], [right]) => left.localeCompare(right))]);
}

type ReferenceInput =
  | { kind: "empty" }
  | { kind: "query"; query: string }
  | { kind: "thread-url"; input: string; projectId: string | null; threadId: string }
  | { kind: "external-url"; href: string; suggestedLabel: string }
  | { kind: "invalid"; input: string; message: string };

function hasSensitiveUrlParameter(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (SENSITIVE_URL_PARAMETERS.has(name.toLowerCase())) return true;
  }
  if (url.hash.startsWith("#")) {
    for (const name of new URLSearchParams(url.hash.slice(1)).keys()) {
      if (SENSITIVE_URL_PARAMETERS.has(name.toLowerCase())) return true;
    }
  }
  return false;
}

function referenceInput(value: string, origin: string): ReferenceInput {
  const input = value.trim();
  if (input.length === 0) return { kind: "empty" };
  if (!/^https?:\/\//iu.test(input)) return { kind: "query", query: input };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { kind: "invalid", input, message: "Enter a valid HTTP or HTTPS URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "invalid", input, message: "Only HTTP and HTTPS links can be attached." };
  }
  if (url.username !== "" || url.password !== "" || hasSensitiveUrlParameter(url)) {
    return { kind: "invalid", input, message: "Links containing credentials or sensitive parameters cannot be attached." };
  }
  if (url.href.length > MAX_REFERENCE_INPUT_LENGTH) {
    return { kind: "invalid", input, message: "This URL is too long to attach." };
  }
  if (url.origin === origin) {
    const projectRoute = url.pathname.match(/^\/projects\/([A-Za-z0-9_-]{1,128})\/threads\/([A-Za-z0-9_-]{1,128})\/?$/u);
    if (projectRoute != null) {
      return { kind: "thread-url", input, projectId: projectRoute[1]!, threadId: projectRoute[2]! };
    }
    const personalRoute = url.pathname.match(/^\/threads\/([A-Za-z0-9_-]{1,128})\/?$/u);
    if (personalRoute != null) return { kind: "thread-url", input, projectId: null, threadId: personalRoute[1]! };
  }
  return {
    kind: "external-url",
    href: url.href,
    suggestedLabel: url.hostname.replace(/^www\./u, "") || "External link",
  };
}

type ThreadSearchState =
  | { status: "idle"; input: string }
  | { status: "waiting"; input: string }
  | { status: "searching"; input: string }
  | { status: "ready"; input: string; threads: PickerThread[] }
  | { status: "external"; input: string; href: string; suggestedLabel: string }
  | { status: "error"; input: string; message: string };

function useThreadSearch(query: string): ThreadSearchState {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const connection = useRealtimeConnectionState();
  const input = query.trim();
  const [state, setState] = useState<ThreadSearchState>({ status: "idle", input: "" });

  useEffect(() => {
    const parsed = referenceInput(input, window.location.origin);
    if (parsed.kind === "empty" || (parsed.kind === "query" && parsed.query.length < 2)) {
      setState({ status: "idle", input });
      return;
    }
    if (parsed.kind === "invalid") {
      setState({ status: "error", input, message: parsed.message });
      return;
    }
    if (parsed.kind === "external-url") {
      setState({ status: "external", input, href: parsed.href, suggestedLabel: parsed.suggestedLabel });
      return;
    }
    if (parsed.kind === "query" && parsed.query.length > 256) {
      setState({ status: "error", input, message: "Thread searches are limited to 256 characters." });
      return;
    }
    if (connection !== "connected") {
      setState({ status: "waiting", input });
      return;
    }

    let active = true;
    setState({ status: "searching", input });
    const timer = window.setTimeout(() => {
      if (parsed.kind === "thread-url") {
        const href = new URL(parsed.input).href;
        void rpcRef.current.call("getThread", { threadId: parsed.threadId }).then((thread) => {
          if (!active) return;
          if (parsed.projectId == null || thread.projectId === parsed.projectId) {
            setState({ status: "ready", input, threads: [thread] });
          } else {
            setState({ status: "external", input, href, suggestedLabel: "BB thread link" });
          }
        }, () => {
          if (active) setState({ status: "external", input, href, suggestedLabel: "BB thread link" });
        });
        return;
      }
      void rpcRef.current.call("searchThreads", { query: parsed.query }).then((response) => {
        if (active) setState({ status: "ready", input, threads: response.threads.slice(0, MAX_SEARCH_RESULTS) });
      }, (cause) => {
        if (active) setState({
          status: "error",
          input,
          message: cause instanceof Error ? cause.message : "Could not search BB threads.",
        });
      });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [connection, input]);

  return state.input === input ? state : { status: "searching", input };
}

type ReadControl = {
  generation: number;
  inFlight: boolean;
  pending: boolean;
};

function useMachineMonitorAttachments() {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [snapshot, setSnapshot] = useState<AttachmentSnapshot | null>(null);
  const snapshotRef = useRef<AttachmentSnapshot | null>(null);
  snapshotRef.current = snapshot;
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  const mutationInFlight = useRef(false);
  const readControl = useRef<ReadControl>({ generation: 0, inFlight: false, pending: false });

  const applySnapshot = useCallback((next: AttachmentSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const restartReads = useCallback(() => {
    readControl.current = {
      generation: readControl.current.generation + 1,
      inFlight: false,
      pending: false,
    };
  }, []);

  const refresh = useCallback(async () => {
    const control = readControl.current;
    control.pending = true;
    if (!mounted.current || mutationInFlight.current || control.inFlight) return;
    control.inFlight = true;
    try {
      while (mounted.current && !mutationInFlight.current && readControl.current === control && control.pending) {
        control.pending = false;
        try {
          const next = await rpcRef.current.call("getAttachments");
          if (mounted.current && readControl.current === control && !mutationInFlight.current) {
            applySnapshot(next);
            setReadError(null);
            setStale(false);
            setLoading(false);
          }
        } catch (cause) {
          if (mounted.current && readControl.current === control && !mutationInFlight.current) {
            setReadError(cause instanceof Error ? cause.message : "Could not read saved references.");
            setLoading(false);
          }
        }
      }
    } finally {
      if (readControl.current === control) control.inFlight = false;
    }
  }, [applySnapshot]);

  useEffect(() => {
    mounted.current = true;
    restartReads();
    setLoading(snapshotRef.current == null);
    void refresh();
    return () => {
      mounted.current = false;
      restartReads();
    };
  }, [refresh, restartReads]);

  useRealtime("machine-monitor-attachments", useCallback(() => {
    void refresh();
  }, [refresh]));

  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (connection === "reconnecting") {
      setStale(true);
      restartReads();
      previousConnection.current = connection;
      return;
    }
    if (connection === "connected" && previousConnection.current !== "connected") {
      restartReads();
      void refresh();
    }
    previousConnection.current = connection;
  }, [connection, refresh, restartReads]);

  const mutate = useCallback(async (transform: (targets: readonly Resource[]) => Resource[] | null): Promise<boolean> => {
    if (mutationInFlight.current) return false;
    const current = snapshotRef.current;
    if (current == null) return false;
    const targets = transform(current.targets);
    if (targets == null) return true;
    mutationInFlight.current = true;
    setSaving(true);
    setMutationError(null);
    restartReads();
    try {
      const result = await rpcRef.current.call("replaceAttachments", {
        expectedSourceRevision: current.sourceRevision,
        targets,
      });
      if (!mounted.current) return false;
      applySnapshot(result);
      if (result.outcome === "cas-mismatch") {
        setMutationError("These saved links changed in another window. The latest list is shown below.");
        return false;
      }
      return true;
    } catch (cause) {
      if (mounted.current) {
        setMutationError(cause instanceof Error ? cause.message : "Could not save this thread link.");
      }
      return false;
    } finally {
      mutationInFlight.current = false;
      if (mounted.current) setSaving(false);
      void refresh();
    }
  }, [applySnapshot, refresh, restartReads]);

  const add = useCallback((thread: PickerThread) => mutate((targets) => {
    const target = threadResource(thread);
    const key = resourceKey(target);
    return targets.some((candidate) => resourceKey(candidate) === key) ? null : [...targets, target];
  }), [mutate]);

  const addResource = useCallback((target: Resource) => mutate((targets) => {
    const key = resourceKey(target);
    return targets.some((candidate) => resourceKey(candidate) === key) ? null : [...targets, target];
  }), [mutate]);

  const remove = useCallback((target: Resource) => mutate((targets) => {
    const key = resourceKey(target);
    return targets.filter((candidate) => resourceKey(candidate) !== key);
  }), [mutate]);

  return { snapshot, loading, readError, mutationError, stale, saving, add, addResource, remove };
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

function ReferenceLink({ target }: { target: Resource }) {
  const thread = targetThread(target);
  if (thread != null) {
    return <ThreadLink projectId={thread.projectId} threadId={thread.threadId} label={target.presentation.label} />;
  }
  const href = targetUrl(target);
  if (href == null) return <span className="machine-monitor__reference-link">{target.presentation.label}</span>;
  return (
    <a
      className="machine-monitor__reference-link"
      href={href}
    >
      {target.presentation.label}
    </a>
  );
}

function ThreadPicker({
  attached,
  disabled,
  onAdd,
  onAddResource,
}: {
  attached: ReadonlySet<string>;
  disabled: boolean;
  onAdd: (thread: PickerThread) => Promise<boolean>;
  onAddResource: (resource: Resource) => Promise<boolean>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const searchId = `machine-monitor-thread-search-${useId().replaceAll(":", "")}`;
  const nameId = `${searchId}-external-name`;
  const [query, setQuery] = useState("");
  const search = useThreadSearch(query);
  const [externalName, setExternalName] = useState("");
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const selectionSequence = useRef(0);

  useEffect(() => {
    return () => { selectionSequence.current += 1; };
  }, []);

  useEffect(() => {
    if (search.status === "external") setExternalName(search.suggestedLabel);
  }, [search.status === "external" ? search.href : null]);

  const select = async (thread: PickerThread) => {
    const sequence = ++selectionSequence.current;
    setSelectingId(thread.id);
    setSelectionError(null);
    try {
      const fresh = await rpcRef.current.call("getThread", { threadId: thread.id });
      if (sequence !== selectionSequence.current) return;
      if (await onAdd(fresh)) setQuery("");
    } catch (cause) {
      if (sequence === selectionSequence.current) {
        setSelectionError(cause instanceof Error ? cause.message : "Could not attach this thread.");
      }
    } finally {
      if (sequence === selectionSequence.current) setSelectingId(null);
    }
  };

  const attachExternal = async () => {
    if (search.status !== "external") return;
    const label = externalName.trim();
    if (label.length === 0) {
      setSelectionError("Give this external reference a name.");
      return;
    }
    const sequence = ++selectionSequence.current;
    setSelectingId(search.href);
    setSelectionError(null);
    const resource: Resource = {
      provider: "url",
      keys: { href: search.href },
      presentation: { label, detail: new URL(search.href).hostname, url: search.href },
    };
    try {
      if (await onAddResource(resource) && sequence === selectionSequence.current) setQuery("");
    } finally {
      if (sequence === selectionSequence.current) setSelectingId(null);
    }
  };

  const results = search.status === "ready" ? search.threads : [];
  const externalAttached = search.status === "external" && attached.has(resourceKey({
    provider: "url",
    keys: { href: search.href },
    presentation: { label: externalName || search.suggestedLabel, url: search.href },
  }));
  const statusText = search.status === "searching"
    ? "Searching threads…"
    : search.status === "waiting"
      ? "Search will resume when the connection returns."
      : search.status === "ready" && search.threads.length === 0
        ? "No matching threads."
        : search.status === "ready"
          ? `${search.threads.length} matching thread${search.threads.length === 1 ? "" : "s"}.`
          : "";

  return (
    <div className="machine-monitor__reference-picker">
      <label htmlFor={searchId}>Add a thread or link</label>
      <input
        id={searchId}
        type="search"
        value={query}
        disabled={disabled}
        maxLength={MAX_REFERENCE_INPUT_LENGTH}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelectionError(null);
        }}
        placeholder="Search threads or paste a URL…"
        aria-describedby={`${searchId}-help`}
      />
      <p id={`${searchId}-help`} className="machine-monitor__reference-help">
        Search active and archived threads, or paste a link. BB thread links on this host resolve to their thread.
      </p>
      <p className="machine-monitor__reference-status" role="status" aria-live="polite">{statusText}</p>
      {search.status === "error" && <p className="machine-monitor__reference-error" role="alert">{search.message}</p>}
      {selectionError != null && <p className="machine-monitor__reference-error" role="alert">{selectionError}</p>}
      {results.length > 0 && (
        <ul className="machine-monitor__reference-search-results">
          {results.map((thread) => {
            const key = resourceKey(threadResource(thread));
            const isAttached = attached.has(key);
            return (
              <li key={key}>
                <span>
                  <strong>{thread.title}</strong>
                  <small id={`${searchId}-result-${thread.id}`}>{thread.archived ? "Archived" : "Active"}{thread.detail == null ? ` · Project ${thread.projectId}` : ` · ${thread.detail}`}</small>
                </span>
                <button
                  type="button"
                  className="machine-monitor__reference-add"
                  disabled={disabled || isAttached || selectingId !== null}
                  onClick={() => void select(thread)}
                  aria-label={isAttached ? `${thread.title} is already linked` : `Link ${thread.title}`}
                  aria-describedby={`${searchId}-result-${thread.id}`}
                >
                  {isAttached ? "Linked" : selectingId === thread.id ? "Adding…" : "Link"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {search.status === "external" && (
        <div className="machine-monitor__reference-external">
          <span><strong>External link</strong><small>{search.href}</small></span>
          <label htmlFor={nameId}>Reference name</label>
          <div>
            <input
              id={nameId}
              type="text"
              value={externalName}
              maxLength={256}
              disabled={disabled || selectingId !== null}
              onChange={(event) => setExternalName(event.target.value)}
            />
            <button
              type="button"
              className="machine-monitor__reference-add"
              disabled={disabled || selectingId !== null || externalAttached}
              onClick={() => void attachExternal()}
              aria-label={externalAttached ? `${externalName || search.suggestedLabel} is already linked` : `Link ${externalName || search.suggestedLabel}`}
            >
              {externalAttached ? "Linked" : selectingId === search.href ? "Adding…" : "Link"}
            </button>
          </div>
        </div>
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
  const { snapshot, loading, readError, mutationError, stale, saving, add, addResource, remove } = useMachineMonitorAttachments();
  const targets = snapshot?.targets ?? [];
  const attached = useMemo(() => new Set(targets.map(resourceKey)), [snapshot?.targets]);

  return (
    <section className="machine-monitor__references" aria-labelledby="machine-monitor-references-title">
      <header>
        <div>
          <h2 id="machine-monitor-references-title">Linked references</h2>
          <p>Keep the BB threads and external resources that explain or repair this fleet close at hand.</p>
        </div>
        <span className="machine-monitor__reference-count" aria-label={`${targets.length} linked reference${targets.length === 1 ? "" : "s"}`}>{targets.length}</span>
      </header>
      {loading && snapshot == null && <p className="machine-monitor__reference-status" role="status">Loading saved references…</p>}
      {snapshot != null && <p className={`machine-monitor__reference-status machine-monitor__reference-status--${snapshot.status.state}`} role="status">{attachmentStatusText(snapshot)}</p>}
      {stale && <p className="machine-monitor__reference-status" role="status">The connection is recovering; this list may be briefly out of date.</p>}
      {readError != null && <p className="machine-monitor__reference-error" role="alert">{readError}</p>}
      {mutationError != null && <p className="machine-monitor__reference-error" role="alert">{mutationError}</p>}
      {targets.length === 0 && snapshot != null && <p className="machine-monitor__reference-empty">No references linked yet.</p>}
      {targets.length > 0 && (
        <ul className="machine-monitor__reference-list">
          {targets.map((target) => {
            return (
              <li key={resourceKey(target)}>
                <span>
                  <ReferenceLink target={target} />
                  <small>{target.presentation.detail ?? (targetThread(target) == null ? target.presentation.url : `Project ${targetThread(target)!.projectId}`)}</small>
                </span>
                <button
                  type="button"
                  className="machine-monitor__reference-remove"
                  disabled={saving}
                  onClick={() => { void remove(target); }}
                  aria-label={`Remove ${target.presentation.label}`}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ThreadPicker attached={attached} disabled={saving || snapshot == null} onAdd={add} onAddResource={addResource} />
    </section>
  );
}
