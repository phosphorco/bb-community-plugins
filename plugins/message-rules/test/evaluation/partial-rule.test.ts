import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../../evaluation/evaluator.ts";
import { defaultConnection } from "../../contracts/model.ts";
import { captured, jevRule, answer } from "../helpers.ts";
for (const reduction of ["any","all"] as const)
  for (const choice of ["yes","no"] as const)
    test(`incomplete ${reduction} rule with known ${choice} retains only determined cause/advice and never becomes final`,async()=>{
      const rule=jevRule("partial-rule");
      rule.reduction=reduction;rule.advice="Repair the known cause.";
      rule.criteria=[rule.criteria[0]!,{...rule.criteria[0]!,id:"missing-sibling"}];
      let calls=0;
      const result=await evaluate(captured,[rule],defaultConnection,async wire=>{
        calls++;const response=answer(wire,choice);
        delete response.answers[Object.keys(wire.questions)[1]!];
        return response;
      },new AbortController().signal);
      const knownCause=reduction==="any"&&choice==="yes";
      assert.equal(result.policy,"unknown");assert.equal(result.rules[0]!.status,"unknown");
      assert.equal(result.rules[0]!.applies,knownCause);
      assert.equal(Object.keys(result.rules[0]!.observations).length,1);
      assert.deepEqual(result.advice,knownCause?[{text:rule.advice,ruleIds:[rule.id]}]:[]);
      assert.equal(result.route,undefined);assert.equal(calls,1);
    });
