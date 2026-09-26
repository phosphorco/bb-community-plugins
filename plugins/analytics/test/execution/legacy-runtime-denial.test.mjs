import assert from "node:assert/strict";
import test from "node:test";
import { createQueryRuntime } from "../../query-runtime/index.mjs";

test("ordinary legacy DB-path runtime construction is hard-denied", async () => {
  await assert.rejects(
    () => createQueryRuntime({ trustedSource: { kind: "node-sqlite-readonly", readonlyDatabasePath: "/not-used" } }),
    (error) => error?.code === "isolation-unavailable",
  );
});
