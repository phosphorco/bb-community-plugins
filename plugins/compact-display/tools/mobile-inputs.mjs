// Live integration probe. See ../README.md for setup and iOS coverage limits.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href
  : "playwright-core");
const base = process.env.BB_URL;
const thread = process.env.BB_TEST_THREAD;
assert.ok(base && thread && process.env.BB_EVIDENCE_DIR && process.env.CHROME_EXECUTABLE,
  "Set BB_URL, BB_TEST_THREAD, BB_EVIDENCE_DIR, and CHROME_EXECUTABLE");
const out = resolve(process.env.BB_EVIDENCE_DIR);
await mkdir(out, { recursive: true });
const sheetSelector = "style[data-bb-compact-display]";
const typing = 'input:not([type="button"], [type="checkbox"], [type="color"], [type="file"], [type="hidden"], [type="image"], [type="radio"], [type="range"], [type="reset"], [type="submit"]), textarea, select, [contenteditable=""], [contenteditable="true" i], [contenteditable="plaintext-only" i]';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE,
  headless: true,
  args: ["--no-sandbox"],
});
const results = { engine: "Chromium emulation; no native iOS keyboard", browser: browser.version(), cases: [] };
let activePage;
try {
  for (const scenario of [
    { name: "phone", width: 390, height: 844, touch: true },
    { name: "touch-landscape", width: 844, height: 390, touch: true },
    { name: "narrow-fine-pointer", width: 767, height: 844, touch: false },
    { name: "desktop", width: 1280, height: 900, touch: false },
  ]) {
    if (process.env.BB_TEST_SCENARIOS && !process.env.BB_TEST_SCENARIOS.split(",").includes(scenario.name)) continue;
    const mobileRule = scenario.touch || scenario.width < 768;
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.height },
      isMobile: scenario.touch,
      hasTouch: scenario.touch,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(15000);
    const record = { scenario, routes: [], geometry: [], errors: [] };
    page.on("pageerror", error => record.errors.push(String(error)));
    page.on("response", response => {
      if (response.status() >= 400 && new URL(response.url()).origin === new URL(base).origin)
        record.errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    results.cases.push(record);
    for (const route of [`/threads/${encodeURIComponent(thread)}`, "/settings/general", "/settings/appearance"]) {
      await page.goto(new URL(route, base).href, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes("font-size: max(16px, 1em)"), sheetSelector, { timeout: 30000 });
      // Let native route content mount after the plugin bundle is ready.
      if (route.startsWith("/threads/")) await page.locator("#thread-detail-follow-up-composer").waitFor();
      else await page.getByRole("combobox", { name: "Search settings", exact: true }).waitFor();
      await page.waitForTimeout(1200);
      assert.equal(await page.locator(".tb-full").count(), 0,
        "Choose a thread without an open full Thread Brief overlay so the composer is reachable");
      const fields = await page.locator(typing).evaluateAll(elements => elements
        .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden")
        .map(e => ({ tag: e.tagName, type: e.getAttribute("type"), label: e.getAttribute("aria-label"), fontSize: parseFloat(getComputedStyle(e).fontSize) })));
      if (mobileRule) for (const field of fields) assert.ok(field.fontSize >= 16, `${scenario.name} ${route}: ${JSON.stringify(field)}`);
      record.routes.push({ route, fields });

      if (!route.startsWith("/threads/") || scenario.name !== "phone") continue;
      const editor = page.locator("#thread-detail-follow-up-composer");
      const capture = async stage => {
        record.geometry.push({ stage, ...await editor.evaluate(e => {
          const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
          const scroller = e.closest(".thread-scrollbar");
          return { focused: document.activeElement === e, fontSize: getComputedStyle(e).fontSize,
            expanded: !!e.closest("[data-follow-up-composer-expanded]"),
            editor: rect(e), composer: rect(e.closest("form")), pageScrollY: scrollY,
            viewport: { width: innerWidth, height: innerHeight, visualHeight: visualViewport.height, offsetTop: visualViewport.offsetTop, scale: visualViewport.scale },
            scroller: scroller && { ...rect(scroller), scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight } };
        }) });
        if (stage.endsWith("after-tap")) assert.equal(record.geometry.at(-1).focused, true,
          "Composer lost focus before capture; an overlay or late mount may have intercepted the tap");
        await page.screenshot({ path: `${out}/${scenario.name}-${stage}.png` });
      };
      await capture("before-tap");
      const box = await editor.boundingBox();
      // A real touch event at a measured point; no forced focus or DOM click.
      await page.touchscreen.tap(box.x + 20, box.y + box.height / 2);
      await page.waitForFunction(() => document.activeElement?.id === "thread-detail-follow-up-composer");
      // BB waits for keyboard viewport changes, then uses a delayed fallback
      // in headless Chromium, which has no native software keyboard.
      await page.waitForFunction(() => !!document.querySelector("#thread-detail-follow-up-composer")?.closest("[data-follow-up-composer-expanded]"));
      await page.waitForTimeout(350);
      await capture("after-tap");
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.synthesizeScrollGesture", { x: 190, y: 300, yDistance: 300, speed: 800, gestureSourceType: "touch" });
      await cdp.detach();
      await page.waitForTimeout(350);
      await capture("after-touch-scroll");
      // Chromium may acknowledge a synthesized touch gesture without moving
      // the scroller. Record that attempt, then exercise wheel scrolling too.
      await page.mouse.move(190, 300);
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(350);
      await capture("after-wheel-scroll");
      const scrolled = record.geometry.at(-1).scroller;
      assert.ok(scrolled.scrollHeight - scrolled.height - scrolled.scrollTop > 50,
        "Use a thread long enough to exercise scrolling away from the bottom");
      await editor.evaluate(e => e.blur());

      if (process.env.BB_RELOAD_CHECK === "1") {
        await page.evaluate(selector => { window.__compactPreviousSheet = document.querySelector(selector); }, sheetSelector);
        execFileSync("bb", ["plugin", "reload", "compact-display", "--json"], { stdio: "pipe" });
        await page.waitForFunction(selector => {
          const sheets = document.querySelectorAll(selector);
          return sheets.length === 1 && sheets[0].textContent.includes("font-size: max(16px, 1em)");
        }, sheetSelector);
        // BB may retain the mounted app when its bundle hash is unchanged.
        record.reload = await page.locator(sheetSelector).evaluate(e => ({
          stylesheetCount: document.querySelectorAll("style[data-bb-compact-display]").length,
          reusedUnchangedBundle: e === window.__compactPreviousSheet,
        }));
      }

      // Compare the movement with all compact overrides disabled only in this
      // test page, using a fresh mount to restore the collapsed composer.
      await page.reload({ waitUntil: "domcontentloaded" });
      await editor.waitFor();
      await page.waitForFunction(selector => !!document.querySelector(selector)?.sheet, sheetSelector);
      await page.locator(sheetSelector).evaluate(e => { e.sheet.disabled = true; });
      await page.waitForTimeout(400);
      await capture("native-control-before-tap");
      const controlBox = await editor.boundingBox();
      await page.touchscreen.tap(controlBox.x + 20, controlBox.y + controlBox.height / 2);
      await page.waitForFunction(() => document.activeElement?.id === "thread-detail-follow-up-composer");
      await page.waitForFunction(() => !!document.querySelector("#thread-detail-follow-up-composer")?.closest("[data-follow-up-composer-expanded]"));
      await page.waitForTimeout(350);
      await capture("native-control-after-tap");
      await editor.evaluate(e => e.blur());
      await page.locator(sheetSelector).evaluate(e => { e.sheet.disabled = false; });
    }

    // Late-mounted control fixtures expose gaps that native forms may already
    // cover. These are browser-only elements, not a BB form or saved content.
    await page.evaluate(() => {
      const fixture = document.createElement("section");
      fixture.id = "mobile-input-size-fixture";
      fixture.style.cssText = "position:fixed;inset:60px 10px auto;z-index:2147483647;background:var(--background);padding:12px;font-size:14px";
      fixture.textContent = "Synthetic typing control fixtures (not native BB UI)";
      for (const type of ["text", "search", "email", "password", "number", "tel", "url", "date", "time", "datetime-local", "month", "week"]) {
        const e = document.createElement("input"); e.type = type; e.style.fontSize = "12px"; e.setAttribute("aria-label", type); fixture.append(e);
      }
      for (const tag of ["textarea", "select", "div"]) {
        const e = document.createElement(tag); e.style.fontSize = "12px";
        if (tag === "div") e.contentEditable = "true";
        e.setAttribute("aria-label", tag); fixture.append(e);
      }
      for (const value of ["", "plaintext-only"]) {
        const e = document.createElement("div"); e.setAttribute("contenteditable", value); e.style.fontSize = "12px"; fixture.append(e);
      }
      const large = document.createElement("div"); large.style.fontSize = "24px";
      const inherited = document.createElement("textarea"); inherited.style.fontSize = "inherit"; large.append(inherited); fixture.append(large);
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.style.fontSize = "12px"; fixture.append(checkbox);
      document.body.append(fixture);
    });
    const fixtures = page.locator("#mobile-input-size-fixture").locator(typing);
    const sizes = () => fixtures.evaluateAll(es => es.map(e => parseFloat(getComputedStyle(e).fontSize)));
    const enabled = await sizes();
    if (mobileRule) for (const size of enabled) assert.ok(size >= 16);
    assert.equal(enabled.at(-1), 24, "larger inherited text is preserved");
    assert.equal(await page.locator('#mobile-input-size-fixture [type="checkbox"]').evaluate(e => getComputedStyle(e).fontSize), "12px");
    // Negative control changes only this browser document, not server settings.
    await page.locator(sheetSelector).evaluate(e => { e.sheet.disabled = true; });
    const disabled = await sizes();
    assert.ok(disabled.some(size => size === 12), "fixture detects undersized controls without the plugin");
    await page.locator(sheetSelector).evaluate(e => { e.sheet.disabled = false; });
    assert.deepEqual(await sizes(), enabled);
    if (!mobileRule) assert.deepEqual(enabled, disabled, "desktop typing sizes are unchanged");
    await fixtures.first().fill("Disposable browser fixture");
    assert.ok(await fixtures.first().evaluate(e => document.activeElement === e));
    if (mobileRule) assert.ok(await fixtures.first().evaluate(e => parseFloat(getComputedStyle(e).fontSize) >= 16));
    record.fixtures = { enabled, disabled };
    await page.locator("#mobile-input-size-fixture").evaluate(e => e.remove());
    await context.close();
    console.log(`PASS ${scenario.name}: ${record.routes.length} routes and ${enabled.length} control fixtures`);
  }
} catch (error) {
  results.error = String(error.stack || error);
  if (activePage && !activePage.isClosed()) {
    try {
      results.failure = await activePage.evaluate(() => ({ url: location.href,
        stylesheetCount: document.querySelectorAll("style[data-bb-compact-display]").length,
        bodyText: document.body.innerText.slice(0, 2000) }));
      await activePage.screenshot({ path: `${out}/failure.png`, timeout: 5000 });
    } catch (captureError) { results.captureError = String(captureError); }
  }
  throw error;
} finally {
  await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2) + "\n");
  await browser.close();
}
