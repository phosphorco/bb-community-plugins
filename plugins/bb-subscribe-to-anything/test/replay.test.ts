import test from "node:test";
import assert from "node:assert/strict";
import { collectorMain } from "../collector.ts";
import { recipeSchema } from "../contracts.ts";
import type { runBash } from "../runner.ts";
import type { createMailbox } from "../mailbox.ts";
const recipe = recipeSchema.parse({ script: "true", interpretation: "flag", coverage: "snapshot", evaluation: { kind: "json_equals", path: [], value: true } });
const config = { id: "sub", token: "token", generation: 1, recipe, expires_at: Date.now() + 10000 };
const task = (id: string, sequence: number) => ({ id, sequence, generation: 1, recipe, history: [] });
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

test("bounded sequence fence retries the exact sealed payload after lost receipt and ignores delayed older assignment", async () => {
  let completed = 0, runs = 0, retries = 0, stopped = 0, sentOld = false, committed = false;
  const payloads: string[][] = [];
  const connect = async () => ({ transport: "fixture", abort() {}, close() {}, async rpc(op: string, extra: string[] = []) {
    if (op === "collector-stopped") { stopped++; return { accepted: true }; }
    if (op === "collector-result") {
      payloads.push(extra);
      if (extra[0] === "one" && retries++ === 0) { committed = true; throw new Error("accepted but receipt lost"); }
      completed++; return { accepted: true };
    }
    await pause(20);
    if (!completed) return { task: committed ? null : task("one", 1) };
    if (runs === 2 && !sentOld) { sentOld = true; return { task: task("one", 1) }; }
    if (completed === 1) return { task: task("two", 2) };
    return { task: task("corrupt-same-sequence", 2) };
  } });
  const run = async (_r: unknown, _h: unknown, _g: unknown, signal: AbortSignal) => { runs++; if (runs === 2) { await pause(250); assert.equal(signal.aborted, false, "older reply cannot withdraw newer task"); } return { id: "runner", generation: 1, started_at: 1, ended_at: 2, duration_ms: 1, output: "false", stdout: "", stderr: "", exit_code: 0 }; };
  await collectorMain(config, run as typeof runBash, connect as typeof createMailbox);
  assert.equal(runs, 2); assert.equal(completed, 2); assert.equal(stopped, 1);
  assert.deepEqual(payloads[0], payloads[1], "lost receipt retries identical sealed bytes without recipe replay");
  assert.equal(payloads[2]![0], "two");
});
test("withdrawal aborts collection before submit; missing sequence is fail-closed", async () => {
  for (const legacy of [false, true]) {
    let polls = 0, submitted = 0, runs = 0;
    const connect = async () => ({ transport: "fixture", abort() {}, close() {}, async rpc(op: string) {
      if (op === "collector-stopped") return { accepted: true };
      if (op === "collector-result") { submitted++; return {}; }
      await pause(20); polls++;
      if (polls === 1) return { task: { ...task("one", 1), ...(legacy ? { sequence: undefined } : {}) } };
      return polls === 2 ? { task: null } : { stop: true };
    } });
    const run = async (_r: unknown, _h: unknown, _g: unknown, signal: AbortSignal) => {
      runs++; await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { id: "runner", generation: 1, started_at: 1, ended_at: 2, duration_ms: 1, output: "false", stdout: "", stderr: "", exit_code: 0 };
    };
    await collectorMain(config, run as typeof runBash, connect as typeof createMailbox);
    assert.equal(runs, legacy ? 0 : 1); assert.equal(submitted, 0);
  }
});
