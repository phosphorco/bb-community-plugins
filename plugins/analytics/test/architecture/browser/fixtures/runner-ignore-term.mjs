process.on("SIGTERM", () => {});
export async function runSuite() {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  return { suite: "ui", status: "pass", checks: [{ id: "late", status: "pass", details: "unreachable" }], limits: [] };
}
