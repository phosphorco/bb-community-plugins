import { runBootstrapSuite } from "../runner/bootstrap-suite.mjs";

export async function runSuite(options = {}) {
  return await runBootstrapSuite({ suite: "analytics-contract", module: "../contracts/analytics/run.mjs", options });
}
