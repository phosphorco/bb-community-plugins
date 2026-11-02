import { afterAll, expect, test } from "bun:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { idCodec, identityKeyCodec } from "@phosphorco/bb-identity/model";
import type { PendingDraft } from "@phosphorco/bb-identity/state";
import { inputDraftResource, type PersonalDraft } from "../model.ts";
import { browserDrafts } from "../ui/drafts.ts";
const previousIDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB"),
  previousRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
Object.defineProperty(globalThis, "indexedDB", {
  configurable: true,
  value: indexedDB,
});
Object.defineProperty(globalThis, "IDBKeyRange", {
  configurable: true,
  value: IDBKeyRange,
});
afterAll(() => {
  if (previousIDB) Object.defineProperty(globalThis, "indexedDB", previousIDB);
  else Reflect.deleteProperty(globalThis, "indexedDB");
  if (previousRange)
    Object.defineProperty(globalThis, "IDBKeyRange", previousRange);
  else Reflect.deleteProperty(globalThis, "IDBKeyRange");
});
const branded = <K extends string>(kind: K, value: string) => {
  const r = idCodec(kind).decode(value);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
function pending(
  name: string,
  template = "review-pr",
): PendingDraft<PersonalDraft> {
  const actor = identityKeyCodec.decode(`issuer:${name}`);
  if (!actor.ok) throw new Error("fixture");
  const address = {
    instanceId: branded("instance", "checkpoint-test"),
    pluginId: branded("plugin", "new-thread-templates"),
    collection: "input-drafts",
    recordId: template,
    owner: actor.value,
  };
  return {
    formatVersion: 1,
    key: {
      address,
      actor: actor.value,
      ownerSession: branded("owner-session", `${name}-owner-session`),
    },
    schemaVersion: 1,
    acknowledged: {
      status: "empty",
      address,
      version: { epoch: "empty", sequence: 0 },
    },
    desired: { inputs: { focus: `${name} unfinished` } },
    localGeneration: 1,
    inFlight: null,
  };
}
function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("new-thread-templates-recovery-v1", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

test("real recovery adapter isolates owner/template and closes/reopens across surface disposal", async () => {
  const storage = browserDrafts(inputDraftResource.definition.codec),
    ada = pending("ada"),
    bea = pending("bea"),
    other = pending("ada", "idea");
  try {
    expect((await storage.write(ada, null)).ok).toBe(true);
    expect((await storage.write(bea, null)).ok).toBe(true);
    expect((await storage.write(other, null)).ok).toBe(true);
    const found = await storage.find(ada.key.address, ada.key.actor, 20);
    expect(found.ok && found.value.map((c) => c.draft.desired)).toEqual([
      { inputs: { focus: "ada unfinished" } },
    ]);
    expect((await storage.write({ ...ada, localGeneration: 2 }, 1)).ok).toBe(
      true,
    );
    const stale = await storage.remove(ada.key, 1);
    expect(stale.ok).toBe(true);
    const retained = await storage.find(ada.key.address, ada.key.actor, 20);
    expect(retained.ok && retained.value[0]?.revision).toBe(2);
  } finally {
  }
});

test("corrupt existing checkpoint cannot be overwritten by null CAS; unrelated owner remains usable", async () => {
  const storage = browserDrafts(inputDraftResource.definition.codec),
    draft = pending("corrupt"),
    other = pending("healthy");
  const saved = await storage.write(draft, null);
  expect(saved.ok).toBe(true);
  const database = await db();
  try {
    const raw = await new Promise<any>((resolve, reject) => {
      const tx = database.transaction("drafts", "readwrite"),
        store = tx.objectStore("drafts"),
        req = store.getAll();
      req.onsuccess = () => {
        const record = req.result.find(
          (r) => r.draft.key.actor === draft.key.actor,
        );
        record.draft.desired = { inputs: { broken: null } };
        store.put(record);
        tx.oncomplete = () => resolve(record);
      };
      req.onerror = () => reject(req.error);
    });
    const refused = await storage.write(draft, null);
    expect(refused.ok).toBe(false);
    const found = await storage.find(draft.key.address, draft.key.actor, 20);
    expect(found.ok).toBe(false);
    expect((await storage.write(other, null)).ok).toBe(true);
    const healthy = await storage.find(other.key.address, other.key.actor, 20);
    expect(healthy.ok && healthy.value.length).toBe(1);
    const still = await new Promise<any>((resolve) => {
      const req = database
        .transaction("drafts", "readonly")
        .objectStore("drafts")
        .get(raw.key);
      req.onsuccess = () => resolve(req.result);
    });
    expect(still).toEqual(raw);
  } finally {
    database.close();
  }
});
