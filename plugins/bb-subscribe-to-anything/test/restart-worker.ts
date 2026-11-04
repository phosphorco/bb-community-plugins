// Separate-process crash fixture: actual Store writes, no graceful close.
import Sqlite from "better-sqlite3";
import { Store } from "../store.ts";
import type { Database } from "../store.ts";
import { Engine } from "../engine.ts";
const db = new Sqlite(process.argv[2]!);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
const store = new Store(db as unknown as Database);
const unavailable = async () => {
  throw Error("fixture must not call ports");
};
const engine = new Engine(store, {
  now: () => 1,
  owner: unavailable,
  launch: unavailable,
  wake: unavailable,
  stop: unavailable,
  send: unavailable,
  run: unavailable,
  classify: unavailable,
});
const receipt = engine.create("owner", "project", null, "until", {
  subject: "https://example.com",
  notify_when: "ready",
  required_evidence: "proof",
  timeout_minutes: 10,
});
const record = store.get(receipt.subscription_id);
record.launch = "intent";
store.save(record);
store.putFinding({
  id: "finding",
  subscription_id: record.id,
  owner: "owner",
  occurrence: "one",
  created_at: 1,
  outcome: "matched",
  summary: "result persisted before send",
  evidence: "fixture",
  delivery: "sending",
});
process.exit(73);
