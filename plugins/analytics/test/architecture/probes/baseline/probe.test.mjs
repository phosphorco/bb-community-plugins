import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { classifyWitness } from "./probe.mjs";

test("missing child imports and failed assertion controls remain failures", () => {
  assert.deepEqual(
    classifyWitness({ childOk: false, controlsPass: true, witnessPresent: true }),
    { status: "failure", behavior: "infrastructure-failure" },
  );
  assert.deepEqual(
    classifyWitness({ childOk: true, controlsPass: false, witnessPresent: true }),
    { status: "failure", behavior: "assertion-control-failure" },
  );
});

test("a current fix is separate from a historical-witness failure", () => {
  assert.deepEqual(
    classifyWitness({ childOk: true, controlsPass: true, witnessPresent: false }),
    { status: "unsupported", behavior: "fixed-or-changed" },
  );
});

test("historical source fixtures retain the exact review-recorded hashes", async () => {
  const directory = join(dirname(fileURLToPath(import.meta.url)), "fixtures/historical");
  const expected = {
    "sql-policy.ts": "10ecf53e1e02ed4db148add0e57f1e1642eb86be10e8606ad895948ca3fe226e",
    "browser-engine.ts": "94ab5c0b9e7d856be4ca384a8eebcd4bd0bb1ff80fb471e735ce935277f8a5d7",
  };
  for (const [name, hash] of Object.entries(expected)) {
    const source = await readFile(join(directory, name));
    assert.equal(createHash("sha256").update(source).digest("hex"), hash, name);
  }
});
