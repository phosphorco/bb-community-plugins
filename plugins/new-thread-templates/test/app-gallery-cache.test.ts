import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
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
async function counts(factory: IDBFactory) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(
      "new-thread-templates-published-gallery-v1",
      1,
    );
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<Record<string, number>>((resolve, reject) => {
      const names = [...db.objectStoreNames],
        tx = db.transaction(names, "readonly"),
        values: Record<string, number> = {};
      for (const name of names) {
        const request = tx.objectStore(name).count();
        request.onsuccess = () => {
          values[name] = request.result;
        };
      }
      tx.oncomplete = () => resolve(values);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
test("published cache old tab and held read cannot resurrect authoritative empty or conflicting equal version", async () => {
  const db = new IDBFactory(),
    first = createGalleryCache({ database: () => db }),
    second = createGalleryCache({ database: () => db }),
    initial = snapshot();
  await first.accept(await first.begin(scope()), initial, () => true);
  const old = await first.begin(scope());
  const empty = { ...initial, version: 2, revisions: [] };
  await second.accept(await second.begin(scope()), empty, () => true);
  await expect(first.accept(old, initial, () => true)).rejects.toThrow(
    "newer Templates",
  );
  await expect(
    first.accept(
      await first.begin(scope()),
      { ...initial, version: 2 },
      () => true,
    ),
  ).rejects.toThrow("newer Templates");
  const reopened = createGalleryCache({ database: () => db });
  expect((await reopened.read(scope()))?.revisions).toEqual([]);
  expect(
    (await reopened.accept(await reopened.begin(scope()), empty, () => true))
      .version,
  ).toBe(2);
});
test("namespace ticket fences old callback and permits freshly acquired new epoch", async () => {
  const db = new IDBFactory(),
    cache = createGalleryCache({ database: () => db }),
    a = snapshot();
  await cache.accept(await cache.begin(scope()), a, () => true);
  const old = await cache.begin(scope()),
    newer = snapshot("instance", 0);
  await cache.accept(await cache.begin(scope()), newer, () => true);
  await expect(
    cache.accept(old, { ...a, version: 50 }, () => true),
  ).rejects.toThrow("newer Templates");
  expect(cache.readMemory(scope())?.catalogId).toBe(newer.catalogId);
  await cache.accept(
    await cache.begin(scope()),
    { ...newer, version: 1 },
    () => true,
  );
});
test("disk and memory retain only four partitions and one stamp; evicted old tab cannot repopulate", async () => {
  const db = new IDBFactory(),
    oldTab = createGalleryCache({ database: () => db }),
    writer = createGalleryCache({ database: () => db });
  const oldValue = snapshot("old");
  await oldTab.accept(await oldTab.begin(scope("old")), oldValue, () => true);
  const oldTicket = await oldTab.begin(scope("old"));
  // Also fence an initially absent namespace held across later admissions.
  const absentTicket = await oldTab.begin(scope("absent"));
  for (let i = 0; i < 9; i++) {
    const value = snapshot(`new-${i}`);
    await writer.accept(
      await writer.begin(scope(value.instanceId)),
      value,
      () => true,
    );
  }
  expect(await counts(db)).toEqual({ catalogs: 4, metadata: 1, pointers: 4 });
  await expect(oldTab.accept(oldTicket, oldValue, () => true)).rejects.toThrow(
    "newer Templates",
  );
  await expect(
    oldTab.accept(absentTicket, snapshot("absent"), () => true),
  ).rejects.toThrow("newer Templates");
  expect(await counts(db)).toEqual({ catalogs: 4, metadata: 1, pointers: 4 });
  await oldTab.accept(await oldTab.begin(scope("old")), oldValue, () => true);
  expect(await counts(db)).toEqual({ catalogs: 4, metadata: 1, pointers: 4 });
});
test("cache age and size bounds discard advisory bytes while fresh server result stays available", async () => {
  const db = new IDBFactory();
  let now = 100;
  const cache = createGalleryCache({ database: () => db, now: () => now }),
    value = snapshot();
  await cache.accept(await cache.begin(scope()), value, () => true);
  now += GALLERY_CACHE_LIMITS.ageMs + 1;
  expect(cache.readMemory(scope())).toBeNull();
  expect(await cache.read(scope())).toBeNull();
  const large = structuredClone(value);
  large.version++;
  large.revisions = Array.from({ length: 20 }, (_, i) => ({
    ...value.revisions[0]!,
    templateId: `large-${i}`,
    definition: {
      ...value.revisions[0]!.definition,
      id: `large-${i}`,
      promptTemplate: "x".repeat(60000),
    },
  }));
  expect(
    (await cache.accept(await cache.begin(scope()), large, () => true))
      .revisions.length,
  ).toBe(20);
  expect(cache.readMemory(scope())).toBeNull();
  expect(
    await createGalleryCache({ database: () => db }).read(scope()),
  ).toBeNull();
  const many = {
    ...value,
    version: 3,
    revisions: Array.from({ length: 101 }, (_, i) => ({
      ...value.revisions[0]!,
      templateId: `entry-${i}`,
      definition: { ...value.revisions[0]!.definition, id: `entry-${i}` },
    })),
  };
  expect(
    (await cache.accept(await cache.begin(scope()), many, () => true)).revisions
      .length,
  ).toBe(101);
  expect(cache.readMemory(scope())).toBeNull();
});
test("optional storage failure does not hide authoritative content; disposed admission cannot mutate cache", async () => {
  const cache = createGalleryCache({ database: () => undefined }),
    value = snapshot(),
    ticket = await cache.begin(scope());
  expect(await cache.accept(ticket, value, () => true)).toEqual(value);
  expect(cache.readMemory(scope())).toEqual(value);
  await expect(
    cache.accept(
      await cache.begin(scope()),
      { ...value, version: 2, revisions: [] },
      () => false,
    ),
  ).rejects.toThrow("newer Templates");
  expect(cache.readMemory(scope())?.revisions.length).toBe(2);
});
test("malformed retained bytes and namespace metadata cannot hide a fresh server catalog", async () => {
  const factory = new IDBFactory(),
    writer = createGalleryCache({ database: () => factory }),
    value = snapshot();
  await writer.accept(await writer.begin(scope()), value, () => true);
  const db = await new Promise<IDBDatabase>((resolve) => {
    const request = factory.open(
      "new-thread-templates-published-gallery-v1",
      1,
    );
    request.onsuccess = () => resolve(request.result);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["catalogs", "pointers"], "readwrite"),
      request = tx.objectStore("catalogs").openCursor();
    request.onsuccess = () => {
      const row = request.result;
      if (row) row.update({ ...row.value, serialized: "unreadable" });
    };
    tx.objectStore("pointers").put({ nonsense: true }, "malformed-key");
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  db.close();
  const fresh = createGalleryCache({ database: () => factory });
  expect(await fresh.read(scope())).toBeNull();
  expect(
    await fresh.accept(await fresh.begin(scope()), value, () => true),
  ).toEqual(value);
  expect(await counts(factory)).toEqual({
    catalogs: 1,
    pointers: 1,
    metadata: 1,
  });
  const oversizedInstance = "i".repeat(GALLERY_CACHE_LIMITS.namespaceBytes + 1),
    oversized = snapshot(oversizedInstance);
  expect(
    await fresh.accept(
      await fresh.begin(scope(oversizedInstance)),
      oversized,
      () => true,
    ),
  ).toEqual(oversized);
  expect(fresh.readMemory(scope(oversizedInstance))).toBeNull();
  expect(await counts(factory)).toEqual({
    catalogs: 1,
    pointers: 1,
    metadata: 1,
  });
});
test("catalog equality is semantic, ordering remains observable, and invalidation during hashing cannot commit", async () => {
  const database = new IDBFactory(),
    cache = createGalleryCache({ database: () => database }),
    value = snapshot();
  await cache.accept(await cache.begin(scope()), value, () => true);
  const reordered = {
    revisions: value.revisions,
    version: value.version,
    catalogId: value.catalogId,
    instanceId: value.instanceId,
  };
  expect(
    await cache.accept(await cache.begin(scope()), reordered, () => true),
  ).toEqual(value);
  await expect(
    cache.accept(
      await cache.begin(scope()),
      { ...value, revisions: [...value.revisions].reverse() },
      () => true,
    ),
  ).rejects.toThrow("newer Templates");
  let current = true;
  const ticket = await cache.begin(scope()),
    work = cache.accept(
      ticket,
      { ...value, version: 2, revisions: [] },
      () => current,
    );
  current = false;
  await expect(work).rejects.toThrow("newer Templates");
  const reopened = createGalleryCache({ database: () => database });
  expect((await reopened.read(scope()))?.version).toBe(1);
  const privateProjection = {
    ...value,
    drafts: [{ personal: "must never enter cache" }],
  };
  await expect(
    cache.accept(await cache.begin(scope()), privateProjection, () => true),
  ).rejects.toThrow();
});
test("a retained cache read held in digest cannot replace newer authoritative empty memory", async () => {
  const { spyOn } = await import("bun:test");
  const database = new IDBFactory(),
    cache = createGalleryCache({ database: () => database }),
    initial = snapshot();
  await cache.accept(await cache.begin(scope()), initial, () => true);
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void,
    entered!: () => void,
    held = false;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = spyOn(crypto.subtle, "digest").mockImplementation(
    async (algorithm, data) => {
      if (!held) {
        held = true;
        entered();
        await gate;
      }
      return original(algorithm, data);
    },
  );
  try {
    const reading = cache.read(scope());
    await reached;
    await cache.accept(
      await cache.begin(scope()),
      { ...initial, version: 2, revisions: [] },
      () => true,
    );
    release();
    expect((await reading)?.revisions).toEqual([]);
    expect(cache.readMemory(scope())?.version).toBe(2);
  } finally {
    release();
    spy.mockRestore();
  }
});

test("old acceptance held after its initial memory guard cannot resurrect an evicted newer empty after storage failure", async () => {
  const { controlledGalleryIO } = await import("./app-fixture.ts");
  const io = controlledGalleryIO(new IDBFactory()),
    cache = createGalleryCache({ database: () => io.factory }),
    initial = snapshot();
  await cache.accept(await cache.begin(scope()), initial, () => true);
  const ticket = await cache.begin(scope());
  io.holdNextOpen();
  const old = cache
    .accept(ticket, initial, () => true)
    .then(
      () => null,
      (error) => error,
    );
  while (!io.pending.length)
    await new Promise((resolve) => setTimeout(resolve, 1));
  await cache.accept(
    await cache.begin(scope()),
    { ...initial, version: 2, revisions: [] },
    () => true,
  );
  for (let i = 0; i < 4; i++) {
    const value = snapshot(`eviction-${i}`);
    await cache.accept(
      await cache.begin(scope(value.instanceId)),
      value,
      () => true,
    );
  }
  io.pending[0]!.fail();
  expect((await old)?.message).toContain("newer Templates");
  expect(cache.readMemory(scope())).toBeNull();
  io.releaseAll();
  expect(io.stats().closed).toBe(io.stats().opened);
});

test("optional transaction deadline returns fresh server data and retiring late callbacks cannot write", async () => {
  const { controlledGalleryIO } = await import("./app-fixture.ts");
  const database = new IDBFactory(),
    io = controlledGalleryIO(database),
    cache = createGalleryCache({ database: () => io.factory }),
    value = snapshot();
  const ticket = await cache.begin(scope());
  io.holdNextTransaction();
  expect(await cache.accept(ticket, value, () => true)).toEqual(value);
  expect(io.pending.some((item) => item.kind === "transaction")).toBe(true);
  io.releaseAll();
  expect(await counts(database)).toEqual({
    catalogs: 0,
    metadata: 0,
    pointers: 0,
  });
  expect(io.stats().closed).toBe(io.stats().opened);
});

test("unavailable hashing disables advisory caching without bypassing known content version or namespace", async () => {
  const { spyOn } = await import("bun:test");
  const cache = createGalleryCache({ database: () => undefined }),
    value = snapshot();
  const spy = spyOn(crypto.subtle, "digest").mockRejectedValue(
    new Error("Hashing unavailable"),
  );
  try {
    expect(
      await cache.accept(await cache.begin(scope()), value, () => true),
    ).toEqual(value);
    expect(cache.readMemory(scope())).toBeNull();
    await expect(
      cache.accept(
        await cache.begin(scope()),
        { ...value, revisions: [] },
        () => true,
      ),
    ).rejects.toThrow("newer Templates");
    await cache.accept(
      await cache.begin(scope()),
      { ...value, version: 2, revisions: [] },
      () => true,
    );
    await expect(
      cache.accept(await cache.begin(scope()), value, () => true),
    ).rejects.toThrow("newer Templates");
  } finally {
    spy.mockRestore();
  }
  expect(
    await cache.accept(
      await cache.begin(scope()),
      { ...value, version: 2, revisions: [] },
      () => true,
    ),
  ).toHaveProperty("version", 2);
  expect(cache.readMemory(scope())?.revisions).toEqual([]);
});
test("metadata acquisition deadline freezes request ticket before late readonly callbacks", async () => {
  const { controlledGalleryIO } = await import("./app-fixture.ts");
  const io = controlledGalleryIO(new IDBFactory()),
    cache = createGalleryCache({ database: () => io.factory }),
    value = snapshot();
  await cache.accept(await cache.begin(scope()), value, () => true);
  io.holdNextTransaction("readonly");
  const acquire = await cache.beginRequest(origin),
    captured = acquire("instance");
  expect(io.pending.length).toBeGreaterThan(0);
  io.releaseAll();
  expect(acquire("instance")).toEqual(captured);
  expect(io.stats().closed).toBe(io.stats().opened);
});
test("corrupt shape-valid higher-version bytes do not become facts when optional persistence fails", async () => {
  const { controlledGalleryIO } = await import("./app-fixture.ts");
  const database = new IDBFactory(),
    io = controlledGalleryIO(database),
    seed = createGalleryCache({ database: () => database }),
    value = snapshot();
  await seed.accept(await seed.begin(scope()), value, () => true);
  const db = await new Promise<IDBDatabase>((resolve) => {
    const request = database.open(
      "new-thread-templates-published-gallery-v1",
      1,
    );
    request.onsuccess = () => resolve(request.result);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["pointers", "catalogs"], "readwrite"),
      request = tx.objectStore("catalogs").openCursor();
    request.onsuccess = () => {
      const row = request.result;
      if (!row) return;
      const badPointer = { ...row.value.pointer, version: 999 };
      row.update({
        ...row.value,
        pointer: badPointer,
        serialized: JSON.stringify({ ...value, version: 999 }),
      });
      tx.objectStore("pointers").put(
        badPointer,
        JSON.parse(String(row.key))[0],
      );
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  db.close();
  const fresh = createGalleryCache({ database: () => io.factory });
  expect(await fresh.read(scope())).toBeNull();
  const ticket = await fresh.begin(scope());
  io.holdNextTransaction();
  expect(await fresh.accept(ticket, value, () => true)).toEqual(value);
  io.releaseAll();
  expect(fresh.readMemory(scope())?.version).toBe(value.version);
});
test("oversized published watermark remains verifiable after reopen and rejects an older tab", async () => {
  const database = new IDBFactory(),
    oldTab = createGalleryCache({ database: () => database }),
    writer = createGalleryCache({ database: () => database }),
    value = snapshot();
  await oldTab.accept(await oldTab.begin(scope()), value, () => true);
  const held = await oldTab.begin(scope());
  const large = {
    ...value,
    version: 2,
    revisions: Array.from({ length: 101 }, (_, index) => ({
      ...value.revisions[0]!,
      templateId: `overflow-${index}`,
      definition: {
        ...value.revisions[0]!.definition,
        id: `overflow-${index}`,
      },
    })),
  };
  await writer.accept(await writer.begin(scope()), large, () => true);
  expect(writer.readMemory(scope())).toBeNull();
  await expect(oldTab.accept(held, value, () => true)).rejects.toThrow(
    "newer Templates",
  );
  const reopened = createGalleryCache({ database: () => database });
  expect(await reopened.read(scope())).toBeNull();
  await expect(
    reopened.accept(await reopened.begin(scope()), value, () => true),
  ).rejects.toThrow("newer Templates");
  expect(
    await reopened.accept(
      await reopened.begin(scope()),
      { ...value, version: 3, revisions: [] },
      () => true,
    ),
  ).toHaveProperty("version", 3);
});

test("retired retained validation cannot promote facts or write after its hash resolves late", async () => {
  const { spyOn } = await import("bun:test");
  const database = new IDBFactory(),
    initial = snapshot(),
    seed = createGalleryCache({ database: () => database });
  await seed.accept(await seed.begin(scope()), initial, () => true);
  const cache = createGalleryCache({ database: () => database }),
    original = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void,
    calls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = spyOn(crypto.subtle, "digest").mockImplementation(
    async (algorithm, data) => {
      calls++;
      if (calls === 2) await gate;
      return original(algorithm, data);
    },
  );
  try {
    const next = { ...initial, version: 2, revisions: [] };
    expect(
      await cache.accept(await cache.begin(scope()), next, () => true),
    ).toEqual(next);
    expect(calls).toBe(2);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cache.readMemory(scope())?.version).toBe(2);
    expect(
      await createGalleryCache({ database: () => database }).read(scope()),
    ).toEqual(initial);
  } finally {
    release();
    spy.mockRestore();
  }
});
test("known oversized digest survives unavailable hashing and exact same-version recovery", async () => {
  const { spyOn } = await import("bun:test");
  const base = snapshot(),
    large = {
      ...base,
      revisions: Array.from({ length: 101 }, (_, index) => ({
        ...base.revisions[0]!,
        templateId: `known-${index}`,
        definition: { ...base.revisions[0]!.definition, id: `known-${index}` },
      })),
    };
  const cache = createGalleryCache({ database: () => undefined });
  await cache.accept(await cache.begin(scope()), large, () => true);
  const spy = spyOn(crypto.subtle, "digest").mockRejectedValue(
    new Error("Hash outage"),
  );
  try {
    await expect(
      cache.accept(await cache.begin(scope()), large, () => true),
    ).rejects.toThrow();
    const conflicting = structuredClone(large);
    conflicting.revisions[0]!.definition.name = "Changed at same version";
    await expect(
      cache.accept(await cache.begin(scope()), conflicting, () => true),
    ).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
  expect(
    await cache.accept(await cache.begin(scope()), large, () => true),
  ).toEqual(large);
  expect(cache.readMemory(scope())).toBeNull();
});

test("unverified oversized hash placeholder is never treated as content authority after hashing recovers", async () => {
  const { spyOn } = await import("bun:test");
  const base = snapshot(),
    large = {
      ...base,
      revisions: Array.from({ length: 101 }, (_, index) => ({
        ...base.revisions[0]!,
        templateId: `unverified-${index}`,
        definition: {
          ...base.revisions[0]!.definition,
          id: `unverified-${index}`,
        },
      })),
    };
  const cache = createGalleryCache({ database: () => undefined });
  const spy = spyOn(crypto.subtle, "digest").mockRejectedValue(
    new Error("Hash outage"),
  );
  try {
    expect(
      await cache.accept(await cache.begin(scope()), large, () => true),
    ).toEqual(large);
  } finally {
    spy.mockRestore();
  }
  expect(
    await cache.accept(await cache.begin(scope()), large, () => true),
  ).toEqual(large);
  const next = { ...large, version: 2 };
  const again = spyOn(crypto.subtle, "digest").mockRejectedValue(
    new Error("Second outage"),
  );
  try {
    expect(
      await cache.accept(await cache.begin(scope()), next, () => true),
    ).toEqual(next);
  } finally {
    again.mockRestore();
  }
  expect(
    await cache.accept(await cache.begin(scope()), next, () => true),
  ).toEqual(next);
});
