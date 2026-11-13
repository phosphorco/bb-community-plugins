import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, prepare } from "../../evaluation/evaluator.ts";
import { actionOf, migrateRule, newRule, validateRule, defaultConnection, type Action, type Rule } from "../../contracts/model.ts";
import { captured, jevRule, answer } from "../helpers.ts";
import { parseFixture } from "../../contracts/fixture.ts";
import { assertResult } from "../../suites/runner.ts";
const signal = () => new AbortController().signal;
const direct = (action: Action): Rule => ({ ...newRule(action), enabled: true, advice: "Correct this cause", action });
test("five actions share JEV predicates; Proceed preserves routing; conflicting preferences are unresolved", async () => {
  for (const action of ["reject", "proceed", "steer", "queue", "queue-batched"] as const) {
    const r = direct(action); validateRule(r);
    let calls = 0;
    const result = await evaluate(captured,[r],defaultConnection,async () => { calls++; throw Error("direct"); },signal());
    assert.equal(calls,0);
    assert.equal(result.policy,action === "reject" ? "reject" : "allow");
    assert.equal(result.route?.action,action === "reject" ? undefined : action);
    const semantic = { ...jevRule(), action };
    const nonmatch = await evaluate(captured,[semantic],defaultConnection,async w => answer(w,"no"),signal());
    assert.equal(nonmatch.policy,"allow"); assert.equal(nonmatch.route?.action,"proceed");
    const matched = await evaluate(captured,[semantic],defaultConnection,async w => answer(w),signal());
    assert.equal(matched.policy,action === "reject" ? "reject" : "allow");
    assert.equal(matched.route?.action,action === "reject" ? undefined : action);
  }
  const conflict = await evaluate(captured,[direct("queue"),direct("steer"),direct("reject")],defaultConnection,async () => null,signal());
  assert.equal(conflict.policy,"unknown"); assert.equal(conflict.route,undefined);
  assert.match(conflict.errors.join(" "),/Conflicting routing/);
  assert.deepEqual(conflict.advice,[{ text:"Correct this cause",ruleIds:["reject"] }]);
  const proceed = await evaluate(captured,[direct("proceed"),direct("queue")],defaultConnection,async () => null,signal());
  assert.equal(proceed.route?.action,"queue");
});
test("failed partition still collects later check and known advice", async () => {
  const rules = [jevRule("first"),jevRule("second"),direct("reject")];
  rules.forEach((r,i) => r.order=i);
  const single = prepare(captured,[rules[0]!],defaultConnection).partitions[0]!;
  const config = { ...defaultConnection,maxWireBytes:Buffer.byteLength(JSON.stringify(single.wire))+30 };
  assert.equal(prepare(captured,rules,config).partitions.length,2);
  let calls = 0;
  const result = await evaluate(captured,rules,config,async wire => { if (++calls === 1) throw Error("first unknown"); return answer(wire); },signal());
  assert.equal(calls,2); assert.equal(result.policy,"unknown");
  assert.equal(result.rules.find(r => r.id === "second")!.status,"reject"); assert.equal(result.advice.length,2);
});
test("legacy projection preserves historical bytes, enable state and revision", () => {
  for (const action of ["jev","batch"] as const) {
    const legacy: Rule = { ...jevRule(),action,revision:7,enabled:false }; delete legacy.check;
    const bytes = JSON.stringify(legacy), current = migrateRule(legacy);
    assert.equal(actionOf(current),action === "jev" ? "reject" : "queue-batched");
    assert.equal(current.check,action === "jev" ? "jev" : "always");
    assert.equal(current.revision,7); assert.equal(current.enabled,false); assert.equal(JSON.stringify(legacy),bytes);
  }
});
test("fixtures assert route separately from acceptance", async () => {
  const fixture = parseFixture('---\nversion: 1\nid: route\nexpect: allow\nexpected_route: queue-batched\n---\n# Message\nhello\n');
  const result = await evaluate(fixture.capture,[direct("queue-batched")],defaultConnection,async () => null,signal());
  assert.equal(assertResult(fixture,result).status,"pass");
  assert.equal(assertResult(fixture,{ ...result,route:{action:"queue",ruleIds:[]} }).status,"fail");
});
