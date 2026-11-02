/** Browser reload cut after real personal save, before synthetic server launch dispatch. */
import { expect } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appFixture } from "./app-fixture.ts";
import { launchRequestSchema, type LaunchRequest } from "../rpc-contract.ts";

export async function browserSavedRequestRecovery() {
  const fixture = await appFixture(`browser-recovery-${crypto.randomUUID()}`),
    scratch = await mkdtemp(join(tmpdir(), "templates-recovery-")),
    artifacts = join(
      process.env.BB_THREAD_STORAGE ?? "/tmp/templates-browser-evidence",
      "templates-recovery",
    );
  await mkdir(artifacts, { recursive: true });
  const built = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "browser-mobile-build.ts"),
      scratch,
      "product",
    ],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  if (built.exitCode !== 0)
    throw new Error(new TextDecoder().decode(built.stderr));
  const bundle = JSON.parse(new TextDecoder().decode(built.stdout)) as {
    script: string;
    css: string | null;
  };
  let cut = false,
    captured: LaunchRequest | null = null;
  const held = new Set<() => void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/rpc/")) {
        try {
          const method = decodeURIComponent(url.pathname.slice(5)),
            input = await request.json();
          if (method === "launch" && cut) {
            captured = launchRequestSchema.parse(input);
            return await new Promise<Response>((resolve) => {
              const release = () => {
                held.delete(release);
                resolve(
                  Response.json(
                    { error: "Fixture request cut before launch handler" },
                    { status: 503 },
                  ),
                );
              };
              held.add(release);
            });
          }
          const handler = fixture.handlers[method];
          if (!handler) throw new Error(`Unknown ${method}`);
          return Response.json(await handler(input));
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          );
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
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${bundle.css ? `<link rel="stylesheet" href="/${basename(bundle.css)}">` : ""}<style>:root{--background:#171922;--foreground:#d4d5e2;--muted-foreground:#a1a4bb;--border:#373a4c;--primary:#b7a3ed;--primary-foreground:#191529}body{font:14px system-ui;margin:24px;max-width:900px;background:var(--background);color:var(--foreground)}</style></head><body><script type="module" src="/${basename(bundle.script)}"></script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true }),
    page = await browser.newPage({ viewport: { width: 1100, height: 900 } }),
    errors: string[] = [],
    evidence: unknown[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.port}`);
    for (const native of [false, true]) {
      await page.getByRole("button", { name: /PR Review/ }).click();
      await page
        .getByLabel(/Pull request URL/)
        .fill(`https://example.test/pull/${native ? "native" : "direct"}`);
      await page
        .getByLabel(/Main change or review goal/)
        .fill(native ? "Native saved checkpoint" : "Direct saved checkpoint");
      await browserExpect(
        page.getByRole("button", { name: "Edit with BB" }),
      ).toBeEnabled();
      cut = true;
      captured = null;
      const before = fixture.flags.launchCount;
      if (native) {
        const edit = page.getByRole("button", { name: "Edit with BB" });
        await browserExpect(edit).toBeEnabled();
        await edit.click();
        await page
          .getByTestId("bb-new-thread-composer-input")
          .fill("Exact native text saved before dispatch");
        await page.getByTestId("bb-new-thread-composer-submit").click();
      } else await page.getByRole("button", { name: "Start thread" }).click();
      await browserExpect.poll(() => captured).not.toBeNull();
      const original = structuredClone(captured!);
      const personal = await fixture.readPersonal();
      expect(personal?.launchCheckpoint).toEqual({
        version: 1,
        request: original,
      });
      expect(fixture.flags.launchCount).toBe(before);
      expect(fixture.launches.has(original.operationId)).toBe(false);
      // Lose the entire old browser lifecycle before its held request can return.
      fixture.wire.switchActor("ada");
      await page.reload();
      cut = false;
      for (const release of [...held]) release();
      await page.getByRole("button", { name: /PR Review/ }).click();
      const resume = page.getByRole("button", { name: "Resume saved request" });
      await browserExpect(resume).toBeEnabled();
      await page.screenshot({
        path: join(artifacts, `${native ? "native" : "direct"}-restored.png`),
      });
      await resume.click();
      await browserExpect
        .poll(
          () =>
            fixture.calls.filter(
              (call) =>
                call.method === "resumeLaunch" &&
                (call.input as { checkpoint: { request: LaunchRequest } })
                  .checkpoint.request.operationId === original.operationId,
            ).length,
        )
        .toBe(1);
      await browserExpect
        .poll(async () => (await fixture.readPersonal())?.operationId)
        .toBeUndefined();
      await browserExpect
        .poll(async () =>
          (
            (await page.evaluate(() => window.templatesHarness.stats())) as {
              navigation: { method: string }[];
            }
          ).navigation.some((call) => call.method === "toThread"),
        )
        .toBe(true);
      const resumed = fixture.calls.find(
        (call) =>
          call.method === "resumeLaunch" &&
          (call.input as { checkpoint: { request: LaunchRequest } }).checkpoint
            .request.operationId === original.operationId,
      )!.input as {
        checkpoint: { request: LaunchRequest };
        expectedActor: string;
        expectedSession: string;
      };
      expect(resumed.checkpoint.request).toEqual(original);
      expect(resumed.expectedActor).toBe(original.expectedActor);
      expect(resumed.expectedSession).not.toBe(original.expectedSession);
      expect(fixture.flags.launchCount).toBe(before + 1);
      expect((await fixture.readPersonal())?.launchCheckpoint).toBeUndefined();
      evidence.push({
        native,
        operationId: original.operationId,
        exactSnapshot: true,
        freshOriginalActorSession: true,
        serverDispatches: fixture.flags.launchCount - before,
      });
      await page.getByRole("button", { name: "‹ All templates" }).click();
    }
    expect(errors).toEqual([]);
    await Bun.write(
      join(artifacts, "result.json"),
      JSON.stringify(
        {
          productComponents: true,
          nativeShell: false,
          providerAndLaunchResponses: "synthetic",
          realIdentityWire: true,
          reloadBothPaths: evidence,
          pageErrors: errors,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const release of [...held]) release();
    await browser.close();
    server.stop(true);
    await fixture.dispose();
    await rm(scratch, { recursive: true, force: true });
  }
}
