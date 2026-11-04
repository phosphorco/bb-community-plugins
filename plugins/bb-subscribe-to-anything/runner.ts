import type { Recipe, Run } from "./contracts.ts";

export const CAPTURE_BYTES = 128 * 1024;

// This function is also serialized into the provider-launched collector. Keep it
// self-contained: importing this module on the server never executes a shell.
export async function runBash(
  recipe: Recipe,
  history: Run[],
  generation: number,
  signal: AbortSignal,
): Promise<Run> {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, mkdir, writeFile, readFile, rm, lstat, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const limit = 128 * 1024;
  const started = Date.now(), mono = performance.now(), id = randomUUID();
  let root: string | undefined, output = "", stdout = "", stderr = "";
  let problem: string | undefined, code: number | null = null;
  try {
    if (signal.aborted) throw new Error("execution cancelled");
    root = await mkdtemp(join(tmpdir(), "bb-subscribe-"));
    await chmod(root, 0o700);
    await mkdir(join(root, "work"));
    await mkdir(join(root, "history"));
    const outputPath = join(root, "work", "output");
    await writeFile(outputPath, "");
    const scriptPath = join(root, "observe.sh");
    const statusPath = join(root, "status");
    await writeFile(scriptPath, recipe.script, { mode: 0o400 });
    const selected = (recipe.history_count ? history.slice(-recipe.history_count) : []).reverse();
    // Inherit the provider process, never the plugin server process. HOME,
    // PATH, CLI credentials, cwd, and OS restrictions remain that process's.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SUB_")));
    const env = { ...inherited, ...recipe.parameters, SUB_OUTPUT: outputPath,
      SUB_WORKDIR: join(root, "work"), SUB_HISTORY_COUNT: String(selected.length) };
    for (const [i, run] of selected.entries()) {
      const path = join(root, "history", String(i + 1));
      await writeFile(path, run.output, { mode: 0o400 });
      Object.assign(env, { [`SUB_HISTORY_${i + 1}`]: path });
    }
    // The watchdog is independent of Node and explicitly kills the whole group;
    // timeout implementations differ in how they handle nested descendants.
    // Bash's $$ stays the group leader's PID inside this background subshell.
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c",
      '( /bin/sleep "$3"; kill -KILL -- -$$ ) & ulimit -f 256; ulimit -t 60; /bin/bash --noprofile --norc "$1"; status=$?; printf "%s" "$status" > "$2"; while :; do /bin/sleep 1; done', "collector", scriptPath, statusPath, String(recipe.timeout_seconds)],
      { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const actions = {
      kill() {
        if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      },
      stop(reason: string) { problem ??= reason; actions.kill(); },
      onAbort() { actions.stop("execution cancelled"); },
      capture(target: "stdout" | "stderr", data: Buffer) {
        bytes += data.length;
        if (target === "stdout") stdout = (stdout + data.toString("utf8")).slice(0, 16000);
        else stderr = (stderr + data.toString("utf8")).slice(0, 16000);
        if (bytes > limit) actions.stop("log capture overflow");
      },
    };
    let bytes = 0;
    signal.addEventListener("abort", actions.onAbort, { once: true });
    if (signal.aborted) actions.onAbort();
    const timer = setTimeout(() => actions.stop("execution timeout"), recipe.timeout_seconds * 1000);
    let completedCode: number | undefined;
    const completion = setInterval(() => {
      void readFile(statusPath, "utf8").then(value => {
        if (/^\d+$/.test(value)) { completedCode = Number(value); actions.kill(); }
      }).catch(() => {});
    }, 25);
    child.stdout.on("data", (data: Buffer) => actions.capture("stdout", data));
    child.stderr.on("data", (data: Buffer) => actions.capture("stderr", data));
    // Kill descendants when the foreground script exits, before reading output.
    child.once("exit", actions.kill);
    try {
      code = await new Promise<number | null>((resolve) => {
        child.once("error", (e: Error) => { problem ??= e.message; resolve(null); });
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
      clearInterval(completion);
      signal.removeEventListener("abort", actions.onAbort);
      actions.kill();
    }
    code = completedCode ?? code;
    if (completedCode === undefined && code === null) problem ??= "execution timeout or collector terminated";
    const stat = await lstat(outputPath);
    if (!stat.isFile() || stat.isSymbolicLink()) problem ??= "output must be a regular file";
    else if (stat.size > limit) problem ??= "evidence capture overflow; narrow the command";
    else output = await readFile(outputPath, "utf8");
    if (Buffer.byteLength(output) > limit) { output = ""; problem ??= "evidence capture overflow"; }
    if (code !== 0) problem ??= `collector exited ${code}`;
    if (!output.trim()) problem ??= "empty evidence";
  } catch (e) { problem ??= String(e); }
  finally { if (root) await rm(root, { recursive: true, force: true }); }
  return { id, generation, started_at: started, ended_at: Date.now(),
    duration_ms: Math.round(performance.now() - mono), output, stdout, stderr, exit_code: code, problem };
}
