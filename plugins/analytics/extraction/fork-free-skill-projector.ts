import { createHash } from "node:crypto";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import {
  FORK_FREE_SKILL_EVIDENCE_VERSION,
  replayPublicSkillEvidence,
  validatePublicSkillCatalogCapture,
  type PublicCatalogCaptureTrigger,
  type PublicSkillCatalogCapture,
  type PublicSkillCatalogEntry,
  type PublicSkillCatalogSnapshot,
  type PublicThreadEvent,
} from "../skill-observation-contract.ts";
import { AnalyticsStore, type ForkFreeCatalogCaptureRecord } from "../store.ts";
import { isExactThreadNotFound } from "./source-adapter.ts";

type Skills = BbPluginApi["sdk"]["skills"];
type Threads = BbPluginApi["sdk"]["threads"];

export type ForkFreeSkillSdk = {
  skills: Pick<Skills, "list" | "getContent" | "listFiles">;
  threads: Pick<Threads, "list" | "get"> & { events: Pick<Threads["events"], "list"> };
};

export interface ForkFreeThreadContext {
  id: string;
  projectId: string;
  environmentId: string | null;
  providerId: string;
}

export interface ForkFreeProjectionResult {
  capture: ForkFreeCatalogCaptureRecord;
  sourceEventCount: number;
  promptMentionCount: number;
  commandCandidateCount: number;
  deletedThreadIds: readonly string[];
}

const EVENT_TYPES = ["client/turn/requested", "item/started", "item/completed", "thread/tokenUsage/updated"] as const;
const PAGE_SIZE = 100;
const MAX_LIST_PAGES = 512;
const MAX_EVENT_PAGES = 512;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function assertIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 512) throw new Error(`Invalid public ${label}.`);
  return value;
}

/** The one public SDK failure that means a listed symlink cannot be read safely. */
function isReadRootContainmentFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:HTTP\s+)?502:\s*Path "SKILL\.md" escapes read root/u.test(message);
}

function absoluteRegisteredPath(filePath: string, relativePath: unknown): string {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\0") || relativePath.startsWith("/")) throw new Error("sdk.skills.listFiles returned a non-relative path.");
  const slash = filePath.lastIndexOf("/");
  if (!filePath.startsWith("/") || slash <= 0) throw new Error("sdk.skills.list returned an invalid absolute filePath.");
  const root = filePath.slice(0, slash);
  const parts: string[] = [];
  for (const part of relativePath.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new Error("sdk.skills.listFiles path escapes its skill root.");
    parts.push(part);
  }
  if (parts.length === 0) throw new Error("sdk.skills.listFiles returned an empty path.");
  return `${root}/${parts.join("/")}`;
}

function captureContext(thread: ForkFreeThreadContext | null, trigger: PublicCatalogCaptureTrigger, projectId?: string, environmentId?: string | null): {
  projectId: string; environmentId: string | null; threadId: string | null; providerId: string | null;
} {
  if (thread !== null) return { projectId: assertIdentifier(thread.projectId, "project ID"), environmentId: thread.environmentId, threadId: assertIdentifier(thread.id, "thread ID"), providerId: assertIdentifier(thread.providerId, "provider ID") };
  if (trigger !== "refresh") throw new Error("Only refresh may capture a catalog without a post-transition thread.");
  return { projectId: assertIdentifier(projectId, "project ID"), environmentId: environmentId ?? null, threadId: null, providerId: null };
}

function safeEvent(row: unknown, expectedThreadId: string): PublicThreadEvent | null {
  if (row === null || typeof row !== "object") throw new Error("Public threads.events.list returned a malformed row.");
  const event = row as Record<string, unknown>;
  if (!EVENT_TYPES.includes(event.type as typeof EVENT_TYPES[number])) return null;
  if (event.threadId !== expectedThreadId || !Number.isSafeInteger(event.seq) || (event.seq as number) < 1 || !Number.isSafeInteger(event.createdAt) || (event.createdAt as number) < 0 || typeof event.id !== "string" || event.id.length === 0 || event.data === null || typeof event.data !== "object" || event.scope === null || typeof event.scope !== "object") {
    throw new Error("Public thread event lacks the required bounded envelope.");
  }
  const scope = event.scope as Record<string, unknown>;
  if (scope.kind !== "thread" && scope.kind !== "turn") throw new Error("Public thread event scope is invalid.");
  if (scope.kind === "turn" && typeof scope.turnId !== "string") throw new Error("Public turn-scoped event lacks a turn ID.");
  return { id: event.id, threadId: expectedThreadId, seq: event.seq as number, createdAt: event.createdAt as number, type: event.type as PublicThreadEvent["type"], scope: scope.kind === "turn" ? { kind: "turn", turnId: scope.turnId as string } : { kind: "thread" }, data: event.data as Record<string, unknown> };
}

/**
 * Plugin-only projector. Composition owns event registration; it can call
 * captureForThread after `thread.created`/`thread.active`, never before the
 * transition. `refresh` is equally current-only and cannot reconstruct the
 * private catalog used when an older turn was launched.
 */
export class ForkFreeSkillProjector {
  private inFlight: Promise<ForkFreeProjectionResult> | null = null;
  private readonly sdk: ForkFreeSkillSdk;
  private readonly store: AnalyticsStore;
  private readonly clock: () => number;
  private readonly checkBudget: () => void;

  constructor(sdk: ForkFreeSkillSdk, store: AnalyticsStore, clock: () => number = () => Date.now(), checkBudget: () => void = () => {}) {
    this.sdk = sdk;
    this.store = store;
    this.clock = clock;
    this.checkBudget = checkBudget;
  }

  async captureForThread(thread: ForkFreeThreadContext, trigger: Exclude<PublicCatalogCaptureTrigger, "refresh">): Promise<ForkFreeProjectionResult> {
    return await this.project(trigger, thread, undefined, undefined);
  }

  async refresh(projectId: string, environmentId: string | null): Promise<ForkFreeProjectionResult> {
    return await this.project("refresh", null, projectId, environmentId);
  }

  private async project(trigger: PublicCatalogCaptureTrigger, thread: ForkFreeThreadContext | null, projectId?: string, environmentId?: string | null): Promise<ForkFreeProjectionResult> {
    if (this.inFlight !== null) return await this.inFlight;
    const run = this.projectOnce(trigger, thread, projectId, environmentId);
    this.inFlight = run;
    try { return await run; } finally { if (this.inFlight === run) this.inFlight = null; }
  }

  private async projectOnce(trigger: PublicCatalogCaptureTrigger, thread: ForkFreeThreadContext | null, projectId?: string, environmentId?: string | null): Promise<ForkFreeProjectionResult> {
    const context = captureContext(thread, trigger, projectId, environmentId);
    const capturedAtMs = this.clock();
    if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs < 0) throw new Error("Fork-free projection clock must return a nonnegative safe integer.");
    const capture = await this.captureCatalog(context, trigger, capturedAtMs);
    this.checkBudget();
    if (capture.snapshot === null) {
      this.store.commitForkFreeSkillEvidence({ projectId: context.projectId, environmentId: context.environmentId, captures: [capture], sourceEvents: [], mentions: [], candidates: [], aggregateTokens: [], deletedThreadIds: [], completedAtMs: capturedAtMs, sourceDigest: digest({ capture }) });
      return { capture, sourceEventCount: 0, promptMentionCount: 0, commandCandidateCount: 0, deletedThreadIds: [] };
    }
    const { events, dimensions, deletedThreadIds } = await this.readRetainedEvents(context.projectId, context.environmentId);
    const replay = replayPublicSkillEvidence(capture.snapshot, events);
    const sourceEvents = events.map((event) => {
      const dimension = dimensions.get(event.threadId);
      if (dimension === undefined) throw new Error("Public event has no authoritative thread dimensions.");
      return { id: event.id, threadId: event.threadId, projectId: dimension.projectId, environmentId: dimension.environmentId, providerId: dimension.providerId, seq: event.seq, createdAt: event.createdAt, type: event.type, digest: digest({ id: event.id, threadId: event.threadId, projectId: dimension.projectId, environmentId: dimension.environmentId, providerId: dimension.providerId, seq: event.seq, createdAt: event.createdAt, type: event.type, scope: event.scope, data: event.data }) };
    });
    const sourceDigest = digest({ captures: [capture], sourceEvents, mentions: replay.mentions, candidates: replay.candidates, aggregateTokens: replay.aggregateTokens, deletedThreadIds });
    this.checkBudget();
    this.store.commitForkFreeSkillEvidence({ projectId: context.projectId, environmentId: context.environmentId, captures: [capture], sourceEvents, mentions: replay.mentions, candidates: replay.candidates, aggregateTokens: replay.aggregateTokens, deletedThreadIds, completedAtMs: capturedAtMs, sourceDigest });
    return { capture, sourceEventCount: sourceEvents.length, promptMentionCount: replay.mentions.length, commandCandidateCount: replay.candidates.length, deletedThreadIds };
  }

  private async captureCatalog(context: { projectId: string; environmentId: string | null; threadId: string | null; providerId: string | null }, trigger: PublicCatalogCaptureTrigger, capturedAtMs: number): Promise<ForkFreeCatalogCaptureRecord> {
    try {
      const listed = await this.sdk.skills.list({ projectId: context.projectId, environmentId: context.environmentId });
      const entries: PublicSkillCatalogEntry[] = [];
      for (const listedEntry of listed.skills) {
        this.checkBudget();
        const skillId = assertIdentifier(listedEntry.id, "skill ID");
        if (!listedEntry.filePath.startsWith("/")) throw new Error("sdk.skills.list returned a non-absolute filePath.");
        // Membership and registered paths remain mandatory public SDK facts.
        // Content is a separate, optional footprint measurement: BB may reject
        // a listed SKILL.md symlink that escapes its root, and Analytics must
        // neither bypass that containment check nor replace it with a local
        // filesystem read.
        const files = await this.sdk.skills.listFiles({ projectId: context.projectId, environmentId: context.environmentId, skillId });
        if (files.truncated) throw new Error("sdk.skills.listFiles was truncated; catalog is not complete.");
        const registeredPaths = [...new Set([listedEntry.filePath, ...files.files.map((path) => absoluteRegisteredPath(listedEntry.filePath, path))])].sort();
        let contentRevision: string | null = null;
        let contentBytes: number | null = null;
        try {
          const content = await this.sdk.skills.getContent({ projectId: context.projectId, environmentId: context.environmentId, skillId, path: "SKILL.md" });
          contentRevision = content.revision;
          contentBytes = Buffer.byteLength(content.content, "utf8");
        } catch (error) {
          if (!isReadRootContainmentFailure(error)) throw error;
          // A null footprint is explicit unknown measurement, never a missing
          // catalog member and never permission to read the server filesystem.
        }
        entries.push({ skillId, name: listedEntry.name, provider: listedEntry.provider, scope: listedEntry.scope, pluginId: listedEntry.pluginId, filePath: listedEntry.filePath, contentRevision, contentBytes, registeredPaths, filesTruncated: false });
      }
      entries.sort((left, right) => left.skillId.localeCompare(right.skillId));
      const identity = { trigger, capturedAtMs, projectId: context.projectId, environmentId: context.environmentId, entries };
      const snapshot: PublicSkillCatalogSnapshot = { version: FORK_FREE_SKILL_EVIDENCE_VERSION, snapshotId: `sdk-catalog-v1-${digest(identity)}`, capturedAtMs, projectId: context.projectId, environmentId: context.environmentId, source: "sdk.skills.list/getContent/listFiles", entries };
      const capture: ForkFreeCatalogCaptureRecord = { captureId: `sdk-capture-v1-${digest({ threadId: context.threadId, providerId: context.providerId, ...identity })}`, trigger, capturedAtMs, completeness: "complete", error: null, snapshot, threadId: context.threadId, providerId: context.providerId, projectId: context.projectId, environmentId: context.environmentId };
      validatePublicSkillCatalogCapture(capture);
      return capture;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { captureId: `sdk-capture-v1-${digest({ trigger, capturedAtMs, threadId: context.threadId, providerId: context.providerId, projectId: context.projectId, environmentId: context.environmentId, error: message })}`, trigger, capturedAtMs, completeness: "failed", error: message.slice(0, 4096), snapshot: null, threadId: context.threadId, providerId: context.providerId, projectId: context.projectId, environmentId: context.environmentId };
    }
  }

  private async readRetainedEvents(projectId: string, environmentId: string | null): Promise<{ events: PublicThreadEvent[]; dimensions: Map<string, Pick<ForkFreeThreadContext, "projectId" | "environmentId" | "providerId">>; deletedThreadIds: string[] }> {
    const ids = new Set(this.store.listActiveForkFreeSourceThreadIds(projectId, environmentId));
    const retainedIds = new Set(ids);
    for (let offset = 0, page = 0; page < MAX_LIST_PAGES; page += 1) {
      const rows = await this.sdk.threads.list({ projectId, includeHidden: true, limit: 200, offset });
      for (const row of rows) ids.add(assertIdentifier(row.id, "thread ID"));
      if (rows.length < 200) break;
      offset += rows.length;
      if (page === MAX_LIST_PAGES - 1) throw new Error("Public threads.list page budget exceeded.");
    }
    const events: PublicThreadEvent[] = [];
    const dimensions = new Map<string, Pick<ForkFreeThreadContext, "projectId" | "environmentId" | "providerId">>();
    const deletedThreadIds: string[] = [];
    for (const threadId of [...ids].sort()) {
      this.checkBudget();
      let publicThread;
      try { publicThread = await this.sdk.threads.get({ threadId }); } catch (error) {
        if (isExactThreadNotFound(error)) { deletedThreadIds.push(threadId); continue; }
        throw error;
      }
      const dimensionsRow = { projectId: assertIdentifier(publicThread.projectId, "project ID"), environmentId: publicThread.environmentId, providerId: assertIdentifier(publicThread.providerId, "provider ID") };
      if (dimensionsRow.projectId !== projectId || dimensionsRow.environmentId !== environmentId) {
        if (retainedIds.has(threadId)) throw new Error("Conflicting fork-free source event workspace dimensions.");
        continue;
      }
      dimensions.set(threadId, dimensionsRow);
      let afterSeq: string | undefined;
      for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
        const rows = await this.sdk.threads.events.list({ threadId, order: "asc", limit: String(PAGE_SIZE), ...(afterSeq === undefined ? {} : { afterSeq }), types: EVENT_TYPES });
        let maximum = afterSeq === undefined ? 0 : Number(afterSeq);
        for (const row of rows) {
          const event = safeEvent(row, threadId);
          if (event === null) continue;
          if (event.seq <= maximum) throw new Error("Public thread events failed to advance.");
          maximum = event.seq;
          events.push(event);
        }
        if (rows.length < PAGE_SIZE) break;
        if (maximum === (afterSeq === undefined ? 0 : Number(afterSeq))) throw new Error("A full public event page did not advance its cursor.");
        afterSeq = String(maximum);
        if (page === MAX_EVENT_PAGES - 1) throw new Error("Public thread event page budget exceeded.");
      }
    }
    return { events, dimensions, deletedThreadIds };
  }
}
