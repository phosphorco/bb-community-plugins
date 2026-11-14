/** Real source chunks in public slot/identity fixture; native compiler artifacts remain host proof. */
import { test, expect } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appFixture } from "./app-fixture.ts";

test("source fixture lazy chunks stay deferred and real failed fetch Retry Back and personal recovery work", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "templates-lazy-artifact-")),
    fixture = await appFixture(`native-lazy-${crypto.randomUUID()}`),
    artifacts = join(
      process.env.BB_THREAD_STORAGE ?? "/tmp/templates-browser-evidence",
      "templates-lazy",
    );
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let holdRun = true,
    failRun = false,
    failManagement = false;
  const held = new Set<() => void>();
  try {
    await mkdir(artifacts, { recursive: true });
    const built = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "browser-lazy-build.ts"),
        scratch,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (built.exitCode !== 0)
      throw new Error(new TextDecoder().decode(built.stderr));
    const { files } = JSON.parse(new TextDecoder().decode(built.stdout)) as {
      files: {
        path: string;
        kind: string;
        run: boolean;
        management: boolean;
      }[];
    };
    const runFile = files.find((file) => file.run)!.path,
      managementFile = files.find((file) => file.management)!.path,
      bootstrap = files.find((file) => file.kind === "entry-point")!,
      assetPrefix = "/fixture/",
      artifactRoot = scratch;
    expect(runFile).toBeTruthy();
    expect(managementFile).toBeTruthy();
    expect(runFile).not.toBe(bootstrap.path);
    expect(managementFile).not.toBe(bootstrap.path);
    const clock = {
      version: 1 as const,
      instant: 1700000000000,
      timeZone: "Asia/Kathmandu",
    };
    fixture.seedPersonal({
      inputs: {
        subject: "Native artifact retained",
        pr_url: "https://example.test/pull/9",
      },
      projectId: "project-a",
      renderContext: clock,
    });
    const before = await fixture.readPersonal(),
      requests: string[] = [],
      failures: string[] = [],
      errors: string[] = [];
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
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
        if (url.pathname.startsWith(assetPrefix)) {
          const file = url.pathname.slice(assetPrefix.length);
          requests.push(file);
          if (!files.some((item) => item.path === file))
            return new Response("Missing", { status: 404 });
          if (
            (file === runFile && failRun) ||
            (file === managementFile && failManagement)
          ) {
            if (file === runFile) failRun = false;
            else failManagement = false;
            failures.push(file);
            return new Response("Deliberate first chunk transport failure", {
              status: 503,
            });
          }
          if (file === runFile && holdRun)
            await new Promise<void>((done) => {
              const release = () => {
                held.delete(release);
                done();
              };
              held.add(release);
            });
          return new Response(await readFile(join(artifactRoot, file)), {
            headers: {
              "content-type": file.endsWith(".css")
                ? "text/css"
                : "text/javascript",
            },
          });
        }
        return new Response(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${assetPrefix}${files.find((file) => file.path.endsWith(".css"))!.path}"><style>:root{--background:#171922;--foreground:#d4d5e2;--muted-foreground:#a1a4bb;--card:#20222f;--card-foreground:#d4d5e2;--primary:#b7a3ed;--border:#373a4c;--input:#41455b}body{font:14px system-ui;margin:0;background:var(--background);color:var(--foreground)}[hidden]{display:none!important}[data-fixture-home]{height:100dvh;overflow:auto}[data-fixture-home-slot]{padding:16px}li{height:60px}[data-fixture-settings]{padding:16px}[data-fixture-dock]{position:fixed;bottom:0;left:0;right:0;height:100px;background:var(--background)}textarea[aria-label="Native freeform fixture"]{width:100%;height:70px}</style></head><body><main data-fixture-home data-testid="root-compose-compact-home"><section data-root-compose-mobile-recents><ol>${Array.from({ length: 300 }, () => "<li>Native Recent fixture</li>").join("")}</ol></section><section data-fixture-home-slot><h2>Templates</h2></section></main><main data-fixture-settings hidden><section data-fixture-settings-slot></section></main><div data-fixture-dock><textarea aria-label="Native freeform fixture">Independent draft</textarea></div><script type="module" src="${assetPrefix}${bootstrap.path}"></script></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    browser = await chromium.launch({ headless: true });
    let context = await browser.newContext({
        viewport: { width: 390, height: 844 },
      }),
      page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") console.error(message.text());
    });
    await page.goto(server.url.toString());
    await page.waitForFunction(() => !!window.mobileTemplatesHarness);
    await page.evaluate(() => window.mobileTemplatesHarness.enable());
    const card = () => page.getByRole("button", { name: /PR Review/ });
    await browserExpect(card()).toBeEnabled();
    expect(requests.includes(runFile)).toBe(false);
    expect(requests.includes(managementFile)).toBe(false);
    const initialFiles = [...new Set(requests)];
    await card().click();
    await page.getByText("Loading template form…", { exact: true }).waitFor();
    await browserExpect(
      page.locator("[data-root-compose-mobile-recents]"),
    ).toBeHidden();
    await browserExpect(
      page.getByRole("heading", { name: "PR Review", exact: true }),
    ).toBeFocused();
    expect(
      await page
        .getByRole("button", { name: "Start thread", exact: true })
        .count(),
    ).toBe(0);
    await page.getByRole("button", { name: "‹ All templates" }).click();
    const lateResponse = page.waitForResponse((response) =>
      response.url().endsWith(runFile),
    );
    holdRun = false;
    for (const release of [...held]) release();
    await lateResponse;
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    await browserExpect(card()).toBeFocused();
    expect(await page.getByLabel(/Main change or review goal/).count()).toBe(0);
    await context.close();

    failRun = true;
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") console.error(message.text());
    });
    await page.goto(server.url.toString());
    await page.waitForFunction(() => !!window.mobileTemplatesHarness);
    await page.evaluate(() => window.mobileTemplatesHarness.enable());
    await browserExpect(card()).toBeEnabled();
    await card().click();
    await page.getByText(/This view could not load/).waitFor();
    await browserExpect(
      page.locator("[data-root-compose-mobile-recents]"),
    ).toBeHidden();
    await page.getByRole("button", { name: "Retry loading" }).click();
    await page.getByRole("button", { name: "Reload view" }).waitFor();
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("new-thread-templates:return:")) {
          Storage.prototype.setItem = original;
          throw new Error("Scripted handoff storage failure");
        }
        return original.call(this, key, value);
      };
    });
    await page.getByRole("button", { name: "Reload view" }).click();
    await page
      .getByText(/selected form could not be retained for return/)
      .waitFor();
    await browserExpect(
      page.getByRole("heading", { name: "PR Review", exact: true }),
    ).toBeVisible();
    // The handoff is written once, then explicitly armed. Either write can fail.
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      let writes = 0;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("new-thread-templates:return:") && ++writes === 2) {
          Storage.prototype.setItem = original;
          throw new Error("Scripted arm storage failure");
        }
        return original.call(this, key, value);
      };
    });
    await page.getByRole("button", { name: "Reload view" }).click();
    expect(
      await page.evaluate(() => {
        const key = Object.keys(sessionStorage).find((key) =>
          key.startsWith("new-thread-templates:return:"),
        );
        return key ? JSON.parse(sessionStorage.getItem(key)!).armed : null;
      }),
    ).toBe(false);
    await browserExpect(
      page.getByText(/selected form could not be retained for return/),
    ).toBeVisible();
    await Promise.all([
      page.waitForEvent("domcontentloaded"),
      page.getByRole("button", { name: "Reload view" }).click(),
    ]);
    await page.waitForFunction(() => !!window.mobileTemplatesHarness);
    await page.evaluate(() => window.mobileTemplatesHarness.enable());
    await browserExpect(
      page.getByLabel(/Main change or review goal/),
    ).toHaveValue("Native artifact retained");
    expect(await fixture.readPersonal()).toEqual(before);
    failManagement = true;
    await page.goto(`${server.url}?settings`);
    await page.getByText(/This view could not load/).waitFor();
    await page.getByRole("button", { name: "Retry loading" }).click();
    await page.getByRole("button", { name: "Reload view" }).waitFor();
    await Promise.all([
      page.waitForEvent("domcontentloaded"),
      page.getByRole("button", { name: "Reload view" }).click(),
    ]);
    await browserExpect(
      page.getByRole("button", { name: "+ New template" }),
    ).toBeEnabled();
    expect(requests.includes(runFile)).toBe(true);
    expect(requests.includes(managementFile)).toBe(true);
    expect(failures).toEqual([runFile, managementFile]);
    expect(
      fixture.calls.filter((call) =>
        ["launch", "saveDraft", "publish", "remove"].includes(call.method),
      ),
    ).toHaveLength(0);
    expect(fixture.wire.saveInputs).toHaveLength(0);
    expect(await page.getByLabel("Native freeform fixture").inputValue()).toBe(
      "Independent draft",
    );
    expect(errors).toEqual([]);
    await writeFile(
      join(artifacts, "result.json"),
      JSON.stringify(
        {
          compiler:
            "Bun source-fixture splitting; actual SDK artifact rendering remains canonical host proof",
          initialFiles,
          requests,
          failures,
          source: "actual product source with public slot/identity fixture",
          nativeShell: false,
        },
        null,
        2,
      ),
    );
    await context.close();
  } finally {
    holdRun = false;
    for (const release of [...held]) release();
    try {
      await browser?.close();
    } finally {
      try {
        server?.stop(true);
      } finally {
        try {
          await fixture.dispose();
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      }
    }
  }
}, 60000);
