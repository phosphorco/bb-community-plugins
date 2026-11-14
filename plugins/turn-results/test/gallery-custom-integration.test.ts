import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// e6 CI completed 57.3s of tests before the final real 3s source-timeout
// recovery, excluding module startup. Give the whole child 90s, including
// cleanup, and a separate 1s forced-termination grace. This is not an idle
// timeout: progress never extends the deadline.
function runChild(args: string[], options: {
  deadlineMs: number;
  signal?: AbortSignal;
  output?: (chunk: string, stderr: boolean) => void;
}) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  return new Promise<{ status: number | null; signal: NodeJS.Signals | null; output: string; reason: string | null }>((resolve, reject) => {
    // Node's test runner starts another process. Own its process group so a
    // timeout/cancellation also retires that actual test process.
    const child = spawn(process.execPath, args, { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, reason: string | null = null, force: ReturnType<typeof setTimeout> | undefined;
    function kill(signal: NodeJS.Signals) {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    function stop(why: string) {
      if (reason) return;
      reason = why; kill('SIGTERM');
      force = setTimeout(() => kill('SIGKILL'), 1000);
    }
    const deadline = setTimeout(() => stop(`deadline ${options.deadlineMs}ms exceeded`), options.deadlineMs);
    const abort = () => stop('cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    for (const [stream, stderr] of [[child.stdout, false], [child.stderr, true]] as const) stream.on('data', data => {
      const chunk = data.toString(); bytes += data.length;
      if (bytes <= 4194304) { output += chunk; options.output?.(chunk, stderr); }
      else stop('output exceeded 4MiB');
    });
    function cleanup() {
      clearTimeout(deadline); clearTimeout(force);
      options.signal?.removeEventListener('abort', abort);
      if (reason) kill('SIGKILL');
    }
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (status, signal) => { cleanup(); resolve({ status, signal, output, reason }); });
  });
}

test('actual gallery app/panel/dialog custom presentation integration', { timeout: 95000 }, async t => {
  const result = await runChild(['--experimental-transform-types', '--test', '--test-reporter=tap', fileURLToPath(new URL('./gallery-custom-integration.mjs', import.meta.url))], {
    deadlineMs: 90000, signal: t.signal,
    output(chunk, stderr) { (stderr ? process.stderr : process.stdout).write(chunk); },
  });
  assert.equal(result.reason, null, `Gallery child ${result.reason}; signal=${result.signal}`);
  assert.equal(result.status, 0, `Gallery child failed; signal=${result.signal}`);
});

test('gallery child deadline kills a live process even when progress continues and SIGTERM is ignored', { timeout: 5000 }, async () => {
  const result = await runChild(['--eval', "process.on('SIGTERM', () => {}); setInterval(() => console.log('still running'), 20)"], { deadlineMs: 500 });
  assert.match(result.output, /still running/);
  assert.equal(result.reason, 'deadline 500ms exceeded');
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.status, null);
});

test('gallery child cancellation retires the test-runner descendant and preserves failures and subsequent success', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const result = await runChild(['--eval', 'process.exit(23)'], { deadlineMs: 1000 });
  assert.equal(result.status, 23, 'a failing child cannot pass');
  assert.equal(result.reason, null);
  const cancelled = await runChild(['--eval', `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {});
    spawn(process.execPath, ['--eval', "process.on('SIGTERM', () => {}); console.log('descendant ready'); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
  `], {
    deadlineMs: 2000, signal: controller.signal, output() { controller.abort(); },
  });
  assert.match(cancelled.output, /descendant ready/);
  assert.equal(cancelled.reason, 'cancelled'); assert.equal(cancelled.signal, 'SIGKILL');
  const recovered = await runChild(['--eval', "console.log('finished')"], { deadlineMs: 1000 });
  assert.equal(recovered.status, 0); assert.equal(recovered.reason, null); assert.match(recovered.output, /finished/);
});
