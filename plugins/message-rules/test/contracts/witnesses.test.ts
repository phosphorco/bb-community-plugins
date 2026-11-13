import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare, decode } from "../../evaluation/evaluator.ts";
import { assertResult } from "../../suites/runner.ts";
import { parseFixture } from "../../contracts/fixture.ts";
import { defaultConnection } from "../../contracts/model.ts";
import { captured, jevRule, count, answer, source } from "../helpers.ts";
test("defective references trip the actual answer-binding and fixture assertion instruments", () => {
  const plan = prepare(
    captured,
    [jevRule(), jevRule("second-rule")],
    defaultConnection,
    count,
  ).partitions[0]!;
  const omitted = answer(plan.wire);
  delete omitted.answers.q1;
  assert.throws(() => decode(omitted, plan), /Missing/);
  const misnamed = answer(plan.wire);
  misnamed.answers.not_requested = misnamed.answers.q0!;
  delete misnamed.answers.q0;
  assert.throws(() => decode(misnamed, plan), /unexpected/);
  const fixture = parseFixture(source());
  const base = {
    version: "reference",
    inputHash: "reference",
    policy: "reject" as const,
    rules: [
      {
        id: "avoid-status-pings",
        title: "Avoid status pings",
        revision: 1,
        status: "reject" as const,
        observations: {},
      },
    ],
    advice: [],
    errors: [],
  };
  assert.equal(assertResult(fixture, base).status, "pass");
  assert.equal(
    assertResult(fixture, { ...base, policy: "allow" }).status,
    "fail",
  );
  assert.equal(
    assertResult(fixture, {
      ...base,
      rules: [{ ...base.rules[0]!, id: "second-rule" }],
    }).status,
    "fail",
  );
});
