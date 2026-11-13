import { test } from "node:test";
import assert from "node:assert/strict";
import { groupAdmission, plannedBatch } from "../../admission/policy.ts";
const evaluation = (policy: "allow" | "reject" | "unknown") => ({
  version: "v",
  inputHash: "h",
  policy,
  rules: [],
  advice:
    policy === "reject" ? [{ text: "Send the result.", ruleIds: ["r"] }] : [],
  errors: [],
});
const row = (
  id: string,
  policy: "allow" | "reject" | "unknown",
  receipt = false,
) => ({
  id,
  revision: "h",
  senderId: id,
  evaluation: evaluation(policy),
  verifiedReceipt: receipt,
});
test("mixed allow/reject and reject/unknown always wait: no collateral terminal rejection", () => {
  for (const rows of [
    [row("a", "allow"), row("b", "reject")],
    [row("a", "reject"), row("b", "unknown")],
    [row("a", "unknown", true), row("b", "reject")],
    [row("a", "allow", true), row("b", "unknown")],
  ])
    assert.equal(groupAdmission(rows, true).action, "wait");
});
test("verified receipt exempts exact original only; ordinary neighbor still evaluated", () => {
  assert.equal(
    groupAdmission([row("receipt", "unknown", true)], true).action,
    "proceed",
  );
  assert.equal(
    groupAdmission(
      [row("receipt", "allow", true), row("ordinary", "reject")],
      true,
    ).action,
    "wait",
  );
  assert.equal(
    groupAdmission([row("ordinary", "reject")], true).action,
    "reject",
  );
});
test("all-sender membership never silently narrows by sender; plan cannot claim native proof", () => {
  const plan = plannedBatch([
    { id: "a", senderId: "one", eligible: true },
    { id: "b", senderId: "two", eligible: true },
    { id: "c", senderId: null, eligible: false, reason: "future schedule" },
  ]);
  assert.deepEqual(plan.included, ["a", "b"]);
  assert.equal(plan.nativeDeliveryProved, false);
  assert.equal(
    groupAdmission([row("a", "allow"), row("b", "allow")], true).action,
    "wait",
  );
});
