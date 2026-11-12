import { groupDraftCounts, groupSummary } from "./summary.ts";
import { EnforcementBanner } from "./enforcement-banner.tsx";
import { RecentNativeDecisions } from "./recent-decisions.tsx";
import { resolvePanelId } from "./route.ts";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { Occurrence, Run } from "../state/store.ts";
import type { Client, Draft, Snapshot, LookupState } from "./types.ts";
import {
  confirmsWrite,
  operationKey,
  reconcileDrafts,
  keepNewerSavedInputs,
  settleDraft,
  type WriteIntent,
} from "./writes.ts";
import { hasRelevantDrafts } from "./drafts.ts";
import { RuleEditor, GroupEditor, SearchValue } from "./rule-editor.tsx";
import {
  newRule,
  newGroup,
  defaultConnection,
  fileLocation,
  VERSION,
} from "../contracts/model.ts";
import type { Rule, RuleGroup, FileLocation } from "../contracts/model.ts";
import { fixtureTemplate } from "../contracts/template.ts";
const CodeEditor = lazy(() => import("./editor.tsx"));
const statusLabel = {
  pass: "Passed",
  fail: "Failed",
  error: "Error",
  unknown: "Unresolved",
};
export type PanelProps = {
  client: Client;
  projectId: string | null;
  legacyProjectId?: string;
  projects: { id: string; name: string }[];
  projectLookup?: LookupState;
  subPath: string;
  navigate: (path: string) => void;
  refreshSignal: number;
  discoverFiles?: boolean;
  drafts: Map<string, Draft>;
};
export function Panel({
  client,
  projectId,
  legacyProjectId,
  projects,
  projectLookup,
  subPath,
  navigate,
  refreshSignal,
  discoverFiles = true,
  drafts,
}: PanelProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [readError, setReadError] = useState<string | null>(null),
    [writeError, setWriteError] = useState<{
      message: string;
      operation: string;
      attempt?: number;
      intent?: WriteIntent;
      dialog?: "add" | "connection";
    } | null>(null),
    [busy, setBusy] = useState(false),
    [draftRevision, setDraftRevision] = useState(0),
    [connectionOpen, setConnectionOpen] = useState(false),
    [adding, setAdding] = useState<"rule" | "test" | "group" | null>(null),
    [addName, setAddName] = useState(""),
    [addError, setAddError] = useState<string | null>(null),
    [creationLocation, setCreationLocation] = useState<FileLocation | null>(
      null,
    ),
    [testGroupChoice, setTestGroupChoice] = useState<string | null>(null),
    [readAttempt, setReadAttempt] = useState(0);
  const latestSnapshot = useRef<Snapshot | null>(null);
  const acceptSnapshot = useCallback((incoming: Snapshot) => {
    const next = keepNewerSavedInputs(latestSnapshot.current, incoming);
    latestSnapshot.current = next;
    setSnapshot(next);
    return next;
  }, []);
  const readGeneration = useRef(0),
    mounted = useRef(true),
    scope = useRef(projectId),
    loadedScope = useRef(projectId),
    mutationAttempt = useRef(0),
    lastSignal = useRef(refreshSignal),
    fullRead = useRef<{
      projectId: string;
      promise: Promise<Snapshot | undefined>;
    } | null>(null);
  scope.current = projectId;
  const p = snapshot?.project;
  const refresh = useCallback(
    (discover = true, requestId?: string, runId?: string): Promise<Snapshot | undefined> => {
      if (!projectId) return Promise.resolve(undefined);
      if (!requestId && !runId && !discover && fullRead.current?.projectId === projectId)
        return fullRead.current.promise;
      const pending = (async () => {
        const generation = ++readGeneration.current;
        try {
          const incoming = await client.call("snapshot", {
            projectId,
            discoverFiles: discover,
            ...(requestId ? { requestId } : {}),
            ...(runId ? { runId } : {}),
          });
          if (
            mounted.current &&
            scope.current === projectId &&
            generation === readGeneration.current
          ) {
            const next = acceptSnapshot(incoming);
            if (reconcileDrafts(drafts, next)) setDraftRevision((n) => n + 1);
            setWriteError((old) =>
              old?.intent && confirmsWrite(old.intent, next) ? null : old,
            );
            setReadError(null);
            setReadAttempt((n) =>
              next.readError ? (discover ? n + 1 : n) : 0,
            );
            return next;
          }
        } catch (e) {
          if (
            mounted.current &&
            scope.current === projectId &&
            generation === readGeneration.current
          ) {
            setReadError(String(e));
            setReadAttempt((n) => n + 1);
          }
        }
      })();
      if (discover) {
        fullRead.current = { projectId, promise: pending };
        void pending
          .finally(() => {
            if (fullRead.current?.promise === pending) fullRead.current = null;
          })
          .catch(() => {});
      }
      return pending;
    },
    [client, projectId, drafts, acceptSnapshot],
  );
  useEffect(() => {
    mounted.current = true;
    if (loadedScope.current !== projectId) {
      loadedScope.current = projectId;
      setWriteError(null);
      setReadError(null);
      setReadAttempt(0);
      setBusy(false);
    }
    latestSnapshot.current = null;
    setSnapshot(null);
    void refresh();
    return () => {
      mounted.current = false;
      readGeneration.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if (lastSignal.current === refreshSignal) return;
    lastSignal.current = refreshSignal;
    void refresh(discoverFiles);
  }, [refresh, refreshSignal, discoverFiles]);
  useEffect(() => {
    const handler = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [refresh]);
  const hasReadFailure = !!(readError || snapshot?.readError);
  useEffect(() => {
    if (!hasReadFailure || busy || document.hidden) return;
    const timer = setTimeout(
      () => {
        if (!document.hidden) void refresh();
      },
      Math.min(15000, 1000 * 2 ** Math.min(readAttempt, 4)),
    );
    return () => clearTimeout(timer);
  }, [hasReadFailure, readAttempt, busy, refresh]);
  const updateDraft = () => setDraftRevision((x) => x + 1);
  const key = (kind: string, id: string) => projectId + ":" + kind + ":" + id;
  const selectedType = subPath.startsWith("group/")
      ? "group"
      : subPath.startsWith("rule/")
        ? "rule"
        : subPath.startsWith("test/")
          ? "test"
          : null,
    rawId = decodeURIComponent(subPath.slice(subPath.indexOf("/") + 1)),
    id = resolvePanelId(
      snapshot?.catalog?.aliases,
      legacyProjectId,
      selectedType,
      rawId,
    );
  const selectedGroup =
    selectedType === "group" ? p?.groups.find((g) => g.id === id) : null;
  const selectedRule =
      selectedType === "rule" ? p?.rules.find((x) => x.id === id) : null,
    selectedTest =
      selectedType === "test"
        ? p?.occurrences.find((x) => x.occurrenceId === id)
        : null;
  const contextGroupId =
    selectedGroup?.id ?? selectedRule?.groupId ?? selectedTest?.groupId;
  const contextGroup = p?.groups.find((g) => g.id === contextGroupId);
  const ownedTests =
    p?.occurrences.filter(
      (o) => (o.groupId ?? p.groups[0]?.id) === contextGroupId,
    ) ?? [];
  useEffect(() => setTestGroupChoice(null), [selectedTest?.occurrenceId]);
  const selectedKey = selectedGroup
    ? key("group", selectedGroup.id)
    : selectedRule
      ? key("rule", selectedRule.id)
      : selectedTest
        ? key("test", selectedTest.occurrenceId)
        : null;
  const selectedSource = selectedGroup
    ? JSON.stringify(selectedGroup)
    : selectedRule
      ? JSON.stringify(selectedRule)
      : (selectedTest?.source ?? "");
  const currentDraft = selectedKey ? drafts.get(selectedKey) : undefined;
  const current = currentDraft?.value ?? selectedSource;
  const dirty = current !== selectedSource;
  const relevant = hasRelevantDrafts(projectId, p, drafts);
  const run = snapshot?.run,
    stale = !!run && run.frozen.basis !== snapshot?.basis;
  const pass = run?.results.filter((x) => x.status === "pass").length ?? 0,
    total =
      run?.frozen.denominator ??
      p?.occurrences.filter((x) => x.enabled).length ??
      0;
  const duplicateNames = useMemo(() => {
    const groups = new Map<string, number>(),
      rules = new Map<string, number>(),
      files = new Map<string, number>();
    for (const g of p?.groups ?? [])
      groups.set(g.title, (groups.get(g.title) ?? 0) + 1);
    for (const r of p?.rules ?? []) {
      const key = r.groupId + "\0" + r.title;
      rules.set(key, (rules.get(key) ?? 0) + 1);
    }
    for (const o of ownedTests) files.set(o.path, (files.get(o.path) ?? 0) + 1);
    return { groups, rules, files };
  }, [p, contextGroupId]);
  const resultMap = useMemo(
    () => new Map(run?.results.map((r) => [r.occurrenceId, r])),
    [run],
  );
  const testsByGroup = useMemo(() => {
    const map = new Map<string, Occurrence[]>();
    for (const o of p?.occurrences ?? []) {
      const id = o.groupId ?? p?.groups[0]?.id ?? "";
      const list = map.get(id) ?? [];
      list.push(o);
      map.set(id, list);
    }
    return map;
  }, [p]);
  const savedTestsByGroup = useMemo(() => {
    const map = new Map<string, Occurrence[]>();
    for (const o of run?.frozen.occurrences ?? []) {
      const id = o.groupId ?? "";
      const list = map.get(id) ?? [];
      list.push(o);
      map.set(id, list);
    }
    return map;
  }, [run]);
  const groupDrafts = groupDraftCounts(p, drafts, projectId!);
  const rulesByGroup = useMemo(() => {
    const map = new Map<string, Rule[]>();
    for (const r of p?.rules ?? []) {
      const list = map.get(r.groupId) ?? [];
      list.push(r);
      map.set(r.groupId, list);
    }
    for (const list of map.values())
      list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    return map;
  }, [p]);
  const result = selectedTest
    ? resultMap.get(selectedTest.occurrenceId)
    : undefined;
  const suiteTone =
    relevant ||
    stale ||
    (run && run.status !== "complete") ||
    run?.results.some((r) => r.status === "unknown")
      ? "pending"
      : !run || !total
        ? "neutral"
        : pass === total
          ? "pass"
          : "fail";
  const resultTone =
    dirty || stale || result?.status === "unknown"
      ? "pending"
      : result?.status === "pass"
        ? "pass"
        : result?.status === "fail" ||
            result?.status === "error" ||
            selectedTest?.error
          ? "fail"
          : "neutral";
  function edit(value: string) {
    if (!selectedKey) return;
    const old = drafts.get(selectedKey);
    drafts.set(selectedKey, {
      ...old,
      value,
      base: old?.base ?? selectedSource,
      hash: old?.hash ?? selectedTest?.hash ?? null,
      location:
        old?.location ??
        (selectedTest && p
          ? (selectedTest.location ?? fileLocation(p.config))
          : undefined),
      kind: selectedGroup ? "group" : selectedRule ? "rule" : "test",
      enabled:
        selectedGroup?.enabled ??
        selectedRule?.enabled ??
        selectedTest?.enabled ??
        false,
    });
    updateDraft();
  }
  async function action(
    method: string,
    input: Record<string, unknown>,
    dialog?: "add" | "connection",
  ) {
    if (!projectId) return;
    ++readGeneration.current;
    const attempt = ++mutationAttempt.current;
    const intent: WriteIntent = { projectId, method, input };
    const operation = operationKey(intent);
    setBusy(true);
    try {
      const next = await client.call(method, { projectId, ...input });
      if (!mounted.current || scope.current !== projectId) return next;
      acceptSnapshot(next);
      if (reconcileDrafts(drafts, next)) updateDraft();
      // Acknowledged saved inputs are presented immediately; delayed reads cannot regress them.
      setWriteError((old) =>
        old?.operation === operation && (old.attempt ?? 0) <= attempt
          ? null
          : old,
      );
      return next;
    } catch (e) {
      if (mounted.current && scope.current === projectId)
        setWriteError((old) =>
          old?.operation === operation && (old.attempt ?? 0) > attempt
            ? old
            : {
                message: e instanceof Error ? e.message : String(e),
                operation,
                attempt,
                intent,
                dialog,
              },
        );
      // Read the authoritative revisions without replaying the failed write.
      // Its error remains separate until the same write is confirmed.
      if (mounted.current && scope.current === projectId) {
        const next = await refresh(
          true,
          method === "startSuite" ? String(input.requestId) : undefined,
          method === "cancelSuite" ? String(input.runId) : undefined,
        );
        if (next && confirmsWrite(intent, next)) return next;
      }
      return undefined;
    } finally {
      if (mounted.current && scope.current === projectId) setBusy(false);
    }
  }
  async function save() {
    if (!p || !selectedKey) return;
    const method = selectedGroup
      ? "saveGroup"
      : selectedRule
        ? "saveRule"
        : "saveFile";
    const input = selectedGroup
      ? { revision: p.revision, group: JSON.parse(current) }
      : selectedRule
        ? { revision: p.revision, rule: JSON.parse(current) }
        : {
            occurrenceId: selectedTest!.occurrenceId,
            path: selectedTest!.path,
            source: current,
            hash: currentDraft?.hash ?? selectedTest!.hash,
            location:
              currentDraft?.location ??
              selectedTest?.location ??
              fileLocation(p.config),
          };
    const pending = {
      submitted: current,
      intent: { projectId: projectId!, method, input },
    };
    const draft = drafts.get(selectedKey);
    if (draft) drafts.set(selectedKey, { ...draft, pending });
    const next = await action(method, input);
    if (next) {
      settleDraft(drafts, selectedKey, pending, next, true);
      if (mounted.current && scope.current === projectId) updateDraft();
    }
  }
  const select = (kind: string, id: string) =>
    navigate(kind + "/" + encodeURIComponent(id));
  return (
    <div className="mr-root" data-draft-revision={draftRevision}>
      <EnforcementBanner delivery={snapshot?.delivery} readError={readError} projects={projects} />
      <RecentNativeDecisions client={client} />
      {relevant && (
        <p className="mr-notice" id="mr-draft-reason">
          Save or discard group, enabled rule and test drafts before Test.
        </p>
      )}
      {(readError || snapshot?.readError) && (
        <p className="mr-error" role="alert">
          {readError || snapshot?.readError}{" "}
          <button onClick={() => void refresh()}>Retry read</button>
        </p>
      )}
      {writeError &&
        !(adding && writeError.dialog === "add") &&
        !(connectionOpen && writeError.dialog === "connection") && (
          <p className="mr-error" role="alert">
            {writeError.message}{" "}
            <button onClick={() => void refresh()}>
              Read current saved inputs
            </button>
          </p>
        )}
      {!!snapshot?.unresolved.length && (
        <p className="mr-notice" role="status">
          {snapshot.unresolved.length} prior call outcome(s) remain unknown and
          reserved against the suite call limit. An explicit new Test does not
          replay them.
        </p>
      )}
      {run?.error && (
        <p className="mr-error" role="status">
          {run.error}
        </p>
      )}
      <div className="mr-workspace">
        <aside className="mr-list" aria-label="Rules and tests">
          <div className="mr-list-group">
            <div className="mr-section-heading">
              <h2>Rules</h2>
              <button
                className="mr-link"
                disabled={!p || busy}
                onClick={() => {
                  setAdding("group");
                  setAddError(null);
                  setAddName("");
                }}
              >
                + Group
              </button>
              <button
                className="mr-link"
                disabled={!p?.groups.length || busy}
                onClick={() => {
                  setAdding("rule");
                  setAddError(null);
                  setAddName("");
                }}
              >
                + Add
              </button>
            </div>
            {p?.groups
              .slice()
              .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
              .map((g) => (
                <div className="mr-rule-group" key={g.id}>
                  <InboxRow
                    name={
                      g.title +
                      ((duplicateNames.groups.get(g.title) ?? 0) > 1
                        ? " · " + g.id
                        : "")
                    }
                    selected={selectedGroup?.id === g.id}
                    enabled={g.enabled}
                    kind="group"
                    onSelect={() => select("group", g.id)}
                    onToggle={() =>
                      void action("saveGroup", {
                        revision: p.revision,
                        group: { ...g, enabled: !g.enabled },
                      })
                    }
                    disabled={busy}
                  />
                  <p
                    className="mr-group-summary"
                    aria-label={g.title + " test summary"}
                  >
                    {groupSummary(
                      testsByGroup.get(g.id) ?? [],
                      savedTestsByGroup.get(g.id) ?? [],
                      resultMap,
                      stale,
                      groupDrafts.get(g.id) ?? 0,
                    )}
                  </p>
                  <div className="mr-child-rules">
                    {(rulesByGroup.get(g.id) ?? []).map((r) => (
                      <InboxRow
                        key={r.id}
                        name={
                          r.title +
                          ((duplicateNames.rules.get(
                            r.groupId + "\0" + r.title,
                          ) ?? 0) > 1
                            ? " · " + r.id
                            : "")
                        }
                        selected={selectedRule?.id === r.id}
                        enabled={r.enabled}
                        kind="rule"
                        onSelect={() => select("rule", r.id)}
                        onToggle={() =>
                          void action("saveRule", {
                            revision: p.revision,
                            rule: { ...r, enabled: !r.enabled },
                          })
                        }
                        disabled={busy}
                      />
                    ))}
                  </div>
                </div>
              ))}
            {!p?.rules.length && (
              <p className="mr-note">Add a rule to get started.</p>
            )}
          </div>
          <div className="mr-test-all" aria-label="All groups test run">
            <span className={"mr-count mr-tone-" + suiteTone} role="status">
              {run?.status === "running"
                ? `Running ${run.results.length} / ${total}…`
                : run
                  ? total
                    ? `${run.frozen.selectedOccurrenceIds ? "Selected · " : ""}${relevant ? "Saved: " : ""}${pass} / ${total} passed${stale ? " · Stale" : ""}${run.status !== "complete" ? " · " + (run.status === "cancelled" ? "Cancelled" : "Stopped") : ""}`
                    : `No enabled tests${stale ? " · Stale" : ""}`
                  : `${total} enabled`}
            </span>
            <button
              className="mr-primary"
              disabled={busy || !p || relevant || run?.quiescent === false}
              aria-describedby={relevant ? "mr-draft-reason" : undefined}
              onClick={() =>
                void action("startSuite", {
                  requestId: crypto.randomUUID(),
                  basis: snapshot!.basis,
                  hasRelevantDrafts: relevant,
                })
              }
            >
              ▶ Test all
            </button>
          </div>
          <div className="mr-list-group">
            <div className="mr-section-heading">
              <h2>Tests</h2>
              <button
                className="mr-link"
                disabled={!p || !contextGroup || busy}
                onClick={() => {
                  setAdding("test");
                  setAddError(null);
                  setCreationLocation(
                    ownedTests[0]?.location ??
                      (p ? fileLocation(p.config) : null),
                  );
                  setAddName("");
                }}
              >
                + Add
              </button>
            </div>
            {contextGroup && (
              <p className="mr-context-label">{contextGroup.title}</p>
            )}
            {ownedTests.map((o) => {
              const r = resultMap.get(o.occurrenceId);
              const draft = drafts.get(key("test", o.occurrenceId));
              const edited = !!draft && draft.value !== draft.base;
              return (
                <InboxRow
                  key={o.occurrenceId}
                  name={
                    o.path +
                    ((duplicateNames.files.get(o.path) ?? 0) > 1
                      ? " · " +
                        (o.projectId ?? o.sourceProjectId ?? o.occurrenceId)
                      : "")
                  }
                  selected={selectedTest?.occurrenceId === o.occurrenceId}
                  enabled={o.enabled}
                  kind="test"
                  status={
                    !o.enabled
                      ? "disabled"
                      : edited
                        ? "draft"
                        : stale
                          ? "stale"
                          : o.error
                            ? "error"
                            : (r?.status ?? "untested")
                  }
                  onSelect={() => select("test", o.occurrenceId)}
                  onToggle={() =>
                    void action("toggleTest", {
                      revision: p!.revision,
                      occurrenceId: o.occurrenceId,
                      enabled: !o.enabled,
                    })
                  }
                  disabled={busy}
                />
              );
            })}
            {!ownedTests.length && (
              <p className="mr-note">
                {contextGroup
                  ? "No saved tests in this group. Add a Markdown test."
                  : "Select a group or child rule to see its tests."}
              </p>
            )}
          </div>
          {snapshot?.catalog && (
            <details className="mr-catalog-notes">
              <summary>Imported tests and compatibility</summary>
              {snapshot.catalog.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
              <p>
                Each test shows its recorded group, project and original host
                path.
              </p>
            </details>
          )}
          <button
            className="mr-link mr-connection"
            onClick={() => setConnectionOpen(true)}
          >
            ♧ JEV connection
          </button>
        </aside>
        <section className="mr-inspector" aria-label="Rule and test editor">
          {selectedGroup || selectedRule || selectedTest ? (
            <>
              <div className="mr-editor-header">
                <h2>
                  <span className="mr-editor-kind" aria-hidden="true">
                    {selectedGroup ? "◎" : selectedRule ? "≡" : "▤"}
                  </span>{" "}
                  {selectedGroup?.title ??
                    selectedRule?.title ??
                    selectedTest?.path}
                  {dirty && <span className="mr-draft"> · Draft</span>}
                </h2>
                <div className="mr-inline">
                  {dirty && (
                    <>
                      <button
                        disabled={busy}
                        onClick={() => {
                          drafts.delete(selectedKey!);
                          updateDraft();
                        }}
                      >
                        Discard
                      </button>
                      <button
                        className="mr-primary"
                        disabled={busy}
                        onClick={() => void save()}
                      >
                        Save
                      </button>
                    </>
                  )}
                  {(selectedRule || selectedGroup) && (
                    <details className="mr-menu">
                      <summary
                        aria-label={
                          selectedGroup ? "Group actions" : "Rule actions"
                        }
                      >
                        •••
                      </summary>
                      <button
                        onClick={() =>
                          void action(
                            selectedGroup ? "deleteGroup" : "deleteRule",
                            {
                              revision: p!.revision,
                              ...(selectedGroup
                                ? { groupId: selectedGroup.id }
                                : { ruleId: selectedRule!.id }),
                            },
                          ).then((next) => {
                            if (next) navigate("");
                          })
                        }
                      >
                        Delete {selectedGroup ? "group" : "rule"}
                      </button>
                    </details>
                  )}
                </div>
              </div>
              {selectedGroup ? (
                <GroupEditor
                  projects={projects}
                  projectLookup={projectLookup}
                  group={JSON.parse(current) as RuleGroup}
                  onChange={(g) => edit(JSON.stringify(g))}
                />
              ) : selectedRule ? (
                <RuleEditor
                  projects={projects}
                  projectLookup={projectLookup}
                  groups={p!.groups}
                  rule={JSON.parse(current) as Rule}
                  onChange={(rule) => edit(JSON.stringify(rule))}
                />
              ) : (
                <div className="mr-test-split">
                  <div className="mr-source">
                    <div className="mr-test-identity">
                      <strong>
                        Group: {contextGroup?.title ?? "Unassigned"}
                      </strong>
                      <SearchValue
                        label="Test group"
                        entity="group"
                        value={testGroupChoice ?? contextGroupId ?? ""}
                        options={p!.groups.map((g) => ({
                          id: g.id,
                          name: g.title,
                        }))}
                        onChange={setTestGroupChoice}
                      />
                      {testGroupChoice &&
                        testGroupChoice !== contextGroupId && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void action("assignTest", {
                                revision: p!.revision,
                                occurrenceId: selectedTest!.occurrenceId,
                                groupId: testGroupChoice,
                              }).then((next) => {
                                if (next) setTestGroupChoice(null);
                              })
                            }
                          >
                            Move test
                          </button>
                        )}
                      <span>{selectedTest?.ownership ?? "Legacy test"}</span>
                      <span>
                        Project:{" "}
                        {selectedTest?.projectId ??
                          "From fixture project_id; otherwise unavailable"}
                      </span>
                      <span>
                        {selectedTest?.location?.hostId ?? p?.config.hostId} ·{" "}
                        {selectedTest?.location?.root ?? p?.config.root}/
                        {selectedTest?.path}
                      </span>
                    </div>
                    <div className="mr-source-heading">
                      {dirty ? "Draft source" : "Saved test"}
                      <span>Markdown</span>
                    </div>
                    <Suspense
                      fallback={
                        <textarea
                          aria-label="Test source"
                          value={current}
                          onChange={(e) => edit(e.target.value)}
                        />
                      }
                    >
                      <CodeEditor
                        label="Test source"
                        value={current}
                        onChange={edit}
                      />
                    </Suspense>
                  </div>
                  <section
                    className="mr-results"
                    aria-label="Selected test results"
                  >
                    <button
                      className="mr-primary"
                      disabled={busy || !p || relevant || !selectedTest?.enabled || selectedTest.missing || !!selectedTest.error || run?.quiescent === false}
                      aria-describedby={relevant ? "mr-draft-reason" : undefined}
                      onClick={() => void action("startSuite", {
                        requestId: crypto.randomUUID(), basis: snapshot!.basis,
                        hasRelevantDrafts: relevant,
                        selectedOccurrenceIds: [selectedTest!.occurrenceId],
                      })}
                    >▶ Test selected</button>
                    <div className={"mr-result-summary mr-tone-" + resultTone}>
                      <h2>
                        <span aria-hidden="true">
                          {dirty
                            ? "✎"
                            : stale
                              ? "◷"
                              : result?.status === "pass"
                                ? "✓"
                                : result?.status === "fail" ||
                                    result?.status === "error" ||
                                    selectedTest?.error
                                  ? "⊗"
                                  : "?"}
                        </span>{" "}
                        {dirty
                          ? "Draft · not tested"
                          : stale
                            ? "Stale result"
                            : result
                              ? `${relevant ? "Saved · " : ""}${statusLabel[result.status]}`
                              : selectedTest?.error
                                ? "Error"
                                : "Not tested"}
                      </h2>
                      <p>
                        {dirty
                          ? "Results below belong to the saved source. Save or discard this draft before Test."
                          : stale
                            ? run?.frozen.version !== VERSION
                              ? `Evaluator version changed from ${run?.frozen.version} to ${VERSION}. These historical results have not been re-evaluated.`
                              : "Saved inputs have changed. These results belong to the previous run."
                            : (selectedTest?.error ??
                              result?.reason ??
                              "Run Test to evaluate the saved source.")}
                      </p>
                      {stale && !dirty && selectedTest?.error && (
                        <p role="alert" className="mr-current-error">
                          {selectedTest.error}
                        </p>
                      )}
                      {stale && !dirty && result && (
                        <p className="mr-previous-result">
                          Previous run · {statusLabel[result.status]}
                          <br />
                          {result.reason}
                        </p>
                      )}
                    </div>
                    {result?.evaluation && (
                      <>
                        <div className="mr-scope-results">
                          {result.evaluation.groups?.map((g) => (
                            <p className="mr-scope-result" key={g.id}>
                              <span aria-hidden="true">
                                {g.status === "in-scope" ? "◎" : "−"}
                              </span>{" "}
                              {g.title} ·{" "}
                              {
                                {
                                  "in-scope": "In scope",
                                  "outside-scope": "Outside scope",
                                  disabled: "Disabled",
                                  "scope-unavailable": "Scope unavailable",
                                }[g.status]
                              }
                            </p>
                          ))}
                        </div>
                        {result.evaluation.route && (
                          <p className="mr-note">
                            Delivery preference: {{ proceed: "Proceed · requested mode and time preserved", steer: "Steer", queue: "Queue", "queue-batched": "Queue batched" }[result.evaluation.route.action]}
                          </p>
                        )}
                        {result.evaluation.policy === "unknown" && result.evaluation.advice.length > 0 && (
                          <p className="mr-note">Known causes and advice below are incomplete while other checks remain unresolved.</p>
                        )}
                        <section
                          className="mr-result-card"
                          aria-label="Rule results"
                        >
                          <h3>Rule results</h3>
                          <table>
                            <tbody>
                              {result.evaluation.rules.map((r) => (
                                <tr key={r.id}>
                                  <th scope="row">{r.title}</th>
                                  <td>
                                    <span
                                      className={
                                        "mr-rule-verdict mr-verdict-" + r.status
                                      }
                                    >
                                      {r.status === "not-applicable"
                                        ? "Not applicable"
                                        : r.status === "unknown"
                                          ? "Unresolved"
                                          : r.status === "reject"
                                            ? "Rejected"
                                            : "Allowed"}
                                    </span>
                                  </td>
                                  <td>
                                    <button
                                      className="mr-link"
                                      onClick={() => select("rule", r.id)}
                                    >
                                      Open
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </section>
                        <section
                          className="mr-result-card mr-advice-card"
                          aria-label="Advice"
                        >
                          <h3>Advice</h3>
                          {result.evaluation.advice.length ? (
                            result.evaluation.advice.map((a) => (
                              <p key={a.ruleIds.join(",")}>{a.text}</p>
                            ))
                          ) : (
                            <p className="mr-note">None returned.</p>
                          )}
                        </section>
                        <details className="mr-observations">
                          <summary>Observations</summary>
                          <pre>
                            {JSON.stringify(result.evaluation, null, 2)}
                          </pre>
                        </details>
                      </>
                    )}
                  </section>
                </div>
              )}
            </>
          ) : (
            <div className="mr-empty">
              <h2>
                {p && legacyProjectId && selectedType && id === null
                  ? "This legacy link is unavailable"
                  : p
                    ? "Select a group, rule or saved test"
                    : "Loading shared rule groups…"}
              </h2>
              <p>
                {p && legacyProjectId && selectedType && id === null
                  ? `No ${selectedType} mapping exists for ${legacyProjectId} / ${rawId}. Choose an item from the shared catalog.`
                  : "All groups are shared. A group’s scope can restrict projects. Select a group or child rule to see its tests."}
              </p>
              {!p && (
                <button
                  className="mr-link"
                  onClick={() => setConnectionOpen(true)}
                >
                  Set up Message Rules
                </button>
              )}
            </div>
          )}
        </section>
      </div>
      {run?.status === "running" && (
        <button
          className="mr-cancel"
          onClick={() => void action("cancelSuite", { runId: run.id })}
        >
          Cancel run
        </button>
      )}
      <span className="mr-sr" role="status" aria-live="polite">
        {run && run.status !== "running"
          ? `Test ${run.status}. ${pass} of ${total} passed.`
          : ""}
      </span>
      {adding && (
        <Modal
          label={
            adding === "group"
              ? "Add group"
              : adding === "rule"
                ? "Add rule"
                : "Add test"
          }
          close={() => setAdding(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!p) return;
              const id = addName
                .toLowerCase()
                .replace(/\.md$/, "")
                .replace(/[^a-z0-9-]/g, "-");
              if (!/^[a-z][a-z0-9-]{0,79}$/.test(id)) {
                setAddError("Use a name beginning with a letter.");
                return;
              }
              if (
                (adding === "group" && p.groups.some((g) => g.id === id)) ||
                (adding === "rule" && p.rules.some((r) => r.id === id))
              ) {
                setAddError(
                  "This ID already exists. Choose another name; saved items were not changed.",
                );
                return;
              }
              const creation =
                adding === "group"
                  ? action(
                      "saveGroup",
                      {
                        revision: p.revision,
                        group: {
                          ...newGroup(id),
                          title: addName,
                          order: p.groups.length,
                          match: { kind: "all", children: [] },
                        },
                      },
                      "add",
                    )
                  : adding === "rule"
                    ? action(
                        "saveRule",
                        {
                          revision: p.revision,
                          rule: {
                            ...newRule(id, contextGroup?.id ?? p.groups[0]!.id),
                            title: addName,
                            order: p.rules.length,
                          },
                        },
                        "add",
                      )
                    : action(
                        "saveFile",
                        {
                          groupId: contextGroupId,
                          path: id + ".md",
                          source: fixtureTemplate(id),
                          hash: null,
                          location: creationLocation,
                        },
                        "add",
                      );
              void creation.then((next) => {
                if (!next) return;
                if (adding === "test" && !next.savedOccurrenceId) {
                  setAddError("Test was saved but its exact identity is unavailable. Refresh before continuing; do not create it again.");
                  return;
                }
                setAddError(null);
                setAdding(null);
                select(
                  adding === "group"
                    ? "group"
                    : adding === "rule"
                      ? "rule"
                      : "test",
                  adding === "test" ? next.savedOccurrenceId! : id,
                );
              });
            }}
          >
            <h2>
              {adding === "group"
                ? "Add group"
                : adding === "rule"
                  ? "Add rule"
                  : "Add test"}
            </h2>
            <label>
              Name{" "}
              <input
                autoFocus
                required
                value={addName}
                onChange={(e) => {
                  setAddName(e.target.value);
                  setAddError(null);
                }}
              />
            </label>
            {(addError || writeError?.dialog === "add") && (
              <p role="alert" className="mr-error">
                {addError ?? writeError?.message}
              </p>
            )}
            <div className="mr-inline">
              <button type="button" onClick={() => setAdding(null)}>
                Cancel
              </button>
              <button className="mr-primary" disabled={busy}>
                Add
              </button>
            </div>
          </form>
        </Modal>
      )}
      {connectionOpen && (
        <ConnectionDialog
          snapshot={snapshot}
          projectId={projectId}
          error={
            writeError?.dialog === "connection" ? writeError.message : null
          }
          close={() => setConnectionOpen(false)}
          save={async (values) => {
            const next = await action("configure", values, "connection");
            if (next) setConnectionOpen(false);
          }}
        />
      )}
    </div>
  );
}
function InboxRow({
  name,
  selected,
  enabled,
  kind,
  status,
  onSelect,
  onToggle,
  disabled,
}: {
  name: string;
  selected: boolean;
  enabled: boolean;
  kind: string;
  status?: string;
  onSelect: () => void;
  onToggle: () => void;
  disabled: boolean;
}) {
  return (
    <div
      className={"mr-row" + (selected ? " mr-selected" : "")}
      data-enabled={enabled}
    >
      <button
        className="mr-row-select"
        onClick={onSelect}
        aria-current={selected ? "page" : undefined}
      >
        {kind === "test" && (
          <span
            className={"mr-status mr-status-" + status}
            aria-label={status}
            title={status}
          >
            {status === "pass"
              ? "✓"
              : status === "fail" || status === "error"
                ? "⊗"
                : status === "unknown"
                  ? "?"
                  : status === "stale"
                    ? "◷"
                    : status === "draft"
                      ? "✎"
                      : "−"}
          </span>
        )}
        <span>{name}</span>
      </button>
      <button
        role="switch"
        aria-checked={enabled}
        aria-label={"Enable " + name}
        className="mr-switch"
        disabled={disabled}
        onClick={onToggle}
      >
        <span />
      </button>
    </div>
  );
}
function ConnectionDialog({
  snapshot,
  projectId,
  close,
  save,
  error,
}: {
  snapshot: Snapshot | null;
  projectId: string | null;
  close: () => void;
  save: (v: Record<string, unknown>) => Promise<void>;
  error: string | null;
}) {
  const [host, setHost] = useState(snapshot?.project?.config.hostId ?? ""),
    [root, setRoot] = useState(snapshot?.project?.config.root ?? ""),
    [config, setConfig] = useState(
      snapshot?.project?.config.connection ?? defaultConnection,
    );

  return (
    <Modal label="JEV connection" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save({
            revision: snapshot?.project?.revision ?? null,
            hostId: host,
            root,
            connection: config,
          });
        }}
      >
        <h2>JEV connection</h2>
        <p>
          {snapshot?.connection.mode === "injected"
            ? "Controlled test transport is active."
            : snapshot?.connection.source === "shared"
              ? `Shared JEV owner: ${snapshot.connection.ownerPluginId}. ${snapshot.connection.reason ?? ""}`
              : snapshot?.connection.configured
                ? "Dedicated Message Rules override is configured."
                : "Dedicated override has no key. Select Topics shared connection or configure the explicit override in Settings → Plugins → Message Rules."}
        </p>
        {!snapshot?.connection.tokenAccounting && (
          <p>
            Context fit is checked by JEV. Byte and call limits are engineering
            bounds, not exact token counts. An over-limit response is unresolved
            and may incur spend; no automatic retry.
          </p>
        )}
        <label>
          Host ID{" "}
          <input
            autoFocus
            required
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </label>
        <label>
          Test directory{" "}
          <input
            required
            placeholder="/absolute/project/.bb/message-rules/tests"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
          />
        </label>
        <label>
          Model{" "}
          <select
            value={config.model}
            onChange={(e) =>
              setConfig({
                ...config,
                model: e.target.value as typeof config.model,
              })
            }
          >
            <option>jev-1.14.0</option>
            <option>jev-1.13.0</option>
          </select>
        </label>
        <details>
          <summary>Run limits</summary>
          {(
            [
              "maxCalls",
              "maxWireBytes",
              "timeoutMs",
              "maxResponseBytes",
            ] as const
          ).map((k) => (
            <label key={k}>
              {k}
              <input
                type="number"
                min={1}
                value={config[k]}
                onChange={(e) =>
                  setConfig({ ...config, [k]: Number(e.target.value) })
                }
              />
            </label>
          ))}
        </details>
        <p className="mr-note">
          Saved files use hash-guarded replacement. An arbitrary external editor
          can still race a save. No live inference quality or cost has been
          measured.
        </p>
        <p className="mr-note">{snapshot?.delivery.reason}</p>
        {error && (
          <p role="alert" className="mr-error">
            {error}
          </p>
        )}
        <div className="mr-inline">
          <button type="button" onClick={close}>
            Close
          </button>
          <button className="mr-primary" disabled={!projectId}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Modal({
  label,
  close,
  children,
}: {
  label: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="mr-dialog"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // Keep both halves of Escape inside the modal; host keyup shortcuts
          // must not act on the restored opener after native cancel closes it.
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      {children}
    </dialog>
  );
}
