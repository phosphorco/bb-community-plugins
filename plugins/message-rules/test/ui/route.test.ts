import { test } from "node:test";
import assert from "node:assert/strict";
import { panelPath, panelScope } from "../../ui/route.ts";
test("responsive remount and deep-link restore project plus selected item from the public subpath", () => {
  const path = panelPath("proj_one", "test/occurrence-one");
  assert.deepEqual(panelScope(path, null), {
    projectId: "proj_one",
    path: "test/occurrence-one",
  });
  assert.deepEqual(panelScope(path, "another-project"), {
    projectId: "proj_one",
    path: "test/occurrence-one",
  });
  assert.deepEqual(panelScope("test/legacy", "proj_one"), {
    projectId: "proj_one",
    path: "test/legacy",
  });
  assert.deepEqual(panelScope("project/%/test/x", null), {
    projectId: null,
    path: "",
  });
});
