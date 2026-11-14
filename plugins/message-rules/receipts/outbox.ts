import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { canonical, sha256 } from "../contracts/hash.ts";
import type { Store } from "../state/store.ts";
export function createReceipts(store: Store) {
  let row = store.db
    .prepare("SELECT value FROM mr_metadata WHERE key='receipt-key-v1'")
    .get() as { value: string } | undefined;
  if (!row) {
    row = { value: randomBytes(32).toString("hex") };
    store.db
      .prepare("INSERT INTO mr_metadata VALUES('receipt-key-v1',?)")
      .run(row.value);
  }
  const key = row.value;
  const sign = (id: string, target: string, text: string) =>
    createHmac("sha256", key)
      .update(canonical({ v: 1, id, target, hash: sha256(text) }))
      .digest("hex");
  function read(id: string) {
    return store.db.prepare("SELECT * FROM mr_receipts WHERE id=?").get(id) as
      | {
          id: string;
          original_id: string;
          target: string;
          payload: string;
          signature: string;
          state: string;
          observation: string | null;
        }
      | undefined;
  }
  return {
    read,
    enqueue(originalId: string, target: string | null, text: string) {
      if (!target) return { state: "no-known-sender" as const };
      const prior = store.db
        .prepare(
          "SELECT * FROM mr_receipts WHERE original_id=? AND target=? AND payload=?",
        )
        .get(originalId, target, text) as { id: string } | undefined;
      if (prior) return { state: "existing" as const, id: prior.id };
      const id = randomUUID(),
        signature = sign(id, target, text);
      store.db
        .prepare("INSERT INTO mr_receipts VALUES(?,?,?,?,?,'pending',NULL)")
        .run(id, originalId, target, text, signature);
      return { state: "pending" as const, id };
    },
    verify(id: string, target: string, text: string, signature: string) {
      const r = read(id);
      if (
        !r ||
        r.target !== target ||
        r.payload !== text ||
        r.signature !== signature
      )
        return false;
      const expected = Buffer.from(sign(id, target, text), "hex"),
        actual = Buffer.from(signature, "hex");
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    },
    async send(
      id: string,
      port: (input: {
        target: string;
        text: string;
        operationId: string;
        signature: string;
      }) => Promise<unknown>,
    ) {
      const r = read(id);
      if (!r || r.state !== "pending") return r?.state ?? "missing";
      store.db
        .prepare("UPDATE mr_receipts SET state='sending' WHERE id=?")
        .run(id);
      try {
        const ack = await port({
          target: r.target,
          text: r.payload,
          operationId: id,
          signature: r.signature,
        });
        store.db
          .prepare(
            "UPDATE mr_receipts SET state='accepted',observation=? WHERE id=?",
          )
          .run(canonical(ack), id);
        return "accepted";
      } catch (e) {
        store.db
          .prepare(
            "UPDATE mr_receipts SET state='unknown',observation=? WHERE id=?",
          )
          .run(String(e), id);
        return "unknown";
      }
    },
    recover() {
      store.db
        .prepare("UPDATE mr_receipts SET state='unknown' WHERE state='sending'")
        .run();
    },
  };
}
