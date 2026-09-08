import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { decodeChildResult, runSuiteProcess } from "../acceptance.mjs";
import { runSupervisedNode } from "./supervised-node.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).href;

test("runner terminates an inert timed-out suite group before advancing", async () => {
  const result = await runSuiteProcess({ suite: "ui", module: fixture("runner-timeout.mjs"), mode: "acceptance", timeoutMs: 50, killGraceMs: 50 });
  assert.equal(result.reason, "deadline");
  assert.equal(result.closeObserved, true);
  assert.equal(result.exitObserved, true);
  assert.ok(result.signal === "SIGTERM" || result.signal === "SIGKILL");
  assert.equal(decodeChildResult(result, "ui").status, "blocked");
});

test("runner escalates to SIGKILL after an inert child ignores SIGTERM", async () => {
  const result = await runSuiteProcess({ suite: "ui", module: fixture("runner-ignore-term.mjs"), mode: "acceptance", timeoutMs: 50, killGraceMs: 50, closeGraceMs: 50 });
  assert.equal(result.reason, "deadline");
  assert.equal(result.closeObserved, true);
  assert.equal(result.signal, "SIGKILL");
});

test("runner terminates a suite when incremental stdout cap is exceeded", async () => {
  const result = await runSuiteProcess({ suite: "ui", module: fixture("runner-output.mjs"), mode: "acceptance", timeoutMs: 1_000, outputCapBytes: 512, killGraceMs: 50 });
  assert.equal(result.reason, "stdout-cap");
  assert.equal(result.closeObserved, true);
  assert.ok(result.capturedBytes.stdout <= 512);
  assert.ok(result.receivedBytes.stdout > 512);
  assert.equal(decodeChildResult(result, "ui").status, "fail");
});

test("runner rejects a contradictory suite aggregate", async () => {
  const result = await runSuiteProcess({ suite: "ui", module: fixture("runner-contradiction.mjs"), mode: "acceptance", timeoutMs: 1_000, killGraceMs: 50 });
  const decoded = decodeChildResult(result, "ui");
  assert.equal(decoded.status, "fail");
  assert.equal(decoded.checks[0].id, "suite-protocol");
});

test("runner rejects a printed pass followed by nonzero exit", async () => {
  const result = await runSuiteProcess({ suite: "ui", module: fixture("runner-print-pass-exit23.mjs"), mode: "acceptance", timeoutMs: 1_000 });
  assert.equal(result.closeObserved, true);
  assert.equal(result.code, 23);
  assert.equal(decodeChildResult(result, "ui").status, "fail");
});

test("runner rejects a 65th hidden failing check", async () => {
  const result = await runSuiteProcess({ suite: "ui", module: fixture("runner-65th-fail.mjs"), mode: "acceptance", timeoutMs: 1_000 });
  assert.equal(result.code, 0);
  assert.equal(decodeChildResult(result, "ui").checks[0].id, "suite-protocol");
});

test("runner counts UTF-8 bytes and retains no more than cap during multibyte flood", async () => {
  const result = await runSuiteProcess({ suite: "ui", module: fixture("runner-multibyte-output.mjs"), mode: "acceptance", timeoutMs: 1_000, outputCapBytes: 513, killGraceMs: 50 });
  assert.equal(result.reason, "stdout-cap");
  assert.equal(result.closeObserved, true);
  assert.ok(result.capturedBytes.stdout <= 513);
  assert.ok(result.receivedBytes.stdout > 513);
});

test("synthetic no-close seam settles explicitly and releases owned pipe handles", async () => {
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let unrefCount = 0;
  child.unref = () => { unrefCount += 1; };
  const result = await runSupervisedNode({ args: [], cwd: process.cwd(), timeoutMs: 10, killGraceMs: 10, closeGraceMs: 10, spawnImpl: () => child, killImpl: () => {} });
  assert.equal(result.reason, "child-exit-not-confirmed");
  assert.equal(result.terminationReason, "deadline");
  assert.equal(result.closeObserved, false);
  assert.equal(unrefCount, 1);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});
