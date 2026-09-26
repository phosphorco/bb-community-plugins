import assert from "node:assert/strict";
import test from "node:test";
import {
  IsolationUnavailableError,
  REQUIRED_ISOLATION_CONTROLS,
  assertCgroupLimitValues,
  assertIsolationControls,
  verifyLinuxIsolation,
} from "../../query-runtime/isolation-policy.mjs";

test("a caller capability boolean is not an isolation launcher", () => {
  assert.throws(
    () => assertIsolationControls({ controls: Object.fromEntries(REQUIRED_ISOLATION_CONTROLS.map((key) => [key, true])) }),
    IsolationUnavailableError,
  );
});

test("incomplete controls fail before any worker spawn", () => {
  assert.throws(
    () => assertIsolationControls({ launch() {}, controls: { privateMountNamespace: true } }),
    IsolationUnavailableError,
  );
});

test("a configuration fixture is not OS-isolation qualification", async () => {
  await assert.rejects(
    () => verifyLinuxIsolation({ version: 1, kind: "bubblewrap-cgroup-v2", bwrapPath: "/not-a-launcher", cgroupPath: "/not-a-cgroup", snapshotPath: "/not-a-snapshot", network: "deny", snapshotMount: "/analytics-snapshot/snapshot.json", limits: { cpuQuotaMicros: 1, cpuPeriodMicros: 1, memoryMaxBytes: 1, pidsMax: 1, ioMaxBytesPerSecond: 1 } }),
    IsolationUnavailableError,
  );
});

test("unbounded or mismatched cgroup files cannot satisfy the reviewed envelope", () => {
  const limits = { cpuQuotaMicros: 10_000, cpuPeriodMicros: 100_000, memoryMaxBytes: 128, pidsMax: 8, ioMaxBytesPerSecond: 1_024 };
  assert.throws(() => assertCgroupLimitValues({ "cpu.max": "max 100000", "memory.max": "max", "pids.max": "max", "io.max": "8:0 rbps=max" }, limits), IsolationUnavailableError);
  assert.doesNotThrow(() => assertCgroupLimitValues({ "cpu.max": "10000 100000", "memory.max": "128", "pids.max": "8", "io.max": "8:0 rbps=1024 wbps=1024" }, limits));
});
