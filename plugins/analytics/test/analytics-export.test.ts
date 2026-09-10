import assert from "node:assert/strict";
import test from "node:test";

import { rowsToCsv } from "../analytics-export.ts";

test("CSV export is deterministic, quoted, and neutralizes spreadsheet formulas", () => {
  const csv = rowsToCsv([
    { label: "=IMPORTXML(\"https://example.invalid\")", value: 2 },
    { label: "safe, value", value: null },
  ], ["label", "value"]);
  assert.equal(csv, [
    '"label","value"',
    '"\'=IMPORTXML(""https://example.invalid"")","2"',
    '"safe, value",""',
  ].join("\r\n"));
});
