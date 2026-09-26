import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runtimeEntry = new URL("../../query-runtime/index.mjs", import.meta.url);
const verifierEntry = new URL("../../analytics-verifier.ts", import.meta.url);

test("production execution entries cannot reach legacy DB-path probes", async () => {
  const [runtimeSource, verifierSource, runtime] = await Promise.all([
    readFile(runtimeEntry, "utf8"),
    readFile(verifierEntry, "utf8"),
    import(runtimeEntry),
  ]);

  for (const source of [runtimeSource, verifierSource]) {
    assert.doesNotMatch(source, /node:sqlite|node:child_process|readonlyDatabasePath|createProbeQueryRuntime/);
  }
  assert.deepEqual(Object.keys(runtime).sort(), ["createQueryRuntime"]);
  await assert.rejects(
    runtime.createQueryRuntime({}),
    (error) => error?.code === "isolation-unavailable",
  );
});

test("the legacy runtime implementation is only located beneath test/probes", () => {
  assert.match(fileURLToPath(new URL("../probes/legacy-query-runtime.mjs", import.meta.url)), /\/test\/probes\//);
});
