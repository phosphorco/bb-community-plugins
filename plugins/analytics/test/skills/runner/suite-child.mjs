const prefix = "@@bb-skills-acceptance-result@@";
const args = process.argv.slice(2);
const moduleIndex = args.indexOf("--module");
const modeIndex = args.indexOf("--mode");
const controlsIndex = args.indexOf("--negative-controls");
const module = moduleIndex < 0 ? null : args[moduleIndex + 1];
const mode = modeIndex < 0 ? "acceptance" : args[modeIndex + 1];
let negativeControls = [];

function emit(envelope) { process.stdout.write(`${prefix}${JSON.stringify(envelope)}\n`); }

try {
  if (controlsIndex >= 0) {
    negativeControls = JSON.parse(args[controlsIndex + 1]);
    if (!Array.isArray(negativeControls) || negativeControls.some((control) => typeof control !== "string")) throw new Error("negative controls must be a string array");
  }
} catch (error) {
  emit({ ok: false, phase: "arguments", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}

if (!module) {
  emit({ ok: false, phase: "arguments", message: "missing suite module" });
  process.exitCode = 1;
} else {
  let imported;
  try {
    imported = await import(module);
  } catch (error) {
    emit({ ok: false, phase: "import", code: error?.code, message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
  if (imported != null) {
    try {
      if (typeof imported.runSuite !== "function") throw new Error("suite does not export runSuite(options = {})");
      emit({ ok: true, result: await imported.runSuite({ mode, negativeControls }) });
    } catch (error) {
      emit({ ok: false, phase: "run", code: error?.code, message: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    }
  }
}
