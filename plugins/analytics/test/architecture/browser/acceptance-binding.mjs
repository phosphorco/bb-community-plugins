import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const pluginRoot = resolve(new URL("../../../", import.meta.url).pathname);

export function check(id, status, details) {
  return { id, status, details: String(details).slice(0, 1_500) };
}

export function suiteResult(suite, checks, limits = []) {
  const status = checks.some((item) => item.status === "fail")
    ? "fail"
    : checks.some((item) => item.status === "blocked")
      ? "blocked"
      : "pass";
  return { suite, status, checks, limits };
}

export function acceptanceMode(options = {}) {
  const mode = options.mode ?? "acceptance";
  if (mode !== "acceptance" && mode !== "instrument-self-test")
    throw new Error("mode must be acceptance or instrument-self-test");
  return mode;
}

/**
 * A future production lane adds this TEST-owned module only:
 * browser/production-binding.mjs exporting bindProduction({ suite }). It imports
 * actual components/services and exposes operations, never assertion outcomes.
 */
export async function loadProductionBinding(options, suite) {
  let bindProduction;
  const bindingUrl = new URL("./production-binding.mjs", import.meta.url).href;
  try {
    ({ bindProduction } = await import(bindingUrl));
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && error?.url === bindingUrl) return {
      kind: "missing",
      reason: "missing test-owned browser/production-binding.mjs; no real Analytics UI/browser surface is wired",
    };
    throw error;
  }
  if (typeof bindProduction !== "function")
    throw new Error("test-owned browser/production-binding.mjs must export bindProduction({ suite })");
  const binding = await bindProduction({ suite, signal: options.signal });
  if (binding == null || binding.identity?.kind !== "production")
    throw new Error("production binding must identify itself as production and expose source files");
  const sources = await sourceFingerprints(["test/architecture/browser/production-binding.mjs", ...binding.identity.sourceFiles]);
  if (sources.length === 0)
    throw new Error("production binding has no readable source files to fingerprint");
  return { kind: "production", binding, sources };
}

async function sourceFingerprints(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("production binding sourceFiles must be nonempty");
  if (files.length > 16) throw new Error("production binding sourceFiles exceeds explicit 16-file fingerprint cap");
  const entries = [];
  for (const file of files) {
    if (typeof file !== "string") throw new Error("production binding sourceFiles contains a non-string path");
    const path = resolve(pluginRoot, file);
    if (!path.startsWith(pluginRoot + "/")) throw new Error("production binding source file escapes plugin root");
    try {
      const bytes = await readFile(path);
      entries.push({
        file,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } catch (error) {
      throw new Error(`cannot fingerprint production binding source ${file}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return entries;
}

export function sourceLimit(sources) {
  return { kind: "production-source-hashes", files: sources };
}

export function missingBindingResult(suite, reason) {
  return suiteResult(suite, [check("production-binding", "blocked", reason)]);
}
export function invalidBindingResult(suite, reason) {
  return suiteResult(suite, [check("production-binding", "fail", reason)]);
}

export function requireMethods(value, methods) {
  const missing = methods.filter((method) => typeof value?.[method] !== "function");
  return missing.length === 0 ? null : `binding is missing operations: ${missing.join(", ")}`;
}

export function controlledClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  return Object.freeze({ now: () => now, advance: (ms) => (now += ms) });
}

export function controlledComposerSink() {
  const mentions = [];
  const attempts = [];
  return Object.freeze({
    insert: (mention) => mentions.push(mention),
    attemptSend: (payload) => { attempts.push(payload); throw new Error("controlled composer sink blocks external delivery"); },
    mentions: () => [...mentions],
    attempts: () => [...attempts],
    deliveryCount: () => 0,
  });
}

/** Controlled doubles prove each oracle rejects its own isolated corruption. */
export function isolatedNegativeControls(verify, good, controls) {
  const positive = verify(good);
  return [
    check(
      "instrument-self-test-positive",
      positive.every((item) => item.status === "pass") ? "pass" : "fail",
      "controlled concrete positive trace",
    ),
    ...controls.map(({ id, value }) => {
      const observed = verify(value).find((item) => item.id === id);
      return check(
        `instrument-self-test-negative-${id}`,
        observed?.status === "fail" ? "pass" : "fail",
        `controlled isolated corruption of ${id} is rejected`,
      );
    }),
  ];
}
