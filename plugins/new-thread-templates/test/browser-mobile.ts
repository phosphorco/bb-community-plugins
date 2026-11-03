import { expect } from "bun:test";
import {
  chromium,
  expect as browserExpect,
  type Locator,
  type Browser,
} from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appFixture } from "./app-fixture.ts";

export interface MobileResources {
  fixture?: Awaited<ReturnType<typeof appFixture>>;
  scratch?: string;
  server?: Pick<ReturnType<typeof Bun.serve>, "stop" | "port">;
  browser?: Browser;
}
interface MobileSetupHooks {
  build?: (scratch: string) => { exitCode: number; stdout: Uint8Array; stderr: Uint8Array };
  launch?: () => Promise<Browser>;
  acquired?: (resources: Readonly<MobileResources>) => void;
}
/** Local harness ownership only; every acquired resource gets a cleanup attempt. */
export async function cleanupMobileResources(resources: MobileResources) {
  const failures: unknown[] = [];
  for (const cleanup of [
    () => resources.browser?.close(),
    () => resources.server?.stop(true),
    () => resources.fixture?.dispose(),
    () => resources.scratch ? rm(resources.scratch, { recursive: true, force: true }) : undefined,
  ]) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Mobile harness cleanup failed");
}
export function mobileReachability() { return mobileReachabilityWithSetup(); }
/** Fault-injection seam; the existing registered browser test stays zero-argument. */
export async function mobileReachabilityWithSetup(hooks: MobileSetupHooks = {}) {
  const resources: MobileResources = {};
  let primaryFailed = false;
  try {
    const fixture = resources.fixture = await appFixture(`mobile-${crypto.randomUUID()}`);
    hooks.acquired?.(resources);
    const scratch = resources.scratch = await mkdtemp(join(tmpdir(), "templates-mobile-"));
    hooks.acquired?.(resources);
    const artifacts = join(
      process.env.BB_THREAD_STORAGE ?? "/tmp/templates-browser-evidence",
      "templates-mobile",
    );
    await mkdir(artifacts, { recursive: true });
    const build = hooks.build ? hooks.build(scratch) : Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "browser-mobile-build.ts"),
        scratch,
      ],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    if (build.exitCode !== 0)
      throw new Error(new TextDecoder().decode(build.stderr));
    const built = JSON.parse(new TextDecoder().decode(build.stdout)) as {
      script: string;
      css: string | null;
    };
    const script = { path: built.script },
      css = built.css ? { path: built.css } : null;
    let identityUnavailable = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/rpc/")) {
          try {
            const method = decodeURIComponent(url.pathname.slice(5));
            if (identityUnavailable && method.startsWith("bb-identity."))
              throw new Error("Identity temporarily unavailable");
            const handler = fixture.handlers[method];
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
          `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${css ? `<link rel="stylesheet" href="/${basename(css.path)}">` : ""}<style>
      :root{--background:#171922;--foreground:#d4d5e2;--card:#20222f;--card-foreground:#d4d5e2;--muted-foreground:#a1a4bb;--primary:#b7a3ed;--primary-foreground:#191529;--border:#373a4c;--input:#41455b;--ring:#b7a3ed;--accent:#2c2f42}*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font:14px system-ui}header{height:56px;padding:16px}[hidden]{display:none!important}[data-fixture-home]{height:calc(100dvh - 56px);position:relative}[data-fixture-viewport]{position:absolute;top:0;bottom:0;left:0;right:0;overflow:auto}[data-fixture-column]{max-width:760px;margin:auto;padding:0 16px}[data-fixture-leading]{height:max(44px,calc(100dvh - 476px))}[data-fixture-bottom]{height:112px}[data-fixture-home-slot]{margin-top:24px}h2{font-size:14px;margin:0 0 12px}ol{margin:0;padding:0;list-style:none}li{height:61px;padding:16px 0;border-bottom:1px solid var(--border)}[data-fixture-dock]{height:112px;position:absolute;bottom:0;left:0;right:0;background:var(--background);padding:12px 16px}textarea[aria-label="Native freeform fixture"]{display:block;width:100%;height:80px;background:var(--card);color:var(--foreground)}[data-fixture-fade]{position:absolute;top:-6rem;left:0;right:0;height:6rem;pointer-events:none;background:linear-gradient(transparent,var(--background))}[data-fixture-settings]{padding:16px}[data-fixture-other-list]{display:block;position:fixed;right:0;top:0;width:1px;height:1px;overflow:hidden}@media(min-width:768px){[data-root-compose-mobile-recents]{display:none}}
      </style></head><body><header>New thread · marked native-shell fixture</header><main data-fixture-home data-testid="root-compose-compact-home"><div data-fixture-viewport><div data-fixture-leading></div><div data-fixture-column><section data-root-compose-mobile-recents aria-label="Native Recent fixture"><h2>Recent</h2><ol>${Array.from({ length: 1685 }, (_, i) => `<li>Recent thread ${i + 1}</li>`).join("")}</ol></section><section data-fixture-home-slot><h2>Templates</h2></section></div><div data-fixture-bottom></div></div><div data-fixture-dock><div data-fixture-fade aria-hidden="true"></div><textarea aria-label="Native freeform fixture">Native draft sentinel</textarea></div></main><main data-fixture-settings hidden><div data-fixture-settings-slot></div></main><div data-fixture-other-list>Unrelated native list</div><script type="module" src="/${basename(script.path)}"></script></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    });
    resources.server = server;
    hooks.acquired?.(resources);
    const browser = resources.browser = await (hooks.launch ? hooks.launch() : chromium.launch({ headless: true }));
    hooks.acquired?.(resources);
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      }),
      page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const recent = page.locator("[data-root-compose-mobile-recents]"),
      card = page.getByRole("button", { name: /PR Review/ }),
      freeform = page.getByRole("textbox", { name: "Native freeform fixture" }),
      viewport = page.locator("[data-fixture-viewport]");
    const visibleRecent = async () =>
      expect(
        await recent.evaluate((element) => getComputedStyle(element).display),
      ).not.toBe("none");
    const hiddenRecent = async () => await browserExpect(recent).toBeHidden();
    const endGeometry: unknown[] = [];
    const checkScrollEnd = async (target: Locator, kind: string) => {
      await viewport.hover({ position: { x: 8, y: 8 } });
      await page.mouse.wheel(0, 1_000_000);
      await browserExpect
        .poll(() =>
          viewport.evaluate(
            (element) =>
              element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThan(1);
      const box = await target.boundingBox(),
        fade = await page.locator("[data-fixture-fade]").boundingBox(),
        area = await viewport.boundingBox();
      const hit = await target.evaluate((element) => {
        const box = element.getBoundingClientRect(),
          hit = document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          );
        return !!hit && (hit === element || element.contains(hit));
      });
      expect(box!.y).toBeGreaterThanOrEqual(area!.y);
      expect(fade!.y - (box!.y + box!.height)).toBeGreaterThanOrEqual(15.5);
      expect(hit).toBe(true);
      endGeometry.push({
        kind,
        viewport: page.viewportSize(),
        box,
        fade,
        clearance: fade!.y - (box!.y + box!.height),
        hit,
        scrollTop: await viewport.evaluate((element) => element.scrollTop),
      });
      await page.screenshot({
        path: join(
          artifacts,
          `end-${kind}-${page.viewportSize()!.width}x${page.viewportSize()!.height}.png`,
        ),
      });
    };
    await page.goto(`http://127.0.0.1:${server.port}`);
    await card.waitFor({ state: "attached" });
    await page.locator(".ntt-gallery").waitFor();
    const before = await card.boundingBox();
    expect(before!.y).toBeGreaterThan(100000);
    await page.screenshot({ path: join(artifacts, "before-mobile.png") });
    await Bun.write(
      join(artifacts, "before.json"),
      JSON.stringify(
        {
          productComponents: true,
          nativeShell: false,
          card: before,
          recentRows: await recent.locator("li").count(),
          styleCount: await page
            .locator("style[data-new-thread-templates-mobile-layout]")
            .count(),
        },
        null,
        2,
      ),
    );
    const scrollBefore = await viewport.evaluate(
      (element) => element.scrollTop,
    );
    await page.evaluate(() => window.mobileTemplatesHarness.enable());
    await browserExpect
      .poll(() =>
        recent.evaluate((element) => getComputedStyle(element).display),
      )
      .toBe("none");
    // Record immediate reachability BEFORE click/trial/scrollIntoView can scroll.
    const after = await card.boundingBox(),
      dock = await page.locator("[data-fixture-dock]").boundingBox();
    const immediateHit = await card.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const target = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return (
        target !== null && (target === element || element.contains(target))
      );
    });
    const scrollAfter = await viewport.evaluate((element) => element.scrollTop);
    expect(after!.y).toBeGreaterThanOrEqual(0);
    expect(after!.y + after!.height / 2).toBeLessThan(dock!.y);
    expect(immediateHit).toBe(true);
    expect(scrollAfter).toBe(scrollBefore);
    expect(scrollAfter).toBe(0);
    await card.click({ trial: true, timeout: 1500 });
    expect(await recent.locator("li").count()).toBe(1685);
    expect(
      await page
        .locator("[data-fixture-leading]")
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBe(368);
    await freeform.fill("Independent native draft");
    await page.screenshot({ path: join(artifacts, "after-mobile.png") });
    // This marked shell includes a native-like fade. Geometry is fixture proof,
    // separate from the steward's retained actual native fade captures.
    for (const size of [
      { width: 390, height: 844 },
      { width: 360, height: 640 },
    ]) {
      await page.setViewportSize(size);
      await checkScrollEnd(page.locator(".ntt-card").last(), "chooser");
      await card.click();
      await page.getByLabel(/Pull request URL/).waitFor();
      await browserExpect(
        page.locator("[data-new-thread-templates-form]"),
      ).toHaveAttribute("data-new-thread-templates-form", "usable");
      await checkScrollEnd(page.locator(".ntt-footer"), "form-footer");
      await page.getByRole("button", { name: "‹ All templates" }).click();
      await card.waitFor();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    // Loading, initial personal-input failure and cold context failure all keep
    // the selected Back/recovery surface ahead of the unchanged long Recent.
    const inputLoads = fixture.wire.holdLoads();
    fixture.flags.contextError = true;
    fixture.wire.failNextLoads(1);
    try {
      await card.click();
      await inputLoads.reached;
      await browserExpect(
        page.getByRole("heading", { name: "PR Review" }),
      ).toBeFocused();
      await hiddenRecent();
      await browserExpect(
        page.locator("[data-new-thread-templates-form]"),
      ).toHaveAttribute("data-new-thread-templates-form", "recovery");
      const back = page.getByRole("button", { name: "‹ All templates" }),
        box = await back.boundingBox(),
        fade = await page.locator("[data-fixture-fade]").boundingBox();
      expect(box!.y + box!.height).toBeLessThan(fade!.y);
      expect(
        await back.evaluate((element) => {
          const box = element.getBoundingClientRect(),
            hit = document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
          return !!hit && (hit === element || element.contains(hit));
        }),
      ).toBe(true);
    } finally {
      inputLoads.release();
    }
    await page.getByLabel(/Pull request URL/).waitFor();
    await page.getByRole("button", { name: "Reconnect inputs" }).waitFor();
    await page.getByText(/Destination choices could not refresh/).waitFor();
    await hiddenRecent();
    expect(
      await page.getByRole("button", { name: "Start thread" }).isDisabled(),
    ).toBe(true);
    await page.getByRole("button", { name: "Reconnect inputs" }).click();
    fixture.flags.contextError = false;
    await page.evaluate(() => window.mobileTemplatesHarness.emit());
    await browserExpect(
      page.locator("[data-new-thread-templates-form]"),
    ).toHaveAttribute("data-new-thread-templates-form", "usable");
    await hiddenRecent();
    // Selected pinned form remains useful after authoritative empty catalog, until Back.
    const publications = fixture.entries.map((entry) => entry.published);
    for (const entry of fixture.entries) entry.published = null;
    await page.evaluate(() => window.mobileTemplatesHarness.emit());
    await hiddenRecent();
    await page.getByRole("button", { name: "‹ All templates" }).click();
    await page.getByText("No published templates yet.").waitFor();
    await visibleRecent();
    publications.forEach(
      (publication, index) => (fixture.entries[index]!.published = publication),
    );
    await page.evaluate(() => window.mobileTemplatesHarness.emit());
    await card.waitFor({ state: "attached" });
    await hiddenRecent();
    // Error with last-good published entries keeps cards and error reachable; same snapshot recovers.
    fixture.flags.catalogError = true;
    await page.evaluate(() => window.mobileTemplatesHarness.emit());
    await page.getByText(/Templates could not refresh/).waitFor();
    await hiddenRecent();
    fixture.flags.catalogError = false;
    await page.evaluate(() => window.mobileTemplatesHarness.emit());
    await page
      .getByText(/Templates could not refresh/)
      .waitFor({ state: "hidden" });
    await hiddenRecent();
    await page.evaluate(() =>
      window.mobileTemplatesHarness.replaceWithStaleCleanup(),
    );
    expect(
      await page
        .locator("style[data-new-thread-templates-mobile-layout]")
        .count(),
    ).toBe(1);
    await hiddenRecent();
    await page.evaluate(() => window.mobileTemplatesHarness.disable());
    expect(
      await page
        .locator("style[data-new-thread-templates-mobile-layout]")
        .count(),
    ).toBe(0);
    await visibleRecent();
    await page.evaluate(() => window.mobileTemplatesHarness.enable());
    await hiddenRecent();
    // A stylesheet mounted on Settings applies after route change without observers.
    await page.evaluate(() => window.mobileTemplatesHarness.mount("settings"));
    await page.getByRole("button", { name: "+ New template" }).waitFor();
    expect(
      await page.locator("[data-new-thread-templates-homepage]").count(),
    ).toBe(0);
    await page.evaluate(() => window.mobileTemplatesHarness.mount());
    await card.waitFor({ state: "attached" });
    await hiddenRecent();
    expect(await freeform.inputValue()).toBe("Independent native draft");
    // Root/native-marker compatibility fails closed; no other list/spacer is styled.
    await page
      .locator("[data-testid=root-compose-compact-home]")
      .evaluate((element) => element.removeAttribute("data-testid"));
    await visibleRecent();
    await page
      .locator("[data-fixture-home]")
      .evaluate((element) =>
        element.setAttribute("data-testid", "root-compose-compact-home"),
      );
    await hiddenRecent();
    await recent.evaluate((element) => {
      element.removeAttribute("data-root-compose-mobile-recents");
      element.setAttribute("data-fixture-recent", "old");
    });
    expect(
      await page
        .locator("[data-fixture-recent]")
        .evaluate((element) => getComputedStyle(element).display),
    ).not.toBe("none");
    await page
      .locator("[data-fixture-recent]")
      .evaluate((element) =>
        element.setAttribute("data-root-compose-mobile-recents", ""),
      );
    await hiddenRecent();
    expect(
      await page
        .locator("[data-fixture-other-list]")
        .evaluate((element) => getComputedStyle(element).display),
    ).toBe("block");
    // Width boundary preserves desktop and uses only native mobile breakpoint.
    await page.setViewportSize({ width: 768, height: 844 });
    const desktopBefore = await card.boundingBox();
    await page.evaluate(() => window.mobileTemplatesHarness.disable());
    expect(await card.boundingBox()).toEqual(desktopBefore);
    await page.evaluate(() => window.mobileTemplatesHarness.enable());
    expect(await card.boundingBox()).toEqual(desktopBefore);
    await page.setViewportSize({ width: 767, height: 844 });
    await hiddenRecent();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.mobileTemplatesHarness.unmount());
    await visibleRecent();
    const releaseCatalog = fixture.holdResponse("publishedCatalog");
    try {
      await page.evaluate(() => window.mobileTemplatesHarness.mount());
      await browserExpect(card).toBeVisible();
      await browserExpect(card).toBeDisabled();
      await page.getByText("Checking templates…", { exact: true }).waitFor();
      await hiddenRecent();
    } finally {
      releaseCatalog();
    }
    await browserExpect(card).toBeEnabled();
    await page.evaluate(() => window.mobileTemplatesHarness.unmount());
    fixture.flags.catalogError = true;
    await page.evaluate(() => window.mobileTemplatesHarness.mount());
    await page.getByText(/Templates could not refresh/).waitFor();
    // Trusted last-good published cards remain reachable but advisory only.
    await browserExpect(card).toBeDisabled();
    await hiddenRecent();
    // A genuine no-good reload has no advisory publication and restores Recent.
    await page.evaluate(() => window.mobileTemplatesHarness.unmount());
    await page.reload();
    await page.getByText(/Templates could not refresh/).waitFor();
    await page.evaluate(() => window.mobileTemplatesHarness.enable());
    await visibleRecent();
    fixture.flags.catalogError = false;
    await page.evaluate(() => window.mobileTemplatesHarness.emit());
    await card.waitFor({ state: "attached" });
    await hiddenRecent();
    identityUnavailable = true;
    await page.reload();
    await page.waitForFunction(() => !!window.mobileTemplatesHarness);
    await page.evaluate(() => window.mobileTemplatesHarness.enable());
    await visibleRecent();
    expect(
      await page
        .locator('[data-new-thread-templates-homepage="usable"]')
        .count(),
    ).toBe(0);
    identityUnavailable = false;
    await page.reload();
    await card.waitFor({ state: "attached" });
    await page.evaluate(() => window.mobileTemplatesHarness.enable());
    await hiddenRecent();
    await page.evaluate(() => window.mobileTemplatesHarness.disable());
    await visibleRecent();
    expect(fixture.flags.launchCount).toBe(0);
    expect(errors).toEqual([]);
    await Bun.write(
      join(artifacts, "result.json"),
      JSON.stringify(
        {
          productComponents: true,
          nativeShell: false,
          longRecentRows: 1685,
          beforeCard: before,
          afterCard: after,
          immediateHit,
          scrollBefore,
          scrollAfter,
          freeformIndependent: true,
          endGeometry,
          selectedLoadingAndRecoveryReachable: true,
          launches: fixture.flags.launchCount,
          pageErrors: errors,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    try { await cleanupMobileResources(resources); }
    catch (cleanupError) {
      if (!primaryFailed) throw cleanupError;
      console.error("Mobile cleanup also failed after the primary error:", cleanupError);
    }
  }
}
