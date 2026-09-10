import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROBE_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE_ROOT = resolve(PROBE_ROOT, "../../../../../../..");

/**
 * A source-only feasibility probe. It never opens BB operational storage, makes
 * no SDK request, and deliberately records absent guarantees as unsupported.
 */
const SOURCE_FILES = {
  threadSdk: "fork/build/bb/packages/sdk/src/areas/threads.ts",
  threadContract: "fork/build/bb/packages/server-contract/src/api/threads.ts",
  threadRoute: "fork/build/bb/apps/server/src/routes/threads/base.ts",
  eventRoute: "fork/build/bb/apps/server/src/routes/threads/data.ts",
  threadData: "fork/build/bb/packages/db/src/data/threads.ts",
  entityLookup: "fork/build/bb/apps/server/src/services/lib/entity-lookup.ts",
  dbEvents: "fork/build/bb/packages/db/src/data/events.ts",
  internalEvents: "fork/build/bb/apps/server/src/internal/events.ts",
  threadEvents: "fork/build/bb/apps/server/src/services/threads/thread-events.ts",
  changeKinds: "fork/build/bb/packages/domain/src/change-kinds.ts",
  sdkResponse: "fork/build/bb/packages/sdk/src/response.ts",
  pluginApi: "fork/build/bb/apps/server/src/services/plugins/plugin-api.ts",
  analyticsServer: "community-plugins/plugins/analytics/server.ts",
  identityBinding: "plugins/packages/bb-identity/bb.d.ts",
};

function evidence(id, status, detail) {
  return { id, status, detail };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function gitRevision(root) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], {
      timeout: 2_000,
      maxBuffer: 1_024,
    });
    return stdout.trim() || "unavailable";
  } catch {
    return "unavailable";
  }
}

async function readSources(workspaceRoot) {
  const result = {};
  const failures = [];
  await Promise.all(Object.entries(SOURCE_FILES).map(async ([name, relativePath]) => {
    try {
      const text = await readFile(resolve(workspaceRoot, relativePath), "utf8");
      result[name] = { relativePath, sha256: sha256(text), text };
    } catch {
      failures.push(name);
    }
  }));
  return { failures, result };
}

function has(text, expression) {
  return expression.test(text);
}

/**
 * This deterministic in-memory fixture is deliberately not an SDK test. It
 * uses synthetic IDs and sequence numbers only, never a BB thread or event.
 * It makes the reconciliation policy falsifiable: the correct strategy must
 * reach the fixture's quiescent retained set, while two intentionally broken
 * strategies must not.
 */
function runReconciliationControls() {
  const cloneEvents = (events) => new Map(
    [...events].map(([id, sequences]) => [id, [...sequences]]),
  );
  const equalEventSets = (left, right) => JSON.stringify(
    [...left].sort(([a], [b]) => a.localeCompare(b)),
  ) === JSON.stringify([...right].sort(([a], [b]) => a.localeCompare(b)));
  const summarize = (events) => ({
    threadCount: events.size,
    eventCount: [...events.values()].reduce((sum, sequences) => sum + sequences.length, 0),
    digest: sha256(JSON.stringify([...events].sort(([a], [b]) => a.localeCompare(b)))),
  });

  function createSource() {
    let members = new Set(["synthetic-alpha", "synthetic-beta", "synthetic-gamma"]);
    let events = new Map([
      ["synthetic-alpha", [1, 2]],
      ["synthetic-beta", [1]],
      ["synthetic-gamma", [1]],
    ]);
    let afterList = null;
    let genericGetFailures = new Set();
    const calls = { list: 0, eventRead: 0, directGet: 0, fullReread: 0 };
    return {
      calls,
      list({ limit, offset }) {
        calls.list += 1;
        const page = [...members].sort().slice(offset, offset + limit);
        const hook = afterList;
        afterList = null;
        hook?.();
        return page;
      },
      events(id, { afterSeq }) {
        calls.eventRead += 1;
        return [...(events.get(id) ?? [])].filter((sequence) => sequence > afterSeq);
      },
      fullEvents(id) {
        calls.eventRead += 1;
        calls.fullReread += 1;
        return [...(events.get(id) ?? [])];
      },
      get(id) {
        calls.directGet += 1;
        if (genericGetFailures.delete(id)) return { kind: "generic-error" };
        if (!members.has(id)) return { code: "thread_not_found", kind: "not-found", status: 404 };
        return { kind: "ok" };
      },
      setMembers(next) { members = new Set(next); },
      setEvents(id, sequences) { events.set(id, [...sequences]); },
      setAfterList(hook) { afterList = hook; },
      failNextGet(id) { genericGetFailures.add(id); },
      snapshot() { return cloneEvents(new Map([...events].filter(([id]) => members.has(id)))); },
    };
  }

  function runSweep({ source, state, strategy, signals, directChecks }) {
    const listed = new Set();
    const listLimit = 1;
    let offset = 0;
    for (let page = 0; page < 8; page += 1) {
      const ids = source.list({ limit: listLimit, offset });
      for (const id of ids) listed.add(id);
      if (ids.length < listLimit) break;
      offset += ids.length;
    }
    if (strategy === "omission-delete") {
      for (const id of state.events.keys()) {
        if (!listed.has(id)) {
          state.events.delete(id);
          state.omissionTombstones.add(id);
        }
      }
    }
    for (const id of listed) {
      if (strategy === "omission-delete" && state.omissionTombstones.has(id)) continue;
      const prior = state.events.get(id) ?? [];
      const signal = signals.get(id);
      if (signal === "history-rewritten" && strategy !== "delta-only") {
        state.events.set(id, source.fullEvents(id));
      } else {
        const afterSeq = prior.at(-1) ?? 0;
        const tail = source.events(id, { afterSeq });
        state.events.set(id, [...prior, ...tail]);
      }
    }
    for (const id of directChecks) {
      const result = source.get(id);
      if (result.kind === "not-found" && result.status === 404 && result.code === "thread_not_found") {
        state.events.delete(id);
      }
    }
  }

  function runScenario(strategy) {
    const source = createSource();
    const state = { events: new Map(), omissionTombstones: new Set() };
    // Baseline establishes retained membership and the known high sequences.
    runSweep({ source, state, strategy, signals: new Map(), directChecks: [] });

    // A normal append is cheaply caught up using afterSeq before the rewrite.
    source.setEvents("synthetic-alpha", [1, 2, 3]);
    runSweep({
      source,
      state,
      strategy,
      signals: new Map([["synthetic-alpha", "events-appended"]]),
      directChecks: [],
    });

    // Between offset pages: beta is temporarily absent, gamma is deleted with
    // an exact not-found, alpha is rewritten, and beta's direct read fails
    // generically. The hook fires after page one was returned.
    source.setAfterList(() => {
      source.setMembers(["synthetic-alpha"]);
      source.setEvents("synthetic-alpha", [1, 2]);
      source.failNextGet("synthetic-beta");
    });
    runSweep({
      source,
      state,
      strategy,
      signals: new Map([["synthetic-alpha", "history-rewritten"]]),
      directChecks: ["synthetic-gamma", "synthetic-beta"],
    });
    const betaSurvivedOmissionAndGenericFailure = state.events.has("synthetic-beta");
    const knownNotFoundRemovedGamma = !state.events.has("synthetic-gamma");

    // The source is now quiescent. A fresh sweep can re-observe beta, unless
    // the deliberately broken omission-delete strategy permanently suppressed it.
    source.setMembers(["synthetic-alpha", "synthetic-beta"]);
    runSweep({ source, state, strategy, signals: new Map(), directChecks: [] });
    return {
      actual: cloneEvents(state.events),
      betaSurvivedOmissionAndGenericFailure,
      calls: source.calls,
      knownNotFoundRemovedGamma,
      expected: source.snapshot(),
    };
  }

  const correct = runScenario("retained-union-full-reread");
  const omissionDelete = runScenario("omission-delete");
  const deltaOnly = runScenario("delta-only");
  const correctMatchesAfterQuiescence = equalEventSets(correct.actual, correct.expected);
  const omissionDeleteMismatchesAfterQuiescence = !equalEventSets(
    omissionDelete.actual,
    omissionDelete.expected,
  );
  const deltaOnlyMismatchesAfterQuiescence = !equalEventSets(deltaOnly.actual, deltaOnly.expected);
  const controls = [
    ["retained-union-converges-after-quiescence", correctMatchesAfterQuiescence],
    ["generic-error-and-omission-preserve-retained-membership", correct.betaSurvivedOmissionAndGenericFailure],
    ["exact-not-found-removes-retained-membership", correct.knownNotFoundRemovedGamma],
    ["negative-omission-delete-mismatches-quiescent-source", omissionDeleteMismatchesAfterQuiescence],
    ["negative-delta-only-rewrite-mismatches-quiescent-source", deltaOnlyMismatchesAfterQuiescence],
  ].map(([id, passed]) => ({ id, passed }));
  return {
    kind: "deterministic-synthetic-source-and-reconciler-not-live-sdk-evidence",
    passed: controls.every((control) => control.passed),
    controls,
    expectedAfterQuiescence: summarize(correct.expected),
    strategies: {
      retainedUnionFullReread: { actual: summarize(correct.actual), calls: correct.calls },
      deliberatelyBrokenOmissionDelete: { actual: summarize(omissionDelete.actual), calls: omissionDelete.calls },
      deliberatelyBrokenDeltaOnly: { actual: summarize(deltaOnly.actual), calls: deltaOnly.calls },
    },
    coverageLabelAfterQuiescence: "reconciled-observed-as-of",
  };
}

/**
 * Return only JSON-safe, redacted source evidence. `workspaceRoot` is useful
 * to a harness that materializes this plugin elsewhere; it defaults to this BB
 * workspace. No caller-supplied SDK client is accepted so this probe cannot
 * accidentally inspect live thread/event contents.
 */
export async function runProbe({ workspaceRoot = DEFAULT_WORKSPACE_ROOT } = {}) {
  const loaded = await readSources(workspaceRoot);
  const source = loaded.result;
  const failures = [...loaded.failures];
  const checks = [];

  const check = (id, condition, detail) => {
    const status = condition ? "observed" : "failure";
    checks.push(evidence(id, status, detail));
    if (!condition) failures.push(id);
  };

  if (loaded.failures.length === 0) {
    check(
      "thread-list-offset-and-scope",
      has(source.threadSdk.text, /archived\?: boolean;[\s\S]*includeHidden\?: boolean;[\s\S]*limit\?: number;[\s\S]*offset\?: number;/)
        && has(source.threadRoute.text, /parseOptionalInteger\(query\.offset, "offset"\)/)
        && has(source.threadData.text, /nonDeletedThreads\(\),[\s\S]*options\.includeHidden \? undefined : eq\(threads\.visibility, "visible"\)/)
        && has(source.threadData.text, /options\.archived === true[\s\S]*options\.archived === false[\s\S]*: undefined/),
      "Public list accepts offset, archived, and includeHidden. With archived omitted and includeHidden true, current source filters non-deleted threads without an archive-state filter.",
    );
    check(
      "thread-event-keyset",
      has(source.threadSdk.text, /afterSeq\?: string;[\s\S]*beforeSeq\?: string;[\s\S]*order\?: "asc" \| "desc"/)
        && has(source.threadSdk.text, /Return only events with a sequence greater than this value/)
        && has(source.eventRoute.text, /afterSeq: parseOptionalInteger\(query\.afterSeq, "afterSeq"\)/),
      "Public event reads expose afterSeq/beforeSeq and order; afterSeq is documented as strictly greater than the supplied sequence.",
    );
    check(
      "current-analytics-caps",
      has(source.analyticsServer.text, /INDEX_THREAD_CANDIDATE_LIMIT = 200/)
        && has(source.analyticsServer.text, /INDEX_THREAD_LIMIT = 80/)
        && has(source.analyticsServer.text, /EVENTS_PER_THREAD_LIMIT = 500/),
      "The current Analytics implementation remains bounded at 200 candidates, 80 selected threads, and 500 events per selected thread.",
    );
    check(
      "thread-change-invalidation-kinds",
      has(source.changeKinds.text, /"events-appended"/)
        && has(source.changeKinds.text, /"history-rewritten"/)
        && has(source.changeKinds.text, /"thread-deleted"/),
      "The public changed-message schema names append, history-rewrite, and deletion invalidations.",
    );
    const daemonAppendBody = source.dbEvents.text.match(
      /export function appendDaemonEventsInTransaction\([\s\S]*?\n}\n\nexport interface CopyStoredThreadEventsArgs/,
    )?.[0] ?? "";
    const applyEffectsBody = source.internalEvents.text.match(
      /async function applyEventEffects\([\s\S]*?\n}\n\nasync function executeEventFollowUpBestEffort/,
    )?.[0] ?? "";
    check(
      "concrete-item-completed-append-does-not-update-thread-updatedat",
      has(source.internalEvents.text, /case "item\/completed":[\s\S]*?return \{ providerThreadId: event\.providerThreadId \};/)
        && has(source.internalEvents.text, /appendDaemonEventsInTransaction\(tx, eventInputs\)/)
        && has(source.internalEvents.text, /notifyThread\(threadId, \["events-appended"\]/)
        && daemonAppendBody.length > 0
        && !daemonAppendBody.includes("update(threads)")
        && applyEffectsBody.length > 0
        && !applyEffectsBody.includes('"item/completed"'),
      "Static reachable path: daemon item/completed is converted to a stored event, appended in one transaction, then publishes events-appended. That append transaction has no thread update/updatedAt write, and the following event-effect switch has no item/completed branch. This proves one source path only, not a global timestamp invariant or runtime observation.",
    );
    const appendBody = source.dbEvents.text.match(
      /export function appendStoredThreadEventsInTransaction\([\s\S]*?\n}\n\nexport function p6rCountDistinctThreadEventActors/,
    )?.[0] ?? "";
    check(
      "stored-append-helper-lacks-updatedat",
      has(source.threadEvents.text, /const changes: ThreadChangeKind\[\] = \["events-appended"\]/)
        && appendBody.length > 0
        && !appendBody.includes("update(threads)"),
      "The stored-event append helper emits events-appended without itself writing thread updatedAt. This helper observation does not establish what every caller does; the separate daemon item/completed check supplies one concrete no-update path.",
    );
    check(
      "deleted-rows-excluded-from-list",
      has(source.threadData.text, /function nonDeletedThreads[\s\S]*isNull\(threads\.deletedAt\)/)
        && has(source.threadData.text, /function buildListThreadsFilters[\s\S]*nonDeletedThreads\(\)/),
      "Current list source deliberately excludes deleted rows; omission is therefore ambiguous during pagination and may not be treated as a deletion witness.",
    );
    check(
      "identity-public-admission-availability",
      has(source.identityBinding.text, /export declare function bindBbIdentity\(bb: BbIdentityApi/) 
        && has(source.identityBinding.text, /background<T>\(run:/)
        && has(source.identityBinding.text, /Capability absence[\s\S]*stable upstream singleton/),
      "The public identity package exposes bindBbIdentity and a background invocation, but it does not add a thread-history admission or snapshot API.",
    );
    check(
      "direct-get-server-not-found-semantics",
      has(source.threadRoute.text, /get\(routes\.get[\s\S]*requirePublicThread/) 
        && has(source.entityLookup.text, /thread\.deletedAt !== null \|\| project\?\.deletedAt !== null[\s\S]*ApiError\(404, "thread_not_found"/),
      "Server source maps a public get of a deleted thread (or a thread in a deleted project) to HTTP 404/thread_not_found.",
    );
    check(
      "sdk-transport-preserves-not-found-status-and-code",
      has(source.sdkResponse.text, /export class BbHttpError extends Error[\s\S]*readonly code: string \| null;[\s\S]*readonly status: number;/)
        && has(source.sdkResponse.text, /throw new BbHttpError\(\{ body, code, message, status: response\.status \}\)/)
        && has(source.pluginApi.text, /async get\(args\): Promise<ThreadGetResult> \{[\s\S]*return registerThreadTarget\(await sdk\.threads\.get\(args\)\);/),
      "Public SDK transport throws BbHttpError carrying status and code on non-2xx responses. The plugin SDK wrapper awaits get and only registers a successful target, so current source does not remap that rejection. A caller can conservatively recognize the structural 404/thread_not_found shape; all other errors remain non-deletion failures.",
    );
  }

  const syntheticControls = runReconciliationControls();
  if (!syntheticControls.passed) failures.push("synthetic-reconciliation-controls");

  const revisions = {
    workspace: await gitRevision(workspaceRoot),
    communityPlugins: await gitRevision(resolve(workspaceRoot, "community-plugins")),
    fork: await gitRevision(resolve(workspaceRoot, "fork")),
    forkUpstream: await gitRevision(resolve(workspaceRoot, "fork/upstream")),
    plugins: await gitRevision(resolve(workspaceRoot, "plugins")),
  };
  const unavailableRevisions = Object.entries(revisions)
    .filter(([, revision]) => revision === "unavailable")
    .map(([name]) => name);
  if (unavailableRevisions.length > 0) {
    failures.push("git-revision-evidence");
    checks.push(evidence(
      "git-revision-evidence",
      "failure",
      `Cannot cite source revision(s): ${unavailableRevisions.join(", ")}.`,
    ));
  } else {
    checks.push(evidence(
      "git-revision-evidence",
      "observed",
      "All workspace, fork, upstream, community-plugin, and identity-package revisions are available for this evidence run.",
    ));
  }

  const sourceFiles = Object.fromEntries(Object.entries(source).map(([name, item]) => [name, {
    path: item.relativePath,
    sha256: item.sha256,
  }]));

  return {
    schemaVersion: 1,
    probe: "analytics-source-feasibility",
    mode: "static-source-only",
    status: failures.length === 0 ? "observed-with-unsupported-gaps" : "failure",
    safeScope: {
      liveSdkReads: "not-run",
      operationalStorage: "not-opened",
      rawThreadOrEventContent: "not-collected",
    },
    revisions,
    sourceFiles,
    checks,
    syntheticControls,
    supported: [
      {
        capability: "bounded eventual thread enumeration",
        evidence: "A caller can page public list(offset, limit) with archived omitted and includeHidden true. The current source includes non-deleted active and archived threads, including hidden threads, but no deleted rows.",
      },
      {
        capability: "bounded eventual event catch-up",
        evidence: "A caller can read ascending event pages using afterSeq. A page limit is caller-controlled; a bounded run must stop at its own page/event budget and report incomplete coverage rather than claim completion.",
      },
      {
        capability: "conservative invalidation",
        evidence: "The public changed-message schema distinguishes events-appended, history-rewritten, and thread-deleted. A concrete daemon item/completed append path writes an event and emits events-appended without a companion thread updatedAt mutation. Treat changed messages as refresh triggers, never as a replay log or proof of a complete delta.",
      },
      {
        capability: "conservative public not-found confirmation",
        evidence: "Current server source returns 404/thread_not_found for deleted-thread or deleted-project public get. SDK transport throws BbHttpError with status/code and the plugin wrapper preserves the get rejection. Only that exact structural 404/thread_not_found case may be considered a deletion-confirmation candidate; admission changes and all other failures preserve retained facts.",
      },
      {
        capability: "eventual retained-history reconciliation after quiescence",
        evidence: "A demand-triggered, repeated full enumeration plus full per-thread rereads can converge after source churn stops, provided each finished sweep is recorded with scope, page/event budgets, as-of time, and incomplete/degraded status.",
      },
    ],
    unsupported: [
      {
        capability: "strict point-in-time complete thread enumeration",
        reason: "The list response is an array and exposes offset, not a stable snapshot token, cursor, total, or as-of watermark. Inserts, updates that change ordering, archive-state changes, and deletion between pages can create duplicates or gaps.",
      },
      {
        capability: "strict point-in-time complete event enumeration",
        reason: "afterSeq is a forward keyset, but no immutable per-thread snapshot/high-watermark accompanies a page. A bounded reader can race appends and history rewrites, so it must retain an incomplete/retryable state until a later quiescent sweep converges.",
      },
      {
        capability: "safe deletion from list omission or generic SDK failure",
        reason: "List source excludes deleted rows, and paging races can omit rows. Source proves server-side deleted rows are excluded; it does not make omission, abort, authorization failure, or an untyped SDK rejection a deletion proof.",
      },
      {
        capability: "incremental rewind repair from a cursor",
        reason: "history-rewritten is an invalidation kind, not a public old/new sequence mapping or replay cursor. Repair requires a successful full reread and atomic replacement of that thread's projected facts; otherwise preserve the prior facts and report degraded coverage.",
      },
      {
        capability: "updatedAt as a complete event-history invariant",
        reason: "A concrete daemon item/completed append path does not update the thread timestamp, while other callers may. That disproves a universal append-to-updatedAt invariant for this source path; it also does not establish a full global mutation/delete/rewind invariant. Use updatedAt only as an optimization hint, never correctness evidence.",
      },
      {
        capability: "unambiguous deletion under admission or transport races",
        reason: "The exact public 404/thread_not_found transport shape is source-supported, but the same outcome can arise when a project is deleted and cannot distinguish a subsequent re-admission/visibility change. Never infer deletion from omission, 403/401, timeout, abort, generic 404, or an unrecognized rejection; retain and label pending reconciliation.",
      },
    ],
    feasibleAlgorithm: {
      kind: "demand-triggered-eventual-reconciliation",
      steps: [
        "Begin a run with immutable scope, page/event budgets, started-at time, and an explicit incomplete status.",
        "Enumerate list pages with archived omitted and includeHidden true. Deduplicate returned identifiers only within the run; do not delete retained membership when a row is absent.",
        "For each observed thread, use updatedAt only to prioritize. On events-appended or ordinary uncertainty, first attempt a bounded ascending afterSeq read from the retained high sequence; meter SDK calls and response bytes as well as returned events. On history-rewritten, perform a bounded full reread from the beginning and atomically replace that thread's facts only after the reread succeeds.",
        "On an explicit thread-deleted notification, mark local facts pending deletion and confirm only through the exact public 404/thread_not_found transport shape, while preserving admission-race ambiguity. On any omitted row, abort, authorization issue, generic 404, or unrecognized read failure, preserve good facts and mark the run degraded.",
        "Repeat bounded full sweeps only when Analytics is demanded or an explicit refresh/reconciliation policy requests one. A sweep cannot prove absence of churn: when all declared reads succeed, publish reconciled-observed-as-of coverage with its scope, time, budgets, and reconciliation count; otherwise publish partial or degraded coverage.",
      ],
      costLimits: [
        "Each sweep is O(number of list pages plus reread event pages); it must cap pages, threads, event pages, bytes, concurrency, and wall time.",
        "History-rewritten forces an O(events in that thread) reread. A periodic full reread can converge without new SDK work, but it is a freshness/cost choice and must not run while the surface is unused.",
      ],
    },
    limitations: [
      "This is source inspection plus a synthetic algorithm control, not a live SDK observation. It does not prove deployed admission, transport error shapes, realtime delivery/reconnect behavior, actual pagination limits, or absence of churn during a completed sweep.",
      "No raw event contents, identifiers, SQLite data, thread fixtures, or mutations were used.",
      "A new snapshot/cursor/deletion-tombstone contract is required only for strict point-in-time completeness or efficient exact rewind/delete deltas; it is not required for the disclosed eventual-convergence algorithm above.",
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runProbe();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === "failure" ? 1 : 0;
}
