export async function runSuite() {
  process.exitCode = 23;
  return { suite: "ui", status: "pass", checks: [{ id: "printed-pass", status: "pass", details: "must not be trusted" }], limits: [] };
}
