import { runBootstrapSuite } from "../runner/bootstrap-suite.mjs";

export async function runSuite(options = {}) {
  return await runBootstrapSuite({ suite: "fork-free-contract", module: "../contracts/fork-free/run.mjs", options });
}
