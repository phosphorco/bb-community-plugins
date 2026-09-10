import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

import {
  DEFAULT_LOADER_MAX_AGE_MS,
  analyticsBundleSchema,
  parseBundleSource,
  validateBundleQueries,
  type AnalyticsBundle,
} from "./bundle-contract.ts";
import { BUILTIN_BUNDLES, getBuiltinBundle } from "./builtin-bundles.ts";
import { verifyAnalyticsBundle } from "./analytics-verifier.ts";
import { collectTurnTimings, FACT_PROJECTION_VERSION, projectToolExecutionFact, type ToolExecutionFact } from "./fact-projection.ts";
import { renderAnalyticsReference, type CreateAnalyticsReference } from "./analytics-reference.ts";
import { rpcContract } from "./rpc-contract.ts";
import {
  AnalyticsRefreshCoordinator,
  AnalyticsStore,
  analyticsMigrations,
  type AnalyticsThreadReconciliation,
} from "./store.ts";

const INDEX_THREAD_CANDIDATE_LIMIT = 200;
const INDEX_THREAD_LIMIT = 80;
const EVENTS_PER_THREAD_LIMIT = 500;
const INDEX_CONCURRENCY = 4;
const FULL_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_AGE_MS = DEFAULT_LOADER_MAX_AGE_MS;
const require = createRequire(import.meta.url);
const DUCKDB_WASM_PATH = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm");
const DUCKDB_WORKER_PATH = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js");
const DUCKDB_EH_WASM_PATH = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm");
const DUCKDB_EH_WORKER_PATH = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js");

type ListedThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function bundleSummary(bundle: AnalyticsBundle, builtin: boolean) {
  return { id: bundle.id, title: bundle.title, description: bundle.description, builtin };
}

function maxAgeFor(bundle: AnalyticsBundle | null): number {
  const candidate = (bundle?.loader as AnalyticsBundle["loader"] & { maxAgeMs?: unknown }).maxAgeMs;
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? Math.trunc(candidate)
    : DEFAULT_MAX_AGE_MS;
}

function servesStaleWhileRefresh(bundle: AnalyticsBundle | null): boolean {
  return bundle?.loader.staleWhileRefresh ?? true;
}

export default function analyticsPlugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...analyticsMigrations]);
  const store = new AnalyticsStore(db);
  let activeRefreshController: AbortController | null = null;
  let disposed = false;

  const allBundles = () => [
    ...BUILTIN_BUNDLES.map((bundle) => bundleSummary(bundle, true)),
    ...store.listBundles().map((bundle) => bundleSummary(bundle, false)),
  ];

  const bundleById = (id: string): { bundle: AnalyticsBundle; builtin: boolean } | null => {
    const builtin = getBuiltinBundle(id);
    if (builtin != null) return { bundle: builtin, builtin: true };
    const stored = store.getBundle(id);
    return stored == null ? null : { bundle: stored, builtin: false };
  };

  const saveBundle = (bundle: AnalyticsBundle) => {
    if (getBuiltinBundle(bundle.id) != null) throw new Error(`The built-in bundle id ${bundle.id} is reserved.`);
    validateBundleQueries(bundle);
    store.saveBundle(bundle);
    bb.realtime.publish("analytics-bundles-changed", { id: bundle.id, action: "saved" });
    return bundleSummary(bundle, false);
  };

  const verifyBundles = async (id?: string) => {
    const candidates = id == null
      ? [...BUILTIN_BUNDLES, ...store.listBundles()]
      : [bundleById(id)?.bundle ?? (() => { throw new Error(`Unknown bundle: ${id}`); })()];
    return Promise.all(candidates.map((bundle) => verifyAnalyticsBundle(bundle)));
  };

  const createReference = (input: CreateAnalyticsReference) => {
    const selected = bundleById(input.bundleId);
    if (selected == null) throw new Error(`Unknown analytics bundle: ${input.bundleId}`);
    const query = selected.bundle.queries.find((candidate) => candidate.id === input.queryId);
    const visualization = selected.bundle.visualizations.find((candidate) => candidate.id === input.visualizationId);
    if (query == null || visualization == null || visualization.queryId !== query.id) {
      throw new Error("The referenced Analytics query or visualization no longer exists.");
    }
    const currentGeneration = store.getIndexState().generationId;
    if (input.snapshotGenerationId != null && input.snapshotGenerationId > currentGeneration) {
      throw new Error("The referenced Analytics snapshot is not available on this host.");
    }
    let selection = input.selection;
    if (selection != null) {
      if (visualization.kind !== "bar" && visualization.kind !== "line") {
        throw new Error("Datum references require a chart visualization.");
      }
      if (new Set(["source_event_id", "thread_id", "turn_id", "project_id"]).has(visualization.x)) {
        throw new Error("Direct event, thread, turn, and project identifiers cannot be attached to chat.");
      }
      const dimension = selection.row[visualization.x] ?? null;
      if (selection.predicate.field !== visualization.x
        || selection.predicate.value !== dimension) {
        throw new Error("The selected datum does not match the visualization binding.");
      }
      selection = {
        ...selection,
        row: {
          [visualization.x]: dimension,
          [visualization.y]: selection.row[visualization.y] ?? null,
        },
      };
    }
    const id = randomUUID();
    const token = `analytics-ref:v1:${id}`;
    const capsule = {
      ...input,
      selection,
      version: 1 as const,
      id,
      token,
      createdAt: Date.now(),
      bundleTitle: selected.bundle.title,
      queryTitle: query.title,
      querySql: query.sql,
      visualizationTitle: visualization.title,
      visualizationKind: visualization.kind,
    };
    store.saveReference(capsule);
    return { id, token, label: input.selection?.label ?? visualization.title };
  };

  const referenceId = (tokenOrId: string): string => tokenOrId.startsWith("analytics-ref:v1:")
    ? tokenOrId.slice("analytics-ref:v1:".length)
    : tokenOrId;

  const resolveReference = (tokenOrId: string) => {
    const capsule = store.getReference(referenceId(tokenOrId));
    if (capsule == null) throw new Error("This Analytics reference no longer exists.");
    return capsule;
  };

  const listCandidates = async (signal: AbortSignal): Promise<ListedThread[]> => {
    const threads = await bb.sdk.threads.list({
      archived: false,
      includeHidden: true,
      limit: INDEX_THREAD_CANDIDATE_LIMIT,
      signal,
    });
    return [...threads];
  };

  const runRefresh = async (force: boolean): Promise<void> => {
    const controller = new AbortController();
    activeRefreshController = controller;
    const signal = controller.signal;
    const startedAt = Date.now();
    const profileStartedAt = performance.now();
    let candidateListMs = 0;
    let eventFetchMs = 0;
    let projectionMs = 0;
    let eventsRead = 0;
    store.markIndexing(startedAt);
    bb.realtime.publish("analytics-index-changed", store.getIndexState());
    try {
      const prior = new Map(store.listThreadStates().map((thread) => [thread.threadId, thread]));
      const indexState = store.getIndexState();
      const shouldReconcileFully = force || indexState.factProjectionVersion < FACT_PROJECTION_VERSION
        || indexState.lastFullReconciliationAt == null
        || startedAt - (indexState.lastFullReconciliationAt ?? 0) >= FULL_RECONCILIATION_INTERVAL_MS;
      const candidateStartedAt = performance.now();
      const listed = await listCandidates(signal);
      candidateListMs = performance.now() - candidateStartedAt;
      const selected = listed
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, INDEX_THREAD_LIMIT);
      const reconciliations: AnalyticsThreadReconciliation[] = [];
      const pending = selected.filter((thread) =>
        force || shouldReconcileFully || prior.get(thread.id)?.updatedAt !== thread.updatedAt,
      );

      for (let offset = 0; offset < pending.length && !signal.aborted; offset += INDEX_CONCURRENCY) {
        const batch = pending.slice(offset, offset + INDEX_CONCURRENCY);
        const fetchStartedAt = performance.now();
        const results = await Promise.allSettled(batch.map((thread) => bb.sdk.threads.events.list({
          threadId: thread.id,
          types: ["item/completed", "turn/started", "turn/completed"],
          order: "desc",
          limit: String(EVENTS_PER_THREAD_LIMIT),
          signal,
        })));
        eventFetchMs += performance.now() - fetchStartedAt;
        const projectionStartedAt = performance.now();
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index];
          const thread = batch[index] as ListedThread | undefined;
          if (thread == null) continue;
          if (result?.status !== "fulfilled") {
            const message = result?.status === "rejected" ? errorText(result.reason) : "Analytics could not read this thread.";
            bb.log.warn(`Analytics could not inspect ${thread.id}: ${message}`);
            reconciliations.push({
              threadId: thread.id,
              projectId: thread.projectId,
              providerId: thread.providerId,
              updatedAt: thread.updatedAt,
              outcome: "failed",
              error: message,
            });
            continue;
          }
          const events = result.value;
          eventsRead += events.length;
          const facts: ToolExecutionFact[] = [];
          const turnTimings = collectTurnTimings(events);
          for (const event of events) {
            const fact = projectToolExecutionFact(event, {
              projectId: thread.projectId,
              providerId: thread.providerId,
            }, turnTimings);
            if (fact != null) facts.push(fact);
          }
          reconciliations.push({
            threadId: thread.id,
            projectId: thread.projectId,
            providerId: thread.providerId,
            updatedAt: thread.updatedAt,
            outcome: "loaded",
            facts,
            maxObservedSeq: events.reduce<number | null>((max, event) => max == null ? event.seq : Math.max(max, event.seq), null),
            truncated: events.length >= EVENTS_PER_THREAD_LIMIT,
          });
        }
        projectionMs += performance.now() - projectionStartedAt;
      }
      for (const thread of selected) {
        if (reconciliations.some((item) => item.threadId === thread.id)) continue;
        reconciliations.push({
          threadId: thread.id,
          projectId: thread.projectId,
          providerId: thread.providerId,
          updatedAt: thread.updatedAt,
          outcome: "unchanged",
        });
      }
      if (signal.aborted) return;

      const errors = reconciliations.filter((item) => item.outcome === "failed");
      const priorErrors = selected
        .map((thread) => prior.get(thread.id)?.lastError)
        .find((error): error is string => error != null);
      const factCount = reconciliations.reduce((total, item) => {
        if (item.outcome === "loaded") return total + (item.facts?.length ?? 0);
        return total + (prior.get(item.threadId)?.factCount ?? 0);
      }, 0);
      const truncatedThreads = reconciliations.reduce((total, item) => {
        const truncated = item.outcome === "loaded"
          ? item.truncated
          : prior.get(item.threadId)?.truncated;
        return total + (truncated ? 1 : 0);
      }, 0);
      const selectedIds = new Set(selected.map((thread) => thread.id));
      const removedFacts = [...prior.values()].some((thread) =>
        !selectedIds.has(thread.threadId) && thread.factCount > 0,
      );
      const factsChanged = removedFacts || reconciliations.some((item) => item.outcome === "loaded");

      const completedAt = Date.now();
      const publishStartedAt = performance.now();
      store.commitSnapshot({
        completedAt,
        durationMs: completedAt - startedAt,
        selectedThreadIds: selected.map((thread) => thread.id),
        threads: reconciliations,
        loadedThreads: selected.length - errors.filter((item) => prior.get(item.threadId) == null).length,
        factCount,
        truncatedThreads,
        degraded: errors.length > 0 || priorErrors != null,
        lastError: errors[0]?.error ?? priorErrors ?? null,
        factsChanged,
        lastFullReconciliationAt: shouldReconcileFully ? completedAt : undefined,
        factProjectionVersion: shouldReconcileFully && errors.length === 0 ? FACT_PROJECTION_VERSION : undefined,
      });
      const publishMs = performance.now() - publishStartedAt;
      const publishedState = store.getIndexState();
      bb.realtime.publish("analytics-index-changed", publishedState);
      bb.log.info([
        "Analytics refresh complete",
        `generation=${publishedState.generationId}`,
        `totalMs=${Math.round(performance.now() - profileStartedAt)}`,
        `candidateListMs=${Math.round(candidateListMs)}`,
        `eventFetchMs=${Math.round(eventFetchMs)}`,
        `projectionMs=${Math.round(projectionMs)}`,
        `publishMs=${Math.round(publishMs)}`,
        `candidates=${listed.length}`,
        `selected=${selected.length}`,
        `eventReads=${pending.length}`,
        `events=${eventsRead}`,
        `facts=${factCount}`,
        `full=${shouldReconcileFully}`,
        `force=${force}`,
      ].join(" "));
    } catch (cause) {
      if (!signal.aborted && !disposed) {
        store.markError(errorText(cause));
        bb.realtime.publish("analytics-index-changed", store.getIndexState());
        bb.log.error(`Analytics indexing failed: ${errorText(cause)}`);
      }
    } finally {
      if (activeRefreshController === controller) activeRefreshController = null;
    }
  };

  const coordinator = new AnalyticsRefreshCoordinator(
    () => store.getIndexState(),
    runRefresh,
  );

  const requestRefresh = () => coordinator.getOrRefresh(DEFAULT_MAX_AGE_MS, true);

  bb.http.route("GET", "/duckdb-mvp.wasm", async () => new Response(await readFile(DUCKDB_WASM_PATH), {
    headers: {
      "content-type": "application/wasm",
      "cache-control": "public, max-age=31536000, immutable",
    },
  }));
  bb.http.route("GET", "/duckdb-browser-mvp.worker.js", async () => new Response(await readFile(DUCKDB_WORKER_PATH), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  }));
  bb.http.route("GET", "/duckdb-eh.wasm", async () => new Response(await readFile(DUCKDB_EH_WASM_PATH), {
    headers: {
      "content-type": "application/wasm",
      "cache-control": "public, max-age=31536000, immutable",
    },
  }));
  bb.http.route("GET", "/duckdb-browser-eh.worker.js", async () => new Response(await readFile(DUCKDB_EH_WORKER_PATH), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  }));
  bb.http.route("GET", "/facts.ndjson", async (context) => {
    const requestedRange = Number(new URL(context.req.url).searchParams.get("rangeDays") ?? "14");
    const rangeDays = Number.isInteger(requestedRange) ? Math.min(90, Math.max(1, requestedRange)) : 14;
    const bundleId = new URL(context.req.url).searchParams.get("bundleId");
    const selectedBundle = bundleId == null ? null : bundleById(bundleId)?.bundle ?? null;
    if (servesStaleWhileRefresh(selectedBundle)) {
      coordinator.getOrRefresh(maxAgeFor(selectedBundle), false);
    } else {
      await coordinator.waitForRefresh(maxAgeFor(selectedBundle), false);
    }
    const snapshot = store.snapshotFactsAsNdjson(rangeDays);
    const headers = new Headers({
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-analytics-generation-id": String(snapshot.state.generationId),
      "x-analytics-snapshot-updated-at": snapshot.state.snapshotUpdatedAt == null ? "" : String(snapshot.state.snapshotUpdatedAt),
      "x-analytics-index-status": snapshot.state.status,
      "x-analytics-degraded": String(snapshot.state.degraded),
    });
    if (snapshot.state.lastError != null) headers.set("x-analytics-last-error", snapshot.state.lastError);
    return new Response(snapshot.ndjson, {
      headers,
    });
  });

  bb.rpc.register(rpcContract, {
    catalog() {
      coordinator.getOrRefresh(DEFAULT_MAX_AGE_MS, false);
      return { bundles: allBundles(), index: store.getIndexState() };
    },
    async getBundle({ bundleId }) {
      const selected = bundleById(bundleId);
      if (selected == null) throw new Error(`Unknown analytics bundle: ${bundleId}`);
      if (servesStaleWhileRefresh(selected.bundle)) {
        coordinator.getOrRefresh(maxAgeFor(selected.bundle), false);
      } else {
        await coordinator.waitForRefresh(maxAgeFor(selected.bundle), false);
      }
      return {
        bundle: selected.bundle,
        builtin: selected.builtin,
      };
    },
    requestRefresh() {
      return requestRefresh();
    },
    async saveBundle({ source }) {
      return saveBundle(parseBundleSource(source));
    },
    deleteBundle({ id }) {
      if (getBuiltinBundle(id) != null) throw new Error("Built-in analytics bundles cannot be deleted.");
      const deleted = store.deleteBundle(id);
      if (deleted) bb.realtime.publish("analytics-bundles-changed", { id, action: "deleted" });
      return { deleted };
    },
    createReference(input) {
      return createReference(input);
    },
  });

  bb.ui.registerMentionProvider({
    id: "analytics-reference",
    label: "Analytics references",
    search: () => [],
    resolve(itemId) {
      return { context: renderAnalyticsReference(resolveReference(itemId)) };
    },
  });

  bb.cli.register({
    name: "analytics",
    summary: "Manage code-authored Analytics dashboard bundles.",
    commands: [
      { name: "bundles", summary: "List dashboard bundles.", usage: "bb analytics bundles" },
      { name: "install", summary: "Validate and install a bundle JSON file.", usage: "bb analytics install <file.json>" },
      { name: "remove", summary: "Remove a user-authored bundle.", usage: "bb analytics remove <bundle-id>" },
      { name: "refresh", summary: "Request a background capability reindex.", usage: "bb analytics refresh" },
      { name: "verify", summary: "Compile dashboard queries against the typed DuckDB fact contract.", usage: "bb analytics verify [bundle-id]" },
    ],
    async run(argv, context) {
      const [command, argument] = argv;
      if (command === "bundles") {
        return { exitCode: 0, stdout: `${allBundles().map((bundle) => `${bundle.id}\t${bundle.builtin ? "built-in" : "user"}\t${bundle.title}`).join("\n")}\n` };
      }
      if (command === "refresh") {
        requestRefresh();
        return { exitCode: 0, stdout: "Analytics refresh requested.\n" };
      }
      if (command === "verify") {
        try {
          const verified = await verifyBundles(argument);
          return {
            exitCode: 0,
            stdout: `${verified.map((result) => `${result.bundleId}\t${result.queryCount} queries\t${result.visualizationCount} visualizations`).join("\n")}\n`,
          };
        } catch (cause) {
          return { exitCode: 1, stderr: `${errorText(cause)}\n` };
        }
      }
      if (command === "install" && argument != null) {
        try {
          const source = await readFile(resolve(context.cwd ?? process.cwd(), argument), "utf8");
          const saved = saveBundle(parseBundleSource(source));
          return { exitCode: 0, stdout: `Installed ${saved.id}: ${saved.title}\n` };
        } catch (cause) {
          return { exitCode: 1, stderr: `${errorText(cause)}\n` };
        }
      }
      if (command === "remove" && argument != null) {
        if (getBuiltinBundle(argument) != null) return { exitCode: 1, stderr: "Built-in analytics bundles cannot be removed.\n" };
        const deleted = store.deleteBundle(argument);
        if (deleted) bb.realtime.publish("analytics-bundles-changed", { id: argument, action: "deleted" });
        return { exitCode: deleted ? 0 : 1, stdout: deleted ? `Removed ${argument}.\n` : undefined, stderr: deleted ? undefined : `Unknown bundle: ${argument}\n` };
      }
      return { exitCode: 1, stderr: "Usage: bb analytics <bundles|install <file.json>|remove <bundle-id>|refresh|verify [bundle-id]>\n" };
    },
  });

  bb.agents.registerTool({
    name: "save_analytics_bundle",
    description: "Validate and save a declarative Analytics dashboard bundle containing bounded DuckDB SELECT queries and visualizations.",
    parameters: z.object({ bundle: analyticsBundleSchema }).strict(),
    execute({ bundle }) {
      const saved = saveBundle(bundle);
      return `Saved Analytics bundle ${saved.id} (${saved.title}).`;
    },
  });

  bb.agents.registerTool({
    name: "verify_analytics_bundle",
    description: "Compile one Analytics bundle, or every installed bundle, against the typed DuckDB fact contract without reading fact data.",
    parameters: z.object({ id: z.string().min(1).max(64).optional() }).strict(),
    async execute({ id }) {
      try {
        const verified = await verifyBundles(id);
        return verified.map((result) => `Verified ${result.bundleId}: ${result.queryCount} queries, ${result.visualizationCount} visualizations.`).join("\n");
      } catch (cause) {
        return { content: [{ type: "text", text: errorText(cause) }], isError: true };
      }
    },
  });

  bb.agents.registerTool({
    name: "read_analytics_reference",
    description: "Resolve an analytics-ref:v1 token into the exact dashboard, DuckDB query, parameters, snapshot coverage, and selected redacted result row that produced it.",
    parameters: z.object({ reference: z.string().min(1).max(300) }).strict(),
    execute({ reference }) {
      try {
        return renderAnalyticsReference(resolveReference(reference));
      } catch (cause) {
        return { content: [{ type: "text", text: errorText(cause) }], isError: true };
      }
    },
  });

  bb.agents.registerTool({
    name: "delete_analytics_bundle",
    description: "Delete a user-authored Analytics dashboard bundle. Built-in bundles cannot be deleted.",
    parameters: z.object({ id: z.string().min(1).max(64) }).strict(),
    execute({ id }) {
      if (getBuiltinBundle(id) != null) return { content: [{ type: "text", text: "Built-in Analytics bundles cannot be deleted." }], isError: true };
      const deleted = store.deleteBundle(id);
      if (deleted) bb.realtime.publish("analytics-bundles-changed", { id, action: "deleted" });
      return deleted ? `Deleted Analytics bundle ${id}.` : { content: [{ type: "text", text: `Unknown Analytics bundle: ${id}` }], isError: true };
    },
  });

  bb.agents.configure((context) => context.origin.pluginId === bb.pluginId
    ? {
        tools: ["read_analytics_reference", "verify_analytics_bundle"],
        skills: [],
        instructions: "Resolve pasted analytics-ref:v1 tokens with read_analytics_reference before answering about a referenced chart datum.",
      }
    : {
        tools: ["save_analytics_bundle", "delete_analytics_bundle", "read_analytics_reference", "verify_analytics_bundle"],
        skills: [],
        instructions: "Analytics dashboard bundles are declarative JSON: one recent-capability loader, one or more bounded read-only DuckDB SELECT queries over tool_execution_fact_v1, and metric/bar/line/table visualizations. Prefer saving a bundle only when the user asks for a reusable dashboard. Resolve pasted analytics-ref:v1 tokens with read_analytics_reference before answering about a referenced chart datum.",
      });

  bb.onDispose(() => {
    disposed = true;
    activeRefreshController?.abort();
    activeRefreshController = null;
  });

}
