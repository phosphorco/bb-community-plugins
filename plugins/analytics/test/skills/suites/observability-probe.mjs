import { runBootstrapSuite } from "../runner/bootstrap-suite.mjs";

export async function runSuite(options = {}) {
  return await runBootstrapSuite({ suite: "observability-probe", module: "../probes/run.mjs", options });
}
