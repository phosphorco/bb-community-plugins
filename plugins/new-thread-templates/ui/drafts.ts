import { idCodec, identityKeyCodec } from "@phosphorco/bb-identity/model";
import type { Codec, Result } from "@phosphorco/bb-identity/model";
import { stateCodecs } from "@phosphorco/bb-identity/state";
import type {
  DraftCheckpoint,
  DraftStorage,
  PendingDraft,
  StateAddress,
} from "@phosphorco/bb-identity/state";

const failure = (message: string): Result<never> => ({
  ok: false,
  error: { code: "unavailable", message, retry: "after-reconnect" },
});
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const addressKey = (address: StateAddress) =>
  JSON.stringify([
    address.instanceId,
    address.pluginId,
    address.collection,
    address.recordId,
    address.owner,
  ]);
const draftKey = (key: PendingDraft<unknown>["key"]) =>
  JSON.stringify([addressKey(key.address), key.actor, key.ownerSession]);

/** Recovery storage only. Each transaction owns and closes its connection, including late preservation. */
export function browserDrafts<T>(codec: Codec<T>): DraftStorage<T> {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("new-thread-templates-recovery-v1", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("drafts", { keyPath: "key" });
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
  const wire = stateCodecs(codec);
  const decode = (raw: unknown): DraftCheckpoint<T> | null => {
    if (
      !object(raw) ||
      !Number.isSafeInteger(raw.revision) ||
      (raw.revision as number) < 1 ||
      !object(raw.draft)
    )
      return null;
    const draft = raw.draft;
    if (
      draft.formatVersion !== 1 ||
      !object(draft.key) ||
      !Number.isSafeInteger(draft.schemaVersion) ||
      !Number.isSafeInteger(draft.localGeneration)
    )
      return null;
    const read = wire.read.decode(draft.acknowledged),
      value = codec.decode(draft.desired),
      owner = idCodec("owner-session").decode(draft.key.ownerSession),
      actor = identityKeyCodec.decode(draft.key.actor);
    if (
      !read.ok ||
      read.value.status === "migration-required" ||
      !value.ok ||
      !owner.ok ||
      !actor.ok
    )
      return null;
    const address =
      read.value.status === "present"
        ? read.value.envelope.address
        : read.value.address;
    if (JSON.stringify(draft.key.address) !== JSON.stringify(address))
      return null;
    const pending =
      draft.inFlight === null ? null : wire.mutation.decode(draft.inFlight);
    if (pending !== null && !pending.ok) return null;
    return {
      revision: raw.revision as number,
      draft: {
        formatVersion: 1,
        key: { address, actor: actor.value, ownerSession: owner.value },
        schemaVersion: draft.schemaVersion as number,
        localGeneration: draft.localGeneration as number,
        acknowledged: read.value,
        desired: value.value,
        inFlight: pending?.ok ? pending.value : null,
      },
    };
  };
  const encode = (draft: PendingDraft<T>, revision: number) => ({
    key: draftKey(draft.key),
    revision,
    draft: {
      ...draft,
      desired: codec.encode(draft.desired),
      acknowledged: wire.read.encode(draft.acknowledged),
      inFlight: draft.inFlight ? wire.mutation.encode(draft.inFlight) : null,
    },
  });
  async function transaction<R>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore, result: (value: Result<R>) => void) => void,
  ): Promise<Result<R>> {
    let database: IDBDatabase | null = null;
    try {
      database = await open();
      const db = database;
      return await new Promise<Result<R>>((resolve) => {
        const tx = db.transaction("drafts", mode);
        let outcome: Result<R> = failure(
          "Browser recovery storage could not complete the operation.",
        );
        let completed = false;
        const finish = (value: Result<R>) => {
          if (completed) return;
          completed = true;
          db.close();
          resolve(value);
        };
        tx.oncomplete = () => finish(outcome);
        tx.onerror = () =>
          finish(
            failure(
              "Browser recovery storage could not complete the operation.",
            ),
          );
        tx.onabort = tx.onerror;
        try {
          run(tx.objectStore("drafts"), (value) => {
            outcome = value;
          });
        } catch {
          tx.abort();
        }
      });
    } catch {
      database?.close();
      return failure(
        "Browser draft storage is unavailable. Save your inputs before leaving.",
      );
    }
  }
  return {
    find(address, actor, limit) {
      return transaction("readonly", (store, result) => {
        const prefix =
          JSON.stringify([addressKey(address), actor]).slice(0, -1) + ",";
        const request = store.getAll(
          IDBKeyRange.bound(prefix, prefix + String.fromCharCode(65535)),
          Math.min(20, Math.max(1, limit)),
        );
        request.onsuccess = () => {
          const matches: DraftCheckpoint<T>[] = [];
          for (const raw of request.result) {
            const checkpoint = decode(raw);
            if (!checkpoint) {
              result(
                failure(
                  "A saved recovery draft is unreadable. It has been retained.",
                ),
              );
              return;
            }
            matches.push(checkpoint);
          }
          result({ ok: true, value: matches });
        };
      });
    },
    write(draft, expectedRevision) {
      return transaction("readwrite", (store, result) => {
        const request = store.get(draftKey(draft.key));
        request.onsuccess = () => {
          const previous = request.result ? decode(request.result) : null;
          if (request.result && !previous) {
            result(
              failure(
                "Existing recovery draft is unreadable. It has been retained.",
              ),
            );
            return;
          }
          if ((previous?.revision ?? null) !== expectedRevision) {
            result(
              failure(
                "Recovery draft changed in another view. Newer draft retained.",
              ),
            );
            return;
          }
          const revision = (expectedRevision ?? 0) + 1,
            record = encode(draft, revision);
          if (!decode(record)) {
            result(failure("Cannot encode recovery draft."));
            return;
          }
          store.put(record);
          result({ ok: true, value: { revision, draft } });
        };
      });
    },
    remove(key, expectedRevision) {
      return transaction("readwrite", (store, result) => {
        const request = store.get(draftKey(key));
        request.onsuccess = () => {
          if (request.result?.revision === expectedRevision)
            store.delete(draftKey(key));
          result({ ok: true, value: undefined });
        };
      });
    },
  };
}
