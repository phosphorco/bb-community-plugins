import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { attachOwnedSocket } from "./browser-owned.ts";
import { cleanupPromptFixture, retireDisconnectedPromptBrowser } from "./browser-prompt-cleanup.ts";

// Synthetic event/clock boundary only: no socket, browser or child is launched.
class Socket extends EventTarget {
  readyState = 0;
  closes = 0;
  closeFailure?: Error;
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  remoteClose(code = 1006, reason = "peer vanished", wasClean = false) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason, wasClean }));
  }
  close() {
    this.closes++;
    if (this.closeFailure) throw this.closeFailure;
    this.remoteClose(1000, "local cleanup", true);
  }
}
class Child extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    this.exit(null, signal);
    return true;
  }
}

async function withClock(run: (clock: {
  timers: { delay: number | undefined; fire(): void; handle: ReturnType<typeof setTimeout> }[];
  cleared: ReturnType<typeof spyOn>;
}) => Promise<void>) {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers: { delay: number | undefined; fire(): void; handle: ReturnType<typeof setTimeout> }[] = [];
  const scheduled = spyOn(globalThis, "setTimeout").mockImplementation(((fire: () => void, delay?: number) => {
    const handle = originalSet(() => {}, 60000);
    timers.push({ delay, fire, handle });
    return handle;
  }) as typeof setTimeout);
  const cleared = spyOn(globalThis, "clearTimeout");
  try { await run({ timers, cleared }); }
  finally {
    scheduled.mockRestore();
    cleared.mockRestore();
    for (const timer of timers) originalClear(timer.handle);
  }
}
function expectRetired(child: Child, removed: ReturnType<typeof spyOn>) {
  expect(child.listenerCount("exit")).toBe(0);
  expect(child.listenerCount("error")).toBe(0);
  expect(new Set(removed.mock.calls.map((call: unknown[]) => call[0]))).toEqual(new Set(["open", "close", "error"]));
}

test("owned socket opens before attachment and keeps attachment pending until its real result", async () => withClock(async ({ timers, cleared }) => {
  const socket = new Socket(), child = new Child();
  const removed = spyOn(socket, "removeEventListener");
  let attached = 0, finish!: (value: object) => void;
  const result = {}, attachment = new Promise<object>((resolve) => { finish = resolve; });
  const connection = attachOwnedSocket(socket, child, () => { attached++; return attachment; });
  expect(attached).toBe(0);
  expect(timers.map((timer) => timer.delay)).toEqual([5000]);
  socket.open();
  await Promise.resolve(); await Promise.resolve();
  expect(attached).toBe(1);
  expect(cleared).toHaveBeenCalledWith(timers[0]!.handle);
  finish(result);
  expect(await connection).toBe(result);
  expect(socket.closes).toBe(0);
  expectRetired(child, removed);
}));

test("pre-open close fails without firing the deadline or attaching and preserves close diagnostics", async () => withClock(async ({ timers, cleared }) => {
  const socket = new Socket(), child = new Child();
  const removed = spyOn(socket, "removeEventListener");
  let attached = 0;
  const connection = attachOwnedSocket(socket, child, async () => { attached++; });
  socket.remoteClose(1006, "closed before handshake", false);
  await expect(connection).rejects.toThrow('before open: code=1006, reason="closed before handshake", wasClean=false');
  expect(attached).toBe(0);
  expect(socket.closes).toBe(1);
  expect(cleared).toHaveBeenCalledWith(timers[0]!.handle);
  expectRetired(child, removed);
}));

test("only the supplied child exit rejects opening or an in-progress attachment", async () => withClock(async () => {
  for (const opened of [false, true]) {
    const socket = new Socket(), child = new Child(), unrelated = new Child();
    const removed = spyOn(socket, "removeEventListener");
    let attached = 0, settled = false;
    const connection = attachOwnedSocket(socket, child, () => { attached++; return new Promise<void>(() => {}); });
    void connection.then(() => { settled = true; }, () => { settled = true; });
    if (opened) { socket.open(); await Promise.resolve(); await Promise.resolve(); }
    unrelated.exit(9);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.exit(opened ? 0 : null, opened ? null : "SIGTERM");
    await expect(connection).rejects.toThrow(`during CDP ${opened ? "attachment" : "socket opening"}: exitCode=${opened ? 0 : "null"}, signal=${opened ? "null" : "SIGTERM"}`);
    expect(attached).toBe(opened ? 1 : 0);
    expect(socket.closes).toBe(1);
    expectRetired(child, removed);
  }
}));

test("a socket that never opens still uses exactly the original 5000ms deadline", async () => withClock(async ({ timers, cleared }) => {
  const socket = new Socket(), child = new Child();
  const removed = spyOn(socket, "removeEventListener");
  let attached = 0;
  const connection = attachOwnedSocket(socket, child, async () => { attached++; });
  expect(timers.map((timer) => timer.delay)).toEqual([5000]);
  timers[0]!.fire();
  await expect(connection).rejects.toThrow("Owned Chromium CDP socket exceeded 5000ms");
  expect(attached).toBe(0);
  expect(socket.closes).toBe(1);
  expect(cleared).toHaveBeenCalledWith(timers[0]!.handle);
  expectRetired(child, removed);
}));

test("socket error and already-exited or closed snapshots cannot attach", async () => withClock(async () => {
  for (const state of ["error", "exited", "closed"] as const) {
    const socket = new Socket(), child = new Child();
    if (state === "exited") child.exitCode = 17;
    if (state === "closed") socket.readyState = 3;
    const removed = spyOn(socket, "removeEventListener");
    let attached = 0;
    const connection = attachOwnedSocket(socket, child, async () => { attached++; });
    if (state === "error") socket.dispatchEvent(new Event("error"));
    await expect(connection).rejects.toThrow(state === "error" ? "socket failed" : state === "exited" ? "exitCode=17" : "readyState=3");
    expect(attached).toBe(0);
    expectRetired(child, removed);
  }
}));

test("open immediately followed by close cannot begin attachment", async () => withClock(async () => {
  const socket = new Socket(), child = new Child();
  let attached = 0;
  const connection = attachOwnedSocket(socket, child, async () => { attached++; });
  socket.open(); socket.remoteClose(1001, "going away", true);
  await expect(connection).rejects.toThrow('during attachment: code=1001, reason="going away", wasClean=true');
  expect(attached).toBe(0);
}));

test("attachment failure remains primary even when closing the socket also throws", async () => withClock(async () => {
  const socket = new Socket(), child = new Child();
  const primary = new Error("Attachment rejected"), cleanup = new Error("INJECTED_SOCKET_CLOSE_FAILURE");
  socket.closeFailure = cleanup;
  const stderr = spyOn(console, "error");
  try {
    const connection = attachOwnedSocket(socket, child, async () => { throw primary; });
    socket.open();
    await expect(connection).rejects.toBe(primary);
    expect(stderr).toHaveBeenCalledWith("Owned Chromium socket cleanup also failed:", cleanup);
    expect(socket.closes).toBe(1);
    expect(child.listenerCount("exit")).toBe(0);
  } finally { stderr.mockRestore(); }
}));

test("failed connection stays primary through exact synthetic owner retirement and every acquired cleanup step", async () => withClock(async ({ timers, cleared }) => {
  const socket = new Socket(), owned = new Child(), unrelated = new Child();
  const connection = attachOwnedSocket(socket, owned, async () => {
    throw new Error("Attachment must not start before open");
  });
  socket.remoteClose(1006, "synthetic pre-open close", false);
  const primary = await connection.catch((error: unknown) => error);
  expect(primary).toBeInstanceOf(Error);
  expect(String(primary)).toContain("before open");
  const calls: string[] = [], phases: { name: string; detail?: Record<string, unknown> }[] = [];
  const exited = new Promise<void>((resolve) => owned.once("exit", () => resolve()));
  const disposal = new Error("Synthetic acquired fixture disposal failed");
  let failure: unknown;
  try {
    await cleanupPromptFixture({
      // Both children/owner are synthetic; this exercises the unchanged outer boundary.
      browser: {
        process: () => owned as unknown as ChildProcess,
        close: () => retireDisconnectedPromptBrowser(owned as unknown as ChildProcess, exited),
        kill: async () => {
          if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL");
          await exited;
        },
      },
      bodyFailure: { failed: true, error: primary },
      phase: (name, detail) => { phases.push({ name, detail }); },
      steps: [
        { name: "server-stop", run: () => { calls.push("server"); } },
        { name: "fixture-dispose", run: () => { calls.push("fixture"); throw disposal; } },
        { name: "scratch-remove", run: () => { calls.push("scratch"); } },
      ],
    });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0]).toBe(primary);
  expect((failure as AggregateError).cause).toBe(primary);
  expect((failure as AggregateError).errors).toContain(disposal);
  expect((failure as AggregateError).errors.some((error) => String(error).includes("SIGTERM retirement was required"))).toBe(true);
  expect(owned.signals).toEqual(["SIGTERM"]);
  expect(unrelated.signals).toEqual([]);
  expect(unrelated.exitCode).toBeNull();
  expect(unrelated.signalCode).toBeNull();
  expect(calls).toEqual(["server", "fixture", "scratch"]);
  expect(phases.find((event) => event.name === "browser-process:terminal")?.detail?.alive).toBe(false);
  for (const timer of timers) expect(cleared).toHaveBeenCalledWith(timer.handle);
}));
