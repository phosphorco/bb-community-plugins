import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupPromptFixture,
  retireDisconnectedPromptBrowser,
} from "./browser-prompt-cleanup.ts";

test("Prompt cleanup timeout fails with original error, retires exact public owned browser and continues every cleanup step", async () => {
  const browser = await chromium.launchServer({ headless: true }),
    child = browser.process(),
    scratch = await mkdtemp(join(tmpdir(), "prompt-cleanup-fault-"));
  const original = new Error("Original body locator failure"),
    calls: string[] = [],
    phases: { name: string; detail?: Record<string, unknown> }[] = [];
  const stalled = new Proxy(browser, {
    get(target, key) {
      if (key === "close") return () => new Promise<void>(() => {});
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let failure: unknown;
  try {
    await cleanupPromptFixture({
      browser: stalled,
      bodyFailure: { failed: true, error: original },
      limits: { close: 50, kill: 1000, step: 500 },
      phase: (name, detail) => {
        phases.push({ name, detail });
      },
      steps: [
        {
          name: "server-stop",
          run: () => {
            calls.push("server");
          },
        },
        {
          name: "fixture-dispose",
          run: () => {
            calls.push("fixture");
            throw new Error("Fixture disposal failure");
          },
        },
        {
          name: "scratch-remove",
          run: async () => {
            calls.push("scratch");
            await rm(scratch, { recursive: true, force: true });
          },
        },
      ],
    });
  } catch (error) {
    failure = error;
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      await browser.kill();
    await rm(scratch, { recursive: true, force: true });
  }
  expect(failure).toBeInstanceOf(AggregateError);
  const aggregate = failure as AggregateError;
  expect(aggregate.errors[0]).toBe(original);
  expect(aggregate.cause).toBe(original);
  expect(
    aggregate.errors.some((error) =>
      String(error).includes("browser-close exceeded"),
    ),
  ).toBe(true);
  expect(
    aggregate.errors.some((error) =>
      String(error).includes("Fixture disposal failure"),
    ),
  ).toBe(true);
  expect(calls).toEqual(["server", "fixture", "scratch"]);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(phases.some((phase) => phase.name === "browser-owned-kill:done")).toBe(
    true,
  );
  await expect(access(scratch)).rejects.toThrow();
});

test("disconnected live owned browser retirement fails cleanup after exact child exits and later cleanup still runs", async () => {
  const browser = await chromium.launchServer({ headless: true }),
    child = browser.process(),
    exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
  expect(child.exitCode === null && child.signalCode === null).toBe(true);
  const phases: string[] = [],
    calls: string[] = [];
  let failure: unknown;
  try {
    await cleanupPromptFixture({
      // The missing browser connection is synthetic; process and retirement are real.
      browser: {
        process: () => child,
        close: () => retireDisconnectedPromptBrowser(child, exited),
        kill: () => browser.kill(),
      },
      bodyFailure: { failed: false },
      phase: (name) => {
        phases.push(name);
      },
      steps: [
        {
          name: "server-stop",
          run: () => {
            calls.push("server");
          },
        },
        {
          name: "fixture-dispose",
          run: () => {
            calls.push("fixture");
          },
        },
        {
          name: "scratch-remove",
          run: () => {
            calls.push("scratch");
          },
        },
      ],
    });
  } catch (error) {
    failure = error;
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      await browser.kill();
  }
  expect(failure).toBeInstanceOf(AggregateError);
  const aggregate = failure as AggregateError;
  expect(
    aggregate.errors.some((error) =>
      String(error).includes("SIGTERM retirement was required"),
    ),
  ).toBe(true);
  expect(aggregate.cause).toBe(aggregate.errors[0]);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(calls).toEqual(["server", "fixture", "scratch"]);
  expect(phases).toContain("browser-close:error");
});
