import assert from "node:assert/strict";
import test from "node:test";

import {
  getAttachedAnnotationSnapshot,
  markAttachedAnnotationIds,
  observeAttachedAnnotationIds,
  subscribeToDrafts,
} from "../lib/draft-attachments.ts";

test("an inserted mention is attached immediately, before draft observation", () => {
  const scope = { kind: "thread", threadId: "draft-attachments-test" };
  let changes = 0;
  const unsubscribe = subscribeToDrafts(() => { changes += 1; });
  try {
    observeAttachedAnnotationIds(scope, []);
    markAttachedAnnotationIds(scope, ["first"]);
    assert.deepEqual(JSON.parse(getAttachedAnnotationSnapshot(scope)), ["first"]);
    markAttachedAnnotationIds(scope, ["first"]);
    assert.equal(changes, 1, "rapid repeat must not create a second attachment");
    observeAttachedAnnotationIds(scope, ["first"]);
    assert.equal(changes, 1);
    observeAttachedAnnotationIds(scope, []);
    assert.deepEqual(JSON.parse(getAttachedAnnotationSnapshot(scope)), []);
    assert.equal(changes, 2);
  } finally {
    observeAttachedAnnotationIds(scope, []);
    unsubscribe();
  }
});
