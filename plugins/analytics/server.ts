import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  analyticsBundleSchema,
  parseBundleSource,
  validateBundleQueries,
  type AnalyticsBundle,
} from "./bundle-contract.ts";
import { BUILTIN_BUNDLES, getBuiltinBundle } from "./builtin-bundles.ts";
import { verifyAnalyticsBundle } from "./analytics-verifier.ts";
import { renderAnalyticsReference, type CreateAnalyticsReference } from "./analytics-reference.ts";
import { rpcContract } from "./rpc-contract.ts";
import { MAX_SKILL_QUERY_CATALOG_ROWS, MAX_SKILL_QUERY_RAW_ROWS, skillQueryFilterSchema, skillQueryResultSchema, skillRawContributorResultSchema, type SkillQueryFilter } from "./skill-query-schema.ts";
import { SkillQueryService, type ForkFreeSkillQueryInput } from "./skill-query-service.ts";
import { RetainedQueryCache } from "./retained-query-cache.ts";
import {
  AnalyticsStore,
  analyticsMigrations,
} from "./store.ts";

const require = createRequire(import.meta.url);
const DUCKDB_WASM_PATH = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm");
const DUCKDB_WORKER_PATH = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js");
const DUCKDB_EH_WASM_PATH = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm");
const DUCKDB_EH_WORKER_PATH = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js");

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function forkFreeQueryInput(db: ReturnType<BbPluginApi["storage"]["database"]>, untrustedFilters: SkillQueryFilter): ForkFreeSkillQueryInput {
  const filters = skillQueryFilterSchema.parse(untrustedFilters);
  const capturePredicates = ["c.completeness='complete'"];
  const captureParameters: unknown[] = [];
  if (filters.projectId !== undefined) { capturePredicates.push("c.project_id=?"); captureParameters.push(filters.projectId); }
  if (filters.environmentId !== undefined) { capturePredicates.push("c.environment_id IS ?"); captureParameters.push(filters.environmentId); }
  const entryPredicates: string[] = [];
  const entryParameters: unknown[] = [];
  if (filters.providerId !== undefined) { entryPredicates.push("e.provider_id IS ?"); entryParameters.push(filters.providerId); }
  if (filters.skillId !== undefined) { entryPredicates.push("e.skill_id=?"); entryParameters.push(filters.skillId); }
  if (filters.contentRevision !== undefined) { entryPredicates.push("e.content_revision=?"); entryParameters.push(filters.contentRevision); }
  const catalogCte = `WITH latest AS (
      SELECT c.project_id,c.environment_id,MAX(c.captured_at_ms) captured_at_ms
      FROM analytics_fork_free_catalog_captures_v1 c WHERE ${capturePredicates.join(" AND ")}
      GROUP BY c.project_id,c.environment_id
    ), ranked AS (
      SELECT c.capture_id,c.captured_at_ms,c.project_id,c.environment_id,e.provider_id,e.skill_id,e.name,e.scope,e.plugin_id,e.file_path,e.content_revision,e.content_bytes,json_array_length(e.registered_paths_json) registered_path_count,
        ROW_NUMBER() OVER (PARTITION BY e.skill_id,COALESCE(e.content_revision,'') ORDER BY c.captured_at_ms DESC,c.capture_id DESC) rank
      FROM analytics_fork_free_catalog_captures_v1 c
      JOIN latest l ON l.project_id=c.project_id AND l.environment_id IS c.environment_id AND l.captured_at_ms=c.captured_at_ms
      JOIN analytics_fork_free_catalog_entries_v1 e ON e.capture_id=c.capture_id
      WHERE c.completeness='complete'${entryPredicates.length === 0 ? "" : ` AND ${entryPredicates.join(" AND ")}`}
    )`;
  const catalogParameters = [...captureParameters, ...entryParameters];
  const currentCatalogTotal = Number((db.prepare(`${catalogCte} SELECT COUNT(*) count FROM ranked WHERE rank=1`).get(...catalogParameters) as { count: number }).count);
  const rows = db.prepare(`${catalogCte} SELECT * FROM ranked WHERE rank=1 ORDER BY name,skill_id,content_revision LIMIT ?`).all(...catalogParameters, MAX_SKILL_QUERY_CATALOG_ROWS) as Array<Record<string, unknown>>;
  const currentCatalog = rows.map((row) => ({ snapshotId: String(row.capture_id), capturedAtMs: Number(row.captured_at_ms), providerId: row.provider_id === null ? null : String(row.provider_id), projectId: String(row.project_id), environmentId: row.environment_id === null ? null : String(row.environment_id), skillId: String(row.skill_id), name: String(row.name), scope: String(row.scope), pluginId: row.plugin_id === null ? null : String(row.plugin_id), filePath: String(row.file_path), contentRevision: row.content_revision === null ? null : String(row.content_revision), contentBytes: row.content_bytes === null ? null : Number(row.content_bytes), registeredPathCount: Number(row.registered_path_count) }));

  const sourcePredicates = ["s.created_at_ms>=?", "s.created_at_ms<=?"];
  const sourceParameters: unknown[] = [filters.startMs, filters.endMs];
  if (filters.providerId !== undefined) { sourcePredicates.push("s.provider_id IS ?"); sourceParameters.push(filters.providerId); }
  if (filters.projectId !== undefined) { sourcePredicates.push("s.project_id=?"); sourceParameters.push(filters.projectId); }
  if (filters.environmentId !== undefined) { sourcePredicates.push("s.environment_id IS ?"); sourceParameters.push(filters.environmentId); }
  // Public prompt/command evidence has no historical revision attribution.
  if (filters.contentRevision !== undefined) sourcePredicates.push("0");
  const evidencePreviewLimit = Math.floor(MAX_SKILL_QUERY_RAW_ROWS / 2);
  const mentionWhere = ["m.active_generation>0", ...sourcePredicates, ...(filters.skillId === undefined ? [] : ["m.skill_id=?"])];
  const mentionParameters = [...sourceParameters, ...(filters.skillId === undefined ? [] : [filters.skillId])];
  const promptMentionTotal = Number((db.prepare(`SELECT COUNT(*) count FROM analytics_fork_free_prompt_mentions_v1 m JOIN analytics_fork_free_source_events_v1 s ON s.source_event_id=m.source_event_id WHERE ${mentionWhere.join(" AND ")}`).get(...mentionParameters) as { count: number }).count);
  const mentions = (db.prepare(`SELECT m.source_event_id,m.skill_id,m.mention,s.thread_id,s.source_sequence,s.created_at_ms,s.provider_id,s.project_id,s.environment_id FROM analytics_fork_free_prompt_mentions_v1 m JOIN analytics_fork_free_source_events_v1 s ON s.source_event_id=m.source_event_id WHERE ${mentionWhere.join(" AND ")} ORDER BY s.created_at_ms DESC,m.source_event_id DESC LIMIT ?`).all(...mentionParameters, evidencePreviewLimit) as Array<Record<string, unknown>>).map((row) => ({ id: `mention:${row.source_event_id}:${row.skill_id}:${row.mention}`, observedAtMs: Number(row.created_at_ms), sessionId: null, threadId: String(row.thread_id), eventId: String(row.source_event_id), eventSeq: Number(row.source_sequence), providerId: String(row.provider_id), projectId: String(row.project_id), environmentId: row.environment_id === null ? null : String(row.environment_id), skillId: String(row.skill_id), contentRevision: null, kind: "prompt-mention" as const, mention: String(row.mention), historicalRevision: null }));
  const candidateWhere = ["c.active_generation>0", ...sourcePredicates, ...(filters.skillId === undefined ? [] : ["c.skill_id=?"])];
  const candidateParameters = [...sourceParameters, ...(filters.skillId === undefined ? [] : [filters.skillId])];
  const commandCandidateTotal = Number((db.prepare(`SELECT COUNT(*) count FROM analytics_fork_free_command_candidates_v1 c JOIN analytics_fork_free_source_events_v1 s ON s.source_event_id=c.source_started_event_id WHERE ${candidateWhere.join(" AND ")}`).get(...candidateParameters) as { count: number }).count);
  const remainingEvidencePreview = MAX_SKILL_QUERY_RAW_ROWS - mentions.length;
  const candidates = (db.prepare(`SELECT c.*,s.created_at_ms,s.provider_id,s.project_id,s.environment_id FROM analytics_fork_free_command_candidates_v1 c JOIN analytics_fork_free_source_events_v1 s ON s.source_event_id=c.source_started_event_id WHERE ${candidateWhere.join(" AND ")} ORDER BY s.created_at_ms DESC,c.source_started_event_id DESC,c.registered_path LIMIT ?`).all(...candidateParameters, remainingEvidencePreview) as Array<Record<string, unknown>>).map((row) => ({ id: `command:${row.source_started_event_id}:${row.skill_id}:${row.registered_path}`, observedAtMs: Number(row.created_at_ms), sessionId: null, threadId: String(row.thread_id), eventId: String(row.source_started_event_id), eventSeq: Number(row.start_sequence), providerId: String(row.provider_id), projectId: String(row.project_id), environmentId: row.environment_id === null ? null : String(row.environment_id), skillId: String(row.skill_id), contentRevision: null, kind: "registered-path-command-candidate" as const, registeredPath: String(row.registered_path), itemId: String(row.item_id), startEventId: String(row.source_started_event_id), completedEventId: row.source_completed_event_id === null ? null : String(row.source_completed_event_id), executionStatus: String(row.execution_status) as "pending" | "completed" | "failed" | "declined" | "incomplete", exitCode: row.exit_code === null ? null : Number(row.exit_code), outputBytes: row.output_bytes === null ? null : Number(row.output_bytes), outputTruncated: row.output_truncated === null ? null : Number(row.output_truncated) === 1, shellWrapped: Number(row.command_shell_wrapped) === 1, joinedCommand: Number(row.command_joined) === 1, historicalRevision: null }));
  const catalogDetails = currentCatalog.map((row) => ({ id: `catalog:${row.snapshotId}:${row.skillId}`, observedAtMs: row.capturedAtMs, sessionId: null, threadId: `catalog:${row.snapshotId}`, eventId: `catalog:${row.snapshotId}`, eventSeq: 1, providerId: row.providerId, projectId: row.projectId, environmentId: row.environmentId, skillId: row.skillId, contentRevision: row.contentRevision, kind: "catalog-snapshot" as const, snapshotId: row.snapshotId, completeness: "complete" as const }));
  const rawRows = [...mentions, ...candidates];
  const latestComplete = currentCatalogTotal > 0;
  return { currentCatalog, currentCatalogTotal, rawRows, rawEvidenceTotal: promptMentionTotal + commandCandidateTotal, promptMentionTotal, commandCandidateTotal, detailRows: [...catalogDetails, ...rawRows], snapshotComplete: latestComplete, snapshotExplanation: latestComplete ? "Latest complete BB-visible current catalog snapshot retained." : "No complete BB-visible current catalog snapshot has been retained." };
}

function bundleSummary(bundle: AnalyticsBundle, builtin: boolean) {
  return { id: bundle.id, title: bundle.title, description: bundle.description, builtin };
}

export default function analyticsPlugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...analyticsMigrations]);
  const store = new AnalyticsStore(db);
  const skillReadCache = new RetainedQueryCache<ForkFreeSkillQueryInput>();
  const skillQueries = new SkillQueryService((filters) => {
    const state = db.prepare("SELECT generation_id FROM analytics_fork_free_skill_projection_state_v1 WHERE singleton=1").get() as { generation_id: number };
    const retained = skillReadCache.read(String(state.generation_id), skillQueryFilterSchema.parse(filters), () => forkFreeQueryInput(db, filters));
    const limits = " Skills capture is paused during migration to isolated analytics. These are retained observations, not live data. Refresh is unavailable until the platform collector is qualified.";
    return { ...retained, snapshotExplanation: `${retained.snapshotExplanation}${limits}` };
  });
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
    // Reads never admit source work, including cold and stale exports.
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
      return { bundles: allBundles(), index: store.getIndexState() };
    },
    async getBundle({ bundleId }) {
      const selected = bundleById(bundleId);
      if (selected == null) throw new Error(`Unknown analytics bundle: ${bundleId}`);
      return {
        bundle: selected.bundle,
        builtin: selected.builtin,
      };
    },
    requestRefresh() {
      throw Object.assign(new Error("Analytics source refresh is unavailable until the isolated platform collector is qualified."), { code: "isolation-unavailable" });
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
    skillsQuery(input) { return skillQueryResultSchema.parse(skillQueries.query(input)); },
    refreshSkills() {
      return { status: "failed" as const, message: "Analytics source refresh is unavailable until the isolated platform collector is qualified." };
    },
    skillsRawContributors({ filters, ids }) {
      return skillRawContributorResultSchema.parse([...skillQueries.rawContributors(filters, ids)]);
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
      { name: "refresh", summary: "Unavailable until isolated source collection is qualified.", usage: "bb analytics refresh" },
      { name: "refresh-skills", summary: "Unavailable until isolated source collection is qualified.", usage: "bb analytics refresh-skills <project-id> <environment-id|none>" },
      { name: "verify", summary: "Compile dashboard queries against the typed DuckDB fact contract.", usage: "bb analytics verify [bundle-id]" },
    ],
    async run(argv, context) {
      const [command, argument] = argv;
      if (command === "bundles") {
        return { exitCode: 0, stdout: `${allBundles().map((bundle) => `${bundle.id}\t${bundle.builtin ? "built-in" : "user"}\t${bundle.title}`).join("\n")}\n` };
      }
      if (command === "refresh" || command === "refresh-skills") {
        return { exitCode: 1, stderr: "isolation-unavailable: Analytics source refresh is unavailable until the isolated platform collector is qualified.\n" };
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
      return { exitCode: 1, stderr: "Usage: bb analytics <bundles|install <file.json>|remove <bundle-id>|refresh|refresh-skills <project-id> <environment-id|none>|verify [bundle-id]>\n" };
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
        instructions: "Analytics additions must use declarative dashboard bundles: one shared recent-capability loader, bounded read-only queries over curated facts, and shared metric/bar/line/table renderers. Never add feature-owned lifecycle handlers, host SDK scans, database connections, refresh timers, worker pools, or eager frontend dependencies. A new operational data source is a platform capability change, not a dashboard extension. Prefer saving a bundle only when the user asks for a reusable dashboard. Resolve pasted analytics-ref:v1 tokens with read_analytics_reference before answering about a referenced chart datum.",
      });


}
