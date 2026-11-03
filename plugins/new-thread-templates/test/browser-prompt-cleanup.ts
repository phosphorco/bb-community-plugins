/** Test-only ownership boundary. It never operates on a discovered or CDP-reported PID. */
import type { BrowserServer } from "@playwright/test";
import type { ChildProcess } from "node:child_process";

/** Retirement is necessary cleanup, never evidence of a normal browser close. */
export async function retireDisconnectedPromptBrowser(
  child: ChildProcess,
  exited: Promise<void>,
) {
  if (!child.kill("SIGTERM"))
    throw new Error("Disconnected owned browser could not be retired");
  await exited;
  throw new Error(
    "Owned browser disconnected while its process remained alive; SIGTERM retirement was required",
  );
}

export async function cleanupPromptFixture({
  browser,
  bodyFailure,
  steps,
  phase,
  limits = { close: 2000, kill: 1000, step: 1000 },
}: {
  browser: Pick<BrowserServer, "close" | "kill" | "process">;
  bodyFailure: { failed: boolean; error?: unknown };
  steps: { name: string; run(): Promise<unknown> | unknown }[];
  phase(name: string, detail?: Record<string, unknown>): void;
  limits?: { close: number; kill: number; step: number };
}) {
  const failures: unknown[] = [],
    child = browser.process();
  const alive = () => child.exitCode === null && child.signalCode === null;
  const run = async (
    name: string,
    action: () => Promise<unknown> | unknown,
    timeout: number,
  ) => {
    phase(`${name}:start`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${name} exceeded ${timeout}ms`)),
            timeout,
          );
        }),
      ]);
      phase(`${name}:done`);
      return true;
    } catch (error) {
      failures.push(error);
      phase(`${name}:error`, { message: String(error) });
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const closed = await run(
    "browser-close",
    () => browser.close(),
    limits.close,
  );
  if (!closed || alive()) {
    if (closed)
      failures.push(
        new Error("Browser close completed with its owned process still alive"),
      );
    await run("browser-owned-kill", () => browser.kill(), limits.kill);
    if (alive()) {
      await run(
        "browser-owned-process-exit",
        async () => {
          const exited = new Promise<void>((resolve, reject) => {
            child.once("exit", () => resolve());
            child.once("error", reject);
          });
          if (!child.kill("SIGKILL"))
            throw new Error(
              "Exact owned browser process could not be signalled",
            );
          await exited;
        },
        limits.kill,
      );
    }
  }
  phase("browser-process:terminal", {
    pid: child.pid,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    alive: alive(),
  });
  if (alive())
    failures.push(
      new Error("Exact owned browser process remains alive after cleanup"),
    );
  for (const step of steps) await run(step.name, step.run, limits.step);
  if (failures.length)
    throw new AggregateError(
      [...(bodyFailure.failed ? [bodyFailure.error] : []), ...failures],
      "Prompt fixture failed; original body and cleanup errors retained",
      { cause: bodyFailure.failed ? bodyFailure.error : failures[0] },
    );
  if (bodyFailure.failed) throw bodyFailure.error;
}
