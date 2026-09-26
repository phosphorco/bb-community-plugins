import { access, readFile, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, normalize } from "node:path";

/**
 * The execution process is not allowed to start on the ordinary Node child
 * path.  This module is deliberately small and dependency-free so a host
 * provisioner can supply a reviewed Bubblewrap/cgroup v2 configuration rather
 * than quietly falling back to process-local JS limits.
 */
export const REQUIRED_ISOLATION_CONTROLS = Object.freeze([
  "privateMountNamespace",
  "readOnlySnapshot",
  "networkDenied",
  "cpuMax",
  "memoryMax",
  "pidsMax",
  "ioMax",
  "killOnParentExit",
]);

export class IsolationUnavailableError extends Error {
  constructor(reason) {
    super("Required analytics process isolation is unavailable: " + reason);
    this.code = "isolation-unavailable";
  }
}

function safeAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") ||
      normalize(value) !== value || value.length > 4096) {
    throw new IsolationUnavailableError(label + " is not a normalized absolute path");
  }
  return value;
}

function positive(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new IsolationUnavailableError(label + " must be a positive integer");
  }
  return value;
}

/**
 * Validate deployment-owned controls before a snapshot lease is acquired.
 * This rejects missing controls rather than accepting Node heap flags,
 * cooperative timeouts, or a read-only operational database as substitutes.
 */
export async function verifyLinuxIsolation(config) {
  if (process.platform !== "linux") {
    throw new IsolationUnavailableError("Linux cgroup v2 and namespace controls are required");
  }
  if (config?.version !== 1 || config?.kind !== "bubblewrap-cgroup-v2") {
    throw new IsolationUnavailableError("a reviewed bubblewrap-cgroup-v2 configuration is required");
  }
  const bwrapPath = safeAbsolutePath(config.bwrapPath, "bubblewrap path");
  const cgroupPath = safeAbsolutePath(config.cgroupPath, "cgroup path");
  const snapshotPath = safeAbsolutePath(config.snapshotPath, "snapshot artifact path");
  const runtimeRoot = safeAbsolutePath(config.runtimeRoot, "worker runtime root");
  const limits = {
    cpuQuotaMicros: positive(config.limits?.cpuQuotaMicros, "cpu quota"),
    cpuPeriodMicros: positive(config.limits?.cpuPeriodMicros, "cpu period"),
    memoryMaxBytes: positive(config.limits?.memoryMaxBytes, "memory maximum"),
    pidsMax: positive(config.limits?.pidsMax, "pids maximum"),
    ioMaxBytesPerSecond: positive(config.limits?.ioMaxBytesPerSecond, "I/O maximum"),
  };
  await Promise.all([
    access(bwrapPath, fsConstants.X_OK),
    stat(snapshotPath).then((entry) => {
      if (!entry.isFile()) throw new IsolationUnavailableError("snapshot artifact is not a file");
    }),
    stat(cgroupPath).then((entry) => {
      if (!entry.isDirectory()) throw new IsolationUnavailableError("cgroup path is not a directory");
    }),
    stat(runtimeRoot).then((entry) => {
      if (!entry.isDirectory()) throw new IsolationUnavailableError("worker runtime root is not a directory");
    }),
  ]).catch((cause) => {
    if (cause instanceof IsolationUnavailableError) throw cause;
    throw new IsolationUnavailableError("required launcher, cgroup, or snapshot artifact cannot be verified");
  });
  const requiredFiles = ["cgroup.controllers", "cgroup.procs", "cpu.max", "memory.max", "pids.max", "io.max"];
  const contents = await Promise.all(requiredFiles.map(async (name) => {
    try { return [name, await readFile(cgroupPath + "/" + name, "utf8")]; }
    catch { throw new IsolationUnavailableError("cgroup v2 control " + name + " is unavailable"); }
  }));
  const controls = Object.fromEntries(contents);
  for (const controller of ["cpu", "memory", "pids", "io"]) {
    if (!controls["cgroup.controllers"].split(/\s+/).includes(controller)) {
      throw new IsolationUnavailableError("cgroup controller " + controller + " is unavailable");
    }
  }
  assertCgroupLimitValues(controls, limits);
  if (config.network !== "deny" || config.snapshotMount !== "/analytics-snapshot/snapshot.json") {
    throw new IsolationUnavailableError("network denial and fixed read-only snapshot mount are required");
  }
  return Object.freeze({ bwrapPath, cgroupPath, snapshotPath, runtimeRoot, limits });
}

export function assertCgroupLimitValues(controls, limits) {
  if (controls?.["cpu.max"]?.trim() !== `${limits.cpuQuotaMicros} ${limits.cpuPeriodMicros}` ||
      controls?.["memory.max"]?.trim() !== String(limits.memoryMaxBytes) ||
      controls?.["pids.max"]?.trim() !== String(limits.pidsMax) ||
      !new RegExp(`(?:^|\\s)(?:rbps|wbps)=${limits.ioMaxBytesPerSecond}(?:\\s|$)`).test(controls?.["io.max"] ?? "")) {
    throw new IsolationUnavailableError("cgroup resource limits are missing or differ from the reviewed envelope");
  }
}

/**
 * This Node-side adapter intentionally fails closed. `child_process.spawn()`
 * cannot atomically enter a cgroup before the child executes: assigning its
 * PID after spawn has an unbounded execution race. Nor can Node prove the
 * Bubblewrap IPC FD survives the namespace transition. A production adapter
 * must be supplied by a deployment launcher that creates the cgroup/namespace
 * before exec and returns an observed child attestation. Do not replace this
 * denial with a post-spawn cgroup write.
 */
export async function createLinuxIsolatedLauncher(config) {
  await verifyLinuxIsolation(config);
  throw new IsolationUnavailableError(
    "Node cannot establish atomic pre-exec cgroup confinement; use a qualified platform launcher.",
  );
}

export function assertIsolationControls(launcher) {
  for (const control of REQUIRED_ISOLATION_CONTROLS) {
    if (launcher?.controls?.[control] !== true) {
      throw new IsolationUnavailableError("missing " + control + " control");
    }
  }
  if (typeof launcher?.launch !== "function") {
    throw new IsolationUnavailableError("isolated launcher is missing");
  }
}
