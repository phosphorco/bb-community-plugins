export async function runSuite() {
  return { suite: "wrong-value", status: "pass", checks: [{ id: "fixture-check", status: "pass", details: "controlled fixture" }], observations: [{ id: "wrong-value", kind: "fixture", status: "certainly-wrong" }], limits: [] };
}
