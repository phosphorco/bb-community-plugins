import {
  publishedCatalogSchema,
  type PublishedCatalog,
} from "../rpc-contract.ts";

export const GALLERY_CACHE_LIMITS = {
  bytes: 1024 * 1024,
  revisions: 100,
  ageMs: 24 * 60 * 60 * 1000,
  partitions: 4,
  namespaceBytes: 4096,
} as const;
type Scope = { origin: string; instanceId: string };
type Entry = {
  catalogId: string;
  version: number;
  token: object;
  savedAt: number;
  value: PublishedCatalog | null;
};
export interface CatalogTicket {
  scope: Scope;
  previous: object | null;
  stamp: object;
}
const key = (scope: Scope) => JSON.stringify([scope.origin, scope.instanceId]);
const boundedScope = (scope: Scope) =>
  new TextEncoder().encode(key(scope)).length <=
  GALLERY_CACHE_LIMITS.namespaceBytes;
const stale = () =>
  new Error(
    "A newer Templates catalog was retained. Checking the current publication again.",
  );

/** Advisory published data for this module lifetime only. No storage or hashing. */
export function createGalleryCache({ now = () => Date.now() } = {}) {
  const memory = new Map<string, Entry>();
  let stamp: object = {};
  const readMemory = (scope: Scope): PublishedCatalog | null => {
    if (!boundedScope(scope)) return null;
    const entry = memory.get(key(scope));
    return entry &&
      now() >= entry.savedAt &&
      now() - entry.savedAt <= GALLERY_CACHE_LIMITS.ageMs
      ? entry.value
      : null;
  };
  const beginRequest = (origin: string) => {
    // Capture before RPC dispatch, including when the actual instance is not known yet.
    const capturedStamp = stamp;
    const previous = new Map(
      [...memory].map(([scope, entry]) => [scope, entry.token]),
    );
    return (instanceId: string): CatalogTicket => {
      const scope = { origin, instanceId };
      return {
        scope,
        stamp: capturedStamp,
        previous: previous.get(key(scope)) ?? null,
      };
    };
  };
  const begin = (scope: Scope) => beginRequest(scope.origin)(scope.instanceId);
  const accept = (
    ticket: CatalogTicket,
    input: PublishedCatalog,
    isCurrent: () => boolean,
  ): PublishedCatalog => {
    const value = publishedCatalogSchema.parse(input),
      scope = ticket.scope;
    if (!isCurrent() || value.instanceId !== scope.instanceId) throw stale();
    if (!boundedScope(scope)) return value;
    const current = memory.get(key(scope));
    if (!current && stamp !== ticket.stamp) throw stale();
    if (current) {
      if (current.catalogId !== value.catalogId) {
        if (current.token !== ticket.previous) throw stale();
      } else {
        if (current.version > value.version) throw stale();
        // The strict closed schema normalizes object property order; array order is content.
        if (
          current.version === value.version &&
          current.value &&
          JSON.stringify(current.value) !== JSON.stringify(value)
        )
          throw stale();
      }
    }
    const serialized =
      value.revisions.length <= GALLERY_CACHE_LIMITS.revisions
        ? JSON.stringify(value)
        : null;
    const retain =
      serialized !== null &&
      serialized.length <= GALLERY_CACHE_LIMITS.bytes &&
      new TextEncoder().encode(serialized).length <= GALLERY_CACHE_LIMITS.bytes;
    // Oversized responses remain usable, with only bounded epoch/version metadata retained.
    stamp = {};
    memory.delete(key(scope));
    memory.set(key(scope), {
      catalogId: value.catalogId,
      version: value.version,
      token: stamp,
      savedAt: now(),
      value: retain ? value : null,
    });
    while (memory.size > GALLERY_CACHE_LIMITS.partitions)
      memory.delete(memory.keys().next().value!);
    return value;
  };
  return { readMemory, beginRequest, begin, accept };
}
export const galleryCache = createGalleryCache();
