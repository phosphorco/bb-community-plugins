import { test } from "node:test";
import assert from "node:assert/strict";
import { panelPath, panelScope, resolvePanelId } from "../../ui/route.ts";
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

test("legacy source-qualified addresses require an exact alias; raw-ID collisions only resolve in global routes", () => {
  const aliases = [
    { projectId: "a", kind: "rule" as const, oldId: "same", id: "same" },
    { projectId: "b", kind: "rule" as const, oldId: "same", id: "same-b" },
  ];
  assert.equal(resolvePanelId(aliases, "a", "rule", "same"), "same");
  assert.equal(resolvePanelId(aliases, "b", "rule", "same"), "same-b");
  assert.equal(resolvePanelId(aliases, "unmapped", "rule", "same"), null);
  assert.equal(resolvePanelId(aliases, "b", "rule", "same-b"), null);
  assert.equal(resolvePanelId(aliases, undefined, "rule", "same"), "same");
});
