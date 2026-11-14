import { test } from "node:test";
import assert from "node:assert/strict";
import { hasRelevantDrafts } from "../../ui/drafts.ts";
import type { Draft, ProjectState } from "../../ui/types.ts";
import { defaultConnection, newRule, newGroup } from "../../contracts/model.ts";
const p: ProjectState = {
  id: "p",
  revision: 1,
  config: { hostId: "h", root: "/tests", connection: defaultConnection },
  groups: [],
  rules: [newRule("rule")],
  occurrences: [
    {
      occurrenceId: "one",
      path: "one.md",
      logicalId: "one",
      hash: "h",
      source: "saved",
      enabled: true,
      error: null,
      missing: false,
    },
  ],
};
const d: Draft = {
  value: "draft",
  base: "saved",
  hash: "h",
  kind: "test",
  enabled: true,
};
test("enabled test/rule drafts gate Test; disabled tests and another client/project drafts do not", () => {
  const drafts = new Map([["p:test:one", d]]);
  assert.equal(hasRelevantDrafts("p", p, drafts), true);
  assert.equal(
    hasRelevantDrafts(
      "p",
      {
        ...p,
        occurrences: p.occurrences.map((x) => ({ ...x, enabled: false })),
      },
      drafts,
    ),
    false,
  );
  assert.equal(hasRelevantDrafts("other", p, drafts), false);
  assert.equal(hasRelevantDrafts("p", p, new Map()), false);
});
test("unsaved rule enable changes gate; disabled edited rule can coexist with Test", () => {
  const rule = newRule("rule"),
    base = JSON.stringify(rule);
  const draft = {
    value: JSON.stringify({ ...rule, title: "changed" }),
    base,
    hash: null,
    kind: "rule" as const,
    enabled: false,
  };
  assert.equal(
    hasRelevantDrafts("p", p, new Map([["p:rule:rule", draft]])),
    false,
  );
  assert.equal(
    hasRelevantDrafts(
      "p",
      p,
      new Map([
        [
          "p:rule:rule",
          { ...draft, value: JSON.stringify({ ...rule, enabled: true }) },
        ],
      ]),
    ),
    true,
  );
  assert.equal(
    hasRelevantDrafts(
      "p",
      { ...p, rules: [{ ...rule, enabled: true }] },
      new Map([["p:rule:rule", draft]]),
    ),
    true,
  );
});

test("group scope drafts gate Test even before enabling, preserving private client/project boundary", () => {
  const drafts = new Map<string, Draft>([
    [
      "p:group:rollout",
      {
        kind: "group",
        base: "saved",
        value: "changed scope",
        hash: null,
        enabled: false,
      },
    ],
  ]);
  assert.equal(
    hasRelevantDrafts("p", { ...p, groups: [newGroup("rollout")] }, drafts),
    true,
  );
  assert.equal(hasRelevantDrafts("other", p, drafts), false);
});

test("deleted metadata targets do not leave an inaccessible draft blocking Test", () => {
  const drafts = new Map<string, Draft>([
    [
      "p:group:deleted",
      {
        kind: "group",
        value: JSON.stringify({ ...newGroup("deleted"), enabled: true }),
        base: "old",
        hash: null,
        enabled: true,
      },
    ],
  ]);
  assert.equal(hasRelevantDrafts("p", p, drafts), false);
});
