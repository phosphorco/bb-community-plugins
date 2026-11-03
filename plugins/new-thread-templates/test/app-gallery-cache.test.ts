import { expect, spyOn, test } from "bun:test";
import {
  createGalleryCache,
  GALLERY_CACHE_LIMITS,
} from "../ui/gallery-cache.ts";
import { starterDefinitions } from "../model.ts";
import type { PublishedCatalog } from "../rpc-contract.ts";
const origin = "https://templates.test";
const scope = (instanceId = "instance") => ({ origin, instanceId });
function snapshot(
  instanceId = "instance",
  version = 1,
  catalogId = crypto.randomUUID(),
): PublishedCatalog {
  return {
    instanceId,
    catalogId,
    version,
    revisions: starterDefinitions().map((definition) => ({
      templateId: definition.id,
      revision: 1,
      definition,
      publishedAt: 1,
      publishedBy: { key: "fixture:ada", name: "Ada" },
    })),
  };
}

test("memory published cache fences held reads after authoritative empty and rejects conflicting equal content", () => {
  const cache = createGalleryCache(),
    value = snapshot();
  cache.accept(cache.begin(scope()), value, () => true);
  const held = cache.begin(scope());
  const empty = { ...value, version: 2, revisions: [] };
  cache.accept(cache.begin(scope()), empty, () => true);
  expect(() => cache.accept(held, value, () => true)).toThrow(
    "newer Templates",
  );
  expect(cache.readMemory(scope())?.revisions).toEqual([]);
  expect(
    cache.accept(
      cache.begin(scope()),
      {
        revisions: [],
        version: 2,
        catalogId: value.catalogId,
        instanceId: value.instanceId,
      },
      () => true,
    ),
  ).toEqual(empty);
  expect(() =>
    cache.accept(cache.begin(scope()), { ...value, version: 2 }, () => true),
  ).toThrow("newer Templates");
  expect(cache.readMemory(scope())?.revisions).toEqual([]);
});

test("memory namespace capture prevents old epoch restoration but fresh acquisition may enter a new epoch", () => {
  const cache = createGalleryCache(),
    a = snapshot();
  cache.accept(cache.begin(scope()), a, () => true);
  const held = cache.begin(scope()),
    b = snapshot("instance", 0);
  cache.accept(cache.begin(scope()), b, () => true);
  expect(() => cache.accept(held, { ...a, version: 100 }, () => true)).toThrow(
    "newer Templates",
  );
  expect(cache.readMemory(scope())?.catalogId).toBe(b.catalogId);
  expect(
    cache.accept(cache.begin(scope()), { ...b, version: 1 }, () => true)
      .version,
  ).toBe(1);
  expect(cache.accept(cache.begin(scope()), a, () => true).catalogId).toBe(
    a.catalogId,
  );
});

test("four memory scopes bound retention and evicted or initially absent old requests cannot repopulate", () => {
  const cache = createGalleryCache(),
    initial = snapshot();
  cache.accept(cache.begin(scope()), initial, () => true);
  const held = cache.begin(scope()),
    absent = cache.begin(scope("absent"));
  cache.accept(
    cache.begin(scope()),
    { ...initial, version: 2, revisions: [] },
    () => true,
  );
  for (let i = 0; i < 4; i++) {
    const value = snapshot(`other-${i}`);
    cache.accept(cache.begin(scope(value.instanceId)), value, () => true);
  }
  expect(cache.readMemory(scope())).toBeNull();
  expect(() => cache.accept(held, initial, () => true)).toThrow(
    "newer Templates",
  );
  expect(() => cache.accept(absent, snapshot("absent"), () => true)).toThrow(
    "newer Templates",
  );
  expect(
    [0, 1, 2, 3].filter((i) => cache.readMemory(scope(`other-${i}`))),
  ).toHaveLength(GALLERY_CACHE_LIMITS.partitions);
  expect(cache.accept(cache.begin(scope()), initial, () => true)).toEqual(
    initial,
  );
  expect(cache.readMemory(scope("other-0"))).toBeNull();
});

test("warm memory is actual-instance and origin scoped and is deliberately lost across a new module lifetime", () => {
  const cache = createGalleryCache(),
    value = snapshot();
  const acquire = cache.beginRequest(origin);
  cache.accept(acquire(value.instanceId), value, () => true);
  expect(cache.readMemory(scope())).toEqual(value);
  expect(cache.readMemory(scope("other-instance"))).toBeNull();
  expect(
    cache.readMemory({ origin: "https://other.test", instanceId: "instance" }),
  ).toBeNull();
  expect(createGalleryCache().readMemory(scope())).toBeNull();
  expect(() =>
    cache.accept(cache.begin(scope("other-instance")), value, () => true),
  ).toThrow();
});

test("advisory age expiry retains known version fences without timers", () => {
  let now = 100;
  const cache = createGalleryCache({ now: () => now }),
    value = snapshot();
  cache.accept(cache.begin(scope()), { ...value, version: 2 }, () => true);
  now = 99;
  expect(cache.readMemory(scope())).toBeNull();
  now = 101 + GALLERY_CACHE_LIMITS.ageMs;
  expect(cache.readMemory(scope())).toBeNull();
  expect(() => cache.accept(cache.begin(scope()), value, () => true)).toThrow(
    "newer Templates",
  );
});

test("oversized fresh catalogs stay available uncached with epoch and version metadata only", () => {
  const cache = createGalleryCache(),
    initial = snapshot();
  cache.accept(cache.begin(scope()), initial, () => true);
  const large = {
    ...initial,
    version: 2,
    revisions: Array.from({ length: 101 }, (_, i) => ({
      ...initial.revisions[0]!,
      templateId: `many-${i}`,
      definition: { ...initial.revisions[0]!.definition, id: `many-${i}` },
    })),
  };
  expect(cache.accept(cache.begin(scope()), large, () => true)).toEqual(large);
  expect(cache.readMemory(scope())).toBeNull();
  expect(() => cache.accept(cache.begin(scope()), initial, () => true)).toThrow(
    "newer Templates",
  );
  // No digest or equality assertion for bytes we chose not to retain.
  const sameVersion = structuredClone(large);
  sameVersion.revisions[0]!.definition.name = "Fresh uncached server result";
  expect(cache.accept(cache.begin(scope()), sameVersion, () => true)).toEqual(
    sameVersion,
  );
  const bytes = {
    ...initial,
    version: 3,
    revisions: Array.from({ length: 20 }, (_, i) => ({
      ...initial.revisions[0]!,
      templateId: `large-${i}`,
      definition: {
        ...initial.revisions[0]!.definition,
        id: `large-${i}`,
        promptTemplate: "x".repeat(60000),
      },
    })),
  };
  expect(cache.accept(cache.begin(scope()), bytes, () => true)).toEqual(bytes);
  expect(cache.readMemory(scope())).toBeNull();
  const empty = { ...initial, version: 4, revisions: [] };
  cache.accept(cache.begin(scope()), empty, () => true);
  expect(cache.readMemory(scope())).toEqual(empty);
});

test("valid authoritative response never needs IndexedDB or crypto and inactive owner cannot mutate memory", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    get() {
      throw new Error("Storage unavailable");
    },
  });
  const hash = spyOn(crypto.subtle, "digest").mockRejectedValue(
    new Error("Hash unavailable"),
  );
  try {
    const cache = createGalleryCache(),
      value = snapshot();
    expect(cache.accept(cache.begin(scope()), value, () => true)).toEqual(
      value,
    );
    expect(hash).not.toHaveBeenCalled();
    expect(() =>
      cache.accept(
        cache.begin(scope()),
        { ...value, version: 2, revisions: [] },
        () => false,
      ),
    ).toThrow("newer Templates");
    expect(cache.readMemory(scope())).toEqual(value);
    const privateData = { ...value, drafts: [{ private: true }] };
    expect(() =>
      cache.accept(cache.begin(scope()), privateData, () => true),
    ).toThrow();
  } finally {
    hash.mockRestore();
    if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});

test("closed schema normalizes nested object order while publication order remains meaningful", () => {
  const cache = createGalleryCache(),
    value = snapshot();
  cache.accept(cache.begin(scope()), value, () => true);
  const reordered = structuredClone(value);
  reordered.revisions[0]!.definition = Object.fromEntries(
    Object.entries(reordered.revisions[0]!.definition).reverse(),
  ) as (typeof value.revisions)[0]["definition"];
  expect(cache.accept(cache.begin(scope()), reordered, () => true)).toEqual(
    value,
  );
  expect(() =>
    cache.accept(
      cache.begin(scope()),
      { ...value, revisions: [...value.revisions].reverse() },
      () => true,
    ),
  ).toThrow("newer Templates");
});
