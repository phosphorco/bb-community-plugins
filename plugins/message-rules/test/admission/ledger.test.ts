import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdmissionLedger } from "../../admission/ledger.ts";
import type { Evaluation } from "../../contracts/model.ts";
const evaluation: Evaluation = {version:"v",inputHash:"i",policy:"allow",rules:[],advice:[],errors:[]};
test("independent invocation budgets; duplicates, identity reuse, cancellation and late results fenced", () => {
  const db = new Database(":memory:"), l = createAdmissionLedger(db,"owner");
  for (const id of ["one","two"]) {
    assert.equal(l.begin(id,{ publication:"v1",submission:id }).fresh,true);
    const attempt = l.reserve(id,"partition",{ questions:{} },1); l.invoke(id,attempt);
    assert.throws(() => l.invoke(id,attempt),/permit/); assert.throws(() => l.reserve(id,"other",{},1),/budget/);
  }
  assert.equal(l.begin("one",{ publication:"v1",submission:"one" }).fresh,false);
  assert.throws(() => l.begin("one",{ publication:"v2" }),/different frozen inputs/);
  l.retire("one","cancelled by native",true);
  assert.equal(l.finish("one",evaluation),false); assert.equal(l.finish("two",evaluation),true);
  assert.equal(l.get("one")!.state,"cancelled"); assert.equal(l.get("two")!.evaluation!.policy,"allow");
  l.dispose(); db.close();
});
test("database reopen retires interrupted paid invocation without replay", () => {
  const dir = mkdtempSync(join(tmpdir(),"mr-admission-")), path = join(dir,"state.sqlite");
  try {
    const db = new Database(path), first = createAdmissionLedger(db,"first");
    first.begin("native-v1",{ snapshot:"native bytes",revision:"one" });
    const attempt = first.reserve("native-v1","wire",{},2); first.invoke("native-v1",attempt); db.close();
    const reopened = new Database(path), recovered = createAdmissionLedger(reopened,"second");
    assert.equal(recovered.get("native-v1")!.state,"unknown");
    assert.equal(recovered.begin("native-v1",{ snapshot:"native bytes",revision:"one" }).fresh,false);
    assert.throws(() => recovered.reserve("native-v1","retry",{},2),/retired/);
    assert.equal(recovered.finish("native-v1",evaluation),false);
    assert.equal((reopened.prepare("SELECT state FROM mr_admission_attempts WHERE id=?").get(attempt) as any).state,"unknown"); reopened.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
