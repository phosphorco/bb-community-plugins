import * as duckdb from "@duckdb/duckdb-wasm";

import {
  MAX_QUERY_ROWS,
  validateQueryText,
  type AnalyticsBundle,
} from "./bundle-contract.ts";

const HTTP_ROOT = "/api/v1/plugins/analytics/http";
const FACT_FILE = "analytics-facts.ndjson";
const QUERY_TIMEOUT_MS = 2_000;
const QUERY_CACHE_MAX_ENTRIES = 24;
const QUERY_CACHE_MAX_BYTES = 4 * 1024 * 1024;

export type AnalyticsScalar = string | number | boolean | null;

export interface BrowserQueryResult {
  id: string;
  columns: string[];
  rows: Array<Record<string, AnalyticsScalar>>;
  elapsedMs: number;
  truncated: boolean;
  cached: boolean;
}

export interface BrowserDashboardResult {
  results: BrowserQueryResult[];
  startupMs: number;
  loadMs: number;
  queryMs: number;
  factBytes: number;
  materializationCached: boolean;
  generationId: number | null;
  asOf: number | null;
  rangeDays: number;
}

export interface BrowserRunOptions {
  generationId?: number | null;
  asOf?: number | null;
  signal?: AbortSignal;
}

export type BrowserQueryParameters = Readonly<Record<string, AnalyticsScalar>>;

export function normalizeQueryText(sql: string): string {
  let normalized = "";
  let whitespace = false;
  let quote: "'" | '"' | null = null;
  const trimmed = sql.trim();
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index] as string;
    if (quote != null) {
      normalized += character;
      if (character === quote && trimmed[index + 1] === quote) {
        normalized += quote;
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      if (whitespace && normalized.length > 0) normalized += " ";
      whitespace = false;
      quote = character;
      normalized += character;
    } else if (/\s/.test(character)) {
      whitespace = true;
    } else {
      if (whitespace && normalized.length > 0) normalized += " ";
      whitespace = false;
      normalized += character.toLowerCase();
    }
  }
  return normalized;
}

export function queryCacheKey(
  generationId: number,
  sql: string,
  parameters: BrowserQueryParameters,
): string {
  return JSON.stringify([generationId, normalizeQueryText(sql), parameters]);
}

export function reusedQueryResult(result: BrowserQueryResult, id: string): BrowserQueryResult {
  return { ...result, id, cached: true };
}

export class BrowserQueryCache {
  private readonly entries = new Map<string, { result: BrowserQueryResult; bytes: number }>();
  private bytes = 0;
  private generation: number | null = null;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(maxEntries = QUERY_CACHE_MAX_ENTRIES, maxBytes = QUERY_CACHE_MAX_BYTES) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  setGeneration(generation: number | null): void {
    if (this.generation === generation) return;
    this.clear();
    this.generation = generation;
  }

  get(key: string): BrowserQueryResult | undefined {
    const entry = this.entries.get(key);
    if (entry == null) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.result;
  }

  set(key: string, result: BrowserQueryResult): void {
    const bytes = estimateResultBytes(result);
    if (bytes > this.maxBytes) return;
    const previous = this.entries.get(key);
    if (previous != null) this.bytes -= previous.bytes;
    this.entries.delete(key);
    this.entries.set(key, { result, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, { result: BrowserQueryResult; bytes: number }] | undefined;
      if (oldest == null) break;
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get byteSize(): number {
    return this.bytes;
  }
}

class BrowserAnalyticsEngine {
  private queue: Promise<void> = Promise.resolve();
  private readonly database: duckdb.AsyncDuckDB;
  private readonly connection: duckdb.AsyncDuckDBConnection;
  private readonly startupMs: number;

  private constructor(database: duckdb.AsyncDuckDB, connection: duckdb.AsyncDuckDBConnection, startupMs: number) {
    this.database = database;
    this.connection = connection;
    this.startupMs = startupMs;
  }

  private materializedKey: string | null = null;
  private materializedFactBytes = 0;
  private readonly queryCache = new BrowserQueryCache();

  static async open(): Promise<BrowserAnalyticsEngine> {
    const startedAt = performance.now();
    const bundle = await duckdb.selectBundle({
      mvp: {
        mainModule: `${HTTP_ROOT}/duckdb-mvp.wasm`,
        mainWorker: `${HTTP_ROOT}/duckdb-browser-mvp.worker.js`,
      },
      eh: {
        mainModule: `${HTTP_ROOT}/duckdb-eh.wasm`,
        mainWorker: `${HTTP_ROOT}/duckdb-browser-eh.worker.js`,
      },
    });
    if (bundle.mainWorker == null) throw new Error("This browser cannot start the Analytics query worker.");
    const worker = new Worker(bundle.mainWorker, { name: "bb-analytics-duckdb" });
    const database = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    try {
      await database.instantiate(bundle.mainModule);
      await database.open({
        maximumThreads: 1,
        allowUnsignedExtensions: false,
        query: {
          castBigIntToDouble: true,
          castDecimalToDouble: true,
          castTimestampToDate: false,
        },
      });
      const connection = await database.connect();
      return new BrowserAnalyticsEngine(database, connection, performance.now() - startedAt);
    } catch (cause) {
      await database.terminate();
      throw cause;
    }
  }

  async loadAndRun(bundle: AnalyticsBundle, rangeDays: number, options: BrowserRunOptions = {}): Promise<BrowserDashboardResult> {
    const generationId = normalizeGeneration(options.generationId);
    const safeRangeDays = normalizeRangeDays(rangeDays);
    return this.exclusive(async () => {
      throwIfAborted(options.signal);
      const materializationKey = generationId == null
        ? null
        : materializationCacheKey(bundle.loader.id, generationId, safeRangeDays);
      let materializationCached = materializationKey != null && this.materializedKey === materializationKey;
      let factBytes = this.materializedFactBytes;
      let loadMs = 0;
      this.queryCache.setGeneration(generationId);
      if (!materializationCached) {
        const loadStartedAt = performance.now();
        const response = await fetch(`${HTTP_ROOT}/facts.ndjson?rangeDays=${safeRangeDays}&bundleId=${encodeURIComponent(bundle.id)}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: options.signal,
        });
        if (!response.ok) throw new Error(`Capability facts could not load (${response.status}).`);
        const responseGeneration = response.headers.get("x-analytics-generation-id");
        if (generationId != null && responseGeneration != null && responseGeneration !== String(generationId)) {
          throw new Error("The capability snapshot changed while loading. Try again.");
        }
        const buffer = new Uint8Array(await response.arrayBuffer());
        throwIfAborted(options.signal);
        // registerFileBuffer transfers the underlying buffer to the DuckDB worker.
        // Preserve the length before transfer so the empty-snapshot branch and
        // diagnostics observe the source payload rather than a detached buffer.
        factBytes = buffer.byteLength;
        await this.database.registerFileBuffer(FACT_FILE, buffer);
        try {
          if (factBytes === 0) {
            await this.queryWithCancellation(emptyFactTableSql(), options.signal);
          } else {
            await this.queryWithCancellation(`
              CREATE OR REPLACE TABLE tool_execution_fact_v1 AS
              SELECT * FROM read_json_auto('${FACT_FILE}', format = 'newline_delimited')
            `, options.signal);
          }
        } finally {
          await this.database.dropFile(FACT_FILE);
        }
        throwIfAborted(options.signal);
        this.materializedKey = materializationKey;
        this.materializedFactBytes = factBytes;
        loadMs = performance.now() - loadStartedAt;
      } else {
        materializationCached = true;
      }

      const queryStartedAt = performance.now();
      const results: BrowserQueryResult[] = [];
      for (const query of bundle.queries) {
        throwIfAborted(options.signal);
        validateQueryText(query.sql);
        const maxRows = Math.min(MAX_QUERY_ROWS, query.maxRows);
        const parameters = { range_days: safeRangeDays, max_rows: maxRows } satisfies BrowserQueryParameters;
        const key = generationId == null ? null : queryCacheKey(generationId, query.sql, parameters);
        const cached = key == null ? undefined : this.queryCache.get(key);
        if (cached != null) {
          // SQL-equivalent queries may have different bundle-local IDs.
          results.push(reusedQueryResult(cached, query.id));
          continue;
        }
        const parameterizedSql = query.sql.replaceAll("$range_days", String(safeRangeDays));
        const wrapped = `SELECT * FROM (${parameterizedSql}) AS analytics_query LIMIT ${maxRows + 1}`;
        const startedAt = performance.now();
        const table = await this.queryWithCancellation(wrapped, options.signal);
        const columns = table.schema.fields.map((field) => field.name);
        const allRows = table.toArray().map((row) => {
          const source = typeof row?.toJSON === "function" ? row.toJSON() : row;
          return Object.fromEntries(columns.map((column) => [column, scalarValue(source?.[column])]));
        });
        const result: BrowserQueryResult = {
          id: query.id,
          columns,
          rows: allRows.slice(0, maxRows),
          elapsedMs: tenth(performance.now() - startedAt),
          truncated: allRows.length > maxRows,
          cached: false,
        };
        if (key != null) this.queryCache.set(key, result);
        results.push(result);
      }
      return {
        results,
        startupMs: tenth(this.startupMs),
        loadMs: tenth(loadMs),
        queryMs: tenth(performance.now() - queryStartedAt),
        factBytes,
        materializationCached,
        generationId,
        asOf: options.asOf ?? null,
        rangeDays: safeRangeDays,
      };
    }, options.signal);
  }

  async close(): Promise<void> {
    await this.connection.close();
    await this.database.terminate();
  }

  private async queryWithCancellation(query: string, signal?: AbortSignal): Promise<Awaited<ReturnType<duckdb.AsyncDuckDBConnection["query"]>>> {
    throwIfAborted(signal);
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      this.connection.useUnsafe((bindings, connectionId) => {
        void bindings.cancelPendingQuery(connectionId);
      });
    };
    const timeout = window.setTimeout(cancel, QUERY_TIMEOUT_MS);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const table = await this.connection.query(query);
      if (cancelled) throw abortError();
      return table;
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    }
  }

  private async exclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    try {
      await abortable(previous, signal);
    } catch (cause) {
      release();
      throw cause;
    }
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function materializationCacheKey(loaderId: string, generationId: number, rangeDays: number): string {
  return JSON.stringify([loaderId, generationId, rangeDays]);
}

function normalizeGeneration(generationId: number | null | undefined): number | null {
  return generationId != null && Number.isSafeInteger(generationId) && generationId >= 0 ? generationId : null;
}

function normalizeRangeDays(rangeDays: number): number {
  return Math.max(1, Math.min(90, Math.trunc(rangeDays)));
}

function estimateResultBytes(result: BrowserQueryResult): number {
  return JSON.stringify(result).length * 2;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): DOMException {
  return new DOMException("The Analytics request was cancelled.", "AbortError");
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal == null) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject);
    void promise.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => {
      // The original promise is observed by the resolve/reject handlers above.
    });
  });
}

function emptyFactTableSql(): string {
  return `
    CREATE OR REPLACE TABLE tool_execution_fact_v1 AS SELECT
      NULL::VARCHAR AS source_event_id,
      NULL::VARCHAR AS thread_id,
      NULL::VARCHAR AS turn_id,
      NULL::BIGINT AS sequence,
      NULL::VARCHAR AS project_id,
      NULL::VARCHAR AS provider_id,
      NULL::BIGINT AS created_at_ms,
      NULL::VARCHAR AS capability_kind,
      NULL::VARCHAR AS capability_key,
      NULL::VARCHAR AS status,
      NULL::BIGINT AS duration_ms,
      NULL::BOOLEAN AS failed,
      NULL::VARCHAR AS error_class,
      NULL::VARCHAR AS error_signature
    WHERE false
  `;
}

function scalarValue(value: unknown): AnalyticsScalar {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value) ?? null;
}

function tenth(value: number): number {
  return Math.round(value * 10) / 10;
}

let sharedEngine: Promise<BrowserAnalyticsEngine> | null = null;

export function getBrowserAnalyticsEngine(): Promise<BrowserAnalyticsEngine> {
  sharedEngine ??= BrowserAnalyticsEngine.open().catch((cause) => {
    sharedEngine = null;
    throw cause;
  });
  return sharedEngine;
}
