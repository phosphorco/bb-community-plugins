import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateScoped } from "../../evaluation/scoped.ts";
import { groupAdmission } from "../../admission/policy.ts";
import { newGroup, newRule, defaultConnection, type Rule } from "../../contracts/model.ts";
import { captured, jevRule, answer } from "../helpers.ts";
const any = { kind: "all" as const, children: [] };
const groups = ["a", "b"].map(id => ({ ...newGroup(id), enabled: true, match: any }));
const rules: Rule[] = [
  { ...newRule("request", "a"), enabled: true, order: 0, action: "reject", match: any, advice: "State the request." },
  { ...jevRule("owner"), order: 1, groupId: "b", match: any, advice: "Name the owner." },
  { ...jevRule("style"), order: 2, groupId: "b", match: any, advice: "State the request." },
];
const evaluate = (rs: Rule[], transport: Parameters<typeof evaluateScoped>[5]) =>
  evaluateScoped(captured, groups, rs, defaultConnection, async () => captured, transport, new AbortController().signal);
test("all groups aggregate advice with every duplicate cause ID; incomplete fields retain known advice under unknown", async () => {
  let questions = 0;
  const result = await evaluate(rules, async wire => { questions += Object.keys(wire.questions).length; return answer(wire); });
  assert.equal(questions, 2);
  assert.deepEqual(result.rules.map(r => r.status), ["reject", "reject", "reject"]);
  assert.deepEqual(result.advice, [{ text: "State the request.", ruleIds: ["request", "style"] }, { text: "Name the owner.", ruleIds: ["owner"] }]);
  const admission = groupAdmission([{ id: "message", revision: "v1", senderId: "sender", evaluation: result, verifiedReceipt: false }], true);
  assert.equal(admission.action, "reject");
  assert.equal(admission.message, "State the request.\n\nName the owner.");
  const incomplete = await evaluate(rules, async wire => { const response = answer(wire); delete response.answers[Object.keys(response.answers)[0]!]; return response; });
  assert.equal(incomplete.policy, "unknown"); assert.deepEqual(incomplete.advice, [{ text: "State the request.", ruleIds: ["request"] }, { text: "Name the owner.", ruleIds: ["owner"] }]);
  assert.equal(groupAdmission([{ id: "message", revision: "v1", senderId: "sender", evaluation: incomplete, verifiedReceipt: false }], true).action, "wait");
});
test("contradictory Choice/Score distributions hold; consistent metrics, ties and rounded scores remain usable", async () => {
  const score: Rule = { ...rules[1]!, criteria: [{ id: "rating", type: "score", instructions: "Rate it", criteria: ["low", "high"], comparison: "gte", rejectAt: 0.5, context: { message: true, senderHistory: 0, destinationHistory: 0, requireComplete: true } }] };
  for (const rule of [rules[1]!, score]) {
    assert.equal((await evaluate([rule], async wire => answer(wire))).policy, "reject");
    const bad = await evaluate([rule], async wire => { const response: any = answer(wire), a: any = Object.values(response.answers)[0]; if (a.type === "choice") a.choice = "no"; else a.score = 0; return response; });
    assert.equal(bad.policy, "unknown"); assert.deepEqual(bad.advice, []); assert.match(bad.errors.join(" "), /Inconsistent/);
  }
  const rounded = await evaluate([score], async wire => { const response: any = answer(wire), a: any = Object.values(response.answers)[0]; a.score = 0.67; a.probabilities = { 0: 0.3333, 1: 0.6667 }; return response; });
  assert.equal(rounded.policy, "reject");
  const tied = await evaluate([rules[1]!], async wire => { const response: any = answer(wire), a: any = Object.values(response.answers)[0]; a.probabilities = { yes: 0.5, no: 0.5 }; return response; });
  assert.equal(tied.policy, "reject");
});
