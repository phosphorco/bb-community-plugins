import assert from "node:assert/strict";
import test from "node:test";

import {
  createLatestRequestGate,
  selectExactStagedIds,
  snapshotSelection,
} from "../lib/composer-state.ts";

test("only the newest staging refresh can replace the displayed list", async () => {
  const gate = createLatestRequestGate();
  const displayed = ["last good"];
  const first = gate.issue();
  const second = gate.issue();

  // The newer request completes first; the older response cannot restore an
  // annotation that has since been removed.
  if (gate.isLatest(second)) displayed.splice(0, displayed.length, "current");
  if (gate.isLatest(first)) displayed.splice(0, displayed.length, "obsolete");
  assert.deepEqual(displayed, ["current"]);

  // A failed latest request never clears the last confirmed snapshot. A later
  // successful request is accepted, and unmount invalidates work in flight.
  gate.issue();
  assert.deepEqual(displayed, ["current"]);
  const recovered = gate.issue();
  if (gate.isLatest(recovered)) displayed.splice(0, displayed.length, "recovered");
  assert.deepEqual(displayed, ["recovered"]);
  gate.invalidate();
  assert.equal(gate.isLatest(recovered), false);
});

test("Add requires every reviewed annotation to still be staged and unattached", () => {
  const selected = new Set(["first", "second"]);
  const displayed = [{ id: "first", seq: 1 }, { id: "second", seq: 2 }];
  assert.deepEqual(
    selectExactStagedIds(
      [{ id: "second", seq: 2 }, { id: "first", seq: 1 }, { id: "other", seq: 3 }],
      displayed,
      selected,
      new Set(),
    ),
    ["second", "first"],
  );
  assert.equal(selectExactStagedIds([{ id: "first", seq: 1 }], displayed, selected, new Set()), null);
  assert.equal(
    selectExactStagedIds(displayed, displayed, selected, new Set(["first"])),
    null,
  );
  assert.equal(
    selectExactStagedIds(
      [{ id: "first", seq: 1 }, { id: "second", seq: 3 }],
      displayed,
      selected,
      new Set(),
    ),
    null,
  );
});

test("removal confirmation retains the IDs the human confirmed", () => {
  const selected = new Set(["first", "second"]);
  const confirmed = snapshotSelection(selected);
  selected.clear();
  selected.add("third");
  assert.deepEqual(confirmed, ["first", "second"]);
});
