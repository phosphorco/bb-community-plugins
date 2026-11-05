import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** One trusted, server-only source read. Manager owns admission and persistence. */
export const CLIENT_FACT_DATASET = "client-conversation-v1" as const;
export const CLIENT_FACT_EVENT_TYPES = [
  "thread/identity", "turn/input/accepted", "turn/completed",
] as const;
export const CLIENT_FACT_LIMITS = Object.freeze({
  conversations: 2, discoveryRows: 25, calls: 8, eventRows: 25,
  workRows: 600, receivedBytes: 8 * 1024 * 1024,
  outputBytes: 256 * 1024, elapsedMs: 2_000,
});
export type ClientFactLimits = { [K in keyof typeof CLIENT_FACT_LIMITS]: number };
type SdkThreads = BbPluginApi["sdk"]["threads"];
export type ClientFactSdk = { threads: Pick<SdkThreads, "get" | "list"> & {
  events: Pick<SdkThreads["events"], "list">;
} };

export interface ClientFactSource { namespace: string; epoch: string; }
export interface ClientFactCursor { sequence: number; eventId: string; }
export interface ClientFactRequest {
  version: 1; expectedSource: ClientFactSource | null;
  conversations: { id: string; cursor: ClientFactCursor | null }[];
  discovery: { offset: number } | null;
}
type Provider = "codex" | "claude-code";
type NativeSession = { issuer: "codex:header" | "claude-code:header"; id: string };
type EventIdentity = { conversation: string; eventId: string; sequence: number };
export type ClientFact =
  | { kind: "conversation"; conversation: string; provider: Provider;
      displayParent: string | null; sourceFork: string | null;
      lifecycleOwner: string | null; relationshipRevision: null }
  | (EventIdentity & { kind: "native_session"; session: NativeSession })
  | (EventIdentity & { kind: "turn_input"; clientTurn: string;
      clientRequest: string; session: NativeSession })
  | (EventIdentity & { kind: "turn_checkpoint"; clientTurn: string;
      session: NativeSession | null;
      checkpoint: { issuer: "codex:turn" | "claude-code:message"; id: string } | null });
export interface ClientFactBatch {
  version: 1;
  dataset: typeof CLIENT_FACT_DATASET;
  source: ClientFactSource;
  state: "partial" | "reset_required";
  resetReason: "source_epoch_mismatch" | "anchor_missing" | "anchor_changed" | null;
  facts: ClientFact[];
  cursors: { conversation: string; cursor: ClientFactCursor | null; pageExhausted: boolean }[];
  discovery: { offset: number; nextOffset: number; conversations: string[]; pageExhausted: boolean } | null;
  coverage: { complete: false; reasons: string[]; claudeHttpTurn: "unsupported" };
  budget: { calls: number; workRows: number; receivedBytes: number };
}
export class ClientFactReadError extends Error {
  readonly code: "invalid_request" | "invalid_source" | "source_conflict" | "read_budget" | "cancelled";
  constructor(code: ClientFactReadError["code"], message: string) {
    super(message); this.name = "ClientFactReadError"; this.code = code;
  }
}
function id(raw: unknown, field: string): string {
  if (!validId(raw)) throw new ClientFactReadError("invalid_source", `Invalid client-fact source ${field}.`);
  return raw;
}
function validId(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 256 || /[\u0000-\u001f\u007f]/u.test(raw)) return false;
  // JSON.stringify preserves lone surrogates as escapes. Reject them before
  // publication so UTF-8 receivers do not replace an identifier's code points.
  // Keep the existing UTF-16 length bound; valid non-BMP pairs remain two units.
  for (let index = 0; index < raw.length; index++) {
    const unit = raw.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = raw.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function validSequence(raw: unknown): raw is number { return Number.isSafeInteger(raw) && (raw as number) > 0 && (raw as number) < Number.MAX_SAFE_INTEGER; }
function object(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ClientFactReadError("invalid_source", "Client-fact source row must be an object.");
  return raw as Record<string, unknown>;
}
function closed(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  const value = object(raw), actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new Error("Unexpected client-fact input fields.");
  return value;
}
export function parseConfiguredClientFactSource(raw: unknown): ClientFactSource {
  const value = closed(raw, ["namespace", "epoch"]);
  if (!validId(value.namespace) || !validId(value.epoch)) throw new Error("Invalid configured client-fact source.");
  return { namespace: value.namespace, epoch: value.epoch };
}
export function parseClientFactRequest(raw: unknown): ClientFactRequest {
  try {
    const value = closed(raw, ["version", "expectedSource", "conversations", "discovery"]);
    if (value.version !== 1 || !Array.isArray(value.conversations) || value.conversations.length > CLIENT_FACT_LIMITS.conversations) throw new Error("Invalid request shape.");
    const expectedSource = value.expectedSource === null ? null : parseConfiguredClientFactSource(value.expectedSource);
    const conversations = value.conversations.map(raw => {
      const row = closed(raw, ["id", "cursor"]);
      if (!validId(row.id)) throw new Error("Invalid conversation.");
      let cursor: ClientFactCursor | null = null;
      if (row.cursor !== null) {
        const held = closed(row.cursor, ["sequence", "eventId"]);
        if (!validSequence(held.sequence) || !validId(held.eventId)) throw new Error("Invalid cursor.");
        cursor = { sequence: held.sequence, eventId: held.eventId };
      }
      return { id: row.id, cursor };
    });
    let discovery: ClientFactRequest["discovery"] = null;
    if (value.discovery !== null) {
      const held = closed(value.discovery, ["offset"]);
      if (!Number.isSafeInteger(held.offset) || (held.offset as number) < 0 || (held.offset as number) > Number.MAX_SAFE_INTEGER - CLIENT_FACT_LIMITS.discoveryRows) throw new Error("Invalid discovery offset.");
      discovery = { offset: held.offset as number };
    }
    return { version: 1, expectedSource, conversations, discovery };
  } catch {
    throw new ClientFactReadError("invalid_request", "Invalid closed client-fact request.");
  }
}
function nullableId(raw: unknown, field: string): string | null { return raw === null ? null : id(raw, field); }
function provider(raw: unknown): Provider {
  if (raw !== "codex" && raw !== "claude-code") throw new ClientFactReadError("invalid_source", "Client-fact source provider is unsupported.");
  return raw;
}
function session(raw: unknown, p: Provider): NativeSession {
  return { issuer: p === "codex" ? "codex:header" : "claude-code:header", id: id(raw, "native session") };
}
function metadata(raw: unknown, expected?: string): Extract<ClientFact, { kind: "conversation" }> {
  const row = object(raw), conversation = id(row.id, "conversation");
  if (expected !== undefined && conversation !== expected) throw new ClientFactReadError("source_conflict", "Source returned another conversation.");
  return { kind: "conversation", conversation, provider: provider(row.providerId),
    displayParent: nullableId(row.parentThreadId, "display parent"),
    sourceFork: nullableId(row.sourceThreadId, "source fork"),
    lifecycleOwner: nullableId(row.lifecycleOwnerThreadId, "lifecycle owner"), relationshipRevision: null };
}
type CuratedEvent = { eventId: string; sequence: number; fact: Exclude<ClientFact, { kind: "conversation" }> };
function event(raw: unknown, conversation: string, p: Provider): CuratedEvent {
  const row = object(raw), data = object(row.data);
  if (row.threadId !== conversation || !CLIENT_FACT_EVENT_TYPES.includes(row.type as typeof CLIENT_FACT_EVENT_TYPES[number])) {
    throw new ClientFactReadError("source_conflict", "Source event escaped its conversation or requested types.");
  }
  const eventId = id(row.id, "event ID");
  if (!validSequence(row.seq)) throw new ClientFactReadError("invalid_source", "Invalid source event sequence.");
  const base = { conversation, eventId, sequence: row.seq };
  if (row.type === "thread/identity") return { eventId, sequence: base.sequence, fact: { ...base, kind: "native_session", session: session(data.providerThreadId, p) } };
  const scope = object(row.scope);
  if (scope.kind !== "turn") throw new ClientFactReadError("invalid_source", "Turn binding requires an explicit native BB turn scope.");
  const clientTurn = id(scope.turnId, "client turn");
  if (row.type === "turn/input/accepted") return { eventId, sequence: base.sequence, fact: {
    ...base, kind: "turn_input", clientTurn, clientRequest: id(data.clientRequestId, "client request"), session: session(data.providerThreadId, p),
  } };
  return { eventId, sequence: base.sequence, fact: { ...base, kind: "turn_checkpoint", clientTurn,
    session: data.providerThreadId === null ? null : session(data.providerThreadId, p),
    checkpoint: data.providerCheckpointId === undefined ? null : {
      issuer: p === "codex" ? "codex:turn" : "claude-code:message", id: id(data.providerCheckpointId, "provider checkpoint"),
    },
  } };
}
function bytes(raw: unknown): number { return Buffer.byteLength(JSON.stringify(raw), "utf8"); }

/**
 * No timer, scheduler, database or listener is installed. The caller's signal
 * owns cancellation; an unresolved SDK operation remains awaited even after
 * cancellation so central admission cannot release an occupied source slot.
 */
export async function readClientFactBatch(sdk: ClientFactSdk, rawInput: unknown, options: {
  source: ClientFactSource; signal: AbortSignal; limits?: Partial<ClientFactLimits>; clock?: () => number;
}): Promise<ClientFactBatch> {
  const input = parseClientFactRequest(rawInput), limits = { ...CLIENT_FACT_LIMITS };
  let source: ClientFactSource;
  try { source = parseConfiguredClientFactSource(options.source); } catch { throw new ClientFactReadError("invalid_request", "Invalid configured client-fact source."); }
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!(key in limits) || !Number.isSafeInteger(value) || value < 1 || value > CLIENT_FACT_LIMITS[key as keyof ClientFactLimits]) throw new ClientFactReadError("invalid_request", "Client-fact limits may only lower fixed ceilings.");
    (limits as Record<string, number>)[key] = value;
  }
  if (input.conversations.length > limits.conversations || new Set(input.conversations.map(row => row.id)).size !== input.conversations.length) throw new ClientFactReadError("invalid_request", "Conversation selection exceeds its bound or repeats an ID.");
  const now = options.clock ?? Date.now, started = now();
  const result: ClientFactBatch = { version: 1, dataset: CLIENT_FACT_DATASET, source,
    state: "partial", resetReason: null, facts: [], cursors: [], discovery: null,
    coverage: { complete: false, reasons: ["mutable_discovery", "historical_parentage_unknown", "source_reset_not_fully_detectable"], claudeHttpTurn: "unsupported" },
    budget: { calls: 0, workRows: 0, receivedBytes: 0 } };
  const alive = () => {
    if (options.signal.aborted) throw new ClientFactReadError("cancelled", "Client-fact source read cancelled; no cursor may be committed.");
    if (now() - started >= limits.elapsedMs) throw new ClientFactReadError("read_budget", "Client-fact source elapsed-time budget exhausted.");
  };
  const read = async <T>(work: number, run: () => Promise<T>): Promise<T> => {
    alive();
    if (result.budget.calls + 1 > limits.calls || result.budget.workRows + work > limits.workRows) throw new ClientFactReadError("read_budget", "Client-fact aggregate SDK call/work budget exhausted.");
    result.budget.calls++; result.budget.workRows += work;
    const value = await run();
    alive();
    result.budget.receivedBytes += bytes(value);
    if (result.budget.receivedBytes > limits.receivedBytes) throw new ClientFactReadError("read_budget", "Client-fact aggregate received-byte budget exhausted.");
    return value;
  };
  const reset = (reason: NonNullable<ClientFactBatch["resetReason"]>): ClientFactBatch => {
    result.state = "reset_required"; result.resetReason = reason; result.facts = []; result.cursors = []; result.discovery = null;
    result.coverage.reasons.push(reason);
    if (bytes(result) > limits.outputBytes) throw new ClientFactReadError("read_budget", "Client-fact reset output exceeds its fixed byte budget.");
    return result;
  };
  alive();
  if (input.expectedSource !== null && (input.expectedSource.namespace !== source.namespace || input.expectedSource.epoch !== source.epoch)) return reset("source_epoch_mismatch");
  const seenSessions = new Map<string, string>(), seenNativeTurns = new Map<string, string>(), turnSessions = new Map<string, string>();
  const append = (fact: ClientFact) => {
    if (fact.kind !== "conversation" && fact.session !== null) {
      const key = JSON.stringify(fact.session), old = seenSessions.get(key);
      if (old !== undefined && old !== fact.conversation) throw new ClientFactReadError("source_conflict", "Native session is ambiguously bound to multiple conversations.");
      seenSessions.set(key, fact.conversation);
      if (fact.kind === "turn_input" || fact.kind === "turn_checkpoint") {
        const turn = JSON.stringify([fact.conversation, fact.clientTurn]), previous = turnSessions.get(turn);
        if (previous !== undefined && previous !== key) throw new ClientFactReadError("source_conflict", "Client turn carries contradictory native sessions.");
        turnSessions.set(turn, key);
      }
    }
    if (fact.kind === "turn_checkpoint" && fact.checkpoint?.issuer === "codex:turn") {
      const key = JSON.stringify([fact.session, fact.checkpoint]), value = JSON.stringify([fact.conversation, fact.clientTurn]), old = seenNativeTurns.get(key);
      if (old !== undefined && old !== value) throw new ClientFactReadError("source_conflict", "Codex checkpoint is bound to conflicting client turns.");
      seenNativeTurns.set(key, value);
    }
    result.facts.push(fact);
    if (bytes(result) > limits.outputBytes) throw new ClientFactReadError("read_budget", "Client-fact curated output exceeds its fixed byte budget.");
  };
  for (const selected of input.conversations) {
    const meta = metadata(await read(1, () => sdk.threads.get({ threadId: selected.id, signal: options.signal })), selected.id);
    if (selected.cursor !== null) {
      const at = selected.cursor.sequence;
      const anchors = await read(CLIENT_FACT_EVENT_TYPES.length, () => sdk.threads.events.list({ threadId: selected.id, afterSeq: String(at - 1), beforeSeq: String(at + 1), limit: "1", order: "asc", types: CLIENT_FACT_EVENT_TYPES, signal: options.signal }));
      if (anchors.length === 0) return reset("anchor_missing");
      if (anchors.length !== 1) throw new ClientFactReadError("source_conflict", "Source anchor read returned more than one event.");
      const held = event(anchors[0], selected.id, meta.provider);
      if (held.sequence !== at || held.eventId !== selected.cursor.eventId) return reset("anchor_changed");
      // Replaying the exact curated anchor lets Foundation compare its stored
      // digest too; an unchanged ID/sequence never excuses changed binding facts.
      append(held.fact);
    }
    const rows = await read(CLIENT_FACT_EVENT_TYPES.length * limits.eventRows, () => sdk.threads.events.list({ threadId: selected.id,
      ...(selected.cursor === null ? {} : { afterSeq: String(selected.cursor.sequence) }), limit: String(limits.eventRows), order: "asc", types: CLIENT_FACT_EVENT_TYPES, signal: options.signal }));
    if (rows.length > limits.eventRows) throw new ClientFactReadError("source_conflict", "Source event page exceeds its requested row limit.");
    append(meta);
    let cursor = selected.cursor;
    for (const row of rows) {
      const held = event(row, selected.id, meta.provider);
      if (held.sequence <= (cursor?.sequence ?? 0)) throw new ClientFactReadError("source_conflict", "Source event page is not strictly after its exact cursor.");
      append(held.fact); cursor = { sequence: held.sequence, eventId: held.eventId };
    }
    result.cursors.push({ conversation: selected.id, cursor, pageExhausted: rows.length < limits.eventRows });
    if (rows.length === limits.eventRows) result.coverage.reasons.push("event_page_capped");
  }
  if (input.discovery !== null) {
    const rows = await read(limits.discoveryRows, () => sdk.threads.list({ includeHidden: true, limit: limits.discoveryRows, offset: input.discovery!.offset, signal: options.signal }));
    if (rows.length > limits.discoveryRows) throw new ClientFactReadError("source_conflict", "Source discovery page exceeds its requested row limit.");
    const discovered = rows.flatMap(row => {
      const value = object(row);
      if (value.providerId !== "codex" && value.providerId !== "claude-code") {
        result.coverage.reasons.push("unsupported_provider_excluded"); return [];
      }
      return [metadata(row)];
    });
    if (new Set(discovered.map(row => row.conversation)).size !== discovered.length) throw new ClientFactReadError("source_conflict", "Source discovery page repeats a conversation.");
    for (const fact of discovered) if (!input.conversations.some(row => row.id === fact.conversation)) append(fact);
    result.discovery = { offset: input.discovery.offset, nextOffset: input.discovery.offset + rows.length,
      conversations: discovered.map(row => row.conversation), pageExhausted: rows.length < limits.discoveryRows };
  }
  alive(); result.coverage.reasons = [...new Set(result.coverage.reasons)];
  if (bytes(result) > limits.outputBytes) throw new ClientFactReadError("read_budget", "Client-fact curated output exceeds its fixed byte budget.");
  return result;
}
