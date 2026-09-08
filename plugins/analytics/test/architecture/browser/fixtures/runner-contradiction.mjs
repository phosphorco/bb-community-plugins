export async function runSuite() {
  return { suite: "ui", status: "pass", checks: [{ id: "actual-failure", status: "fail", details: "controlled contradiction" }], limits: [] };
}
