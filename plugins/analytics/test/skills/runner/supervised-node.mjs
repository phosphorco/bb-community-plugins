import { spawn } from "node:child_process";

function terminate(child, signal, killImpl) {
  if (child.pid == null) return;
  try { killImpl(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}

/** Run exactly one Node suite in a detached process group with bounded output and deadline. */
export async function runSupervisedNode({ args, cwd, timeoutMs, outputCapBytes = 16_384, killGraceMs = 1_000, closeGraceMs = 1_000, spawnImpl = spawn, killImpl = process.kill }) {
  return await new Promise((resolve) => {
    const child = spawnImpl(process.execPath, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const captured = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0, stdoutReceivedBytes: 0, stderrReceivedBytes: 0 };
    let settled = false;
    let closeObserved = false;
    let code = null;
    let signal = null;
    let reason = null;
    let deadlineTimer;
    let killTimer;
    let closeTimer;
    const clearTimers = () => { clearTimeout(deadlineTimer); clearTimeout(killTimer); clearTimeout(closeTimer); };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ code, signal, reason, closeObserved, stdout: Buffer.concat(captured.stdout, captured.stdoutBytes), stderr: Buffer.concat(captured.stderr, captured.stderrBytes) });
    };
    const requestTermination = (nextReason) => {
      if (reason != null) return;
      reason = nextReason;
      terminate(child, "SIGTERM", killImpl);
      killTimer = setTimeout(() => {
        if (closeObserved || settled) return;
        terminate(child, "SIGKILL", killImpl);
        closeTimer = setTimeout(() => {
          if (!closeObserved) {
            reason = "child-exit-not-confirmed";
            try { child.stdout?.destroy(); child.stderr?.destroy(); child.unref?.(); child.removeAllListeners?.(); } catch {}
            finish();
          }
        }, closeGraceMs);
      }, killGraceMs);
    };
    const append = (stream, chunk) => {
      const bytes = `${stream}Bytes`;
      const received = `${stream}ReceivedBytes`;
      captured[received] += chunk.byteLength;
      const remaining = outputCapBytes - captured[bytes];
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        captured[stream].push(kept);
        captured[bytes] += kept.byteLength;
      }
      if (captured[received] > outputCapBytes) requestTermination(`${stream}-cap`);
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    deadlineTimer = setTimeout(() => requestTermination("deadline"), timeoutMs);
    child.on("error", (error) => requestTermination(`spawn:${error.message}`));
    child.on("close", (closeCode, closeSignal) => { closeObserved = true; code = closeCode; signal = closeSignal; finish(); });
  });
}
