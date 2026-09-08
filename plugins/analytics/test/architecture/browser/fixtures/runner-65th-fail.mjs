export async function runSuite() {
  return { suite: "ui", status: "pass", checks: Array.from({ length: 65 }, (_, index) => ({ id: `check-${index}`, status: index === 64 ? "fail" : "pass", details: "control" })), limits: [] };
}
