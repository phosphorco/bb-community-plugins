import type { BbPluginApi } from "@get-bb/plugin-sdk";

type SdkThreads = BbPluginApi["sdk"]["threads"];
type ListArgs = NonNullable<Parameters<SdkThreads["list"]>[0]>;
type GetArgs = Parameters<SdkThreads["get"]>[0];
type EventsListArgs = Parameters<SdkThreads["events"]["list"]>[0];

export type RetainedSourceThread = Awaited<ReturnType<SdkThreads["list"]>>[number];
export type RetainedSourceThreadResult = Awaited<ReturnType<SdkThreads["get"]>>;
export type RetainedSourceEvent = Awaited<ReturnType<SdkThreads["events"]["list"]>>[number];

/** The smallest public SDK port needed by retained extraction. */
export type RetainedSourceSdk = {
  threads: Pick<SdkThreads, "list" | "get"> & {
    events: Pick<SdkThreads["events"], "list">;
  };
};

export interface RetainedSourceLimits {
  listPageSize: number;
  eventPageSize: number;
  maxCalls: number;
  maxListPages: number;
  maxEventPages: number;
  maxRows: number;
  maxResponseBytes: number;
}

/**
 * Fixed adapter ceilings. The public SDK exposes no transport byte limit, so
 * these are the source policy maxima rather than a claim about SDK receive
 * memory. Callers may lower every value, but cannot raise the ceiling.
 */
export const RETAINED_SOURCE_POLICY_MAXIMA: Readonly<RetainedSourceLimits> = Object.freeze({
  listPageSize: 200,
  // BB's public thread-events endpoint permits at most 100 events per request.
  eventPageSize: 100,
  // Preserve the prior 32,000-event call budget across 100-event pages.
  maxCalls: 320,
  maxListPages: 64,
  maxEventPages: 512,
  maxRows: 50_000,
  maxResponseBytes: 32 * 1024 * 1024,
});

export const DEFAULT_RETAINED_SOURCE_LIMITS = RETAINED_SOURCE_POLICY_MAXIMA;
export const RETAINED_SOURCE_MAX_IDENTIFIER_BYTES = 512;
export const RETAINED_SOURCE_MAX_CURSOR_BYTES = 64;
export const RETAINED_SOURCE_MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

export interface RetainedSourceBudgetUsage {
  calls: number;
  listPages: number;
  eventPages: number;
  rows: number;
  responseBytes: number;
}

export interface RetainedSourcePageMetadata {
  operation: "list" | "events";
  page: number;
  requestedLimit: number;
  returnedRows: number;
  responseBytes: number;
  pageExhausted: boolean;
  budget: RetainedSourceBudgetUsage;
}

export interface RetainedSourceListPage {
  rows: readonly RetainedSourceThread[];
  metadata: RetainedSourcePageMetadata & {
    operation: "list";
    offset: number;
    nextOffset: number;
  };
}

export interface RetainedSourceEventPage {
  /** Ephemeral SDK rows. The adapter does not persist or retain raw events. */
  rows: readonly RetainedSourceEvent[];
  metadata: RetainedSourcePageMetadata & {
    operation: "events";
    threadId: string;
    requestedAfterSeq: string | null;
    returnedMaxSeq: string | null;
    /** The input cursor carried forward when the response is empty. */
    sourceAfterSeq: string | null;
  };
}

export type RetainedSourceThreadObservation =
  | {
    kind: "found";
    thread: RetainedSourceThreadResult;
    responseBytes: number;
    budget: RetainedSourceBudgetUsage;
  }
  | {
    kind: "confirmed-not-found";
    responseBytes: null;
    budget: RetainedSourceBudgetUsage;
  };

export type RetainedSourceBudgetReason =
  | "max-calls"
  | "max-list-pages"
  | "max-event-pages"
  | "max-rows"
  | "max-response-bytes";

export class RetainedSourceBudgetError extends Error {
  readonly code = "retained_source_budget_exceeded";
  readonly reason: RetainedSourceBudgetReason;
  readonly operation: "list" | "get" | "events";
  readonly usage: RetainedSourceBudgetUsage;
  readonly responseBytes: number | null;

  constructor(
    reason: RetainedSourceBudgetReason,
    operation: "list" | "get" | "events",
    usage: RetainedSourceBudgetUsage,
    responseBytes: number | null = null,
  ) {
    super(`Retained source ${reason} budget exceeded during ${operation}.`);
    this.reason = reason;
    this.operation = operation;
    this.usage = usage;
    this.responseBytes = responseBytes;
    this.name = "RetainedSourceBudgetError";
  }
}

export class RetainedSourceBusyError extends Error {
  readonly code = "retained_source_busy";

  constructor() {
    super("Retained source adapter already has an in-flight operation.");
    this.name = "RetainedSourceBusyError";
  }
}

export class RetainedSourceResponseError extends Error {
  readonly code = "retained_source_invalid_response";

  constructor(message: string) {
    super(message);
    this.name = "RetainedSourceResponseError";
  }
}

interface BbHttpErrorShape {
  readonly name: "BbHttpError";
  readonly status: number;
  readonly code: string | null | undefined;
}

/**
 * The plugin SDK may be loaded from a different package instance than this
 * module. Structural checking preserves the public error contract without an
 * instanceof dependency on the fork or a second SDK copy.
 */
export function isExactThreadNotFound(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const candidate = error as Partial<BbHttpErrorShape>;
  return candidate.name === "BbHttpError"
    && candidate.status === 404
    && candidate.code === "thread_not_found";
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function validateLimits(input: RetainedSourceLimits): RetainedSourceLimits {
  const names: readonly (keyof RetainedSourceLimits)[] = [
    "listPageSize",
    "eventPageSize",
    "maxCalls",
    "maxListPages",
    "maxEventPages",
    "maxRows",
    "maxResponseBytes",
  ];
  for (const name of names) {
    const value = positiveInteger(input[name], name);
    if (value > RETAINED_SOURCE_POLICY_MAXIMA[name]) {
      throw new RangeError(`${name} exceeds the fixed retained source policy maximum.`);
    }
  }
  return { ...input };
}

interface SerializedMeasurement {
  bytes: number;
  exceedsLimit: boolean;
}

function serializeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new RetainedSourceResponseError("SDK response is not JSON-serializable.");
    return serialized;
  } catch (error) {
    if (error instanceof RetainedSourceResponseError) throw error;
    throw new RetainedSourceResponseError("SDK response is not JSON-serializable.");
  }
}

/**
 * Arrays are measured one element at a time so an oversized SDK page does
 * not create a second whole-array JSON string. This is an accepted parsed
 * response budget, not a transport receive-memory bound: the SDK has already
 * parsed the response before the adapter sees it.
 */
function measureSerializedBytes(value: unknown, limit: number): SerializedMeasurement {
  if (!Array.isArray(value)) {
    const bytes = Buffer.byteLength(serializeJson(value), "utf8");
    return { bytes, exceedsLimit: bytes > limit };
  }

  let bytes = 1;
  for (let index = 0; index < value.length; index += 1) {
    const element = serializeJson(value[index]);
    bytes += (index === 0 ? 0 : 1) + Buffer.byteLength(element, "utf8");
    if (bytes > limit) return { bytes, exceedsLimit: true };
  }
  bytes += 1;
  return { bytes, exceedsLimit: bytes > limit };
}

function assertArray<T>(value: T[] | readonly T[] | unknown, operation: string): readonly T[] {
  if (!Array.isArray(value)) throw new RetainedSourceResponseError(`${operation} SDK response was not an array.`);
  return value;
}

function assertOffset(offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a nonnegative safe integer.");
  return offset;
}

function assertThreadId(threadId: string): string {
  if (
    threadId.length === 0
    || Buffer.byteLength(threadId, "utf8") > RETAINED_SOURCE_MAX_IDENTIFIER_BYTES
  ) throw new TypeError("threadId must be a nonempty bounded identifier.");
  return threadId;
}

function assertCursor(cursor: string | null | undefined): string | null {
  if (cursor == null) return null;
  if (
    Buffer.byteLength(cursor, "utf8") > RETAINED_SOURCE_MAX_CURSOR_BYTES
    || !/^\d+$/.test(cursor)
  ) throw new TypeError("afterSeq must be a bounded decimal cursor.");
  const sequence = BigInt(cursor);
  if (sequence > BigInt(RETAINED_SOURCE_MAX_SEQUENCE)) {
    throw new TypeError("afterSeq exceeds the supported sequence range.");
  }
  return sequence.toString();
}

function validateEventRows(
  threadId: string,
  afterSeq: string | null,
  rows: readonly RetainedSourceEvent[],
  requestedLimit: number,
): {
  returnedMaxSeq: string | null;
  sourceAfterSeq: string | null;
} {
  if (rows.length > requestedLimit) {
    throw new RetainedSourceResponseError("events SDK response exceeded the requested row limit.");
  }
  let prior = afterSeq == null ? null : BigInt(afterSeq);
  let returnedMax: bigint | null = null;
  for (const row of rows) {
    if (row.threadId !== threadId) {
      throw new RetainedSourceResponseError("events SDK response contained a foreign thread row.");
    }
    if (!Number.isSafeInteger(row.seq) || row.seq < 0 || row.seq > RETAINED_SOURCE_MAX_SEQUENCE) {
      throw new RetainedSourceResponseError("events SDK response contained an invalid sequence.");
    }
    const sequence = BigInt(row.seq);
    if (prior != null && sequence <= prior) {
      throw new RetainedSourceResponseError("events SDK response was not strictly after the source cursor.");
    }
    prior = sequence;
    returnedMax = sequence;
  }
  return {
    returnedMaxSeq: returnedMax == null ? null : returnedMax.toString(),
    sourceAfterSeq: prior == null ? null : prior.toString(),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  throw error;
}

class RetainedSourceAdapterImpl {
  private readonly sdk: RetainedSourceSdk;
  private readonly limits: RetainedSourceLimits;
  private terminalBudgetFailure: RetainedSourceBudgetError | null = null;
  private busy = false;
  private readonly usage: RetainedSourceBudgetUsage = {
    calls: 0,
    listPages: 0,
    eventPages: 0,
    rows: 0,
    responseBytes: 0,
  };

  constructor(
    sdk: RetainedSourceSdk,
    limits: RetainedSourceLimits,
  ) {
    this.limits = validateLimits(limits);
    this.sdk = sdk;
  }

  private snapshot(): RetainedSourceBudgetUsage {
    return { ...this.usage };
  }

  private ensureUsable(operation: "list" | "get" | "events"): void {
    if (this.terminalBudgetFailure != null) throw this.terminalBudgetFailure;
    if (this.usage.responseBytes >= this.limits.maxResponseBytes) {
      const error = new RetainedSourceBudgetError("max-response-bytes", operation, this.snapshot());
      this.terminalBudgetFailure = error;
      throw error;
    }
  }

  private beginOperation(): void {
    if (this.busy) throw new RetainedSourceBusyError();
    this.busy = true;
  }

  private endOperation(): void {
    this.busy = false;
  }

  /** Preflight all limits, then increment call/page usage as one dispatch reservation. */
  private reserveOperation(
    operation: "list" | "get" | "events",
    paged: boolean,
  ): number | null {
    this.ensureUsable(operation);
    if (this.usage.calls >= this.limits.maxCalls) {
      throw new RetainedSourceBudgetError("max-calls", operation, this.snapshot());
    }
    const usedPages = operation === "list" ? this.usage.listPages : this.usage.eventPages;
    const pageLimit = operation === "list" ? this.limits.maxListPages : this.limits.maxEventPages;
    if (paged && usedPages >= pageLimit) {
      throw new RetainedSourceBudgetError(
        operation === "list" ? "max-list-pages" : "max-event-pages",
        operation,
        this.snapshot(),
      );
    }
    this.usage.calls += 1;
    if (!paged) return null;
    if (operation === "list") this.usage.listPages += 1;
    else this.usage.eventPages += 1;
    return usedPages + 1;
  }

  private acceptResponse(
    operation: "list" | "get" | "events",
    value: unknown,
    rows: number,
  ): number {
    if (this.usage.rows + rows > this.limits.maxRows) {
      throw new RetainedSourceBudgetError("max-rows", operation, this.snapshot());
    }
    const remainingBytes = this.limits.maxResponseBytes - this.usage.responseBytes;
    const measurement = measureSerializedBytes(value, remainingBytes);
    if (measurement.exceedsLimit) {
      const error = new RetainedSourceBudgetError(
        "max-response-bytes",
        operation,
        this.snapshot(),
        measurement.bytes,
      );
      this.terminalBudgetFailure = error;
      throw error;
    }
    this.usage.rows += rows;
    this.usage.responseBytes += measurement.bytes;
    return measurement.bytes;
  }

  async listPage(input: { offset: number; signal?: AbortSignal }): Promise<RetainedSourceListPage> {
    throwIfAborted(input.signal);
    this.beginOperation();
    try {
      const offset = assertOffset(input.offset);
      const remainingRows = this.limits.maxRows - this.usage.rows;
      if (remainingRows <= 0) {
        throw new RetainedSourceBudgetError("max-rows", "list", this.snapshot());
      }
      const limit = Math.min(this.limits.listPageSize, remainingRows);
      const args: ListArgs = {
        includeHidden: true,
        limit,
        offset,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      };
      const page = this.reserveOperation("list", true);
      const rows = assertArray<RetainedSourceThread>(await this.sdk.threads.list(args), "threads.list");
      if (rows.length > limit) {
        throw new RetainedSourceResponseError("threads.list SDK response exceeded the requested row limit.");
      }
      if (rows.length > Number.MAX_SAFE_INTEGER - offset) {
        throw new RetainedSourceResponseError("threads.list response would overflow the next offset.");
      }
      const bytes = this.acceptResponse("list", rows, rows.length);
      return {
        rows,
        metadata: {
          operation: "list",
          page: page!,
          offset,
          nextOffset: offset + rows.length,
          requestedLimit: limit,
          returnedRows: rows.length,
          responseBytes: bytes,
          pageExhausted: rows.length < limit,
          budget: this.snapshot(),
        },
      };
    } finally {
      this.endOperation();
    }
  }

  async eventPage(input: {
    threadId: string;
    afterSeq?: string | null;
    signal?: AbortSignal;
  }): Promise<RetainedSourceEventPage> {
    throwIfAborted(input.signal);
    this.beginOperation();
    try {
      const threadId = assertThreadId(input.threadId);
      const afterSeq = assertCursor(input.afterSeq);
      const remainingRows = this.limits.maxRows - this.usage.rows;
      if (remainingRows <= 0) {
        throw new RetainedSourceBudgetError("max-rows", "events", this.snapshot());
      }
      const limit = Math.min(this.limits.eventPageSize, remainingRows);
      const args: EventsListArgs = {
        threadId,
        limit: String(limit),
        order: "asc",
        ...(afterSeq == null ? {} : { afterSeq }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      };
      const page = this.reserveOperation("events", true);
      const rows = assertArray<RetainedSourceEvent>(
        await this.sdk.threads.events.list(args),
        "threads.events.list",
      );
      const cursor = validateEventRows(threadId, afterSeq, rows, limit);
      const bytes = this.acceptResponse("events", rows, rows.length);
      return {
        rows,
        metadata: {
          operation: "events",
          page: page!,
          threadId,
          requestedAfterSeq: afterSeq,
          returnedMaxSeq: cursor.returnedMaxSeq,
          sourceAfterSeq: cursor.sourceAfterSeq,
          requestedLimit: limit,
          returnedRows: rows.length,
          responseBytes: bytes,
          pageExhausted: rows.length < limit,
          budget: this.snapshot(),
        },
      };
    } finally {
      this.endOperation();
    }
  }

  async getThread(input: { threadId: string; signal?: AbortSignal }): Promise<RetainedSourceThreadObservation> {
    throwIfAborted(input.signal);
    this.beginOperation();
    try {
      const threadId = assertThreadId(input.threadId);
      const args: GetArgs = {
        threadId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      };
      this.reserveOperation("get", false);
      try {
        const thread = await this.sdk.threads.get(args);
        const bytes = this.acceptResponse("get", thread, 0);
        return { kind: "found", thread, responseBytes: bytes, budget: this.snapshot() };
      } catch (error) {
        if (isExactThreadNotFound(error)) {
          return { kind: "confirmed-not-found", responseBytes: null, budget: this.snapshot() };
        }
        throw error;
      }
    } finally {
      this.endOperation();
    }
  }
}

export interface RetainedSourceAdapter {
  listPage(input: { offset: number; signal?: AbortSignal }): Promise<RetainedSourceListPage>;
  eventPage(input: { threadId: string; afterSeq?: string | null; signal?: AbortSignal }): Promise<RetainedSourceEventPage>;
  getThread(input: { threadId: string; signal?: AbortSignal }): Promise<RetainedSourceThreadObservation>;
}

export function createRetainedSourceAdapter(
  sdk: RetainedSourceSdk,
  limits: RetainedSourceLimits = DEFAULT_RETAINED_SOURCE_LIMITS,
): RetainedSourceAdapter {
  return new RetainedSourceAdapterImpl(sdk, limits);
}
