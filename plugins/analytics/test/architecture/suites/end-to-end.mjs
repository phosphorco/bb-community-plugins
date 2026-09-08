import { acceptanceMode, check, controlledClock, controlledComposerSink, invalidBindingResult, isolatedNegativeControls, loadProductionBinding, missingBindingResult, requireMethods, sourceLimit, suiteResult } from "../browser/acceptance-binding.mjs";

const fixture = Object.freeze({ executionId: "analytics-exec_e2e_fixture_abcdefghijklmnop", datumKey: "analytics-datum_e2e_fixture_abcdefghijklmnop_0", referenceId: "analytics-ref_e2e_fixture_abcdefghijklmnop", token: "analytics-ref:v2:e2e_fixture_abcdefghijklmnop", rows: [{ capability_key: "read_file", failures: 3 }], csv: "capability_key,failures\r\nread_file,3\r\n", context: { coverage: { mode: "partial-retained-projection", incompleteReasons: ["backfill-in-progress"], degraded: true, earliestVerifiedRetainedInclusiveMs: 1_699_000_000_000 }, resultTruncated: false, historical: { toolVersion: "unknown", skillRead: "unknown" } } });
const required = ["openDashboard", "openChartMenu", "openKeyboardRowMenu", "changeRange", "refresh", "editBundle", "copyReference", "insertMention", "resolveMentionAtSend", "attemptComposerSend", "exportCsv", "exportImage", "dispose"];
const sameTarget = (value) => value?.executionId === fixture.executionId && value?.datumKey === fixture.datumKey;
const sameContext = (value) => JSON.stringify(value?.context) === JSON.stringify(fixture.context);
function verify(t) { const branch = (value) => sameTarget(value?.target) && value?.reference?.referenceId === fixture.referenceId && value?.reference?.token === fixture.token && sameTarget(value?.reference) && sameContext(value?.reference) && sameTarget(value?.resolved) && sameContext(value?.resolved) && value?.csv?.bytes === fixture.csv && sameContext(value?.csv) && sameTarget(value?.image) && sameContext(value?.image); return [
  check("pointer-branch", branch(t.pointer) ? "pass" : "fail", "pointer branch independently preserves fixture datum, token, coverage, unknowns, and exports"),
  check("keyboard-branch", branch(t.keyboard) ? "pass" : "fail", "keyboard branch independently preserves fixture datum, token, coverage, unknowns, and exports"),
  check("branch-identity", t.pointer?.reference?.token === fixture.token && t.keyboard?.reference?.token === fixture.token && t.pointer?.reference?.executionId === t.keyboard?.reference?.executionId && t.pointer?.reference?.datumKey === t.keyboard?.reference?.datumKey ? "pass" : "fail", "pointer and keyboard capture identical immutable target lineage"),
  check("controlled-send-attempt", t.attempts?.length === 2 && t.attempts.every((attempt) => attempt.referenceId === fixture.referenceId && attempt.token === fixture.token) && t.mentions?.length === 2 && t.mentions.every((mention) => mention.referenceId === fixture.referenceId && mention.token === fixture.token) && t.deliveryCount === 0 ? "pass" : "fail", "two actual sink inserts and two blocked transport attempts carry exact reference identity"),
]; }
async function branch(binding, kind, sink, clock) {
  await binding.openDashboard({ fixture, clock });
  try {
    const target = kind === "pointer" ? await binding.openChartMenu({ fixture, clock }) : await binding.openKeyboardRowMenu({ fixture, clock });
    await binding.changeRange({ clock }); await binding.refresh({ clock }); await binding.editBundle({ clock });
    const reference = await binding.copyReference({ target, clock }); await binding.insertMention({ referenceId: reference.referenceId, token: reference.token, sink, clock });
    const resolved = await binding.resolveMentionAtSend({ sink, clock });
    try { await binding.attemptComposerSend({ sink, referenceId: reference.referenceId, token: reference.token, clock }); } catch (error) { if (error?.message !== "controlled composer sink blocks external delivery") throw error; }
    const csv = await binding.exportCsv({ target, clock }); const image = await binding.exportImage({ target, clock });
    return { target, reference, resolved, csv, image };
  } finally { await binding.dispose(); }
}
export async function runSuite(options = {}) {
  const mode = acceptanceMode(options);
  if (mode === "instrument-self-test") { const one = { target: { executionId: fixture.executionId, datumKey: fixture.datumKey }, reference: { executionId: fixture.executionId, datumKey: fixture.datumKey, referenceId: fixture.referenceId, token: fixture.token, context: fixture.context }, resolved: { executionId: fixture.executionId, datumKey: fixture.datumKey, context: fixture.context }, csv: { bytes: fixture.csv, context: fixture.context }, image: { executionId: fixture.executionId, datumKey: fixture.datumKey, context: fixture.context } }; const p = { pointer: one, keyboard: one, attempts: [{ referenceId: fixture.referenceId, token: fixture.token }, { referenceId: fixture.referenceId, token: fixture.token }], mentions: [{ referenceId: fixture.referenceId, token: fixture.token }, { referenceId: fixture.referenceId, token: fixture.token }], deliveryCount: 0 }; return suiteResult("end-to-end", isolatedNegativeControls(verify, p, [{ id: "pointer-branch", value: { ...p, pointer: { ...one, reference: { ...one.reference, datumKey: "old" } } } }, { id: "keyboard-branch", value: { ...p, keyboard: { ...one, csv: { ...one.csv, context: { ...fixture.context, resultTruncated: true } } } } }, { id: "branch-identity", value: { ...p, keyboard: { ...one, reference: { ...one.reference, token: "analytics-ref:v2:old" } } } }, { id: "controlled-send-attempt", value: { ...p, mentions: [{ referenceId: fixture.referenceId, token: fixture.token }], deliveryCount: 1 } }]), [{ kind: "mode", value: mode }]); }
  const loaded = await loadProductionBinding(options, "end-to-end"); if (loaded.kind === "missing") return missingBindingResult("end-to-end", loaded.reason); const absent = requireMethods(loaded.binding, required); if (absent) return invalidBindingResult("end-to-end", absent);
  const clock = controlledClock(); const sink = controlledComposerSink();
  try { const pointer = await branch(loaded.binding, "pointer", sink, clock); const keyboard = await branch(loaded.binding, "keyboard", sink, clock); return suiteResult("end-to-end", verify({ pointer, keyboard, attempts: sink.attempts(), mentions: sink.mentions(), deliveryCount: sink.deliveryCount() }), [sourceLimit(loaded.sources)]); }
  finally { await loaded.binding.dispose(); }
}
