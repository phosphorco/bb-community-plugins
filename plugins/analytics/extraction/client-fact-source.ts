import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const CLIENT_FACT_DATASET = "client-conversation-v2" as const;
export const CLIENT_FACT_EVENT_TYPES = [
  "thread/identity", "turn/input/accepted", "turn/completed", "item/completed", "thread/extensionState/updated",
] as const;
export const CLIENT_FACT_LIMITS = Object.freeze({
  conversations: 2, discoveryRows: 25, calls: 8, eventRows: 25,
  workRows: 600, receivedBytes: 8 * 1024 * 1024, outputBytes: 256 * 1024, elapsedMs: 2_000,
});
const MAX_SEQUENCE = 9_007_199_254_740_990;
const RESPONSE_KIND = "provider-claude-code/response-identity";
const NATIVE_REASONS = ["canonical_input_not_accepted", "turn_settled", "prior_turn_response", "native_session_conflict", "subagent_response", "identity_conflict", "identity_capacity_exceeded", "identity_enrichment_limit", "invalid_identity", "synthetic_response", "payload_limit"] as const;
export type ClientFactLimits = { [K in keyof typeof CLIENT_FACT_LIMITS]: number };
type SdkThreads = BbPluginApi["sdk"]["threads"];
export type ClientFactSdk = { threads: Pick<SdkThreads, "get" | "list"> & { events: Pick<SdkThreads["events"], "list"> } };
export interface ClientFactSource { namespace: string; epoch: string; }
type EventType = typeof CLIENT_FACT_EVENT_TYPES[number];
export interface ClientFactCursor { sequence: number; eventId: string; eventType: EventType; disposition: "fact" | "outside_projection"; }
export interface ClientFactRequest {
  version: 2; expectedSource: ClientFactSource;
  conversations: { id: string; cursor: ClientFactCursor | null }[]; discovery: { offset: number } | null;
}
type Provider = "codex" | "claude-code";
type Session = { issuer: "codex:header" | "claude-code:header"; id: string };
type ClaudeSession = { issuer: "claude-code:header"; id: string };
type ResponseId = { issuer: "anthropic:message"; id: string };
type RequestId = { issuer: "anthropic:request"; id: string };
type EventIdentity = { conversation: string; eventId: string; sequence: number };
type NativeDetail = { phase: "message_start" | "assistant"; aborted: true | null; supersedesSdkUuids: string[] };
export type ClientFact =
  | { kind: "conversation"; conversation: string; provider: Provider; displayParent: string | null; sourceFork: string | null; lifecycleOwner: string | null; relationshipRevision: null }
  | (EventIdentity & { kind: "native_session"; session: Session })
  | (EventIdentity & { kind: "turn_input"; clientTurn: string; clientRequest: string; session: Session })
  | (EventIdentity & { kind: "turn_checkpoint"; clientTurn: string; session: Session | null; checkpoint: { issuer: "codex:turn" | "claude-code:message"; id: string } | null })
  | (EventIdentity & NativeDetail & { kind: "native_response_id"; session: ClaudeSession; clientTurn: string; response: ResponseId; providerRequest: RequestId | null })
  | (EventIdentity & NativeDetail & { kind: "native_response_coverage"; session: ClaudeSession | null; response: ResponseId | null; providerRequest: RequestId | null; reason: typeof NATIVE_REASONS[number]; parentToolUseId: string | null });
type EventFact = Exclude<ClientFact, { kind: "conversation" }>;
export interface ClientFactBatch {
  version: 2; dataset: typeof CLIENT_FACT_DATASET; source: ClientFactSource;
  state: "partial" | "reset_required"; resetReason: "source_epoch_mismatch" | "anchor_missing" | "anchor_changed" | null;
  facts: ClientFact[];
  cursors: { conversation: string; cursor: ClientFactCursor | null; pageExhausted: boolean; scannedRows: number; projectedRows: number; outsideProjectionRows: number }[];
  discovery: { offset: number; nextOffset: number; conversations: string[]; pageExhausted: boolean } | null;
  coverage: { complete: false; reasons: string[]; claudeHttpTurn: "response_identity_partial" };
  budget: { calls: number; workRows: number; receivedBytes: number };
}
export class ClientFactReadError extends Error {
  readonly code: "invalid_request" | "invalid_source" | "source_conflict" | "read_budget" | "cancelled" | "source_unavailable";
  readonly conversation: string | null;
  readonly sourceError: unknown;
  constructor(code: ClientFactReadError["code"], message: string, conversation: string | null = null, sourceError?: unknown) {
    super(message); this.name = "ClientFactReadError"; this.code = code; this.conversation = conversation; this.sourceError = sourceError;
  }
}
function invalid(message: string): never { throw new ClientFactReadError("invalid_source", message); }
function object(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid("Client-fact source row must be an object.");
  return raw as Record<string, unknown>;
}
function closed(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  const value = object(raw), actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new Error("Unexpected closed client-fact fields.");
  return value;
}
export function validClientFactId(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw.length || raw.length > 256 || /[\u0000-\u001f\u007f]/u.test(raw)) return false;
  for (let i = 0; i < raw.length; i++) {
    const unit = raw.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = raw.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function id(raw: unknown, field: string): string { if (!validClientFactId(raw)) return invalid(`Invalid client-fact source ${field}.`); return raw; }
function nullableId(raw: unknown, field: string): string | null { return raw === null ? null : id(raw, field); }
function sequence(raw: unknown): raw is number { return Number.isSafeInteger(raw) && (raw as number) >= 1 && (raw as number) <= MAX_SEQUENCE; }
function bytes(raw: unknown): number { const wire = JSON.stringify(raw); if (wire === undefined) return invalid("Source returned a non-JSON value."); return Buffer.byteLength(wire, "utf8"); }
function curatedBytes(raw: unknown): number {
  const wire = JSON.stringify(raw).replace(/[&<>\u2028\u2029]/gu, value => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return Buffer.byteLength(wire, "utf8");
}
export function parseConfiguredClientFactSource(raw: unknown): ClientFactSource {
  const value = closed(raw, ["namespace", "epoch"]);
  if (!validClientFactId(value.namespace) || !validClientFactId(value.epoch)) throw new Error("Invalid configured client-fact source.");
  return { namespace: value.namespace, epoch: value.epoch };
}
export function parseClientFactRequest(raw: unknown): ClientFactRequest {
  try {
    const value = closed(raw, ["version", "expectedSource", "conversations", "discovery"]);
    if (value.version !== 2 || !Array.isArray(value.conversations) || value.conversations.length > 2) throw new Error("Invalid request.");
    const expectedSource = parseConfiguredClientFactSource(value.expectedSource);
    const conversations = value.conversations.map(raw => {
      const row = closed(raw, ["id", "cursor"]); if (!validClientFactId(row.id)) throw new Error("Invalid conversation.");
      let cursor: ClientFactCursor | null = null;
      if (row.cursor !== null) {
        const held = closed(row.cursor, ["sequence", "eventId", "eventType", "disposition"]);
        if (!sequence(held.sequence) || !validClientFactId(held.eventId) || !CLIENT_FACT_EVENT_TYPES.includes(held.eventType as EventType) || (held.disposition !== "fact" && held.disposition !== "outside_projection") || (held.disposition === "outside_projection" && held.eventType !== "item/completed" && held.eventType !== "thread/extensionState/updated")) throw new Error("Invalid cursor.");
        cursor = { sequence: held.sequence, eventId: held.eventId, eventType: held.eventType as EventType, disposition: held.disposition };
      }
      return { id: row.id, cursor };
    });
    if (new Set(conversations.map(row => row.id)).size !== conversations.length) throw new Error("Duplicate conversation.");
    let discovery: ClientFactRequest["discovery"] = null;
    if (value.discovery !== null) { const held = closed(value.discovery, ["offset"]); if (!Number.isSafeInteger(held.offset) || (held.offset as number) < 0 || (held.offset as number) > MAX_SEQUENCE - 25) throw new Error("Invalid discovery offset."); discovery = { offset: held.offset as number }; }
    return { version: 2, expectedSource, conversations, discovery };
  } catch { throw new ClientFactReadError("invalid_request", "Invalid closed V2 client-fact request."); }
}
function provider(raw: unknown): Provider { if (raw !== "codex" && raw !== "claude-code") return invalid("Client-fact source provider is unsupported."); return raw; }
function session(raw: unknown, p: Provider): Session { return { issuer: p === "codex" ? "codex:header" : "claude-code:header", id: id(raw, "native session") }; }
function metadata(raw: unknown, expected?: string): Extract<ClientFact, { kind: "conversation" }> {
  const row = object(raw), conversation = id(row.id, "conversation");
  if (expected !== undefined && conversation !== expected) throw new ClientFactReadError("source_conflict", "Source returned another conversation.");
  return { kind: "conversation", conversation, provider: provider(row.providerId), displayParent: nullableId(row.parentThreadId, "display parent"), sourceFork: nullableId(row.sourceThreadId, "source fork"), lifecycleOwner: nullableId(row.lifecycleOwnerThreadId, "lifecycle owner"), relationshipRevision: null };
}
function nativePayload(raw: unknown, bound: boolean): NativeDetail & { nativeSessionId: string | null; messageId: string | null; providerRequestId: string | null; parentToolUseId: string | null; reason: typeof NATIVE_REASONS[number] | null } {
  try {
    const value = closed(raw, ["version", "binding", "reason", "phase", "nativeSessionId", "messageId", "providerRequestId", "parentToolUseId", "aborted", "supersedesSdkUuids"]);
    if (value.version !== 1 || value.binding !== (bound ? "turn_scope" : "unbound") || (bound ? value.reason !== null : !NATIVE_REASONS.includes(value.reason as typeof NATIVE_REASONS[number])) || (value.phase !== "message_start" && value.phase !== "assistant") || (value.aborted !== true && value.aborted !== null) || !Array.isArray(value.supersedesSdkUuids) || value.supersedesSdkUuids.length > 16 || bytes(value) > 4096) throw new Error("Invalid native payload.");
    const nativeSessionId = nullableId(value.nativeSessionId, "response session"), messageId = nullableId(value.messageId, "response message"), providerRequestId = nullableId(value.providerRequestId, "provider request"), parentToolUseId = nullableId(value.parentToolUseId, "parent tool use");
    if (bound && (nativeSessionId === null || messageId === null || parentToolUseId !== null)) throw new Error("Invalid bound response.");
    return { phase: value.phase, aborted: value.aborted, supersedesSdkUuids: value.supersedesSdkUuids.map(v => id(v, "superseded SDK UUID")), nativeSessionId, messageId, providerRequestId, parentToolUseId, reason: value.reason as typeof NATIVE_REASONS[number] | null };
  } catch { return invalid("Declared native response identity payload is invalid."); }
}
type CuratedEvent = { cursor: ClientFactCursor; fact: EventFact | null };
function event(raw: unknown, conversation: string, p: Provider): CuratedEvent {
  const row = object(raw);
  if (row.threadId !== conversation || !CLIENT_FACT_EVENT_TYPES.includes(row.type as EventType)) throw new ClientFactReadError("source_conflict", "Source event escaped its conversation or requested types.");
  const eventId = id(row.id, "event ID"); if (!sequence(row.seq)) return invalid("Invalid source event sequence.");
  const cursor: ClientFactCursor = { sequence: row.seq, eventId, eventType: row.type as EventType, disposition: "fact" };
  const data = object(row.data), base = { conversation, eventId, sequence: row.seq };
  if (row.type === "thread/identity") return { cursor, fact: { ...base, kind: "native_session", session: session(data.providerThreadId, p) } };
  if (row.type === "item/completed" || row.type === "thread/extensionState/updated") {
    const bound = row.type === "item/completed";
    const item = bound ? object(data.item) : data;
    if ((bound && item.type !== "extension") || item.kind !== RESPONSE_KIND) return { cursor: { ...cursor, disposition: "outside_projection" }, fact: null };
    if (p !== "claude-code") throw new ClientFactReadError("source_conflict", "Claude response identity appeared on another provider.");
    const scope = object(row.scope), payload = nativePayload(item.payload, bound);
    if (scope.kind !== (bound ? "turn" : "thread")) return invalid("Declared response identity has the wrong explicit scope.");
    const detail = { phase: payload.phase, aborted: payload.aborted, supersedesSdkUuids: payload.supersedesSdkUuids };
    const native = payload.nativeSessionId === null ? null : { issuer: "claude-code:header" as const, id: payload.nativeSessionId };
    const response = payload.messageId === null ? null : { issuer: "anthropic:message" as const, id: payload.messageId };
    const providerRequest = payload.providerRequestId === null ? null : { issuer: "anthropic:request" as const, id: payload.providerRequestId };
    if (bound) return { cursor, fact: { ...base, ...detail, kind: "native_response_id", session: native!, response: response!, providerRequest, clientTurn: id(scope.turnId, "client turn") } };
    return { cursor, fact: { ...base, ...detail, kind: "native_response_coverage", session: native, response, providerRequest, reason: payload.reason!, parentToolUseId: payload.parentToolUseId } };
  }
  const scope = object(row.scope); if (scope.kind !== "turn") return invalid("Turn binding requires an explicit native BB turn scope.");
  const clientTurn = id(scope.turnId, "client turn");
  if (row.type === "turn/input/accepted") return { cursor, fact: { ...base, kind: "turn_input", clientTurn, clientRequest: id(data.clientRequestId, "client request"), session: session(data.providerThreadId, p) } };
  return { cursor, fact: { ...base, kind: "turn_checkpoint", clientTurn, session: data.providerThreadId === null ? null : session(data.providerThreadId, p), checkpoint: data.providerCheckpointId === undefined ? null : { issuer: p === "codex" ? "codex:turn" : "claude-code:message", id: id(data.providerCheckpointId, "provider checkpoint") } } };
}
function contextual(error: unknown, conversation: string | null): ClientFactReadError {
  if (error instanceof ClientFactReadError) return new ClientFactReadError(error.code, error.message, error.code === "invalid_request" || error.code === "cancelled" ? null : conversation, error.sourceError);
  const status = error !== null && typeof error === "object" && "status" in error ? Reflect.get(error, "status") : null;
  return new ClientFactReadError("source_unavailable", "The configured client-fact source could not be read. No batch or cursor was published. The Analytics server log contains the source error.", status === 401 || status === 403 ? null : conversation, error);
}

/** One finite read; the central collector owns admission, scheduling and persistence. */
export async function readClientFactBatch(sdk: ClientFactSdk, rawInput: unknown, options: { source: ClientFactSource; signal: AbortSignal; limits?: Partial<ClientFactLimits>; clock?: () => number }): Promise<ClientFactBatch> {
  const input = parseClientFactRequest(rawInput), limits = { ...CLIENT_FACT_LIMITS };
  let source: ClientFactSource;
  try { source = parseConfiguredClientFactSource(options.source); } catch { throw new ClientFactReadError("invalid_request", "Invalid configured client-fact source."); }
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!(key in limits) || !Number.isSafeInteger(value) || value < 1 || value > CLIENT_FACT_LIMITS[key as keyof ClientFactLimits]) throw new ClientFactReadError("invalid_request", "Client-fact limits may only lower fixed ceilings.");
    (limits as Record<string, number>)[key] = value;
  }
  if (input.conversations.length > limits.conversations) throw new ClientFactReadError("invalid_request", "Conversation selection exceeds its bound.");
  const now = options.clock ?? Date.now, started = now();
  const result: ClientFactBatch = { version: 2, dataset: CLIENT_FACT_DATASET, source, state: "partial", resetReason: null, facts: [], cursors: [], discovery: null, coverage: { complete: false, reasons: ["mutable_discovery", "historical_parentage_unknown", "source_reset_not_fully_detectable"], claudeHttpTurn: "response_identity_partial" }, budget: { calls: 0, workRows: 0, receivedBytes: 0 } };
  const alive = () => { if (options.signal.aborted) throw new ClientFactReadError("cancelled", "Client-fact source read cancelled; no cursor may be committed."); if (now() - started >= limits.elapsedMs) throw new ClientFactReadError("read_budget", "Client-fact elapsed-time budget exhausted."); };
  const read = async <T>(work: number, run: () => Promise<T>): Promise<T> => {
    alive(); if (result.budget.calls + 1 > limits.calls || result.budget.workRows + work > limits.workRows) throw new ClientFactReadError("read_budget", "Client-fact aggregate SDK call/work budget exhausted.");
    result.budget.calls++; result.budget.workRows += work;
    const value = await run(); result.budget.receivedBytes += bytes(value); alive();
    if (result.budget.receivedBytes > limits.receivedBytes) throw new ClientFactReadError("read_budget", "Client-fact aggregate received-byte budget exhausted.");
    return value;
  };
  const finish = () => { alive(); result.coverage.reasons = [...new Set(result.coverage.reasons)].sort(); if (curatedBytes(result) > limits.outputBytes) throw new ClientFactReadError("read_budget", "Client-fact curated output exceeds its byte budget."); return result; };
  const reset = (reason: NonNullable<ClientFactBatch["resetReason"]>) => { result.state = "reset_required"; result.resetReason = reason; result.facts = []; result.cursors = []; result.discovery = null; result.coverage.reasons.push(reason); return finish(); };
  const scannedIds = new Set<string>(), scannedPositions = new Set<string>();
  const track = (held: CuratedEvent, conversation: string) => {
    const position = JSON.stringify([conversation, held.cursor.sequence]);
    if (scannedIds.has(held.cursor.eventId) || scannedPositions.has(position)) throw new ClientFactReadError("source_conflict", "Source repeated a scanned event identity or position.");
    scannedIds.add(held.cursor.eventId); scannedPositions.add(position);
  };
  const events = new Set<string>(), positions = new Set<string>(), turnSessions = new Map<string, string>(), codexTurns = new Map<string, string>();
  const append = (fact: ClientFact) => {
    if (fact.kind !== "conversation") {
      const position = JSON.stringify([fact.conversation, fact.sequence]);
      if (events.has(fact.eventId) || positions.has(position)) throw new ClientFactReadError("source_conflict", "Source repeated an immutable event identity or position.");
      events.add(fact.eventId); positions.add(position);
      if ((fact.kind === "turn_input" || fact.kind === "turn_checkpoint") && fact.session !== null) {
        const turn = JSON.stringify([fact.conversation, fact.clientTurn]), native = JSON.stringify(fact.session), previous = turnSessions.get(turn);
        if (previous !== undefined && previous !== native) throw new ClientFactReadError("source_conflict", "Client turn carries contradictory native sessions.");
        turnSessions.set(turn, native);
      }
      if (fact.kind === "turn_checkpoint" && fact.session !== null && fact.checkpoint?.issuer === "codex:turn") {
        const native = JSON.stringify([fact.session, fact.checkpoint]), owner = JSON.stringify([fact.conversation, fact.clientTurn]), previous = codexTurns.get(native);
        if (previous !== undefined && previous !== owner) throw new ClientFactReadError("source_conflict", "Codex checkpoint carries contradictory client turns.");
        codexTurns.set(native, owner);
      }
    }
    result.facts.push(fact); if (result.facts.length > 80 || curatedBytes(result) > limits.outputBytes) throw new ClientFactReadError("read_budget", "Client-fact curated output exceeds its fact/byte budget.");
  };
  alive();
  if (input.expectedSource.namespace !== source.namespace || input.expectedSource.epoch !== source.epoch) return reset("source_epoch_mismatch");
  for (const selected of input.conversations) {
    try {
      const meta = metadata(await read(1, () => sdk.threads.get({ threadId: selected.id, signal: options.signal })), selected.id);
      if (selected.cursor !== null) {
        const at = selected.cursor.sequence;
        const anchors = await read(5, () => sdk.threads.events.list({ threadId: selected.id, afterSeq: String(at - 1), beforeSeq: String(at + 1), limit: "1", order: "asc", types: CLIENT_FACT_EVENT_TYPES, signal: options.signal }));
        if (anchors.length === 0) return reset("anchor_missing");
        if (anchors.length !== 1) throw new ClientFactReadError("source_conflict", "Source anchor read returned more than one event.");
        const held = event(anchors[0], selected.id, meta.provider); track(held, selected.id);
        if (JSON.stringify(held.cursor) !== JSON.stringify(selected.cursor)) return reset("anchor_changed");
        if (held.fact !== null) append(held.fact);
      }
      const rows = await read(5 * limits.eventRows, () => sdk.threads.events.list({ threadId: selected.id, ...(selected.cursor === null ? {} : { afterSeq: String(selected.cursor.sequence) }), limit: String(limits.eventRows), order: "asc", types: CLIENT_FACT_EVENT_TYPES, signal: options.signal }));
      if (rows.length > limits.eventRows) throw new ClientFactReadError("source_conflict", "Source event page exceeds its row limit.");
      append(meta); let cursor = selected.cursor, projectedRows = 0;
      for (const row of rows) {
        const held = event(row, selected.id, meta.provider); track(held, selected.id);
        if (held.cursor.sequence <= (cursor?.sequence ?? 0)) throw new ClientFactReadError("source_conflict", "Source event page is not strictly after its cursor.");
        if (held.fact !== null) { append(held.fact); projectedRows++; } cursor = held.cursor;
      }
      result.cursors.push({ conversation: selected.id, cursor, pageExhausted: rows.length < limits.eventRows, scannedRows: rows.length, projectedRows, outsideProjectionRows: rows.length - projectedRows });
      if (rows.length === limits.eventRows) result.coverage.reasons.push("event_page_capped");
    } catch (error) { throw contextual(error, selected.id); }
  }
  if (input.discovery !== null) {
    try {
      const rows = await read(limits.discoveryRows, () => sdk.threads.list({ includeHidden: true, limit: limits.discoveryRows, offset: input.discovery!.offset, signal: options.signal }));
      if (rows.length > limits.discoveryRows) throw new ClientFactReadError("source_conflict", "Source discovery page exceeds its row limit.");
      const discovered = rows.flatMap(row => { const value = object(row); if (value.providerId !== "codex" && value.providerId !== "claude-code") { result.coverage.reasons.push("unsupported_provider_excluded"); return []; } return [metadata(row)]; });
      if (new Set(discovered.map(row => row.conversation)).size !== discovered.length) throw new ClientFactReadError("source_conflict", "Source discovery repeats a conversation.");
      for (const fact of discovered) if (!input.conversations.some(row => row.id === fact.conversation)) append(fact);
      result.discovery = { offset: input.discovery.offset, nextOffset: input.discovery.offset + rows.length, conversations: discovered.map(row => row.conversation), pageExhausted: rows.length < limits.discoveryRows };
    } catch (error) { throw contextual(error, null); }
  }
  return finish();
}
