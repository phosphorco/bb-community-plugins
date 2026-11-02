import { expect, test } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appFixture } from "./app-fixture.ts";

test("actual product browser: chooser, validation, retained drafts, editor publication, recovery, narrow layout and teardown", async () => {
  const fixture = await appFixture(),
    scratch = await mkdtemp(join(tmpdir(), "templates-product-browser-"));
  const artifacts = process.env.BB_THREAD_STORAGE
    ? join(process.env.BB_THREAD_STORAGE, "templates-browser")
    : "/tmp/templates-browser-evidence";
  await mkdir(artifacts, { recursive: true });
  const bundle = await Bun.build({
    entrypoints: [join(import.meta.dir, "browser-app.tsx")],
    outdir: scratch,
    target: "browser",
    define: { "process.env.NODE_ENV": '"development"' },
    minify: false,
  });
  if (!bundle.success) throw new Error(bundle.logs.join("\n"));
  const script = bundle.outputs.find((o) => o.kind === "entry-point")!,
    css = bundle.outputs.find((o) => o.path.endsWith(".css"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/rpc/")) {
        try {
          const method = decodeURIComponent(url.pathname.slice(5)),
            handler = fixture.handlers[method];
          if (!handler) throw new Error(`Unknown ${method}`);
          return Response.json(await handler(await request.json()));
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          );
        }
      }
      if (url.pathname === "/" + basename(script.path))
        return new Response(await readFile(script.path), {
          headers: { "content-type": "text/javascript" },
        });
      if (css && url.pathname === "/" + basename(css.path))
        return new Response(await readFile(css.path), {
          headers: { "content-type": "text/css" },
        });
      return new Response(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${css ? `<link rel="stylesheet" href="/${basename(css.path)}">` : ""}<style>:root{--background:#171922;--foreground:#d4d5e2;--card:#20222f;--card-foreground:#d4d5e2;--popover:#20222f;--popover-foreground:#d4d5e2;--muted:#292c3c;--muted-foreground:#a1a4bb;--primary:#b7a3ed;--primary-foreground:#191529;--border:#373a4c;--input:#41455b;--ring:#b7a3ed;--accent:#2c2f42;--destructive:#ffadb0}body{background:var(--background);color:var(--foreground);font:14px system-ui;margin:24px auto;padding:0 16px;max-width:900px}body>header{font-size:12px;color:var(--muted-foreground);margin-bottom:24px}h1{font-size:24px;font-weight:500}</style></head><body><header>Product component acceptance harness · native host frame and picker internals tested separately</header><h1>Templates</h1><script type="module" src="/${basename(script.path)}"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
      viewport: { width: 1100, height: 1000 },
    }),
    page = await context.newPage(),
    errors: string[] = [];
  // The public fake composer voids onSubmit without catching rejection. Capture
  // its one expected rejection separately; actual native clear/retain is canonical proof.
  let expectingNativeRejection = false;
  const nativeRejections: string[] = [];
  page.on("pageerror", (error) => {
    if (
      expectingNativeRejection &&
      error.message.includes("State route request failed")
    )
      nativeRejections.push(error.message);
    else errors.push(error.message);
  });
  try {
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page
      .getByRole("button", { name: /(?:Review a PR|PR Review)/ })
      .waitFor();
    await page.getByRole("searchbox").fill("unfindable");
    await page.getByText("No matching templates.").waitFor();
    await page.getByRole("searchbox").fill("");
    expect(
      await page.getByRole("button", { name: "Inspect drafts" }).count(),
    ).toBe(0);
    expect(
      await page.getByRole("button", { name: /Recent launches/ }).count(),
    ).toBe(0);
    await page.getByRole("button", { name: "Manage", exact: true }).click();
    expect(
      (
        (await page.evaluate(() => window.templatesHarness.stats())) as {
          navigation: { method: string }[];
        }
      ).navigation.some((call) => call.method === "toPluginPanel"),
    ).toBe(true);
    await page.evaluate(() => window.templatesHarness.mount(true));
    await page.getByRole("button", { name: "History", exact: true }).click();
    await page.getByRole("heading", { name: "History", exact: true }).waitFor();
    await page.evaluate(() => window.templatesHarness.mount(false));
    await page.getByRole("searchbox").waitFor();
    await page.screenshot({
      path: join(artifacts, "gallery-dark.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: /Feedback Session/ }).click();
    await page
      .getByLabel("What are we giving feedback on?", { exact: false })
      .fill("Settings redesign");
    await page
      .getByLabel("Main focus and context", { exact: false })
      .fill("Keyboard navigation and clarity");
    await page
      .getByLabel("Feedback contributors", { exact: false })
      .fill("Ada and Bea");
    expect(await page.locator(".ntt-run.ntt-surface").count()).toBe(0);
    expect(
      await page
        .getByRole("heading", { name: "Feedback Session", exact: true })
        .count(),
    ).toBe(1);
    const ownControl = page.locator("[data-field=subject]");
    const controlHeight = await ownControl.evaluate(
      (node) => node.getBoundingClientRect().height,
    );
    // The host font metrics vary by theme; retain native compact proportions.
    expect(controlHeight).toBeGreaterThanOrEqual(30);
    expect(controlHeight).toBeLessThanOrEqual(34);
    expect(
      await page
        .locator("[data-field=focus]")
        .evaluate((node) => getComputedStyle(node).resize),
    ).toBe("vertical");
    await page.getByLabel("Final launch destination").first().waitFor();
    await browserExpect
      .poll(
        async () =>
          (await fixture.readPersonal("feedback-session"))?.inputs.contributors,
      )
      .toBe("Ada and Bea");
    await page
      .getByText("Saving personal inputs…", { exact: true })
      .waitFor({ state: "hidden" });
    await page.screenshot({
      path: join(artifacts, "feedback-form-compact.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await browserExpect
      .poll(
        async () =>
          (await fixture.readPersonal("feedback-session"))?.inputs.focus,
      )
      .toBe("Keyboard navigation and clarity");
    await page.screenshot({
      path: join(artifacts, "feedback-form-dark.png"),
      fullPage: true,
    });
    expect(fixture.flags.launchCount).toBe(0);
    await page.getByRole("button", { name: "‹ All templates" }).click();
    await page
      .getByRole("button", { name: /(?:Review a PR|PR Review)/ })
      .click();
    await page
      .getByRole("button", { name: "Start thread", exact: true })
      .click();
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-field") === "pr_url",
    );
    await page
      .getByLabel("Pull request URL", { exact: false })
      .fill("https://example.test/pull/42");
    const subject = page.getByLabel("Main change or review goal", {
      exact: false,
    });
    if (await subject.count()) await subject.fill("Identity consistency");
    await page
      .getByLabel(/(?:Focus|Important context or concerns)/, { exact: false })
      .fill("Failure recovery");
    await page
      .getByLabel(/(?:Focus|Important context or concerns)/, { exact: false })
      .press("Enter");
    await page
      .getByLabel(/(?:Focus|Important context or concerns)/, { exact: false })
      .press("a");
    expect(fixture.flags.launchCount).toBe(0);
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await page.getByText("Final launch destination", { exact: true }).count();
    await page.getByLabel("Final launch destination").first().waitFor();
    await browserExpect
      .poll(async () => (await fixture.readPersonal())?.inputs.focus)
      .toContain("Failure recovery");
    await page.screenshot({
      path: join(artifacts, "form-dark.png"),
      fullPage: true,
    });
    // The actual product participates in all theme roles; fixtures supply independent palettes.
    for (const [name, palette] of Object.entries({
      light: {
        "--background": "#ffffff",
        "--foreground": "#171922",
        "--card": "#f7f8fc",
        "--card-foreground": "#171922",
        "--muted": "#eceef5",
        "--muted-foreground": "#5d6277",
        "--primary": "#5e4698",
        "--primary-foreground": "#ffffff",
        "--border": "#ced1dd",
        "--input": "#b8bdcc",
        "--ring": "#5e4698",
        "--accent": "#ece7f5",
        "--destructive": "#a01524",
      },
      custom: {
        "--background": "#201b15",
        "--foreground": "#f5e9d8",
        "--card": "#30281f",
        "--card-foreground": "#f5e9d8",
        "--muted": "#3e3326",
        "--muted-foreground": "#c3b29d",
        "--primary": "#e6bc68",
        "--primary-foreground": "#201b15",
        "--border": "#68553c",
        "--input": "#826d4f",
        "--ring": "#e6bc68",
        "--accent": "#493b29",
        "--destructive": "#ffb0a3",
      },
    })) {
      await page.evaluate((values) => {
        for (const [key, value] of Object.entries(values))
          document.documentElement.style.setProperty(key, value);
      }, palette);
      const contrast = await page.evaluate(() => {
        const channel = (n: number) => {
          const v = n / 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        const luminance = (s: string) => {
          const c = s.match(/[0-9.]+/g)!.map(Number);
          return (
            0.2126 * channel(c[0]!) +
            0.7152 * channel(c[1]!) +
            0.0722 * channel(c[2]!)
          );
        };
        const button = document.querySelector<HTMLElement>(".ntt-send")!,
          style = getComputedStyle(button),
          a = luminance(style.color),
          b = luminance(style.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      expect(contrast).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({
        path: join(artifacts, `form-${name}.png`),
        fullPage: true,
      });
    }
    await page.evaluate(() => {
      document.documentElement.removeAttribute("style");
    });

    await page.getByRole("button", { name: "‹ All templates" }).click();
    await page
      .getByRole("button", { name: /(?:Review a PR|PR Review)/ })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector<HTMLTextAreaElement>('[data-field="focus"]')
        ?.value.includes("Failure recovery\na"),
    );
    // Reload real browser/IndexedDB; server personal state persists through the wire fake.
    await page.reload();
    await page
      .getByRole("button", { name: /(?:Review a PR|PR Review)/ })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector<HTMLTextAreaElement>('[data-field="focus"]')
        ?.value.includes("Failure recovery"),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: join(artifacts, "form-mobile.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    // Exercise our wrapper and visibility using the public component seam; canonical BB proves native chips/catalogs.
    await page
      .getByRole("button", { name: /Edit with BB|Resume BB editor/ })
      .click();
    const native = page.getByTestId("bb-new-thread-composer");
    await native.waitFor();
    const nativeKey = await native.getAttribute("data-draft-key");
    await page
      .getByTestId("bb-new-thread-composer-input")
      .fill("Kept native editor work");
    await page.getByRole("button", { name: "‹ Back to form" }).click();
    expect(await native.isVisible()).toBe(false);
    await page.getByRole("button", { name: "Resume BB editor" }).click();
    expect(await native.getAttribute("data-draft-key")).toBe(nativeKey);
    expect(
      await page.getByTestId("bb-new-thread-composer-input").inputValue(),
    ).toBe("Kept native editor work");
    // Lost personal-save response is known to precede ANY launch RPC. Recover
    // the shared state, remove only this lifecycle's unsent reference, and resume.
    fixture.wire.loseNextSaveResponse();
    expectingNativeRejection = true;
    await page.getByTestId("bb-new-thread-composer-submit").click();
    await page
      .getByRole("alert")
      .filter({ hasText: "No launch request was sent" })
      .waitFor();
    expect(fixture.flags.launchCount).toBe(0);
    expect((await fixture.readPersonal())?.operationId).toBeTruthy();
    // A second cleanup failure leaves the original operation authoritative.
    // Its local no-dispatch proof must survive until acknowledged removal.
    fixture.wire.loseNextSaveResponse();
    await page
      .getByRole("button", { name: "Reconnect inputs", exact: true })
      .click();
    await browserExpect
      .poll(async () => (await fixture.readPersonal())?.operationId)
      .toBeUndefined();
    await page
      .getByRole("button", { name: "Reconnect inputs", exact: true })
      .waitFor();
    expect(
      await page
        .getByRole("button", { name: "Check launch status", exact: true })
        .count(),
    ).toBe(0);
    await page
      .getByRole("button", { name: "Reconnect inputs", exact: true })
      .click();
    await browserExpect
      .poll(async () => (await fixture.readPersonal())?.operationId)
      .toBeUndefined();
    await native.waitFor();
    expect(await native.getAttribute("data-draft-key")).toBe(nativeKey);
    expect(
      await page
        .getByRole("button", { name: "Check launch status", exact: true })
        .count(),
    ).toBe(0);
    await browserExpect.poll(() => nativeRejections.length).toBe(1);
    expectingNativeRejection = false;
    await page.getByRole("button", { name: "‹ Back to form" }).click();
    // Normal response loss enters check-only recovery. Reconnect/reload never sends another launch.
    await page.getByLabel("Final launch destination").first().waitFor();
    fixture.flags.launchMode = "lost";
    await page
      .getByLabel(/(?:Focus|Important context or concerns)/, { exact: false })
      .press("Control+Enter");
    await page
      .getByRole("button", { name: "Check launch status", exact: true })
      .waitFor();
    await page
      .getByRole("alert")
      .filter({ hasText: "Response lost" })
      .waitFor();
    expect(fixture.flags.launchCount).toBe(1);
    await page.evaluate(() => window.templatesHarness.reconnect());
    expect(fixture.flags.launchCount).toBe(1);
    await page.reload();
    await page
      .getByRole("button", { name: /(?:Review a PR|PR Review)/ })
      .click();
    await page
      .getByRole("button", { name: "Check launch status", exact: true })
      .waitFor();
    expect(fixture.flags.launchCount).toBe(1);
    await page.screenshot({
      path: join(artifacts, "unknown-mobile.png"),
      fullPage: true,
    });
    // Product management editor, with real state transitions; no static HTML prototype.
    await page.setViewportSize({ width: 1100, height: 1000 });
    await page.goto(`http://127.0.0.1:${server.port}/?manage`);
    await page.getByRole("button", { name: "+ New template" }).click();
    await page
      .getByLabel("Name", { exact: true })
      .fill("Browser-created template");
    await page.getByRole("button", { name: "+ Add field" }).click();
    await page.getByLabel("Label", { exact: true }).fill("Goal");
    await page.getByLabel("Stable key", { exact: true }).fill("goal");
    await page.getByLabel("Type", { exact: true }).selectOption("textarea");
    for (const tab of ["Project", "Model", "Prompt", "Fields"])
      await page.getByRole("tab", { name: tab, exact: true }).click();
    await page.getByRole("tab", { name: "Prompt", exact: true }).click();
    await page.getByLabel("Thread title template").fill("Explore {{goal}}");
    await page
      .getByLabel("First message template")
      .fill("Help with {{unknown}}.");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByText(/Unknown field unknown/).waitFor();
    expect(fixture.calls.filter((c) => c.method === "publish")).toHaveLength(0);
    const promptBody = page.getByLabel("First message template");
    await promptBody.fill("Help with REPLACE.");
    await promptBody.focus();
    await promptBody.press("Home");
    for (let i = 0; i < 10; i++) await promptBody.press("ArrowRight");
    for (let i = 0; i < 7; i++) await promptBody.press("Shift+ArrowRight");
    expect(
      await promptBody.evaluate((element) => [
        (element as HTMLTextAreaElement).selectionStart,
        (element as HTMLTextAreaElement).selectionEnd,
      ]),
    ).toEqual([10, 17]);
    await page
      .getByRole("group", { name: "Field placeholders" })
      .getByRole("button", { name: /\{\{goal\}\}/ })
      .click();
    await browserExpect(promptBody).toHaveValue("Help with {{goal}}.");
    await browserExpect
      .poll(() =>
        promptBody.evaluate((element) => ({
          focused: document.activeElement === element,
          caret: (element as HTMLTextAreaElement).selectionStart,
        })),
      )
      .toEqual({ focused: true, caret: 18 });
    await page.screenshot({
      path: join(artifacts, "prompt-placeholders-desktop.png"),
      fullPage: false,
    });
    await page
      .getByRole("button", { name: "Preview with sample inputs" })
      .click();
    await page.getByLabel("Goal", { exact: false }).fill("A focused feature");
    await page
      .getByText("Help with A focused feature.", { exact: true })
      .waitFor();
    await page.screenshot({
      path: join(artifacts, "editor-preview-dark.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByText(/ · unsaved changes/).waitFor({ state: "hidden" });
    await page.getByLabel("Name", { exact: true }).fill("Unsaved browser work");
    await page.getByRole("button", { name: "‹ All templates" }).click();
    await page
      .getByRole("dialog", { name: "Unsaved template changes" })
      .waitFor();
    await page.getByRole("button", { name: "Stay", exact: true }).click();
    await page.reload();
    await page
      .getByRole("heading", { name: "Browser-created template" })
      .waitFor();
    const row = page
      .getByRole("heading", { name: "Browser-created template" })
      .locator("..")
      .locator("..");
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await page
      .getByRole("button", { name: "Restore unfinished edits" })
      .click();
    expect(await page.getByLabel("Name", { exact: true }).inputValue()).toBe(
      "Unsaved browser work",
    );
    // Bound the actual product panel in desktop/short/mobile fixture parents.
    // Canonical shell wheel/keyboard acceptance is separately steward-owned.
    await page.getByRole("tab", { name: "Fields", exact: true }).click();
    for (let i = 2; i <= 12; i++) {
      await page
        .getByRole("button", { name: "+ Add field", exact: true })
        .click();
      await page
        .getByRole("region", { name: `Field ${i}`, exact: true })
        .getByLabel("Label", { exact: true })
        .fill(`Extra field ${i}`);
    }
    const last = page.getByRole("region", { name: "Field 12", exact: true });
    for (const [size, viewport] of Object.entries({
      desktop: { width: 1100, height: 900 },
      short: { width: 1100, height: 420 },
      mobile: { width: 390, height: 700 },
    })) {
      await page.setViewportSize(viewport);
      const panel = page.getByRole("region", {
        name: "Templates workspace",
        exact: true,
      });
      await panel.focus();
      await panel.press("Home");
      await panel.hover({ position: { x: 100, y: 100 } });
      await page.mouse.wheel(0, 4000);
      await browserExpect
        .poll(() => panel.evaluate((node) => node.scrollTop))
        .toBeGreaterThan(0);
      const lastLabel = last.getByLabel("Label", { exact: true });
      await lastLabel.fill(`Last field ${size}`);
      await lastLabel.press("Tab");
      await browserExpect(
        last.getByLabel("Stable key", { exact: true }),
      ).toBeFocused();
      await page
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      await page.getByText(/ · unsaved changes/).waitFor({ state: "hidden" });
      expect(
        fixture.entries
          .find(
            (entry) => entry.draft?.definition.name === "Unsaved browser work",
          )
          ?.draft?.definition.fields.at(-1)?.label,
      ).toBe(`Last field ${size}`);
      await last
        .getByRole("button", { name: new RegExp(`^Last field ${size} `) })
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(artifacts, `fields-${size}.png`) });
      const bounds = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      expect(bounds.width).toBeLessThanOrEqual(bounds.viewport);
    }
    // Literal incomplete numbers remain recoverable local work, never NaN in
    // the typed shared definition. Exercise actual browser collapse + reload.
    await last.getByLabel("Type", { exact: true }).selectOption("number");
    await last
      .getByText("Help, defaults and validation", { exact: true })
      .click();
    await last.getByLabel("Default value", { exact: true }).fill("-");
    await last.getByLabel("Minimum", { exact: true }).fill("1e");
    const firstField = page.getByRole("region", {
      name: "Field 1",
      exact: true,
    });
    await firstField.getByRole("button", { name: /^Goal Long text/ }).click();
    await firstField
      .getByText("Help, defaults and validation", { exact: true })
      .click();
    await firstField.getByLabel("Minimum length", { exact: true }).fill("2.");
    const sharedSaves = fixture.calls.filter(
      (call) => call.method === "saveDraft",
    ).length;
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await page
      .getByText(
        "Complete the unfinished number before saving or publishing.",
        { exact: true },
      )
      .waitFor();
    expect(
      fixture.calls.filter((call) => call.method === "saveDraft").length,
    ).toBe(sharedSaves);
    await last
      .getByRole("button", { name: /^Last field mobile Number/ })
      .click();
    await last
      .getByRole("button", { name: /^Last field mobile Number/ })
      .click();
    expect(
      await last.getByLabel("Default value", { exact: true }).inputValue(),
    ).toBe("-");
    expect(await last.getByLabel("Minimum", { exact: true }).inputValue()).toBe(
      "1e",
    );
    await page.reload();
    const savedRow = page
      .getByRole("heading", { name: "Unsaved browser work", exact: true })
      .locator("..")
      .locator("..");
    await savedRow.getByRole("button", { name: "Edit", exact: true }).click();
    await page
      .getByRole("button", { name: "Restore unfinished edits", exact: true })
      .click();
    const restoredLast = page.getByRole("region", {
      name: "Field 12",
      exact: true,
    });
    await restoredLast
      .getByRole("button", { name: /^Last field mobile / })
      .click();
    expect(
      await restoredLast.getByLabel("Label", { exact: true }).inputValue(),
    ).toBe("Last field mobile");
    await restoredLast
      .getByText("Help, defaults and validation", { exact: true })
      .click();
    expect(
      await restoredLast
        .getByLabel("Default value", { exact: true })
        .inputValue(),
    ).toBe("-");
    expect(
      await restoredLast.getByLabel("Minimum", { exact: true }).inputValue(),
    ).toBe("1e");
    await page.screenshot({
      path: join(artifacts, "numeric-recovery-mobile.png"),
    });
    const restoredFirst = page.getByRole("region", {
      name: "Field 1",
      exact: true,
    });
    await restoredFirst
      .getByRole("button", { name: /^Goal Long text/ })
      .click();
    await restoredFirst
      .getByText("Help, defaults and validation", { exact: true })
      .click();
    expect(
      await restoredFirst
        .getByLabel("Minimum length", { exact: true })
        .inputValue(),
    ).toBe("2.");
    await restoredFirst.getByLabel("Minimum length", { exact: true }).fill("2");
    await restoredLast
      .getByRole("button", { name: /^Last field mobile Number/ })
      .click();
    await restoredLast.getByLabel("Default value", { exact: true }).fill("3");
    await restoredLast.getByLabel("Minimum", { exact: true }).fill("1");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await page.getByText(/ · unsaved changes/).waitFor({ state: "hidden" });
    expect(
      fixture.entries
        .find(
          (entry) => entry.draft?.definition.name === "Unsaved browser work",
        )
        ?.draft?.definition.fields.at(-1)?.default,
    ).toBe(3);
    expect(
      await page.getByText("Complete this number.", { exact: true }).count(),
    ).toBe(0);
    // Settings owns normal document scrolling; reuse the same editor and real CAS Remove boundary.
    await page.evaluate(() => window.templatesHarness.mount("settings"));
    await page
      .getByRole("button", { name: "+ New template", exact: true })
      .waitFor();
    expect(await page.locator(".ntt-settings").count()).toBe(1);
    expect(await page.locator(".ntt-panel").count()).toBe(0);
    await page
      .getByRole("button", { name: "+ New template", exact: true })
      .click();
    await page
      .getByLabel("Name", { exact: true })
      .fill("Settings removal witness");
    await page.getByRole("tab", { name: "Project", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Project", exact: true })
      .selectOption("project-b");
    await page
      .getByRole("combobox", { name: "Machine", exact: true })
      .selectOption("host-b");
    expect(
      await page
        .getByRole("combobox", { name: "Environment", exact: true })
        .inputValue(),
    ).toBe("project-default");
    await page
      .getByText(/Choose a source checkout or worktree for this machine/)
      .waitFor();
    await page
      .getByRole("combobox", { name: "Environment", exact: true })
      .selectOption("local-source");

    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await page.getByText(/ · unsaved changes/).waitFor({ state: "hidden" });
    const machineEntry = fixture.entries.find(
      (entry) => entry.draft?.definition.name === "Settings removal witness",
    )!;
    expect(machineEntry.draft!.definition.destination).toMatchObject({
      kind: "existing-project",
      projectId: "project-b",
      hostId: "host-b",
      environment: { kind: "local-source" },
    });
    await page.setViewportSize({ width: 1100, height: 1000 });
    await page.screenshot({
      path: join(artifacts, "project-machine-desktop.png"),
      fullPage: false,
    });
    await page.setViewportSize({ width: 390, height: 700 });
    await page.getByRole("button", { name: "‹ All templates" }).click();
    await page
      .locator(".ntt-list-row")
      .filter({ hasText: "Settings removal witness" })
      .getByRole("button", { name: "Configure", exact: true })
      .click();
    await page.getByRole("tab", { name: "Project", exact: true }).click();
    expect(
      await page
        .getByRole("combobox", { name: "Machine", exact: true })
        .inputValue(),
    ).toBe("host-b");
    expect(
      await page
        .getByRole("combobox", { name: "Environment", exact: true })
        .inputValue(),
    ).toBe("local-source");
    await page.screenshot({
      path: join(artifacts, "settings-editor-mobile.png"),
      fullPage: false,
    });
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page
      .getByRole("button", { name: "+ New template", exact: true })
      .waitFor();
    expect(
      fixture.entries.some(
        (e) => e.draft?.definition.name === "Settings removal witness",
      ),
    ).toBe(false);
    await page.screenshot({
      path: join(artifacts, "settings-console-mobile.png"),
      fullPage: false,
    });
    await page.evaluate(() => window.templatesHarness.unmount());
    const after = fixture.calls.length;
    await page.waitForTimeout(1200);
    expect(fixture.calls.length).toBe(after);
    expect(errors).toEqual([]);
    await Bun.write(
      join(artifacts, "result.json"),
      JSON.stringify(
        {
          productComponents: true,
          nativeChrome: false,
          screenshots: [
            "gallery-dark.png",
            "feedback-form-dark.png",
            "feedback-form-compact.png",
            "form-dark.png",
            "form-light.png",
            "form-custom.png",
            "form-mobile.png",
            "unknown-mobile.png",
            "editor-preview-dark.png",
            "fields-desktop.png",
            "fields-short.png",
            "fields-mobile.png",
            "numeric-recovery-mobile.png",
            "settings-editor-mobile.png",
            "settings-console-mobile.png",
            "prompt-placeholders-desktop.png",
            "project-machine-desktop.png",
          ],
          launches: fixture.flags.launchCount,
          pageErrors: errors,
          expectedPublicFakeComposerRejections: nativeRejections.length,
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

const { mobileReachability } = await import("./browser-mobile.ts");
test(
  "actual product mobile reachability replaces long Recent only with usable mounted Templates",
  mobileReachability,
  60000,
);

const { browserSavedRequestRecovery } = await import("./browser-recovery.ts");
test(
  "actual product browser reload resumes exact saved direct and native request",
  browserSavedRequestRecovery,
  60000,
);
