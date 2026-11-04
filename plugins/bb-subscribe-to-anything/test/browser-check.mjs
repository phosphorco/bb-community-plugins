import { chromium } from "@playwright/test";
import { readFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root = process.cwd(),
  scratch = await mkdtemp(join(tmpdir(), "subscriptions-ui-browser-")),
  out = process.env.SUBSCRIPTIONS_BROWSER_OUTPUT ||
    await mkdtemp(join(tmpdir(), "subscriptions-ui-artifacts-"));
await mkdir(out, { recursive: true });
const build = await Bun.build({
  entrypoints: [join(root, "test/browser-app.tsx")],
  outdir: scratch,
  target: "browser",
  define: { "process.env.NODE_ENV": '"development"' },
});
if (!build.success) throw new Error(build.logs.join("\n"));
const js = build.outputs.find((v) => v.kind === "entry-point");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/app.js")
      return new Response(await readFile(js.path), {
        headers: { "content-type": "text/javascript" },
      });
    if (path === "/app.css")
      return new Response(await readFile(join(root, "dist/app.css")), {
        headers: { "content-type": "text/css" },
      });
    return new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>:root{--spacing:.25rem;--radius:.5rem;--text-xs:.75rem;--text-sm:.875rem;--font-weight-medium:500;--background:#15171c;--foreground:#e2e4eb;--muted:#242831;--muted-foreground:#a9b0c0;--primary:#c2b3ff;--primary-foreground:#201932;--border:#363b46;--input:#363b46;--ring:#c2b3ff;--destructive:#ffb2b2;--destructive-foreground:#331010;--state-hover:#303540;--state-active:#343b48}*{box-sizing:border-box}body{margin:0;font-family:system-ui}button,input,select{font:inherit;color:inherit;background:transparent;border:0}</style></head><body><script type="module" src="/app.js"></script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
let browser;
const errors = [];
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.getByText("Release PR #482", { exact: true }).waitFor();
  await page.screenshot({
    path: join(out, "overview-dark.png"),
    fullPage: true,
  });
  await page.evaluate(() =>
    window.subscriptionsHarness.mount(false, "deployment"),
  );
  await page.getByRole("heading", { name: "Production deployment" }).waitFor();
  await page.locator(".sub-run summary").first().click();
  await page.screenshot({ path: join(out, "detail-dark.png"), fullPage: true });
  await page.evaluate(() => window.subscriptionsHarness.mount(true));
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByText("Release PR #482", { exact: true }).waitFor();
  await page.getByText("Production deployment", { exact: true }).click();
  await page.getByRole("heading", { name: "Production deployment" }).waitFor();
  await page.screenshot({
    path: join(out, "panel-narrow.png"),
    fullPage: true,
  });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("Horizontal overflow at 390px");
  await page
    .getByRole("button", { name: "Cancel subscription", exact: true })
    .click();
  await page.getByRole("button", { name: "Keep watching" }).click();
  await page.evaluate(() => {
    const s = document.documentElement.style;
    s.setProperty("--background", "#ffffff");
    s.setProperty("--foreground", "#202329");
    s.setProperty("--muted", "#f0f2f5");
    s.setProperty("--muted-foreground", "#555f70");
    s.setProperty("--primary", "#5942a0");
    s.setProperty("--border", "#cbd0d8");
    s.setProperty("--ring", "#5942a0");
    s.setProperty("--destructive", "#a22323");
  });
  await page.screenshot({ path: join(out, "panel-light.png"), fullPage: true });
  await page.evaluate(() => {
    const s = document.documentElement.style;
    s.setProperty("--background", "#071c1a");
    s.setProperty("--foreground", "#e4f5ed");
    s.setProperty("--muted", "#13302c");
    s.setProperty("--muted-foreground", "#b0c9bf");
    s.setProperty("--primary", "#9ee2b8");
    s.setProperty("--border", "#34554b");
    s.setProperty("--ring", "#9ee2b8");
  });
  await page.screenshot({
    path: join(out, "panel-custom.png"),
    fullPage: true,
  });
  // Healthy idle does not refetch on a clock tick. Wait past realtime mount coalescing.
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => window.subscriptionsHarness.stats());
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => window.subscriptionsHarness.stats());
  if (after !== before) throw new Error("Unexpected idle RPC");
  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => document.activeElement?.tagName);
  if (!focus) throw new Error("No keyboard focus");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    JSON.stringify({
      passed: true,
      errors,
      idleRpcDelta: after - before,
      screenshots: out,
    }),
  );
} finally {
  await browser?.close();
  server.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
