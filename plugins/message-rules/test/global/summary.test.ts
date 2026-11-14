import { test } from "node:test";
import assert from "node:assert/strict";
import { groupSummary, groupDraftCounts } from "../../ui/summary.ts";
import { newGroup, newRule, defaultConnection } from "../../contracts/model.ts";
import type { Occurrence } from "../../state/store.ts";
const testFile: Occurrence = {
  occurrenceId: "same",
  groupId: "owner",
  path: "same.md",
  logicalId: "same",
  hash: "hash",
  enabled: true,
  missing: false,
  source: "saved",
  error: null,
};
test("saved unknown/fail/pass counts and frozen denominator remain alongside stale and group/rule/test drafts", () => {
  const occurrences = [
    testFile,
    { ...testFile, occurrenceId: "failed" },
    { ...testFile, occurrenceId: "passed" },
  ];
  const results = new Map(
    occurrences.map((o, i) => [
      o.occurrenceId,
      {
        occurrenceId: o.occurrenceId,
        path: o.path,
        status: (["unknown", "fail", "pass"] as const)[i]!,
        reason: "saved",
      },
    ]),
  );
  const stale = groupSummary(
    occurrences.slice(0, 1),
    occurrences,
    results,
    true,
    0,
  );
  assert.match(stale, /Saved: 1 \/ 3 passed, 1 unknown, 1 failed/);
  assert.match(stale, /Stale/);
  const p = {
    id: "catalog",
    revision: 1,
    config: { hostId: "h", root: "/a", connection: defaultConnection },
    groups: [newGroup("owner")],
    rules: [{ ...newRule("rule", "owner"), enabled: true }],
    occurrences: [testFile],
  };
  const drafts = new Map([
    [
      "catalog:rule:rule",
      {
        value: "new",
        base: "old",
        hash: null,
        kind: "rule" as const,
        enabled: true,
      },
    ],
  ]);
  assert.equal(groupDraftCounts(p, drafts, "catalog").get("owner"), 1);
  const draft = groupSummary(
    [testFile],
    [testFile],
    new Map([
      [
        "same",
        {
          occurrenceId: "same",
          path: "same.md",
          status: "pass",
          reason: "saved",
        },
      ],
    ]),
    false,
    1,
  );
  assert.match(draft, /Saved: 1 \/ 1 passed/);
  assert.match(draft, /1 draft/);
  const invalid = groupSummary(
    [{ ...testFile, error: "Malformed", missing: true }],
    occurrences,
    results,
    true,
    1,
  );
  assert.match(invalid, /current error/);
  assert.match(invalid, /unknown/);
});
