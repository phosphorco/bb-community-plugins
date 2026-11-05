/** Controlled component fixture measurements, not production native-shell latency. */
import { test, expect } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { appFixture } from "./app-fixture.ts";

test("controlled product preview and chooser latency DOM RPC and focus witness", async () => {
  const fixture = await appFixture("templates-performance-controlled"),
    scratch = await mkdtemp(join(tmpdir(), "templates-performance-")),
    artifacts = join(
      process.env.BB_THREAD_STORAGE ?? "/tmp/templates-browser-evidence",
      "performance",
    ),
    phase = process.env.TEMPLATES_PERF_PHASE ?? "before";
  await mkdir(artifacts, { recursive: true });
  fixture.seedPersonal({
    inputs: {
      subject: "Stable review",
      pr_url: "https://example.test/pull/42",
      focus: "Initial focus",
    },
  });
  const fixtureHash = createHash("sha256")
    .update(JSON.stringify(fixture.entries))
    .digest("hex");
  const built = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "browser-mobile-build.ts"),
      scratch,
      "product",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (built.exitCode !== 0)
    throw new Error(new TextDecoder().decode(built.stderr));
  const bundle = JSON.parse(new TextDecoder().decode(built.stdout)) as {
    script: string;
    css: string | null;
  };
  const requests: { method: string; start: number; end: number | null }[] = [];
  const delays = { identity: 80, catalog: 120, preview: 180 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/rpc/")) {
        const method = decodeURIComponent(url.pathname.slice(5)),
          event = {
            method,
            start: performance.now(),
            end: null as number | null,
          };
        requests.push(event);
        try {
          const delay =
            method === "bb-identity.v1.bootstrap"
              ? delays.identity
              : method === "catalog" || method === "publishedCatalog"
                ? delays.catalog
                : method === "preview" || method === "targetPreview"
                  ? delays.preview
                  : 0;
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          return Response.json(
            await fixture.handlers[method]!(await request.json()),
          );
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 });
        } finally {
          event.end = performance.now();
        }
      }
      if (url.pathname === "/" + basename(bundle.script))
        return new Response(await readFile(bundle.script), {
          headers: { "content-type": "text/javascript" },
        });
      if (bundle.css && url.pathname === "/" + basename(bundle.css))
        return new Response(await readFile(bundle.css), {
          headers: { "content-type": "text/css" },
        });
      return new Response(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${bundle.css ? `<link rel="stylesheet" href="/${basename(bundle.css)}">` : ""}<style>:root{--background:#171922;--foreground:#d4d5e2;--muted-foreground:#a1a4bb;--border:#373a4c;--input:#41455b;--primary:#b7a3ed;--primary-foreground:#191529;--accent:#292c3c;--ring:#b7a3ed}body{font:14px system-ui;margin:12px auto;padding:0 12px;max-width:850px;background:var(--background);color:var(--foreground)}</style></head><body><textarea aria-label="Independent native freeform">Untouched freeform</textarea><script type="module" src="/${basename(bundle.script)}"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true }),
    page = await browser.newPage({
      viewport: { width: 1100, height: 900 },
      locale: "en-GB",
      timezoneId: "Europe/Berlin",
    }),
    errors: string[] = [],
    chooser: unknown[] = [],
    edits: unknown[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const firstCard = page.getByRole("button", { name: /Feedback Session/ });
  const count = (events: typeof requests) =>
    Object.fromEntries(
      [...new Set(events.map((e) => e.method))].map((method) => [
        method,
        events.filter((e) => e.method === method).length,
      ]),
    );
  try {
    for (const width of [1100, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const mode of ["cold", "warm-remount", "reload"]) {
        const begin = requests.length,
          start = performance.now();
        if (mode === "cold") {
          if (page.url().startsWith(`http://127.0.0.1:${server.port}`)) {
            await page.evaluate(async () => {
              localStorage.clear();
              sessionStorage.clear();
            });
            await page.reload();
          } else await page.goto(`http://127.0.0.1:${server.port}`);
        } else if (mode === "warm-remount")
          await page.evaluate(() => window.templatesHarness.mount(false));
        else await page.reload();
        await firstCard.waitFor();
        const firstVisibleMs = performance.now() - start;
        await browserExpect(firstCard).toBeEnabled();
        const firstUsableMs = performance.now() - start;
        const geometry = await firstCard.evaluate((node) => {
          const r = node.getBoundingClientRect();
          return {
            top: r.top,
            bottom: r.bottom,
            hit: node.contains(
              document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
            ),
          };
        });
        chooser.push({
          width,
          mode,
          firstVisibleMs,
          firstUsableMs,
          rpc: count(requests.slice(begin)),
          geometry,
        });
      }
      await page.getByRole("button", { name: /PR Review/ }).click();
      await page.getByLabel("Final launch destination").waitFor();
      await page.getByRole("button", { name: "Details", exact: true }).click();
      const input = page.getByLabel(/Important context or concerns/);
      await browserExpect(input).toBeEnabled();
      for (let i = 0; i < 3; i++) {
        const marker = `ordinary-${width}-${i}`;
        await page.waitForTimeout(500); // Fixed quiet interval, disclosed fixture protocol.
        const begin = requests.length;
        await input.focus();
        const before = await page.evaluate(() => {
          const field = document.querySelector("[data-field=focus]")!;
          const summary = document.querySelector(".ntt-summary")!;
          const track = {
            started: performance.now(),
            field,
            summary,
            removed: 0,
            added: 0,
            observer: null as MutationObserver | null,
          };
          track.observer = new MutationObserver((records) => {
            for (const record of records) {
              for (const node of record.removedNodes)
                if (
                  node === summary ||
                  (node instanceof Element && node.contains(summary))
                )
                  track.removed++;
              for (const node of record.addedNodes)
                if (
                  node instanceof Element &&
                  (node.matches(".ntt-summary") ||
                    node.querySelector(".ntt-summary"))
                )
                  track.added++;
            }
          });
          track.observer.observe(document.querySelector(".ntt-run")!, {
            childList: true,
            subtree: true,
          });
          (window as any).__templatesPerf = track;
          return {
            clock: document
              .querySelector(".ntt-direct-form .ntt-clock time")
              ?.getAttribute("datetime"),
            summary: summary.textContent,
            started: performance.now(),
          };
        });
        await input.fill(marker);
        const immediate = await page.evaluate(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          const t = (window as any).__templatesPerf;
          return {
            elapsedMs: performance.now() - t.started,
            configPresent: !!document.querySelector(".ntt-summary"),
            sameConfigNode:
              document.querySelector(".ntt-summary") === t.summary,
            sameInputNode:
              document.querySelector("[data-field=focus]") === t.field,
            focused: document.activeElement === t.field,
          };
        });
        await page.waitForFunction(
          (value) =>
            [
              ...document.querySelectorAll(".ntt-direct-form .ntt-preview"),
            ].some((node) => node.textContent?.includes(value)),
          marker,
        );
        const settled = await page.evaluate((started) => {
          const t = (window as any).__templatesPerf;
          t.observer.disconnect();
          return {
            elapsedMs: performance.now() - started,
            removedConfigNodes: t.removed,
            addedConfigNodes: t.added,
            sameConfigNode:
              document.querySelector(".ntt-summary") === t.summary,
            sameInputNode:
              document.querySelector("[data-field=focus]") === t.field,
            focused: document.activeElement === t.field,
            clock: document
              .querySelector(".ntt-direct-form .ntt-clock time")
              ?.getAttribute("datetime"),
            summary: document.querySelector(".ntt-summary")?.textContent,
          };
        }, before.started);
        expect(settled.clock).toBe(before.clock);
        expect(settled.sameInputNode).toBe(true);
        expect(settled.focused).toBe(true);
        const rpc = count(requests.slice(begin));
        if (phase !== "before") {
          expect(immediate.sameConfigNode).toBe(true);
          expect(immediate.sameInputNode).toBe(true);
          expect(immediate.focused).toBe(true);
          expect(settled.sameConfigNode).toBe(true);
          expect(settled.removedConfigNodes).toBe(0);
          expect(settled.addedConfigNodes).toBe(0);
          expect(rpc.preview ?? 0).toBe(0);
          expect(rpc.targetPreview ?? 0).toBe(0);
          expect(rpc.choices ?? 0).toBe(0);
        }
        edits.push({ width, marker, before, immediate, settled, rpc });
      }
      await page.screenshot({ path: join(artifacts, `${phase}-${width}.png`) });
      await browserExpect(
        page.getByLabel("Independent native freeform"),
      ).toHaveValue("Untouched freeform");
      await page.evaluate(() => window.templatesHarness.unmount());
    }
    expect(fixture.flags.launchCount).toBe(0);
    expect(errors).toEqual([]);
    await Bun.write(
      join(artifacts, `${phase}.json`),
      JSON.stringify(
        {
          phase,
          productComponents: true,
          nativeShell: false,
          instrumentation:
            "public development slot harness; fixed synthetic transport delay; no React profiler",
          browser: browser.version(),
          fixtureHash,
          delays,
          chooser,
          edits,
          requests,
          errors,
          sends: fixture.flags.launchCount,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    server.stop(true);
    await fixture.dispose();
    await rm(scratch, { recursive: true, force: true });
  }
}, 60000);
