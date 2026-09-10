const prefix = "@@bb-analytics-acceptance-result@@";
const args = process.argv.slice(2); const moduleIndex = args.indexOf("--module"); const modeIndex = args.indexOf("--mode");
const module = moduleIndex < 0 ? null : args[moduleIndex + 1]; const mode = modeIndex < 0 ? "acceptance" : args[modeIndex + 1];
function emit(envelope) { process.stdout.write(`${prefix}${JSON.stringify(envelope)}\n`); }
if (!module) emit({ ok: false, phase: "arguments", message: "missing suite module" });
else {
  let imported;
  try { imported = await import(module); } catch (error) { emit({ ok: false, phase: "import", code: error?.code, module, missingModule: error?.url, message: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }
  if (imported != null) {
    try { if (typeof imported.runSuite !== "function") throw new Error("suite does not export runSuite(options = {})"); emit({ ok: true, result: await imported.runSuite({ mode }) }); }
    catch (error) { emit({ ok: false, phase: "run", code: error?.code, message: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }
  }
}
