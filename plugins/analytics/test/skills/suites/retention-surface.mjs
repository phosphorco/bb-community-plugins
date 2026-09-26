import { runBootstrapSuite } from "../runner/bootstrap-suite.mjs";

export async function runSuite(options = {}) {
  return await runBootstrapSuite({ suite: "retention-surface", module: "../retention-surface/run.mjs", options });
}
