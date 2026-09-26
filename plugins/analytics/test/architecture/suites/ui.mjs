import { acceptanceMode, check, invalidBindingResult, isolatedNegativeControls, loadProductionBinding, missingBindingResult, requireMethods, sourceLimit, suiteResult } from "../browser/acceptance-binding.mjs";

const required = ["run"];

function verify(receipt) {
  const componentPassed = receipt?.component?.tests === 14 && receipt.component.suites >= 1;
  const staleEventPassed = Number.isInteger(receipt?.staleEvent?.cases) && receipt.staleEvent.cases >= 6 && Array.isArray(receipt.staleEvent.cleanup?.errors) && receipt.staleEvent.cleanup.errors.length === 0;
  const capturedSvgPassed = Number.isInteger(receipt?.capturedSvg?.cases) && receipt.capturedSvg.cases >= 8 && Array.isArray(receipt.capturedSvg.cleanup?.errors) && receipt.capturedSvg.cleanup.errors.length === 0;
  return [
    check("execution-component-fixture", componentPassed ? "pass" : "fail", "14 real execution-backed component cases passed"),
    check("stale-event-browser-fixture", staleEventPassed ? "pass" : "fail", "live Chromium stale-event fixture retained exact identity and cleanup evidence"),
    check("captured-svg-browser-fixture", capturedSvgPassed ? "pass" : "fail", "live Chromium captured-export fixture retained execution lineage and cleanup evidence"),
  ];
}
export async function runSuite(options = {}) {
  const mode = acceptanceMode(options);
  if (mode === "instrument-self-test") {
    const positive = { component: { tests: 14, suites: 1 }, staleEvent: { cases: 6, cleanup: { errors: [] } }, capturedSvg: { cases: 8, cleanup: { errors: [] } } };
    return suiteResult("ui", isolatedNegativeControls(verify, positive, [
      { id: "execution-component-fixture", value: { ...positive, component: { tests: 13, suites: 1 } } },
      { id: "stale-event-browser-fixture", value: { ...positive, staleEvent: { cases: 6, cleanup: { errors: ["leak"] } } } },
      { id: "captured-svg-browser-fixture", value: { ...positive, capturedSvg: { cases: 7, cleanup: { errors: [] } } } },
    ]), [{ kind: "mode", value: mode }]);
  }
  const loaded = await loadProductionBinding(options, "ui"); if (loaded.kind === "missing") return missingBindingResult("ui", loaded.reason);
  const absent = requireMethods(loaded.binding, required); if (absent) return invalidBindingResult("ui", absent);
  const receipt = await loaded.binding.run();
  return suiteResult("ui", verify(receipt), [sourceLimit(loaded.sources)]);
}
