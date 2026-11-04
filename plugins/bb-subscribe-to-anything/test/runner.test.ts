import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recipeSchema } from "../contracts.ts";
import { runBash } from "../runner.ts";
const recipe = (script: string, timeout_seconds = 2) => recipeSchema.parse({
  script, interpretation: "test", coverage: "fixture", timeout_seconds,
  evaluation: { kind: "json_equals", path: [], value: true },
});
const signal = () => new AbortController().signal;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("real Bash separates sealed evidence, logs and nonzero diagnostics", async () => {
  const r = await runBash(recipe('printf true >> "$SUB_OUTPUT"; echo log; echo diagnostic >&2'), [], 1, signal());
  assert.equal(r.problem, undefined); assert.equal(r.output, "true");
  assert.match(r.stdout, /log/); assert.match(r.stderr, /diagnostic/);
  const failed = await runBash(recipe('printf true >> "$SUB_OUTPUT"; exit 7'), [], 1, signal());
  assert.equal(failed.exit_code, 7); assert.match(failed.problem!, /exited 7/);
});
test("history and scratch preserve the provider cwd and inherited environment", async () => {
  process.env.OBSERVATION_FIXTURE_CREDENTIAL = "fixture-only";
  process.env.EXPECTED_CWD = process.cwd();
  process.env.SUB_HISTORY_4 = "must-not-leak";
  try {
    const r = await runBash(recipe('set -euo pipefail; test "$OBSERVATION_FIXTURE_CREDENTIAL" = fixture-only; test "${SUB_HISTORY_4-unset}" = unset; test "$PWD" = "$EXPECTED_CWD"; test "$SUB_HISTORY_COUNT" = 1; cat "$SUB_HISTORY_1" >> "$SUB_OUTPUT"'), [{
      id: "past", generation: 1, started_at: 1, ended_at: 2, duration_ms: 1,
      output: "true", stdout: "", stderr: "", exit_code: 0,
    }], 1, signal());
    assert.equal(r.problem, undefined); assert.equal(r.output, "true");
  } finally {
    delete process.env.SUB_HISTORY_4;
    delete process.env.OBSERVATION_FIXTURE_CREDENTIAL; delete process.env.EXPECTED_CWD;
  }
});
test("foreground completion seals before same-group descendants can append", async () => {
  const r = await runBash(recipe('(sleep 0.5; echo late >> "$SUB_OUTPUT") & echo true >> "$SUB_OUTPUT"'), [], 1, signal());
  assert.equal(r.problem, undefined); assert.equal(r.output.trim(), "true");
});
test("replaced, empty and oversized evidence are explicit problems", async () => {
  for (const script of ['rm "$SUB_OUTPUT"; ln -s /etc/passwd "$SUB_OUTPUT"', 'true', 'head -c 140000 /dev/zero >> "$SUB_OUTPUT"']) {
    const r = await runBash(recipe(script), [], 1, signal()); assert.ok(r.problem);
  }
});
test("timeout and cancellation kill the collection process group", async () => {
  const timed = await runBash(recipe('echo true >> "$SUB_OUTPUT"; sleep 20', 1), [], 1, signal());
  assert.match(timed.problem!, /timeout/); assert.ok(timed.duration_ms < 3000);
  const controller = new AbortController();
  const pending = runBash(recipe('sleep 20'), [], 1, controller.signal);
  setTimeout(() => controller.abort(), 150);
  const cancelled = await pending; assert.match(cancelled.problem!, /cancelled/);
});
test("independent deadline kills descendants even if the Node collector is SIGKILLed", async () => {
  const root = await mkdtemp(join(tmpdir(), "subscribe-watchdog-test-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const started = join(root, "started"), late = join(root, "late"), runnerFile = join(root, "runner.mjs");
    const r = recipe(`echo ready > '${started}'; (sleep 1.5; echo survived > '${late}') & sleep 20`, 1);
    await writeFile(runnerFile, `await (${runBash.toString()})(${JSON.stringify(r)}, [], 1, new AbortController().signal);`);
    child = spawn(process.execPath, [runnerFile], { stdio: "ignore", env: { ...process.env, TMPDIR: root } });
    for (let i = 0; i < 100; i++) {
      try { await access(started); break; } catch { await pause(10); }
    }
    assert.equal(await readFile(started, "utf8"), "ready\n");
    child.kill("SIGKILL");
    await new Promise(resolve => child!.once("close", resolve));
    await pause(1800);
    await assert.rejects(access(late));
  } finally { child?.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); }
});
