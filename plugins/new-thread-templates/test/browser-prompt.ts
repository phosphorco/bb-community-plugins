/** Product Prompt editor; public slot/native frame fixture, never native shell proof. */
import { expect } from "bun:test";
import { expect as browserExpect, type Locator } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appFixture } from "./app-fixture.ts";
import { createRenderContext } from "../model.ts";
import { cleanupPromptFixture } from "./browser-prompt-cleanup.ts";

import { acquireOwnedBrowser } from "./browser-owned.ts";

export async function browserPromptWorkbench() {
  const fixture = await appFixture(`prompt-browser-${crypto.randomUUID()}`),
    scratch = await mkdtemp(join(tmpdir(), "templates-prompt-")),
    artifacts = join(
      process.env.BB_THREAD_STORAGE ?? "/tmp/templates-browser-evidence",
      "templates-prompt",
    );
  await mkdir(artifacts, { recursive: true });
  const started = performance.now();
  const phase = (name: string, detail: Record<string, unknown> = {}) => {
    appendFileSync(
      join(artifacts, "phases.jsonl"),
      JSON.stringify({
        phase: name,
        at: new Date().toISOString(),
        elapsedMs: performance.now() - started,
        ...detail,
      }) + "\n",
    );
  };
  await phase("fixture-ready", { scratch });
  const sample = {
    operationId: crypto.randomUUID(),
    templateId: "feedback-session",
    revision: 3,
    inputs: {
      subject: "Historical subject",
      focus: "Saved focus",
      retired_field: "x".repeat(600),
    },
    renderContext: createRenderContext(
      "Asia/Kathmandu",
      Date.parse("2026-11-02T09:30:00Z"),
    ),
    submittedAt: Date.parse("2026-11-02T09:31:00Z"),
    inputKey: "a".repeat(64),
  };
  fixture.seedSamples("feedback-session", [sample]);
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
  const requests: {
    path: string;
    method: string;
    startedAt: number;
    finishedAt?: number;
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const receipt = {
        path: url.pathname,
        method: request.method,
        startedAt: performance.now() - started,
      };
      requests.push(receipt);
      phase("http:start", receipt);
      try {
        if (url.pathname.startsWith("/rpc/")) {
          try {
            return Response.json(
              await fixture.handlers[
                decodeURIComponent(url.pathname.slice(5))
              ]!(await request.json()),
            );
          } catch (error) {
            return Response.json({ error: String(error) }, { status: 500 });
          }
        }
        if (url.pathname === "/" + basename(bundle.script)) {
          phase("script-read:start", { path: bundle.script });
          const content = await readFile(bundle.script);
          phase("script-read:done", { bytes: content.length });
          return new Response(content, {
            headers: { "content-type": "text/javascript" },
          });
        }
        if (bundle.css && url.pathname === "/" + basename(bundle.css))
          return new Response(await readFile(bundle.css), {
            headers: { "content-type": "text/css" },
          });
        return new Response(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${bundle.css ? `<link rel="stylesheet" href="/${basename(bundle.css)}">` : ""}<style>:root{--background:#171922;--foreground:#d4d5e2;--muted-foreground:#a1a4bb;--border:#373a4c;--primary:#b7a3ed;--primary-foreground:#191529;--accent:#292c3c;--input:#41455b;--ring:#b7a3ed;--muted:#292c3c;--card:#20222f;--card-foreground:#d4d5e2;--popover:#20222f;--popover-foreground:#d4d5e2;--destructive:#ffadb0}body{font:14px system-ui;background:var(--background);color:var(--foreground);margin:16px auto;padding:0 12px;max-width:950px}h1{font-size:18px}*{box-sizing:border-box}</style></head><body><h1>Templates · product component fixture</h1><textarea aria-label="Independent native freeform">Untouched freeform draft</textarea><script type="module" src="/${basename(bundle.script)}"></script></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      } finally {
        Object.assign(receipt, { finishedAt: performance.now() - started });
        phase("http:done", receipt);
      }
    },
  });
  await phase("browser-launch:start");
  const owned = acquireOwnedBrowser({
    scratch,
    artifacts,
    serverURL: server.url.toString(),
    phase,
  });
  const bodyFailure: { failed: boolean; error?: unknown } = { failed: false };
  try {
    const browser = await owned.connect();
    const page = await browser.newPage({
        viewport: { width: 1200, height: 900 },
      }),
      errors: string[] = [],
      evidence: unknown[] = [];
    browser.on("disconnected", () => phase("browser:disconnected"));
    page.context().on("close", () => phase("context:close"));
    page.on("close", () => phase("page:close"));
    page.on("crash", () => phase("page:crash"));
    page.on("pageerror", (error) => errors.push(error.message));
    phase("browser-launch:done", { server: server.url.toString() });
    let activeStep = "body not started";
    const at = async <T>(
      name: string,
      action: () => Promise<T>,
    ): Promise<T> => {
      activeStep = name;
      phase("await:start", { step: name });
      const value = await action();
      phase("await:done", { step: name });
      activeStep = "between steps";
      return value;
    };
    try {
      await phase("product-assertions:start");
      await at("page.goto manage", () =>
        page.goto(`http://127.0.0.1:${server.port}/?manage`),
      );
      const row = page
        .locator(".ntt-list-row")
        .filter({ hasText: "Feedback Session" });
      await at("Feedback Edit enabled", () =>
        browserExpect(
          row.getByRole("button", { name: "Edit", exact: true }),
        ).toBeEnabled(),
      );
      await at("Feedback Edit click", () =>
        row.getByRole("button", { name: "Edit", exact: true }).click(),
      );
      await at("Prompt tab click", () =>
        page.getByRole("tab", { name: "Prompt", exact: true }).click(),
      );
      const panel = page.getByRole("region", {
          name: "Templates workspace",
          exact: true,
        }),
        title = page.getByLabel("Thread title template", { exact: true }),
        body = page.getByLabel("First message template", { exact: true }),
        renderedTitle = page.getByLabel("Rendered thread title"),
        renderedBody = page.getByLabel("Rendered first message");
      await at("title source fill", () => title.fill("{{upper subject}}"));
      await at("body source fill", () =>
        body.fill(
          '{{#if focus}}{{trim focus}}{{else}}No focus{{/if}} · {{date @now "HH:mm"}}',
        ),
      );
      await at("historical sample select", () =>
        page
          .getByLabel("Sample inputs", { exact: true })
          .selectOption(sample.operationId),
      );
      await at("historical rendered title", () =>
        browserExpect(renderedTitle).toHaveText("HISTORICAL SUBJECT"),
      );
      await browserExpect(renderedBody).toHaveText(
        "Saved focus · 15:15 GMT+5:45",
      );
      await browserExpect(
        page.locator(".ntt-prompt-preview > .ntt-clock"),
      ).toContainText("GMT+05:45");
      await browserExpect(
        page.locator(".ntt-prompt-preview > .ntt-clock"),
      ).toContainText("Asia/Kathmandu");
      await page
        .getByLabel(/What are we giving feedback on/)
        .fill("Edited example");
      await browserExpect(renderedTitle).toHaveText("EDITED EXAMPLE");
      await body.fill("Intro\n{{#if subject}}unfinished");
      await page.getByText(/Preview unavailable:.*line 2, column 1/).waitFor();
      await body.fill("REPLACE");
      await body.focus();
      await body.press("ControlOrMeta+A");
      await page
        .getByRole("group", { name: "Field placeholders" })
        .getByRole("button", { name: /\{\{subject\}\}/ })
        .click();
      await browserExpect(body).toHaveValue("{{subject}}");
      await browserExpect(body).toBeFocused();
      expect(
        await body.evaluate(
          (node) => (node as HTMLTextAreaElement).selectionStart,
        ),
      ).toBe(11);
      await browserExpect(renderedBody).toHaveText("Edited example");
      const columns = await page
        .locator(".ntt-prompt-workbench")
        .evaluate((node) => {
          const source = node
              .querySelector(".ntt-prompt-source")!
              .getBoundingClientRect(),
            preview = node
              .querySelector(".ntt-prompt-preview")!
              .getBoundingClientRect();
          return {
            source: source.toJSON(),
            preview: preview.toJSON(),
            adjacent: preview.left >= source.right,
          };
        });
      expect(columns.adjacent).toBe(true);
      await at("desktop screenshot", () =>
        page.screenshot({ path: join(artifacts, "prompt-desktop.png") }),
      );
      const reads = fixture.calls.filter(
        (call) => call.method === "recentSamples",
      ).length;
      const wheelReach = async (target: Locator) => {
        const box = await panel.boundingBox();
        for (let i = 0; i < 25; i++) {
          const hit = await target.evaluate((node) => {
            const rect = node.getBoundingClientRect(),
              center = rect.top + rect.height / 2;
            return (
              center > 0 &&
              center < innerHeight &&
              node.contains(
                document.elementFromPoint(rect.left + rect.width / 2, center),
              )
            );
          });
          if (hit) return;
          await page.mouse.move(
            box!.x + box!.width - 15,
            box!.y + box!.height / 2,
          );
          await page.mouse.wheel(0, 180);
          await page.waitForTimeout(40);
        }
        throw new Error("Prompt control not reachable by ordinary wheel");
      };
      for (const [width, height] of [
        [390, 640],
        [360, 560],
      ]) {
        activeStep = `mobile ${width}x${height} source/preview/wheel`;
        phase("await:start", { step: activeStep });
        await page.setViewportSize({ width, height });
        await panel.focus();
        await panel.press("Home");
        await wheelReach(body);
        const sourceBox = await body.boundingBox();
        await page.screenshot({
          path: join(artifacts, `prompt-source-${width}.png`),
        });
        await wheelReach(renderedTitle);
        const previewBox = await renderedTitle.boundingBox();
        await page.screenshot({
          path: join(artifacts, `prompt-preview-${width}.png`),
        });
        const area = await panel.boundingBox();
        await page.mouse.move(
          area!.x + area!.width - 15,
          area!.y + area!.height / 2,
        );
        await page.mouse.wheel(0, 10000);
        await browserExpect
          .poll(() =>
            panel.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeLessThan(1);
        const footer = page.locator(".ntt-footer"),
          footerBox = await footer.boundingBox();
        expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(
          area!.y + area!.height + 1,
        );
        const footerHit = await footer.evaluate((node) => {
          const r = node.getBoundingClientRect();
          return node.contains(
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
          );
        });
        expect(footerHit).toBe(true);
        expect(
          await panel.evaluate(
            (node) => node.scrollWidth <= node.clientWidth + 1,
          ),
        ).toBe(true);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        evidence.push({
          width,
          height,
          sourceBox,
          previewBox,
          footerBox,
          footerHit,
        });
        await page.screenshot({
          path: join(artifacts, `prompt-footer-${width}.png`),
        });
      }
      expect(
        fixture.calls.filter((call) => call.method === "recentSamples"),
      ).toHaveLength(reads);
      expect(
        fixture.calls.filter((call) =>
          ["saveDraft", "publish", "launch"].includes(call.method),
        ),
      ).toHaveLength(0);
      await browserExpect(
        page.getByLabel("Independent native freeform"),
      ).toHaveValue("Untouched freeform draft");
      await at("product unmount", () =>
        page.evaluate(() => window.templatesHarness.unmount()),
      );
      const count = fixture.calls.length;
      await page.waitForTimeout(400);
      expect(fixture.calls.length).toBe(count);
      expect(errors).toEqual([]);
      await Bun.write(
        join(artifacts, "result.json"),
        JSON.stringify(
          {
            productComponents: true,
            nativeShell: false,
            columns,
            evidence,
            pageErrors: errors,
            sends: fixture.flags.launchCount,
          },
          null,
          2,
        ),
      );
      await phase("product-assertions:done");
    } catch (error) {
      phase("product-assertions:error", {
        step: activeStep,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
        url: page.url(),
        requests,
        pageErrors: errors,
      });
      throw error;
    }
  } catch (error) {
    bodyFailure.failed = true;
    bodyFailure.error = error;
    phase("fixture-body:error", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    });
  } finally {
    await cleanupPromptFixture({
      browser: owned.owner,
      bodyFailure,
      phase,
      steps: [
        {
          name: "server-stop",
          run: () => {
            server.stop(true);
          },
        },
        { name: "fixture-dispose", run: () => fixture.dispose() },
        {
          name: "scratch-remove",
          run: () => rm(scratch, { recursive: true, force: true }),
        },
      ],
    });
  }
}
