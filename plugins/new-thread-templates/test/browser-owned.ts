/** Shared test-only direct browser ownership, extracted from the Prompt fixture. */
import {
  chromium,
  type Browser,
  type ConnectOverCDPTransport,
} from "@playwright/test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { retireDisconnectedPromptBrowser } from "./browser-prompt-cleanup.ts";

export function acquireOwnedBrowser({
  scratch,
  artifacts,
  serverURL,
  phase,
}: {
  scratch: string;
  artifacts: string;
  serverURL: string;
  phase(name: string, detail?: Record<string, unknown>): void;
}) {
  // Own the public executable directly: no parent DevTools pipe to lose.
  const profile = join(scratch, "chromium-profile"),
    child = spawn(
      chromium.executablePath(),
      [
        "--headless",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  let browser: Browser | undefined;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", (exitCode, signalCode) => {
      phase("owned-process:exit", { exitCode, signalCode });
      resolve();
    }),
  );
  const ownedBrowser = {
    process: () => child,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (browser?.isConnected()) {
        const session = await browser.newBrowserCDPSession();
        const result = session.send("Browser.close").then(
          () => null,
          (error: unknown) => error,
        );
        await exited;
        const error = await result;
        // Chromium may close the session before replying to its close command.
        if (
          error &&
          !String(error).includes(
            "Target page, context or browser has been closed",
          )
        )
          throw error;
        if (child.exitCode !== 0)
          throw new Error(
            `Owned Chromium close exited ${child.exitCode}/${child.signalCode}`,
          );
      } else {
        await retireDisconnectedPromptBrowser(child, exited);
      }
    },
    kill: async () => {
      if (
        child.exitCode === null &&
        child.signalCode === null &&
        !child.kill("SIGKILL")
      )
        throw new Error("Exact owned Chromium could not be killed");
      await exited;
    },
  };
  let endpointText = "";
  const endpoint = new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error("Owned Chromium exited before CDP startup")),
    );
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      phase("owned-process:stderr", { text: text.slice(-8000) });
      endpointText = (endpointText + text).slice(-16000);
      const match = endpointText.match(
        /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/,
      );
      if (match) resolve(match[1]!);
    });
  });
  return {
    owner: ownedBrowser,
    connect: async () => {
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Test-only public transport adapter for the owned browser; narrow bundled-
        // WebSocket probe timed out under Bun. Original Prompt stall cause is unproven.
        const startup = new Promise<never>((_, reject) => {
          startupTimer = setTimeout(
            () => reject(new Error("Owned Chromium startup exceeded 10000ms")),
            10000,
          );
        });
        await Bun.write(
          join(artifacts, "owned-browser.json"),
          JSON.stringify(
            {
              pid: child.pid,
              ownership:
                "direct ChildProcess from public chromium.executablePath",
              profile,
              transport:
                "public CDP transport over Bun native WebSocket; no parent DevTools pipe",
              scratch,
              server: serverURL,
            },
            null,
            2,
          ),
        );
        const socket = new WebSocket(await Promise.race([endpoint, startup])),
          transport: ConnectOverCDPTransport = {
            send: (message) => {
              if (
                "method" in message &&
                [
                  "Browser.close",
                  "Target.closeTarget",
                  "Target.disposeBrowserContext",
                ].includes(String(message.method))
              )
                phase("transport:close-command", {
                  message,
                  stack: new Error("Close command caller").stack,
                });
              socket.send(JSON.stringify(message));
            },
            close: () => {
              phase("transport:close-called", {
                stack: new Error("Public transport.close caller").stack,
              });
              socket.close();
            },
          };
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data));
          if (
            [
              "Target.detachedFromTarget",
              "Target.targetDestroyed",
              "Target.targetCrashed",
              "Inspector.detached",
              "Inspector.targetCrashed",
            ].includes(message.method)
          )
            phase("transport:target-event", { message });
          transport.onmessage?.(message);
        };
        socket.onclose = (event) => {
          phase("socket:close", {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          });
          transport.onclose?.(event.reason);
        };
        socket.onerror = (event) => phase("socket:error", { type: event.type });
        let openTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            socket.onopen = () => resolve();
            socket.addEventListener(
              "error",
              () => reject(new Error("Owned Chromium CDP socket failed")),
              { once: true },
            );
            openTimer = setTimeout(
              () =>
                reject(new Error("Owned Chromium CDP socket exceeded 5000ms")),
              5000,
            );
          });
        } catch (error) {
          socket.close();
          throw error;
        } finally {
          if (openTimer) clearTimeout(openTimer);
        }
        browser = await Promise.race([
          chromium.connectOverCDP(transport, { timeout: 5000 }),
          startup,
        ]);
        return browser;
      } finally {
        if (startupTimer) clearTimeout(startupTimer);
      }
    },
  };
}
