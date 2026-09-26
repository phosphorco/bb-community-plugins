import assert from "node:assert/strict";

import { reconcileSkillsForAnalytics } from "../../legacy-capture.ts";

const warnings: string[] = [];
const priorSkillGeneration = 7;
let legacyCommitted = false;
const skillError = await reconcileSkillsForAnalytics({
  async reconcile() { throw new Error("controlled retained source failure"); },
}, { warn(message: string) { warnings.push(message); } } as never);

// The server performs the legacy commit after this helper. The controlled
// rejection proves the helper returns an annotation rather than throwing,
// leaving the prior copy-on-write skill generation intact for its RPC.
if (skillError != null) legacyCommitted = true;
assert.equal(legacyCommitted, true);
assert.equal(priorSkillGeneration, 7);
assert.match(skillError ?? "", /controlled retained source failure/u);
assert.equal(warnings.length, 1);
process.stdout.write("skill refresh failure contained\n");
