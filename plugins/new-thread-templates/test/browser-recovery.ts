/** Browser reload cut after real personal save, before synthetic server launch dispatch. */
import { expect } from "bun:test";
import { expect as browserExpect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appFixture } from "./app-fixture.ts";
import { launchRequestSchema, type LaunchRequest } from "../rpc-contract.ts";

import { acquireOwnedBrowser } from "./browser-owned.ts";
import { cleanupPromptFixture } from "./browser-prompt-cleanup.ts";

/** Closed synthetic sideband schema; never accepts product RPC inputs/results. */
function isRecoveryDiagnostic(value: unknown, run: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fact = value as Record<string, unknown>;
  const common = ["run", "doc", "seq", "at", "elapsedMs", "kind"];
  if (fact.run !== run || typeof fact.doc !== "string" ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(fact.doc) ||
      !Number.isSafeInteger(fact.seq) || (fact.seq as number) < 1 || (fact.seq as number) > 64 ||
      !Number.isSafeInteger(fact.at) || (fact.at as number) < 1 ||
      typeof fact.elapsedMs !== "number" || !Number.isFinite(fact.elapsedMs) ||
      fact.elapsedMs < 0 || fact.elapsedMs > 120000) return false;
  let keys: string[];
  if (fact.kind === "rpc") {
    keys = [...common, "method", "stage", "call", "status"];
    if (!["bb-identity.v1.state.load", "recentLaunches", "launchStatus"].includes(fact.method as string) ||
        !["headers", "json-complete", "adapter-return"].includes(fact.stage as string) ||
        !Number.isSafeInteger(fact.call) || (fact.call as number) < 1 || (fact.call as number) > 64 ||
        !Number.isSafeInteger(fact.status) || (fact.status as number) < 100 || (fact.status as number) > 599) return false;
  } else if (fact.kind === "exposure") {
    keys = [...common, "n", "r", "f"];
    const n = fact.n, r = fact.r, f = fact.f;
    if (!Array.isArray(n) || n.length !== 10 ||
        !n.every((x) => Number.isSafeInteger(x) && x >= 0 && x <= 512) || n[9] > 7 ||
        !Array.isArray(r) || r.length > 4 || !Array.isArray(f) || f.length > 4 ||
        n[1] > n[0] || n[2] + n[3] > n[0] ||
        n[4] !== Math.max(0, n[1] - 8) ||
        r.length !== Math.min(4, n[2]) || f.length !== Math.min(4, n[3]) ||
        n[5] !== n[2] - r.length || n[6] !== n[3] - f.length) return false;
    for (const candidate of [...r, ...f]) {
      if (!Array.isArray(candidate) || candidate.length !== 7 ||
          !candidate.every(Number.isSafeInteger)) return false;
      const [marker, role, name, mask, box, depth, visibility] = candidate;
      if (marker < 1 || marker > 9 || role < 0 || role > 2 || name < 0 || name > 2 ||
          mask < 0 || mask > 1023 || box < 0 || box > 15 || depth < 1 || depth > 32 ||
          visibility < 0 || visibility > 3 ||
          ((mask & 32) !== 0 && depth !== 32) ||
          ((mask & 128) !== 0) !== (name === 0) ||
          ((mask & 256) !== 0) !== (role === 0)) return false;
    }
  } else return false;
  const actual = Object.keys(fact);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

export async function browserSavedRequestRecovery() {
  const artifacts = join(
    process.env.BB_THREAD_STORAGE ?? "/tmp/templates-browser-evidence",
    "templates-recovery",
  );
  let phaseReady = false;
  const steps: { name: string; run(): Promise<unknown> | unknown }[] = [];
  let owned: ReturnType<typeof acquireOwnedBrowser> | undefined;
  const bodyFailure: { failed: boolean; error?: unknown } = { failed: false };
  const held = new Set<() => void>();
  let releaseReason: "after-reload" | "cleanup" = "after-reload";
  const started = performance.now();
  const fixtureRun = crypto.randomUUID();
  let mode: "setup" | "direct" | "native" | "cleanup" = "setup";
  let phaseCount = 0, phaseBytes = 0, tailBytes = 0, dropped = 0;
  const tail: string[] = [];
  const phase = (name: string, detail: Record<string, unknown> = {}) => {
    if (!phaseReady) return;
    try {
      const line = JSON.stringify({
        ...detail,
        fixtureRun,
        ciRun: process.env.GITHUB_RUN_ID ?? null,
        ciAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        at: new Date().toISOString(),
        mode,
        phase: name,
        elapsedMs: performance.now() - started,
      });
      // Bound disk output and the console failure tail, including browser stderr.
      const bytes = Buffer.byteLength(line);
      if (bytes > 8192) { dropped++; return; }
      tail.push(line);
      tailBytes += bytes;
      while (tail.length > 32 || tailBytes > 16384)
        tailBytes -= Buffer.byteLength(tail.shift()!);
      if (phaseCount >= 2048 || phaseBytes + bytes + 1 > 1024 * 1024) {
        dropped++;
        return;
      }
      appendFileSync(join(artifacts, "phases.jsonl"), line + "\n");
      phaseCount++;
      phaseBytes += bytes + 1;
    } catch { dropped++; /* Observability must not replace body/cleanup errors. */ }
  };
  const failureTail = () => {
    try {
      console.error("Saved-request diagnostic tail:", JSON.stringify({
        fixtureRun, mode, dropped, phases: tail.map((line) => JSON.parse(line)),
      }));
    } catch { /* Preserve the original failure. */ }
  };
  const step = async <T>(name: string, action: () => Promise<T>) => {
    phase(`${name}:start`);
    try {
      const value = await action();
      phase(`${name}:done`);
      return value;
    } catch (error) {
      phase(`${name}:error`, {
        error: error instanceof Error ? error.stack : String(error),
      });
      throw error;
    }
  };
  try {
    await mkdir(artifacts, { recursive: true });
    phaseReady = true;
    const fixture = await appFixture(`browser-recovery-${crypto.randomUUID()}`);
    steps.push({ name: "fixture-dispose", run: () => fixture.dispose() });
    const scratch = await mkdtemp(join(tmpdir(), "templates-recovery-"));
    steps.push({
      name: "scratch-remove",
      run: () => rm(scratch, { recursive: true, force: true }),
    });
    phase("build:start");
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
    phase("build:done");
    let cut = false,
      captured: LaunchRequest | null = null;
    let httpSequence = 0;
    let sidebandRequests = 0, sidebandBytes = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        // This route has no access to product handlers, cut requests or saved state.
        if (url.pathname === "/__recovery-diagnostic") {
          if (++sidebandRequests > 256 || sidebandBytes >= 128 * 1024)
            return new Response(null, { status: 429 });
          if (request.method !== "POST" || !request.body)
            return new Response(null, { status: 400 });
          const reader = request.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              bytes += next.value.byteLength;
              sidebandBytes += next.value.byteLength;
              if (bytes > 768 || sidebandBytes > 128 * 1024) {
                void reader.cancel().catch(() => {});
                return new Response(null, { status: 413 });
              }
              chunks.push(next.value);
            }
            const body = new Uint8Array(bytes);
            let offset = 0;
            for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
            const fact: unknown = JSON.parse(new TextDecoder().decode(body));
            if (!isRecoveryDiagnostic(fact, fixtureRun))
              return new Response(null, { status: 400 });
            phase("page:sideband", { fact });
            return new Response(null, { status: 204 });
          } catch {
            return new Response(null, { status: 400 });
          } finally {
            try { reader.releaseLock(); } catch { /* Diagnostic stream only. */ }
          }
        }
        const facts = {
          httpId: ++httpSequence, requestMode: mode,
          path: url.pathname, method: request.method,
        };
        let status: number | null = null, aborted = false;
        let rpcMethod: string | null = null;
        const abort = () => {
          if (!aborted) {
            aborted = true;
            phase("http:aborted", facts);
            if (url.pathname.startsWith("/rpc/"))
              phase("rpc:aborted", { ...facts, rpcMethod });
          }
        };
        request.signal.addEventListener("abort", abort, { once: true });
        phase("http:begin", facts);
        if (request.signal.aborted) abort();
        const response = (value: Response) => { status = value.status; return value; };
        try {
          if (url.pathname.startsWith("/rpc/")) {
            try {
              const method = decodeURIComponent(url.pathname.slice(5));
              rpcMethod = method;
              phase("rpc:begin", { ...facts, rpcMethod });
              const input = await request.json();
              phase("rpc", { method });
              if (method === "launch" && cut) {
                captured = launchRequestSchema.parse(input);
                return await new Promise<Response>((resolve) => {
                  const release = () => {
                    held.delete(release);
                    phase("held:released", { ...facts, reason: releaseReason, remaining: held.size });
                    resolve(
                      response(Response.json(
                        { error: "Fixture request cut before launch handler" },
                        { status: 503 },
                      )),
                    );
                  };
                  held.add(release);
                  phase("held:begin", { ...facts, pending: held.size });
                });
              }
              const handler = fixture.handlers[method];
              if (!handler) throw new Error(`Unknown ${method}`);
              return response(Response.json(await handler(input)));
            } catch (error) {
              phase("rpc:error", { ...facts, rpcMethod, errorType: error instanceof Error ? error.name : typeof error });
              return response(Response.json(
                { error: error instanceof Error ? error.message : String(error) },
                { status: 500 },
              ));
            } finally {
              phase("rpc:end", { ...facts, rpcMethod, status, aborted });
            }
          }
          if (url.pathname === "/" + basename(bundle.script))
            return response(new Response(await readFile(bundle.script), {
              headers: { "content-type": "text/javascript" },
            }));
          if (bundle.css && url.pathname === "/" + basename(bundle.css))
            return response(new Response(await readFile(bundle.css), {
              headers: { "content-type": "text/css" },
            }));
          return response(new Response(
            `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${bundle.css ? `<link rel="stylesheet" href="/${basename(bundle.css)}">` : ""}<style>:root{--background:#171922;--foreground:#d4d5e2;--muted-foreground:#a1a4bb;--border:#373a4c;--primary:#b7a3ed;--primary-foreground:#191529}body{font:14px system-ui;margin:24px;max-width:900px;background:var(--background);color:var(--foreground)}</style></head><body><script>window.__templatesRecoveryDiagnostics=true;window.__templatesRecoveryRun=${JSON.stringify(fixtureRun)}</script><script type="module" src="/${basename(bundle.script)}"></script></body></html>`,
            { headers: { "content-type": "text/html" } },
          ));
        } catch (error) {
          phase("http:error", { ...facts, error: error instanceof Error ? error.message : String(error) });
          throw error;
        } finally {
          request.signal.removeEventListener("abort", abort);
          // End means the handler returned, not proof that Chromium received it.
          phase("http:end", { ...facts, status, aborted });
        }
      },
    });
    steps.unshift({
      name: "server-stop",
      run: () => {
        server.stop(true);
      },
    });
    owned = acquireOwnedBrowser({
      scratch,
      artifacts,
      serverURL: server.url.toString(),
      phase,
    });
    const browser = await step("browser-launch", () => owned!.connect()),
      page = await step("page", () =>
        browser.newPage({ viewport: { width: 1100, height: 900 } }),
      ),
      errors: string[] = [],
      evidence: unknown[] = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      phase("page:error", { error: error.message });
    });
    page.on("requestfailed", (request) => {
      try {
        phase("page:request-failed", {
          path: new URL(request.url()).pathname,
          method: request.method(), error: request.failure()?.errorText ?? null,
        });
      } catch { /* Diagnostics must not introduce an unhandled event error. */ }
    });
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("templates-recovery-loader "))
        phase("page:loader", { event: text.slice(0, 1024) });
    });
    page.on("close", () => phase("page:close"));
    page.on("crash", () => phase("page:crash"));
    browser.on("disconnected", () => phase("browser:disconnected"));
    await step("goto", () => page.goto(`http://127.0.0.1:${server.port}`));
    for (const native of [false, true]) {
      mode = native ? "native" : "direct";
      phase("mode", { native });
      await step("select", () =>
        page.getByRole("button", { name: /PR Review/ }).click(),
      );
      await page
        .getByLabel(/Pull request URL/)
        .fill(`https://example.test/pull/${native ? "native" : "direct"}`);
      await page
        .getByLabel(/Main change or review goal/)
        .fill(native ? "Native saved checkpoint" : "Direct saved checkpoint");
      await step("target-ready", () =>
        browserExpect(
          page.getByRole("button", { name: "Edit with BB" }),
        ).toBeEnabled(),
      );
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
      await step("captured", () =>
        browserExpect.poll(() => captured).not.toBeNull(),
      );
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
      await step("reload", () => page.reload());
      cut = false;
      releaseReason = "after-reload";
      for (const release of [...held]) release();
      await step("reselect", () =>
        page.getByRole("button", { name: /PR Review/ }).click(),
      );
      const resume = page.getByRole("button", { name: "Resume saved request" });
      await step("resume-ready", () => browserExpect(resume).toBeEnabled());
      await page.screenshot({
        path: join(artifacts, `${native ? "native" : "direct"}-restored.png`),
      });
      await step("resume-click", () => resume.click());
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
  } catch (error) {
    phase("body:error", {
      error: error instanceof Error ? error.stack : String(error),
    });
    console.error("Saved-request browser body failed before cleanup:", error);
    failureTail();
    bodyFailure.failed = true;
    bodyFailure.error = error;
  } finally {
    mode = "cleanup";
    releaseReason = "cleanup";
    for (const release of [...held]) release();
    try {
      await cleanupPromptFixture({
        browser: owned?.owner,
        bodyFailure,
        steps,
        phase,
      });
    } catch (error) {
      failureTail();
      throw error;
    }
  }
}
