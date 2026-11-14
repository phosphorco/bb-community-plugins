import { test } from "node:test";
import assert from "node:assert/strict";
import {
  confirmsWrite,
  reconcileDrafts,
  settleDraft,
  keepNewerSavedInputs,
  operationKey,
  type WriteIntent,
} from "../../ui/writes.ts";
import {
  newGroup,
  newRule,
  defaultConnection,
  fileLocation,
} from "../../contracts/model.ts";
import type { Draft, Snapshot } from "../../ui/types.ts";
const location = { hostId: "host", root: "/a", revision: 1 };
function snapshot(): Snapshot {
  return {
    project: {
      id: "p",
      revision: 2,
      config: {
        hostId: "host",
        root: "/a",
        locationRevision: 1,
        connection: defaultConnection,
      },
      groups: [newGroup("g")],
      rules: [newRule("r", "g")],
      occurrences: [
        {
          occurrenceId: "o",
          path: "one.md",
          logicalId: "one",
          hash: "hash-A",
          enabled: true,
          missing: false,
          error: null,
          source: "A",
        },
      ],
    },
    basis: "basis",
    run: null,
    readError: null,
    connection: { configured: false, mode: "live", tokenAccounting: false },
    delivery: { state: "capability-blocked", reason: "preview" },
    unresolved: [],
  };
}
for (const kind of ["test", "rule", "group"] as const)
  test(`save A / later edit B survives acknowledgement and rebases ${kind} independently`, () => {
    const s = snapshot(),
      item = kind === "rule" ? newRule("r", "g") : newGroup("g");
    const submitted =
      kind === "test" ? "A" : JSON.stringify({ ...item, title: "A" });
    const newer =
      kind === "test" ? "AB" : JSON.stringify({ ...item, title: "B" });
    if (kind === "rule")
      s.project!.rules = [{ ...newRule("r", "g"), title: "A", revision: 1 }];
    if (kind === "group")
      s.project!.groups = [{ ...newGroup("g"), title: "A", revision: 1 }];
    const method =
      kind === "test" ? "saveFile" : kind === "rule" ? "saveRule" : "saveGroup";
    const input =
      kind === "test"
        ? { path: "one.md", source: submitted, location }
        : { [kind]: JSON.parse(submitted) };
    const intent: WriteIntent = { projectId: "p", method, input };
    const pending = { intent, submitted };
    const key =
      "p:" + kind + ":" + (kind === "test" ? "o" : kind === "rule" ? "r" : "g");
    const drafts = new Map<string, Draft>([
      [
        key,
        {
          value: newer,
          base: "old",
          hash: "old-hash",
          kind,
          enabled: true,
          location,
          pending,
        },
      ],
    ]);
    assert.equal(reconcileDrafts(drafts, s), true);
    const d = drafts.get(key)!;
    assert.equal(
      kind === "test" ? d.value : JSON.parse(d.value).title,
      kind === "test" ? "AB" : "B",
    );
    assert.equal(kind === "test" ? d.base : JSON.parse(d.base).title, "A");
    if (kind === "test") assert.equal(d.hash, "hash-A");
    else assert.equal(JSON.parse(d.value).revision, 1);
    assert.equal(d.pending, undefined);
    // The original save callback may complete after the confirming refresh; it cannot drop B either.
    settleDraft(drafts, key, pending, s, true);
    assert.ok(drafts.has(key));
    const b = drafts.get(key)!;
    if (kind === "test") s.project!.occurrences[0]!.source = "AB";
    if (kind === "rule")
      s.project!.rules = [{ ...JSON.parse(b.value), revision: 2 }];
    if (kind === "group")
      s.project!.groups = [{ ...JSON.parse(b.value), revision: 2 }];
    const next: WriteIntent = {
      projectId: "p",
      method,
      input:
        kind === "test"
          ? { path: "one.md", source: b.value, location }
          : { [kind]: JSON.parse(b.value) },
    };
    settleDraft(drafts, key, { intent: next, submitted: b.value }, s, true);
    assert.equal(drafts.has(key), false);
  });
test("lost acknowledgement reconciles only exact target/payload/location, including a saved invalid fixture", () => {
  const s = snapshot();
  s.project!.occurrences[0]!.error = "Invalid fixture grammar";
  const w: WriteIntent = {
    projectId: "p",
    method: "saveFile",
    input: { path: "one.md", source: "A", location },
  };
  const d: Draft = {
    value: "A",
    base: "old",
    hash: "old-hash",
    kind: "test",
    enabled: true,
    location,
    pending: { intent: w, submitted: "A" },
  };
  const drafts = new Map([["p:test:o", d]]);
  assert.equal(
    confirmsWrite({ ...w, input: { ...w.input, path: "other.md" } }, s),
    false,
  );
  assert.equal(
    confirmsWrite({ ...w, input: { ...w.input, source: "unrelated" } }, s),
    false,
  );
  assert.equal(
    confirmsWrite(
      { ...w, input: { ...w.input, location: { ...location, root: "/b" } } },
      s,
    ),
    false,
  );
  assert.equal(confirmsWrite(w, s), true);
  assert.equal(reconcileDrafts(drafts, s), true);
  assert.equal(drafts.size, 0);
  assert.notEqual(
    operationKey(w),
    operationKey({
      ...w,
      input: { ...w.input, location: { ...location, revision: 2 } },
    }),
  );
  assert.deepEqual(fileLocation(s.project!.config), location);
});

test("acknowledged saved inputs appear immediately and cannot regress through a delayed older read", () => {
  const older = snapshot();
  const newer = structuredClone(older);
  newer.project!.revision = older.project!.revision + 1;
  newer.basis = "newer saved basis";
  const afterAck = keepNewerSavedInputs(older, newer);
  assert.equal(afterAck, newer);
  const oldRead = structuredClone(older);
  oldRead.connection.configured = true;
  const afterDelayedRead = keepNewerSavedInputs(afterAck, oldRead);
  assert.equal(afterDelayedRead.project!.revision, newer.project!.revision);
  assert.equal(afterDelayedRead.basis, newer.basis);
  assert.equal(afterDelayedRead.connection.configured, true);
});
