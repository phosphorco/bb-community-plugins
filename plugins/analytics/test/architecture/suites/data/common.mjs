import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSupervisedNode } from "../../browser/supervised-node.mjs";

export const analyticsRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

export function check(id, status, details) {
  return { id, status, details };
}

export function suiteResult(suite, checks, limits = []) {
  const statuses = checks.map(({ status }) => status);
  return {
    suite,
    status: statuses.includes("fail")
      ? "fail"
      : statuses.includes("blocked")
        ? "blocked"
        : "pass",
    checks,
    limits,
  };
}

export function isInstrumentSelfTest(options) {
  return options.mode === "instrument-self-test";
}

export async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A test-owned binding imports concrete production modules and exposes their
 * operations. It never accepts a caller's adapter, pass flag, or reported
 * coverage. Until real operations are available, that is an explicit blocked
 * boundary rather than a synthetic success.
 */
export async function bindProductionModules(boundary, paths) {
  const missing = [];
  const modules = {};
  const sourceHashes = [];
  for (const path of paths) {
    const absolute = resolve(analyticsRoot, path);
    if (!absolute.startsWith(analyticsRoot + "/") || !(await exists(absolute))) {
      missing.push(path);
      continue;
    }
    try {
      modules[path] = await import(`${pathToFileUrl(absolute)}?acceptance=${Date.now()}`);
      sourceHashes.push({ path, sha256: await sha256(absolute) });
    } catch (error) {
      return {
        kind: "missing",
        details: `Production ${boundary} module ${path} could not be loaded: ${String(error)}`,
      };
    }
  }
  if (missing.length > 0) {
    return {
      kind: "missing",
      details: `Missing production ${boundary} boundary module(s): ${missing.join(", ")}.`,
    };
  }
  return { kind: "loaded", modules, sourceHashes };
}

export function missingOperation(boundary, signature, sourceHashes = []) {
  return {
    kind: "missing",
    details: `Missing real ${boundary} operation ${signature}. ` +
      "The test-owned binding must call the production surface and inspect its state, not accept a scenario report.",
    sourceHashes,
  };
}

/** Loads only a test-owned thin binding; an absent binding is a normal missing
 * production seam, while a binding that exists but crashes is a harness defect. */
export async function loadOptionalTestBinding(name) {
  const href = new URL(`./bindings/${name}.mjs`, import.meta.url).href;
  try {
    const binding = await import(href);
    if (typeof binding.loadOperations !== "function")
      return { kind: "defect", details: `Test-owned ${name} binding lacks loadOperations().` };
    const operations = await binding.loadOperations();
    return operations == null
      ? { kind: "absent", details: `Test-owned ${name} binding found no real production constructors.` }
      : { kind: "loaded", operations };
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && error?.url === href)
      return { kind: "absent", details: `Test-owned ${name} binding is not present because its real production constructors are not available.` };
    return { kind: "defect", details: `Test-owned ${name} binding failed to import: ${String(error)}` };
  }
}

function pathToFileUrl(path) {
  return new URL(`file://${path}`).href;
}

export async function runNode(args, { timeoutMs = 10_000, cwd = analyticsRoot } = {}) {
  const result = await runSupervisedNode({ args, cwd, timeoutMs });
  return { ...result, output: Buffer.concat([result.stdout, result.stderr]).toString("utf8") };
}

export function evidenceCheck(id, predicate, evidence, failure) {
  try {
    return predicate(evidence)
      ? check(id, "pass", "Observed bounded production evidence matches the fixture.")
      : check(id, "fail", failure);
  } catch (error) {
    return check(id, "fail", failure + " " + String(error));
  }
}
