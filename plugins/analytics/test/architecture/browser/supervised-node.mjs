import { spawn } from "node:child_process";

function terminate(child, signal, killImpl) { if (child.pid == null) return; try { killImpl(-child.pid, signal); } catch { try { child.kill(signal); } catch {} } }

/** A bounded test-only Node supervisor. Captures at most exact byte caps and settles once. */
export async function runSupervisedNode({ args, cwd, timeoutMs, outputCapBytes = 16_384, killGraceMs = 1_000, closeGraceMs = 1_000, spawnImpl = spawn, killImpl = process.kill }) {
  return await new Promise((resolve) => {
    const child = spawnImpl(process.execPath, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const capture = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0, stdoutReceivedBytes: 0, stderrReceivedBytes: 0 };
    let settled = false, closeObserved = false, exitObserved = false, code = null, signal = null, reason = null;
    let deadlineTimer, killTimer, closeTimer;
    const clearTimers = () => { clearTimeout(deadlineTimer); clearTimeout(killTimer); clearTimeout(closeTimer); };
    const result = () => ({ code, signal, reason, terminationReason, closeObserved, exitObserved, stdout: Buffer.concat(capture.stdout, capture.stdoutBytes), stderr: Buffer.concat(capture.stderr, capture.stderrBytes), capturedBytes: { stdout: capture.stdoutBytes, stderr: capture.stderrBytes }, receivedBytes: { stdout: capture.stdoutReceivedBytes, stderr: capture.stderrReceivedBytes } });
    const settle = () => { if (settled) return; settled = true; clearTimers(); resolve(result()); };
    const abandonUnclosedChild = () => { try { child.stdout?.destroy(); child.stderr?.destroy(); child.unref?.(); child.removeAllListeners?.(); } catch {} };
    let terminationReason = null;
    const requestTermination = (nextReason) => {
      if (reason != null) return;
      reason = nextReason; terminationReason = nextReason; terminate(child, "SIGTERM", killImpl);
      killTimer = setTimeout(() => { if (closeObserved || settled) return; terminate(child, "SIGKILL", killImpl); closeTimer = setTimeout(() => { if (!closeObserved) { reason = "child-exit-not-confirmed"; abandonUnclosedChild(); settle(); } }, closeGraceMs); }, killGraceMs);
    };
    const append = (stream, chunk) => {
      const bytesKey = `${stream}Bytes`, receivedKey = `${stream}ReceivedBytes`;
      capture[receivedKey] += chunk.byteLength;
      const remaining = outputCapBytes - capture[bytesKey];
      if (remaining > 0) { const kept = chunk.subarray(0, remaining); capture[stream].push(kept); capture[bytesKey] += kept.byteLength; }
      if (capture[receivedKey] > outputCapBytes) requestTermination(`${stream}-cap`);
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk)); child.stderr.on("data", (chunk) => append("stderr", chunk));
    deadlineTimer = setTimeout(() => requestTermination("deadline"), timeoutMs);
    child.on("error", (error) => requestTermination(`spawn:${error.message}`));
    child.on("exit", (exitCode, exitSignal) => { exitObserved = true; code = exitCode; signal = exitSignal; });
    child.on("close", (closeCode, closeSignal) => { closeObserved = true; exitObserved = true; code = closeCode; signal = closeSignal; settle(); });
  });
}
