export async function runSuite() {
  return { suite: "malformed-observation", status: "pass", checks: [{ id: "fixture-check", status: "pass", details: "controlled fixture" }], observations: [{ id: "broken", kind: "fixture", status: "not-a-status" }], limits: [] };
}
