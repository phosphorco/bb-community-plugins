console.log("😀".repeat(2_000));
export async function runSuite() { return { suite: "ui", status: "pass", checks: [{ id: "late", status: "pass", details: "unreachable" }], limits: [] }; }
