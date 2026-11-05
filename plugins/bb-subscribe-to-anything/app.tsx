import { useCallback, useEffect, useRef, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
  useRealtime,
  useRealtimeConnectionState,
  experimental_Icon as Icon,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginNavPanelProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type {
  uiContract,
  SubscriptionRow,
  SubscriptionDetail,
  ListInput,
} from "./ui-contract";
import { deliveryLabel, needsAttention } from "./ui-model";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import "./app.css";

const terminal = (state: string) =>
  ["fulfilled", "failed", "expired", "cancelled"].includes(state);
const date = (at: number | null) =>
  at === null
    ? "—"
    : new Date(at).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
const label = (row: SubscriptionRow) =>
  row.state === "watching" && row.kind !== "observation"
    ? row.kind === "idle"
      ? "Waiting for idle"
      : "Scheduled"
    : row.state[0].toUpperCase() + row.state.slice(1);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function useVisible() {
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}
function ReadStatus({
  error,
  refresh,
  stale,
}: {
  error: unknown;
  refresh: () => void;
  stale: boolean;
}) {
  if (!error) return null;
  return (
    <div className="sub-read-status" role="status">
      {stale
        ? "Showing the last loaded data. Updates are unavailable."
        : "Subscriptions could not be loaded."}{" "}
      Retrying automatically.
      <Button variant="ghost" size="sm" onClick={refresh}>
        Retry now
      </Button>
      <details>
        <summary>Details</summary>
        {errorText(error)}
      </details>
    </div>
  );
}
function Status({ row }: { row: SubscriptionRow }) {
  return (
    <span
      className={`sub-status ${needsAttention(row) ? "sub-attention" : ""}`}
    >
      <span aria-hidden="true">●</span> {label(row)}
    </span>
  );
}
function Owner({ row }: { row: SubscriptionRow }) {
  const navigate = useBbNavigate();
  return (
    <Button
      variant="link"
      size="sm"
      className="sub-owner"
      onClick={() => navigate.toThread(row.owner)}
    >
      {row.owner_title ?? row.owner}
    </Button>
  );
}
function Refresh({ refresh, busy }: { refresh: () => void; busy: boolean }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Refresh subscriptions"
      disabled={busy}
      onClick={refresh}
    >
      <Icon name="RefreshCw" />
    </Button>
  );
}
function Runtime({
  children,
  threadId,
}: {
  children: React.ReactNode;
  threadId?: string;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 2,
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
            staleTime: 30000,
            gcTime: 60000,
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
            refetchIntervalInBackground: false,
          },
          mutations: { retry: false },
        },
      }),
  );
  const cleanup = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(cleanup.current);
    return () => {
      cleanup.current = setTimeout(() => client.clear(), 0);
    };
  }, [client]);
  return (
    <QueryClientProvider client={client}>
      <Signals threadId={threadId} />
      {children}
    </QueryClientProvider>
  );
}
function Signals({ threadId }: { threadId?: string }) {
  const client = useQueryClient(),
    connection = useRealtimeConnectionState();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void client.invalidateQueries({
        refetchType: document.visibilityState === "hidden" ? "none" : "active",
      });
    }, 200);
  }, [client]);
  useRealtime("subscriptions-changed", (payload) => {
    const owners =
      typeof payload === "object" && payload !== null && "owners" in payload
        ? payload.owners
        : null;
    if (!threadId || !Array.isArray(owners) || owners.includes(threadId))
      refresh();
  });
  useEffect(() => {
    if (connection === "connected") refresh();
  }, [connection, refresh]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return null;
}
function List({
  threadId,
  onSelect,
}: {
  threadId?: string;
  onSelect: (id: string) => void;
}) {
  const rpc = useRpc<typeof uiContract>(),
    visible = useVisible();
  const [view, setView] = useState<"active" | "history">("active"),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [project, setProject] = useState(""),
    [offset, setOffset] = useState(0),
    [state, setState] = useState<ListInput["state"]>();
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const read = useQuery({
    queryKey: [
      "subscriptions",
      threadId ?? "",
      view,
      query,
      project,
      state,
      offset,
    ],
    queryFn: () =>
      rpc.call("subscriptionsList", {
        ...(threadId ? { threadId } : {}),
        view,
        query,
        ...(project ? { project } : {}),
        ...(state ? { state } : {}),
        offset,
      }),
    enabled: visible,
    refetchInterval: (q) => (q.state.error ? 30000 : false),
  });
  const data = read.data;
  return (
    <div className="sub-content">
      <header className="sub-header">
        <div>
          <h1>Watch &amp; reminder subscriptions</h1>
          <p>{threadId ? "Watches and reminders created for this thread using Subscribe to Anything." : "Watches and reminders created by agents using Subscribe to Anything, across all threads."}</p>
        </div>
        <Refresh refresh={() => void read.refetch()} busy={read.isFetching} />
      </header>
      <div className="sub-tabs" aria-label="Subscription history">
        {(["active", "history"] as const).map((tab) => (
          <Button
            key={tab}
            variant="ghost"
            size="sm"
            aria-pressed={view === tab}
            onClick={() => {
              setView(tab);
              setState(undefined);
              setOffset(0);
            }}
          >
            {tab === "active" ? "Active" : "History"}
          </Button>
        ))}
      </div>
      <div className="sub-toolbar">
        <Input
          aria-label="Search subscriptions"
          placeholder="Search subjects or IDs…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {!threadId && (
          <select
            aria-label="Filter by project"
            value={project}
            onChange={(event) => {
              setProject(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">All projects</option>
            {data?.projects.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="Filter by state"
          value={state ?? ""}
          onChange={(event) => {
            setState(
              event.target.value
                ? (event.target.value as ListInput["state"])
                : undefined,
            );
            setOffset(0);
          }}
        >
          <option value="">All states</option>
          {(view === "active"
            ? ["preparing", "watching", "running", "reviewing", "uncertain"]
            : ["fulfilled", "failed", "expired", "cancelled"]
          ).map((value) => (
            <option key={value} value={value}>
              {value[0].toUpperCase() + value.slice(1)}
            </option>
          ))}
        </select>
      </div>
      <ReadStatus
        error={read.error}
        stale={!!data}
        refresh={() => void read.refetch()}
      />
      {!data && read.isPending ? (
        <p className="sub-empty" role="status">
          Loading subscriptions…
        </p>
      ) : (
        data && (
          <>
            {data.rows.some(needsAttention) && (
              <p className="sub-notice">
                <Icon name="TriangleAlert" />{" "}
                {data.rows.filter(needsAttention).length} {data.rows.filter(needsAttention).length === 1 ? "subscription needs" : "subscriptions need"} attention on this page. Open one for details.
              </p>
            )}
            {data.rows.length === 0 ? (
              <div className="sub-empty">
                <h2>
                  {query || project || state
                    ? "No matching subscriptions"
                    : view === "active"
                      ? "No active subscriptions"
                      : "No subscription history"}
                </h2>
                <p>
                  {query || project || state
                    ? "Try a different search or filter."
                    : view === "active"
                      ? "Ask an agent to watch for a change or remind you later. Accepted subscriptions appear here."
                      : "Completed, cancelled, expired and failed subscriptions appear here."}
                </p>
              </div>
            ) : (
              <div className="sub-table-wrap">
                <table className="sub-table">
                  <thead>
                    <tr>
                      <th>Subject</th>
                      <th>Status</th>
                      <th>Last check</th>
                      <th>Next</th>
                      {!threadId && <th>Thread</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <button
                            className="sub-subject"
                            onClick={() => onSelect(row.id)}
                          >
                            {row.subject}
                          </button>
                          <small>
                            {row.kind === "observation"
                              ? "Watch"
                              : row.kind === "idle" ? "Idle reminder" : "Reminder"}
                          </small>
                        </td>
                        <td>
                          <Status row={row} />
                          {row.delivery === "uncertain" && (
                            <small className="sub-attention">
                              Delivery uncertain
                            </small>
                          )}
                          {row.stop_pending && <small>Stop requested</small>}
                        </td>
                        <td>
                          {row.kind !== "observation"
                            ? "No checks needed"
                            : row.last_check_at === null
                              ? "No check output yet"
                              : date(row.last_check_at)}
                          <small>{row.classification}</small>
                        </td>
                        <td>
                          {row.next_at !== null ? date(row.next_at) : "—"}
                          {row.expires_at !== null && (
                            <small>Expires {date(row.expires_at)}</small>
                          )}
                        </td>
                        {!threadId && (
                          <td>
                            <Owner row={row} />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <footer className="sub-footer">
              <span>
                {data.total === 0
                  ? "0"
                  : `${offset + 1}–${offset + data.rows.length} of ${data.total}`}{" "}
                subscriptions
              </span>
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  Previous
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={offset + 50 >= data.total}
                  onClick={() => setOffset(offset + 50)}
                >
                  Next
                </Button>
              </div>
            </footer>
            <p className="sub-help">
              Pending checks stay quiet. Collected output may still need verification.
            </p>
            <small className="sub-updated">
              Snapshot {date(data.observed_at)}
            </small>
          </>
        )
      )}
    </div>
  );
}
function Finding({
  finding,
}: {
  finding: SubscriptionDetail["findings"][number];
}) {
  return (
    <article className="sub-finding">
      <div className="sub-check-title">
        <strong>{finding.outcome}</strong>
        <time>{date(finding.created_at)}</time>
      </div>
      <p>{finding.summary}</p>
      {finding.evidence && (
        <details>
          <summary>Verified evidence / recorded explanation</summary>
          <pre>{finding.evidence}</pre>
        </details>
      )}
      <p className="sub-muted">
        {deliveryLabel(finding.delivery)}
        {finding.withdrawal_pending ? " · Withdrawal requested" : ""}
      </p>
      {finding.delivery === "accepted" && (
        <small>
          BB accepted this notification. This does not confirm that a person
          read it.
        </small>
      )}
      {finding.problem && <p className="sub-attention">{finding.problem}</p>}
    </article>
  );
}
function Diagnostics({ id, threadId }: { id: string; threadId?: string }) {
  const rpc = useRpc<typeof uiContract>(),
    visible = useVisible();
  const read = useQuery({
    queryKey: ["diagnostics", id, threadId],
    queryFn: () =>
      rpc.call("subscriptionDiagnostics", {
        id,
        ...(threadId ? { threadId } : {}),
      }),
    enabled: visible,
    refetchInterval: (q) => (q.state.error ? 30000 : false),
  });
  return (
    <>
      <ReadStatus
        error={read.error}
        stale={!!read.data}
        refresh={() => void read.refetch()}
      />
      {read.data ? (
        <>
          <dl>
            <dt>Observer thread (debug only)</dt>
            <dd>
              <code>{read.data.observer_thread_id ?? "No observer"}</code>
            </dd>
            <dt>Launch</dt>
            <dd>{read.data.launch ?? "Not needed"}</dd>
            <dt>Review wake</dt>
            <dd>{read.data.review_wake ?? "None"}</dd>
          </dl>
          <p className="sub-help">
            Manage the subscription here. Do not send instructions directly to
            the observer.
          </p>
          <details>
            <summary>Collector script</summary>
            <pre>
              {read.data.script ?? "This subscription uses a native trigger."}
            </pre>
          </details>
          <details>
            <summary>Recipe history ({read.data.revisions.length})</summary>
            {read.data.revisions.map((r, index) => (
              <div key={index}>
                <h3>Revision {index + 1}</h3>
                <p>{r.interpretation}</p>
                <p>{r.coverage}</p>
                <pre>{r.script}</pre>
              </div>
            ))}
          </details>
        </>
      ) : (
        !read.error && <p role="status">Loading diagnostics…</p>
      )}
    </>
  );
}
function Detail({
  id,
  threadId,
  onBack,
}: {
  id: string;
  threadId?: string;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof uiContract>(),
    client = useQueryClient(),
    visible = useVisible();
  const [confirm, setConfirm] = useState(false),
    [cancelling, setCancelling] = useState(false),
    [actionError, setActionError] = useState<string | null>(null),
    [receipt, setReceipt] = useState<string | null>(null),
    [debug, setDebug] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const read = useQuery({
    queryKey: ["detail", id, threadId],
    queryFn: () =>
      rpc.call("subscriptionDetail", { id, ...(threadId ? { threadId } : {}) }),
    enabled: visible,
    refetchInterval: (q) => (q.state.error ? 30000 : false),
  });
  const data = read.data;
  useEffect(() => {
    heading.current?.focus();
  }, [id, Boolean(data)]);
  const cancel = async () => {
    if (!data || cancelling) return;
    setCancelling(true);
    setActionError(null);
    try {
      const result = await rpc.call("cancelSubscription", {
        id,
        ...(threadId ? { threadId } : {}),
        owner: data.row.owner,
        generation: data.row.generation,
      });
      setReceipt(
        `${result.state} · ${result.shutdown}. ${result.already_dispatched}`,
      );
      setConfirm(false);
      void client.invalidateQueries();
    } catch (error) {
      setActionError(
        `${errorText(error)} Cancellation may be unconfirmed. Refresh and inspect before retrying.`,
      );
    } finally {
      setCancelling(false);
    }
  };
  return (
    <div className="sub-content">
      <header className="sub-header">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Watch &amp; reminder subscriptions
        </Button>
        <Refresh refresh={() => void read.refetch()} busy={read.isFetching} />
      </header>
      <ReadStatus
        error={read.error}
        stale={!!data}
        refresh={() => void read.refetch()}
      />
      {!data && read.isPending ? (
        <p role="status">Loading subscription…</p>
      ) : (
        data && (
          <>
            <div className="sub-detail-heading">
              <h1 ref={heading} tabIndex={-1}>
                {data.row.subject}
              </h1>
              <Status row={data.row} />
              <Owner row={data.row} />
              {!terminal(data.row.state) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirm(true)}
                >
                  Cancel subscription
                </Button>
              )}
            </div>
            {confirm && (
              <div
                className="sub-confirm"
                role="group"
                aria-label="Confirm cancellation"
              >
                <p>
                  Stop future checks and notifications? Already dispatched
                  messages cannot be recalled.
                </p>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={cancelling}
                  onClick={() => void cancel()}
                >
                  {cancelling ? "Cancelling…" : "Confirm cancellation"}
                </Button>{" "}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={cancelling}
                  onClick={() => setConfirm(false)}
                >
                  Keep watching
                </Button>
              </div>
            )}
            {actionError && (
              <p role="alert" className="sub-notice">
                {actionError}
              </p>
            )}
            {receipt && (
              <p role="status" className="sub-notice">
                {receipt}
              </p>
            )}
            {data.row.problem && (
              <p className="sub-notice">{data.row.problem}</p>
            )}
            <section className="sub-condition">
              <h2>Watching for</h2>
              <p>{data.condition}</p>
              <h3>Required evidence</h3>
              <p>{data.evidence_requirement}</p>
              {data.row.kind === "observation" && <small>Pending checks stay quiet; potential findings are reviewed before notification.</small>}
            </section>
            <div className="sub-detail-grid">
              <main>
                <h2>Recent checks</h2>
                <p className="sub-help">
                  Retained checks from the current watch. Recorded results do not imply confidence beyond what was reported.
                </p>
                {data.runs.length === 0 && (
                  <p className="sub-empty">
                    {data.row.kind === "observation"
                      ? "No check output yet. An accepted watch does not guarantee that a check has run."
                      : "Reminders do not need checks."}
                  </p>
                )}
                {data.runs.map((run) => (
                  <details className="sub-run" key={run.id}>
                    <summary>
                      <time>{date(run.ended_at)}</time>
                      <strong>
                        {run.problem
                          ? "Collection issue"
                          : (run.classification ?? "Awaiting classification")}
                      </strong>
                      <span>
                        {run.duration_ms} ms · exit {run.exit_code ?? "unknown"}
                      </span>
                    </summary>
                    {run.problem && (
                      <p className="sub-attention">{run.problem}</p>
                    )}
                    <h3>Collected output</h3>
                    <pre>{run.output || "(empty)"}</pre>
                    {run.output_truncated && (
                      <p>
                        Preview limited to 20,000 characters. Use
                        subscription_inspect for troubleshooting.
                      </p>
                    )}
                    <details>
                      <summary>Execution logs</summary>
                      <h3>Standard output</h3>
                      <pre>{run.stdout || "(empty)"}</pre>
                      <h3>Standard error</h3>
                      <pre>{run.stderr || "(empty)"}</pre>
                    </details>
                    {data.findings
                      .filter((f) => f.occurrence === run.id)
                      .map((f) => (
                        <Finding key={f.id} finding={f} />
                      ))}
                  </details>
                ))}
                <h2>Findings & notifications</h2>
                {data.findings.length === 0 ? (
                  <p className="sub-muted">
                    No findings recorded. Silence does not prove the condition
                    was checked.
                  </p>
                ) : (
                  data.findings.map((f) => <Finding key={f.id} finding={f} />)
                )}
              </main>
              <aside>
                <section className="sub-health">
                  <h2>Schedule &amp; activity</h2>
                  <dl>
                    <dt>Created</dt>
                    <dd>{date(data.row.created_at)}</dd>
                    <dt>Latest check</dt>
                    <dd>{date(data.row.last_check_at)}</dd>
                    <dt>Next check / trigger</dt>
                    <dd>{date(data.row.next_at)}</dd>
                    <dt>Expires</dt>
                    <dd>
                      {data.row.expires_at
                        ? date(data.row.expires_at)
                        : "No deadline"}
                    </dd>
                    <dt>Mode</dt>
                    <dd>
                      {data.mode === "until"
                        ? "Until matched"
                        : "Ongoing changes"}
                    </dd>
                    <dt>Classifier</dt>
                    <dd>{data.classifier ?? "Not configured / native"}</dd>
                    <dt>Interval</dt>
                    <dd>
                      {data.interval_seconds
                        ? `${data.interval_seconds}s`
                        : "Native / not configured"}
                    </dd>
                    <dt>Executions</dt>
                    <dd>{data.checks}</dd>
                    <dt>Observer turns</dt>
                    <dd>{data.observer_turns}</dd>
                    <dt>Recipe revisions</dt>
                    <dd>{data.recipe_revisions}</dd>
                    <dt>Notification</dt>
                    <dd>{deliveryLabel(data.row.delivery)}</dd>
                    <dt>Cleanup</dt>
                    <dd>
                      {data.row.stop_pending
                        ? "Stop requested"
                        : "No pending stop"}
                    </dd>
                  </dl>
                  {data.coverage && (
                    <>
                      <h3>Declared coverage</h3>
                      <p>{data.coverage}</p>
                    </>
                  )}
                  {data.interpretation && (
                    <>
                      <h3>Interpretation</h3>
                      <p>{data.interpretation}</p>
                    </>
                  )}
                </section>
                <details
                  className="sub-debug"
                  onToggle={(event) => setDebug(event.currentTarget.open)}
                >
                  <summary>Advanced diagnostics</summary>
                  {debug && <Diagnostics id={id} threadId={threadId} />}
                </details>
              </aside>
            </div>
          </>
        )
      )}
    </div>
  );
}
export function SubscriptionSurface({
  threadId,
  selectedId,
  onSelect,
  onBack,
}: {
  threadId?: string;
  selectedId?: string;
  onSelect: (id: string) => void;
  onBack: () => void;
}) {
  return (
    <div className={`sub-root ${threadId ? "sub-panel" : ""}`}>
      {selectedId ? (
        <Detail
          key={`${threadId ?? ""}:${selectedId}`}
          id={selectedId}
          threadId={threadId}
          onBack={onBack}
        />
      ) : (
        <List key={threadId ?? "all"} threadId={threadId} onSelect={onSelect} />
      )}
    </div>
  );
}
function Page({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  return (
    <Runtime>
      <SubscriptionSurface
        selectedId={subPath || undefined}
        onSelect={(id) =>
          navigate.toPluginPanel("subscriptions", { subPath: id })
        }
        onBack={() => navigate.toPluginPanel("subscriptions")}
      />
    </Runtime>
  );
}
function Panel({ threadId }: PluginThreadPanelProps) {
  const [selected, setSelected] = useState<string>();
  useEffect(() => setSelected(undefined), [threadId]);
  return (
    <Runtime threadId={threadId}>
      <SubscriptionSurface
        threadId={threadId}
        selectedId={selected}
        onSelect={setSelected}
        onBack={() => setSelected(undefined)}
      />
    </Runtime>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "subscriptions",
    title: "Watch & reminder subscriptions",
    icon: "Clock",
    path: "subscriptions",
    component: Page,
  });
  app.slots.threadPanelAction({
    id: "subscriptions",
    title: "Watch & reminder subscriptions",
    icon: "Clock",
    layout: "flush",
    component: Panel,
  });
});
