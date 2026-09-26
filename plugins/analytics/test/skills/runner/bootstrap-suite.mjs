export async function runBootstrapSuite({ suite, module, options }) {
  if (options.mode === "self-check") {
    return {
      suite,
      status: "pass",
      checks: [{ id: "bootstrap-entrypoint", status: "pass", details: "The bounded suite entrypoint is registered and reaches the runner protocol." }],
      observations: [{ id: "bootstrap-entrypoint", kind: "runner", status: "observed", details: "Self-check only; no provider or Analytics behavior is claimed." }],
      limits: ["The implementation module is deliberately not imported during self-check."],
    };
  }
  const implementation = await import(module);
  if (typeof implementation.runSuite !== "function") throw new Error(`${module} must export runSuite(options = {})`);
  return await implementation.runSuite(options);
}
