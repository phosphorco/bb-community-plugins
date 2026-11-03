import {
  publishedCatalogSchema,
  type PublishedCatalog,
} from "../rpc-contract.ts";
import { PLUGIN_ID } from "../model.ts";

export const GALLERY_CACHE_LIMITS = {
  bytes: 1024 * 1024,
  revisions: 100,
  ageMs: 24 * 60 * 60 * 1000,
  partitions: 4,
  namespaceBytes: 4096,
  optionalMs: 150,
} as const;
const DATABASE = "new-thread-templates-published-gallery-v1";
type Scope = { origin: string; instanceId: string };
type Pointer = { catalogId: string; version: number; digest: string };
type RecordValue = {
  schema: 1;
  origin: string;
  instanceId: string;
  savedAt: number;
  pointer: Pointer;
  serialized: string | null;
  watermarkProof?: string;
};
export interface CatalogTicket {
  scope: Scope;
  pointer: string | null;
  memoryPointer: string | null;
  stamp: string | null;
  memoryStamp: string;
}
const scopeKey = (scope: Scope) =>
  JSON.stringify([1, PLUGIN_ID, scope.origin, scope.instanceId]);
const partitionKey = (scope: Scope, catalogId: string) =>
  JSON.stringify([scopeKey(scope), catalogId]);
const boundedScope = (scope: Scope) =>
  new TextEncoder().encode(scopeKey(scope)).length <=
  GALLERY_CACHE_LIMITS.namespaceBytes;
const token = (value: Pointer | null) => (value ? JSON.stringify(value) : null);
const pointer = (value: unknown): Pointer | null => {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<Pointer>;
  return typeof p.catalogId === "string" &&
    /^[0-9a-f-]{36}$/i.test(p.catalogId) &&
    Number.isSafeInteger(p.version) &&
    p.version! >= 0 &&
    typeof p.digest === "string" &&
    /^[0-9a-f]{64}$/.test(p.digest)
    ? { catalogId: p.catalogId, version: p.version!, digest: p.digest }
    : null;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const digest = async (serialized: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(serialized),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const stale = () =>
  new Error(
    "A newer Templates catalog was retained. Checking the current publication again.",
  );

type CacheLease = {
  active: boolean;
  db?: IDBDatabase;
  tx?: IDBTransaction;
  assert(): void;
};
/** Deadline retires only this optional continuation; it is not remote cancellation. */
async function bounded<T>(work: (lease: CacheLease) => Promise<T>): Promise<T> {
  const lease: CacheLease = {
    active: true,
    assert() {
      if (!this.active) throw new Error("Gallery cache operation retired");
    },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Gallery cache optional operation timed out")),
      GALLERY_CACHE_LIMITS.optionalMs,
    );
  });
  try {
    return await Promise.race([work(lease), deadline]);
  } finally {
    lease.active = false;
    if (timer) clearTimeout(timer);
    try {
      lease.tx?.abort();
    } catch {}
    lease.db?.close();
  }
}
function transaction(
  lease: CacheLease,
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
) {
  lease.assert();
  const tx = db.transaction(stores, mode);
  lease.tx = tx;
  return tx;
}

/** Bounded published data cache only: no listeners, personal drafts or authority. */
export function createGalleryCache({
  database = () => globalThis.indexedDB,
  now = () => Date.now(),
}: { database?: () => IDBFactory | undefined; now?: () => number } = {}) {
  const memory = new Map<
    string,
    Omit<RecordValue, "serialized"> & {
      value: PublishedCatalog | null;
      advisory: boolean;
      verifiedDigest: string | null;
    }
  >();
  let memoryStamp = crypto.randomUUID();
  const remember = (
    scope: Scope,
    value: RecordValue,
    parsed: PublishedCatalog,
    advisory = true,
  ) => {
    const key = scopeKey(scope);
    memory.delete(key);
    const { serialized, ...metadata } = value;
    memory.set(key, {
      ...metadata,
      value: serialized ? parsed : null,
      advisory,
      verifiedDigest: advisory ? value.pointer.digest : null,
    });
    while (memory.size > GALLERY_CACHE_LIMITS.partitions)
      memory.delete(memory.keys().next().value!);
  };
  const decode = (
    scope: Scope,
    value: RecordValue | undefined,
  ): PublishedCatalog | null => {
    if (
      !value ||
      !Number.isFinite(value.savedAt) ||
      !pointer(value.pointer) ||
      value.schema !== 1 ||
      value.origin !== scope.origin ||
      value.instanceId !== scope.instanceId ||
      !value.serialized ||
      now() < value.savedAt ||
      now() - value.savedAt > GALLERY_CACHE_LIMITS.ageMs ||
      value.serialized.length > GALLERY_CACHE_LIMITS.bytes ||
      new TextEncoder().encode(value.serialized).length >
        GALLERY_CACHE_LIMITS.bytes
    )
      return null;
    try {
      const parsed = publishedCatalogSchema.parse(JSON.parse(value.serialized));
      return parsed.instanceId === scope.instanceId &&
        parsed.catalogId === value.pointer.catalogId &&
        parsed.version === value.pointer.version &&
        parsed.revisions.length <= GALLERY_CACHE_LIMITS.revisions
        ? parsed
        : null;
    } catch {
      return null;
    }
  };
  async function open(lease: CacheLease): Promise<IDBDatabase> {
    const factory = database();
    if (!factory) throw new Error("Gallery cache storage unavailable");
    return await new Promise((resolve, reject) => {
      let settled = false;
      const request = factory.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!lease.active) {
          request.transaction?.abort();
          return;
        }
        request.result.createObjectStore("pointers");
        request.result.createObjectStore("catalogs");
        request.result.createObjectStore("metadata");
      };
      request.onerror = () => {
        settled = true;
        reject(request.error);
      };
      request.onblocked = () => {
        settled = true;
        reject(new Error("Gallery cache storage blocked"));
      };
      request.onsuccess = () => {
        if (settled || !lease.active) {
          request.result.close();
          reject(new Error("Gallery cache open retired"));
        } else {
          settled = true;
          request.result.onversionchange = () => request.result.close();
          lease.db = request.result;
          resolve(request.result);
        }
      };
    });
  }
  const readMemory = (scope: Scope): PublishedCatalog | null => {
    if (!boundedScope(scope)) return null;
    const entry = memory.get(scopeKey(scope));
    return entry &&
      now() >= entry.savedAt &&
      now() - entry.savedAt <= GALLERY_CACHE_LIMITS.ageMs
      ? entry.advisory
        ? entry.value
        : null
      : null;
  };
  async function beginRequest(
    origin: string,
  ): Promise<(instanceId: string) => CatalogTicket> {
    const snapshot = new Map<string, string>();
    const capturedMemoryStamp = memoryStamp;
    let stamp: string | null = null;
    for (const [key, value] of memory) {
      const parts = JSON.parse(key);
      if (parts[2] === origin) snapshot.set(parts[3], token(value.pointer)!);
    }
    const memoryPointers = new Map(snapshot);
    try {
      await bounded(async (lease) => {
        const db = await open(lease);
        await new Promise<void>((resolve, reject) => {
          const tx = transaction(
              lease,
              db,
              ["pointers", "metadata"],
              "readonly",
            ),
            request = tx.objectStore("pointers").openCursor();
          const metadata = tx.objectStore("metadata").get("admission");
          metadata.onsuccess = () => {
            if (!lease.active) return;
            stamp =
              typeof metadata.result === "string" ? metadata.result : null;
          };
          request.onsuccess = () => {
            if (!lease.active) return;
            const cursor = request.result;
            if (!cursor) return;
            try {
              const parts = JSON.parse(String(cursor.key)),
                p = pointer(cursor.value);
              if (
                parts[0] === 1 &&
                parts[1] === PLUGIN_ID &&
                parts[2] === origin &&
                p
              )
                snapshot.set(parts[3], token(p)!);
            } catch {
              /* Malformed optional cache metadata is ignored. */
            }
            cursor.continue();
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      });
    } catch {
      /* Cache metadata is optional; no cached data is painted here. */
    }
    const acquired = new Map(snapshot),
      acquiredStamp = stamp;
    return (instanceId) => ({
      scope: { origin, instanceId },
      pointer: acquired.get(instanceId) ?? null,
      memoryPointer: memoryPointers.get(instanceId) ?? null,
      stamp: acquiredStamp,
      memoryStamp: capturedMemoryStamp,
    });
  }

  async function begin(scope: Scope): Promise<CatalogTicket> {
    return (await beginRequest(scope.origin))(scope.instanceId);
  }
  async function read(scope: Scope): Promise<PublishedCatalog | null> {
    if (!boundedScope(scope)) return null;
    const readStamp = memoryStamp;
    try {
      const value = await bounded(async (lease) => {
        const db = await open(lease);
        return await new Promise<RecordValue | undefined>((resolve, reject) => {
          const tx = transaction(
              lease,
              db,
              ["pointers", "catalogs"],
              "readonly",
            ),
            pointers = tx.objectStore("pointers"),
            catalogs = tx.objectStore("catalogs");
          let result: RecordValue | undefined,
            actual: Pointer | null = null;
          const request = pointers.get(scopeKey(scope));
          request.onsuccess = () => {
            const p = pointer(request.result);
            actual = p;
            if (!p) return;
            const record = catalogs.get(partitionKey(scope, p.catalogId));
            record.onsuccess = () => {
              result = record.result;
            };
          };
          tx.oncomplete = () =>
            resolve(
              result && token(pointer(result.pointer)) === token(actual)
                ? result
                : undefined,
            );
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      });
      const parsed = decode(scope, value);
      if (
        parsed &&
        value?.serialized &&
        (await bounded(() => digest(value.serialized!))) !==
          value.pointer.digest
      )
        return readMemory(scope);
      if (!parsed || !value) return readMemory(scope);
      const current = memory.get(scopeKey(scope));
      if (!current && memoryStamp !== readStamp) return null;
      if (
        current &&
        (current.pointer.catalogId !== parsed.catalogId ||
          current.pointer.version > parsed.version ||
          (current.pointer.version === parsed.version &&
            (current.value
              ? canonical(current.value) !== canonical(parsed)
              : current.verifiedDigest !== null &&
                current.verifiedDigest !== value.pointer.digest)))
      )
        return readMemory(scope);
      remember(scope, value, parsed);
      return parsed;
    } catch {
      return readMemory(scope);
    }
  }
  async function accept(
    ticket: CatalogTicket,
    input: PublishedCatalog,
    isCurrent: () => boolean,
  ): Promise<PublishedCatalog> {
    const value = publishedCatalogSchema.parse(input),
      scope = ticket.scope;
    if (value.instanceId !== scope.instanceId || !isCurrent()) throw stale();
    if (!boundedScope(scope)) return value;
    const serialized = canonical(value);
    const retainBody =
      value.revisions.length <= GALLERY_CACHE_LIMITS.revisions &&
      new TextEncoder().encode(serialized).length <= GALLERY_CACHE_LIMITS.bytes;
    const watermark = (p: Pointer) =>
      canonical({
        schema: 1,
        origin: scope.origin,
        instanceId: scope.instanceId,
        pointer: p,
      });
    let hash: string | null = null,
      watermarkProof: string | undefined;
    try {
      const result = await bounded(async () => {
        const hash = await digest(serialized);
        const proof = retainBody
          ? undefined
          : await digest(
              watermark({
                catalogId: value.catalogId,
                version: value.version,
                digest: hash,
              }),
            );
        return { hash, proof };
      });
      hash = result.hash;
      watermarkProof = result.proof;
    } catch {
      /* Hash unavailable: retain server facts, disable advisory cache. */
    }
    if (!isCurrent()) throw stale();
    const record: RecordValue = {
      schema: 1,
      origin: scope.origin,
      instanceId: scope.instanceId,
      savedAt: now(),
      pointer: {
        catalogId: value.catalogId,
        version: value.version,
        digest: hash ?? "0".repeat(64),
      },
      serialized: retainBody ? serialized : null,
      ...(watermarkProof ? { watermarkProof } : {}),
    };
    const check = (
      previous: Pointer | null,
      content?: PublishedCatalog | null,
      namespaceTicket = ticket.pointer,
      verifiedDigest: string | null = previous?.digest ?? null,
    ) => {
      if (!isCurrent()) throw stale();
      if (!previous) return;
      if (previous.catalogId !== value.catalogId) {
        if (token(previous) !== namespaceTicket) throw stale();
        return;
      }
      if (previous.version > value.version) throw stale();
      if (previous.version === value.version) {
        if (content) {
          if (canonical(content) !== serialized) throw stale();
        } else if (verifiedDigest !== null) {
          if (hash === null)
            throw new Error(
              "Templates publication cannot be verified while hashing is unavailable. Retry when verification recovers.",
            );
          if (verifiedDigest !== hash) throw stale();
        }
      }
    };
    const checkMemory = () => {
      const current = memory.get(scopeKey(scope));
      if (!current && memoryStamp !== ticket.memoryStamp) throw stale();
      check(
        current?.pointer ?? null,
        current?.value,
        ticket.memoryPointer,
        current?.verifiedDigest ?? null,
      );
    };
    checkMemory();
    const persistentFacts: {
      value: { pointer: Pointer; content?: PublishedCatalog | null } | null;
    } = { value: null };
    try {
      if (!hash) throw new Error("Gallery advisory hashing unavailable");
      await bounded(async (lease) => {
        const db = await open(lease);
        // Validate optional retained bytes before treating their version as an ordering fence.
        // Recheck the exact pointer in the write transaction; a concurrent writer wins.
        const inspected = await new Promise<{
          raw: Pointer | null;
          record?: RecordValue;
        }>((resolve, reject) => {
          const tx = transaction(
            lease,
            db,
            ["pointers", "catalogs"],
            "readonly",
          );
          let raw: Pointer | null = null,
            retained: RecordValue | undefined;
          const request = tx.objectStore("pointers").get(scopeKey(scope));
          request.onsuccess = () => {
            raw = pointer(request.result);
            if (raw) {
              const record = tx
                .objectStore("catalogs")
                .get(partitionKey(scope, raw.catalogId));
              record.onsuccess = () => {
                retained = record.result;
              };
            }
          };
          tx.oncomplete = () => resolve({ raw, record: retained });
          tx.onabort = () => reject(tx.error);
          tx.onerror = () => reject(tx.error);
        });
        const retained = inspected.record;
        const linked =
          retained &&
          token(pointer(retained.pointer)) === token(inspected.raw) &&
          retained.schema === 1 &&
          retained.origin === scope.origin &&
          retained.instanceId === scope.instanceId;
        const retainedContent = linked ? decode(scope, retained) : null;
        const validRetained =
          linked &&
          (retained.serialized === null
            ? typeof retained.watermarkProof === "string" &&
              /^[0-9a-f]{64}$/.test(retained.watermarkProof) &&
              (await digest(watermark(retained.pointer))) ===
                retained.watermarkProof
            : !!retainedContent &&
              (await digest(retained.serialized)) === retained.pointer.digest);
        // Parsed raw disk bytes are CAS metadata, not facts. A retired hash may
        // neither promote ordering evidence nor start a transaction later.
        lease.assert();
        if (!isCurrent()) throw stale();
        if (validRetained && inspected.raw)
          persistentFacts.value = {
            pointer: inspected.raw,
            content: retainedContent,
          };
        await new Promise<void>((resolve, reject) => {
          const tx = transaction(
              lease,
              db,
              ["pointers", "catalogs", "metadata"],
              "readwrite",
            ),
            pointers = tx.objectStore("pointers"),
            catalogs = tx.objectStore("catalogs");
          let failure: unknown;
          const request = pointers.get(scopeKey(scope));
          const metadata = tx.objectStore("metadata").get("admission");
          metadata.onsuccess = () => {
            if (!lease.active) return;
            try {
              lease.assert();
              if (!isCurrent()) throw stale();
              const raw = pointer(request.result);
              if (token(raw) !== token(inspected.raw)) throw stale();
              const previous = validRetained ? raw : null;
              const currentStamp =
                typeof metadata.result === "string" ? metadata.result : null;
              if (!raw && currentStamp !== ticket.stamp) throw stale();
              check(previous, retainedContent);
              tx.objectStore("metadata").put(crypto.randomUUID(), "admission");
              pointers.put(record.pointer, scopeKey(scope));
              // Only the active partition is retained for an instance; other deployments stay separate.
              const prior = pointer(request.result);
              if (prior && prior.catalogId !== value.catalogId)
                catalogs.delete(partitionKey(scope, prior.catalogId));
              const activeKey = partitionKey(scope, value.catalogId);
              catalogs.put(record, activeKey);
              const records = catalogs.getAll(),
                keys = catalogs.getAllKeys();
              keys.onsuccess = () => {
                if (!lease.active) return;
                const retained = keys.result.map((key, index) => ({
                  key,
                  value: records.result[index] as RecordValue | undefined,
                }));
                retained.sort(
                  (a, b) => (b.value?.savedAt ?? 0) - (a.value?.savedAt ?? 0),
                );
                let count = 1;
                for (const item of retained) {
                  if (item.key === activeKey) continue;
                  const validAge =
                    item.value &&
                    Number.isFinite(item.value.savedAt) &&
                    now() >= item.value.savedAt &&
                    now() - item.value.savedAt <= GALLERY_CACHE_LIMITS.ageMs;
                  if (validAge && count < GALLERY_CACHE_LIMITS.partitions) {
                    count++;
                    continue;
                  }
                  catalogs.delete(item.key);
                  try {
                    pointers.delete(JSON.parse(String(item.key))[0]);
                  } catch {
                    /* Discard malformed cache-only key. */
                  }
                }
                // Keep only pointers backed by the bounded retained records.
                const cursor = pointers.openCursor();
                cursor.onsuccess = () => {
                  if (!lease.active) return;
                  const row = cursor.result;
                  if (!row) return;
                  const key = row.key,
                    p = pointer(row.value);
                  if (!p) row.delete();
                  else {
                    const record = catalogs.get(
                      JSON.stringify([String(key), p.catalogId]),
                    );
                    record.onsuccess = () => {
                      if (lease.active && !record.result) pointers.delete(key);
                    };
                  }
                  row.continue();
                };
              };
            } catch (error) {
              failure = error;
              tx.abort();
            }
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(failure ?? tx.error);
          tx.onabort = () => reject(failure ?? tx.error);
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message === stale().message)
        throw error;
    }
    // Optional I/O never grants permission to forget a known newer/evicted scope.
    checkMemory();
    const knownPersistent = persistentFacts.value;
    if (knownPersistent)
      check(knownPersistent.pointer, knownPersistent.content);
    // Raw pre-request disk pointers are used only for CAS/namespace comparison
    // in the transaction. Invalid retained bytes cannot become ordering facts.
    memoryStamp = crypto.randomUUID();
    remember(scope, record, value, hash !== null);
    return value;
  }
  return { readMemory, read, begin, beginRequest, accept };
}
export const galleryCache = createGalleryCache();
