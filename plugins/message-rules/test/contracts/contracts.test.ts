import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFixture } from "../../contracts/fixture.ts";
import { fixtureTemplate } from "../../contracts/template.ts";
import {
  validateRule,
  newRule,
  match,
  normalizeAdvice,
} from "../../contracts/model.ts";
import { captured, jevRule, source } from "../helpers.ts";
import { assertResult } from "../../suites/runner.ts";
const empty = {
  version: "v",
  inputHash: "h",
  policy: "allow" as const,
  rules: [],
  advice: [],
  errors: [],
};
test("plain frontmatter, CRLF, fenced/nested headings preserve literal message", () => {
  const s = fixtureTemplate("one").replace(
    "Write the message to check.",
    "Hello\n```md\n# Expected advice\ninside\n```\n## Sender context\nstill message",
  );
  const f = parseFixture(s.replace(/\n/g, "\r\n"));
  assert.match(f.capture.message, /# Expected advice/);
  assert.match(f.capture.message, /still message/);
  assert.equal(f.meta.id, "one");
});
test("malformed/duplicate frontmatter, IDs, sections, huge files fail visibly", () => {
  for (const s of [
    "missing",
    fixtureTemplate("one").replace("version: 1", "version: 1\nversion: 1"),
    fixtureTemplate("one").replace("id: one", "id: invalid id"),
    fixtureTemplate("one") + "\n# Message\nagain",
    fixtureTemplate("one") + "x".repeat(262144),
  ])
    assert.throws(() => parseFixture(s));
});
test("unknown context does not become empty and templates cannot enable unconfigured JEV", () => {
  assert.equal(
    parseFixture(
      "---\nversion: 1\nid: no-context\nexpect: allow\n---\n# Message\nhello",
    ).capture.sender.coverage,
    "unavailable",
  );
  assert.equal(
    match(
      {
        kind: "condition",
        field: "sender_title",
        operator: "contains",
        value: "x",
        insensitive: false,
      },
      { ...captured, senderTitle: null },
    ),
    null,
  );
  assert.throws(() => validateRule({ ...newRule("new-rule"), enabled: true }));
});
test("score thresholds and choice/criterion identity validation", () => {
  const r = jevRule();
  r.criteria.push({ ...r.criteria[0]! });
  assert.throws(() => validateRule(r));
  assert.throws(() =>
    validateRule({
      ...jevRule(),
      criteria: [{ ...jevRule().criteria[0], rejectChoices: ["invented"] }],
    }),
  );
});
test("unexpected allow, wrong rejecting IDs and wrong exact advice are failing witnesses", () => {
  const f = parseFixture(source());
  assert.equal(assertResult(f, empty).status, "fail");
  assert.equal(assertResult(f, { ...empty, policy: "reject" }).status, "fail");
  assert.equal(normalizeAdvice("Cafe\u0301\r\n"), "Café");
});
test("expected rejection can pass; unresolved never becomes a passing expected rejection", () => {
  const f = parseFixture(source());
  const evaluation = {
    ...empty,
    policy: "reject" as const,
    rules: [
      {
        id: "avoid-status-pings",
        title: "x",
        revision: 1,
        status: "reject" as const,
        observations: {},
      },
    ],
  };
  assert.equal(assertResult(f, evaluation).status, "pass");
  assert.equal(
    assertResult(f, { ...evaluation, policy: "unknown" }).status,
    "unknown",
  );
});
test("plain queued originals keep all eligible sender IDs in planned assertions, separate from native proof", () => {
  const f = parseFixture(
    fixtureTemplate("queued").replace(
      "expected_rules: []",
      "expected_rules: []\nexpected_batch: [update-one, update-two]",
    ) +
      "\n# Queued messages\n```yaml\n- id: update-one\n  senderId: sender-a\n  eligible: true\n- id: update-two\n  senderId: sender-b\n  eligible: true\n- id: future\n  senderId: sender-c\n  eligible: false\n  reason: future schedule\n```\n",
  );
  assert.equal(f.queued!.length, 3);
  assert.deepEqual(f.meta.expected_batch, ["update-one", "update-two"]);
  assert.equal(
    assertResult(f, { ...empty, plannedBatch: ["update-one", "update-two"] })
      .status,
    "pass",
  );
  assert.equal(
    assertResult(f, { ...empty, plannedBatch: ["update-one"] }).status,
    "fail",
  );
});
test("delivered authored example files parse through the actual grammar", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of [
    "decision-request",
    "progress-only-update",
    "steward-batch",
    "native-placement-q-a-s-b",
  ])
    assert.equal(
      parseFixture(
        await readFile(
          new URL("../../fixtures/" + file + ".md", import.meta.url),
          "utf8",
        ),
      ).meta.id,
      file === "native-placement-q-a-s-b" ? "q-a-s-b" : file,
    );
});
