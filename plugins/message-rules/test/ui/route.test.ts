import { test } from "node:test";
import assert from "node:assert/strict";
import { panelPath, panelScope } from "../../ui/route.ts";
test("global initial route ignores current project and legacy deep links carry an explicit mapping context", () => {
  assert.equal(
    panelPath("message-rules-global", "group/shared"),
    "group/shared",
  );
  const path = panelPath("proj_one", "test/occurrence-one");
  assert.deepEqual(panelScope(path, null), {
    projectId: "message-rules-global",
    legacyProjectId: "proj_one",
    path: "test/occurrence-one",
  });
  assert.deepEqual(panelScope(path, "another-project"), {
    projectId: "message-rules-global",
    legacyProjectId: "proj_one",
    path: "test/occurrence-one",
  });
  assert.deepEqual(panelScope("test/legacy", "proj_one"), {
    projectId: "message-rules-global",
    path: "test/legacy",
    legacyProjectId: undefined,
  });
  assert.deepEqual(panelScope("project/%/test/x", null), {
    projectId: null,
    path: "",
  });
});
