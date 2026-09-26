import { runBootstrapSuite } from "../runner/bootstrap-suite.mjs";

export async function runSuite(options = {}) {
  return await runBootstrapSuite({ suite: "runtime-contract", module: "../contracts/runtime-events/run.mjs", options });
}
