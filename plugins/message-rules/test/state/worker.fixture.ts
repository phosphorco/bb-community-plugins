import Database from "better-sqlite3";
import { createStore } from "../../state/store.ts";
import { createFiles } from "../../files/files.ts";
import { createSuiteService, savedBasis } from "../../suites/runner.ts";
import {
  memoryFiles,
  source,
  jevRule,
  testGroup,
  count,
  answer,
} from "../helpers.ts";
const db = new Database(process.argv[2]!);
const store = createStore(db);
store.configure("project", null, {
  hostId: "host-proof",
  root: "/tests",
  connection: {
    model: "jev-1.14.0",
    maxWireBytes: 64000,
    maxCalls: 32,
    timeoutMs: 15000,
    maxResponseBytes: 262144,
    perRequestTokens: 64000,
    perQuestionTokens: 32000,
  },
});
store.saveGroup("project", store.get("project")!.revision, testGroup);
store.saveRule("project", store.get("project")!.revision, jevRule());
await createFiles(
  memoryFiles({ "one.md": source("one") }).port,
  store,
).discover("project");
let resume: () => void;
const paused = new Promise<void>((resolve) => {
  resume = resolve;
});
let calls = 0;
const service = createSuiteService(
  store,
  () => async (wire) => {
    process.send?.({ stage: "permit-committed-before-effect" });
    await paused;
    calls++;
    process.send?.({ stage: "effect", calls });
    return answer(wire);
  },
  count,
);
const p = store.get("project")!;
const run = service.start("project", "process-run", savedBasis(p), {});
process.on("message", async (msg) => {
  if (msg === "resume") resume();
  if (msg === "finish") {
    await service.dispose();
    process.send?.({ stage: "quiesced", run: store.run(run.id), calls });
    db.close();
    process.exit(0);
  }
});
