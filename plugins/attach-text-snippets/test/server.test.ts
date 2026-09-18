import assert from "node:assert/strict";
import test from "node:test";

import { insertSnippetWithRollback } from "../server.ts";

test("keeps a successfully indexed snippet file", async () => {
  let removed = false;

  await insertSnippetWithRollback(
    () => undefined,
    async () => {
      removed = true;
    },
    () => undefined,
  );

  assert.equal(removed, false);
});

test("removes a newly-created file when metadata insertion fails", async () => {
  const insertionError = new Error("metadata insert failed");
  let removed = false;

  await assert.rejects(
    insertSnippetWithRollback(
      () => {
        throw insertionError;
      },
      async () => {
        removed = true;
      },
      () => undefined,
    ),
    (cause) => cause === insertionError,
  );

  assert.equal(removed, true);
});

test("preserves the insertion error and reports rollback failures", async () => {
  const insertionError = new Error("metadata insert failed");
  const warnings: string[] = [];

  await assert.rejects(
    insertSnippetWithRollback(
      () => {
        throw insertionError;
      },
      async () => {
        throw new Error("remove failed");
      },
      (message) => warnings.push(message),
    ),
    (cause) => cause === insertionError,
  );

  assert.deepEqual(warnings, [
    "Could not remove a text snippet after its metadata insert failed: remove failed",
  ]);
});
