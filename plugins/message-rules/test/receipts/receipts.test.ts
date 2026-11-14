import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "../helpers.ts";
import { createReceipts } from "../../receipts/outbox.ts";
test("receipt operation binds persisted target/payload; spoof, changed neighbor and replay target fail", () => {
  const { db, store } = setup(),
    r = createReceipts(store),
    op = r.enqueue("original", "sender", "Send a result.");
  assert.ok("id" in op);
  const row = r.read(op.id!)!;
  assert.ok(r.verify(row.id, row.target, row.payload, row.signature));
  assert.equal(r.verify(row.id, "other", row.payload, row.signature), false);
  assert.equal(
    r.verify(
      row.id,
      row.target,
      row.payload + " ordinary neighbor",
      row.signature,
    ),
    false,
  );
  assert.equal(
    r.verify("made-up", row.target, row.payload, row.signature),
    false,
  );
  assert.equal(r.enqueue("no-sender", null, "advice").state, "no-known-sender");
  const reopened = createReceipts(store);
  assert.ok(reopened.verify(row.id, row.target, row.payload, row.signature));
  db.close();
});
test("accepted is distinct from consumed; lost response is unknown with no blind resend", async () => {
  const { db, store } = setup(),
    r = createReceipts(store),
    op = r.enqueue("original", "sender", "Advice");
  let calls = 0;
  const port = async () => {
    calls++;
    throw Error("response lost after accepted");
  };
  assert.equal(await r.send(op.id!, port), "unknown");
  assert.equal(await r.send(op.id!, port), "unknown");
  assert.equal(calls, 1);
  const next = r.enqueue("other", "sender", "Other");
  assert.equal(
    await r.send(next.id!, async () => ({ queued: true })),
    "accepted",
  );
  assert.notEqual(r.read(next.id!)!.state, "delivered");
  db.close();
});
