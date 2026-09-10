#!/usr/bin/env node

import { createRequire } from "node:module";
import { lstat, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runSupervisedNode } from "./supervised-node.mjs";

const sourcePath = fileURLToPath(import.meta.url);
const browserRoot = dirname(sourcePath);
const analyticsRoot = resolve(browserRoot, "../../..");
const communityRoot = resolve(analyticsRoot, "../..");
const communityNodeModules = resolve(communityRoot, "node_modules");
const manifestPath = resolve(analyticsRoot, "package.json");
const requireFromAnalytics = createRequire(manifestPath);

const CHILD_PREFIX = "@@bb-analytics-tooling-smoke@@";
const PARENT_PREFIX = "@@bb-analytics-tooling-smoke-parent@@";
const CHILD_ARGUMENT = "--child";
const CHILD_TIMEOUT_MS = 45_000;
const OUTPUT_CAP_BYTES = 16 * 1024;
const KILL_GRACE_MS = 1_000;
const CLOSE_GRACE_MS = 1_000;
const MAX_PACKAGE_METADATA_ANCESTORS = 8;
const MAX_OBSERVATIONS = 32;
const LOOPBACK = "127.0.0.1";
const FIXTURE_HTML_PATH = "/__bb_analytics_tooling_smoke__.html";
const FIXTURE_MODULE_PATH = "/__bb_analytics_tooling_smoke__.js";
const VIRTUAL_MODULE_ID = "\0bb-analytics-tooling-smoke";
const MARKER_ID = "bb-analytics-tooling-smoke-marker";
const MARKER_TEXT = "analytics-browser-tooling-ready";
const PLAYWRIGHT_BROWSERS_PATH = "0";

const EXPECTED_DIRECT_DEPENDENCIES = Object.freeze({
  "@get-bb/plugin-sdk": "0.4.15",
  "@playwright/test": "1.63.0",
  "@testing-library/react": "16.3.3",
  vite: "8.2.2",
  vitest: "4.1.11",
  jsdom: "26.1.0",
});

const EXPECTED_PACKAGE_VERSIONS = Object.freeze({
  ...EXPECTED_DIRECT_DEPENDENCIES,
  playwright: "1.63.0",
  "playwright-core": "1.63.0",
  react: "19.2.1",
  "@testing-library/dom": "10.4.1",
});

const SDK_ALIASES = Object.freeze([
  { find: "@bb/plugin-sdk/app", replacement: "@get-bb/plugin-sdk/app" },
  { find: "@bb/plugin-sdk", replacement: "@get-bb/plugin-sdk" },
]);

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Analytics tooling smoke</title></head>
  <body><main id="fixture-root"></main>
    <script type="module" src="${FIXTURE_MODULE_PATH}"></script>
  </body>
</html>`;

const FIXTURE_MODULE = `
import React from "react";
import * as publicApp from "@bb/plugin-sdk/app";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@bb/plugin-sdk/testing/app";

const observation = Object.freeze({
  kind: "analytics-browser-tooling-observation",
  version: 1,
  reactCreateElementType: typeof React.createElement,
  publicAppModuleType: typeof publicApp,
  installTestPluginRuntimeType: typeof installTestPluginRuntime,
  renderSlotType: typeof renderSlot,
});

const valid = observation.kind === "analytics-browser-tooling-observation"
  && observation.version === 1
  && observation.reactCreateElementType === "function"
  && observation.publicAppModuleType === "object"
  && observation.installTestPluginRuntimeType === "function"
  && observation.renderSlotType === "function";
if (!valid) throw new Error("public SDK tooling observation failed its schema");

const marker = document.createElement("div");
marker.id = "${MARKER_ID}";
marker.textContent = "${MARKER_TEXT}";
marker.dataset.observation = JSON.stringify(observation);
marker.dataset.reactCreateElementType = observation.reactCreateElementType;
marker.dataset.publicAppModuleType = observation.publicAppModuleType;
marker.dataset.installTestPluginRuntimeType = observation.installTestPluginRuntimeType;
marker.dataset.renderSlotType = observation.renderSlotType;
document.querySelector("#fixture-root").append(marker);
globalThis.__bbAnalyticsToolingObservation = observation;
`;

class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlockedError";
  }
}

class SmokeError extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokeError";
  }
}

function boundedText(value, maximum = 1_500) {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…[truncated]`;
}

function isWithin(child, parent) {
  const childRelative = relative(parent, child);
  return childRelative === ""
    || (!childRelative.startsWith(`..${sep}`) && childRelative !== ".." && !isAbsolute(childRelative));
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new SmokeError(`could not read ${label} at ${path}: ${boundedText(error)}`);
  }
}

function isMissingResolutionError(error) {
  return error?.code === "MODULE_NOT_FOUND" || error?.code === "ERR_MODULE_NOT_FOUND";
}

async function packageDirectoryExists(packageName) {
  try {
    await lstat(resolve(communityNodeModules, packageName));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new SmokeError(`could not inspect community package directory for ${packageName}: ${boundedText(error)}`);
  }
}

async function resolveSpecifier(specifier, label, { packageName, missingIsBlocked = false } = {}) {
  let exportPath;
  try {
    exportPath = requireFromAnalytics.resolve(specifier);
  } catch (error) {
    if (missingIsBlocked && packageName != null && isMissingResolutionError(error) && !(await packageDirectoryExists(packageName))) {
      throw new BlockedError(`missing community-resolved package ${packageName}: ${boundedText(error)}`);
    }
    throw new SmokeError(`${label} did not resolve: ${boundedText(error)}`);
  }
  try {
    return await realpath(exportPath);
  } catch (error) {
    throw new SmokeError(`${label} resolved to an unreadable path: ${boundedText(error)}`);
  }
}

async function findOwningPackageMetadata(resolvedEntry, packageName) {
  if (!isWithin(resolvedEntry, communityNodeModules)) {
    throw new SmokeError(`package ${packageName} resolved outside community node_modules: ${resolvedEntry}`);
  }
  let current = dirname(resolvedEntry);
  for (let depth = 0; depth < MAX_PACKAGE_METADATA_ANCESTORS && isWithin(current, communityNodeModules); depth += 1) {
    const candidate = resolve(current, "package.json");
    let resolvedPackageJson;
    try {
      resolvedPackageJson = await realpath(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") {
        current = dirname(current);
        continue;
      }
      throw new SmokeError(`package metadata path for ${packageName} is not readable: ${boundedText(error)}`);
    }
    if (!isWithin(resolvedPackageJson, communityNodeModules)) {
      throw new SmokeError(`package metadata for ${packageName} resolved outside community node_modules: ${resolvedPackageJson}`);
    }
    let metadata;
    try {
      metadata = JSON.parse(await readFile(resolvedPackageJson, "utf8"));
    } catch (error) {
      throw new SmokeError(`package metadata for ${packageName} is malformed: ${boundedText(error)}`);
    }
    if (metadata?.name !== packageName) {
      throw new SmokeError(`nearest package metadata name ${String(metadata?.name)} does not match ${packageName}`);
    }
    if (typeof metadata.version !== "string") {
      throw new SmokeError(`nearest package metadata for ${packageName} has no valid version`);
    }
    const packageRoot = dirname(resolvedPackageJson);
    if (!isWithin(resolvedEntry, packageRoot)) {
      throw new SmokeError(`resolved ${packageName} entry is outside its owning package root: ${resolvedEntry}`);
    }
    return Object.freeze({
      packageJson: resolvedPackageJson,
      root: packageRoot,
      metadata,
    });
  }
  throw new SmokeError(`could not find bounded owning package metadata for ${packageName}: ${resolvedEntry}`);
}

async function resolvePackage(packageName, expectedVersion, entrySpecifier = packageName, resolvedEntry = null) {
  const entry = resolvedEntry ?? await resolveSpecifier(
    entrySpecifier,
    `package ${packageName}`,
    { packageName, missingIsBlocked: true },
  );
  const owningMetadata = await findOwningPackageMetadata(entry, packageName);
  if (owningMetadata.metadata.version !== expectedVersion) {
    throw new SmokeError(`resolved ${packageName} version ${owningMetadata.metadata.version} does not match ${expectedVersion}`);
  }
  return Object.freeze({
    name: packageName,
    version: owningMetadata.metadata.version,
    packageJson: owningMetadata.packageJson,
    root: owningMetadata.root,
  });
}

async function resolvePublicExport(packageName, exportName, packageRoot = null, { missingIsBlocked = false } = {}) {
  const resolvedExport = await resolveSpecifier(
    exportName,
    `public export ${exportName} from ${packageName}`,
    { packageName, missingIsBlocked },
  );
  if (packageRoot != null && !isWithin(resolvedExport, packageRoot)) {
    throw new SmokeError(`public export ${exportName} resolved outside ${packageName}: ${resolvedExport}`);
  }
  return resolvedExport;
}

async function resolveToolchain() {
  const manifest = await readJson(manifestPath, "Analytics manifest");
  for (const [name, version] of Object.entries(EXPECTED_DIRECT_DEPENDENCIES)) {
    if (manifest.devDependencies?.[name] !== version) {
      throw new SmokeError(`Analytics direct devDependency ${name} is not pinned to ${version}`);
    }
  }

  const packages = {};
  const sdkTestingAppExport = await resolvePublicExport(
    "@get-bb/plugin-sdk",
    "@get-bb/plugin-sdk/testing/app",
    null,
    { missingIsBlocked: true },
  );
  packages["@get-bb/plugin-sdk"] = await resolvePackage(
    "@get-bb/plugin-sdk",
    EXPECTED_PACKAGE_VERSIONS["@get-bb/plugin-sdk"],
    "@get-bb/plugin-sdk/testing/app",
    sdkTestingAppExport,
  );
  const sdkAppExport = await resolvePublicExport(
    "@get-bb/plugin-sdk",
    "@get-bb/plugin-sdk/app",
    packages["@get-bb/plugin-sdk"].root,
  );
  for (const [name, version] of Object.entries(EXPECTED_PACKAGE_VERSIONS)) {
    if (name === "@get-bb/plugin-sdk") continue;
    packages[name] = await resolvePackage(name, version);
  }

  const browsersJson = resolve(packages["playwright-core"].root, "browsers.json");
  const browserManifest = await readJson(browsersJson, "Playwright browser manifest");
  const entries = Array.isArray(browserManifest.browsers) ? browserManifest.browsers : [];
  const byName = (name) => entries.find((entry) => entry?.name === name) ?? null;
  const chromium = byName("chromium");
  const headlessShell = byName("chromium-headless-shell");
  const ffmpeg = byName("ffmpeg");
  if (headlessShell?.revision !== "1243" || headlessShell?.browserVersion !== "153.0.8010.12") {
    throw new SmokeError("Playwright browsers.json does not contain the selected Chromium headless-shell revision");
  }
  if (ffmpeg?.revision !== "1011") {
    throw new SmokeError("Playwright browsers.json does not contain the selected ffmpeg revision");
  }

  const localBrowserRoot = resolve(packages["playwright-core"].root, ".local-browsers");
  let localEntries;
  try {
    localEntries = await readdir(localBrowserRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new BlockedError(`package-local browser directory is absent: ${localBrowserRoot}`);
    throw new SmokeError(`could not read package-local browser directory ${localBrowserRoot}: ${boundedText(error)}`);
  }
  if (localEntries.length > MAX_OBSERVATIONS) {
    throw new SmokeError(`package-local browser directory exceeded its fixed ${MAX_OBSERVATIONS}-entry observation limit`);
  }
  const hasArtifact = (name, revision) => {
    const directoryName = name === "chromium-headless-shell"
      ? `chromium_headless_shell-${revision}`
      : `${name}-${revision}`;
    return localEntries.some((entry) => entry.isDirectory() && entry.name === directoryName);
  };
  if (!hasArtifact("chromium-headless-shell", headlessShell.revision)) {
    throw new BlockedError(`package-local Chromium headless-shell ${headlessShell.revision} is absent`);
  }
  if (!hasArtifact("ffmpeg", ffmpeg.revision)) {
    throw new BlockedError(`package-local ffmpeg ${ffmpeg.revision} is absent`);
  }
  let selectedHeadlessShellRoot;
  try {
    selectedHeadlessShellRoot = await realpath(resolve(
      localBrowserRoot,
      `chromium_headless_shell-${headlessShell.revision}`,
    ));
  } catch (error) {
    throw new BlockedError(`package-local Chromium headless-shell ${headlessShell.revision} is not readable: ${boundedText(error)}`);
  }
  if (!isWithin(selectedHeadlessShellRoot, localBrowserRoot)) {
    throw new SmokeError(`selected Chromium headless-shell is outside package-local browser root: ${selectedHeadlessShellRoot}`);
  }

  return Object.freeze({
    manifest: {
      path: manifestPath,
      directDependencies: EXPECTED_DIRECT_DEPENDENCIES,
    },
    sdkAppExport,
    packages,
    sdkTestingAppExport,
    browsers: {
      path: browsersJson,
      chromium,
      headlessShell,
      ffmpeg,
      localRoot: localBrowserRoot,
      selectedHeadlessShellRoot,
      localEntries: localEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
      fullChromiumDirectoryPresent: chromium != null && hasArtifact("chromium", chromium.revision),
    },
  });
}

function toolingFixturePlugin() {
  return {
    name: "bb-analytics-tooling-smoke-fixture",
    resolveId(id) {
      return id === FIXTURE_MODULE_PATH ? VIRTUAL_MODULE_ID : null;
    },
    load(id) {
      return id === VIRTUAL_MODULE_ID ? FIXTURE_MODULE : null;
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split("?", 1)[0];
        if (path !== FIXTURE_HTML_PATH) return next();
        try {
          const html = await server.transformIndexHtml(FIXTURE_HTML_PATH, FIXTURE_HTML);
          response.statusCode = 200;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(html);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

function observeBrowserProcess(child) {
  const observed = {
    pid: Number.isInteger(child?.pid) ? child.pid : null,
    spawnfile: typeof child?.spawnfile === "string" ? child.spawnfile : null,
    spawnfileRealpath: null,
    exitObserved: false,
    closeObserved: false,
    exitCode: null,
    exitSignal: null,
  };
  let resolveClose;
  const closePromise = new Promise((resolveClosePromise) => {
    resolveClose = resolveClosePromise;
  });
  child.once("exit", (code, signal) => {
    observed.exitObserved = true;
    observed.exitCode = code;
    observed.exitSignal = signal;
  });
  child.once("close", (code, signal) => {
    observed.closeObserved = true;
    observed.exitCode = code;
    observed.exitSignal = signal;
    resolveClose();
  });
  return { observed, closePromise };
}

async function waitForClose(closePromise, timeoutMs = 3_000) {
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs);
  });
  const closed = await Promise.race([closePromise.then(() => true), timeout]);
  clearTimeout(timer);
  return closed;
}

async function validateBrowserProcessObservation(observed, selectedHeadlessShellRoot) {
  if (observed == null || !Number.isInteger(observed.pid) || typeof observed.spawnfile !== "string") {
    throw new SmokeError("Playwright browser process did not expose observed pid and spawnfile");
  }
  let spawnfileRealpath;
  try {
    spawnfileRealpath = await realpath(observed.spawnfile);
  } catch (error) {
    throw new SmokeError(`Playwright browser spawnfile is not readable: ${boundedText(error)}`);
  }
  if (!isWithin(spawnfileRealpath, selectedHeadlessShellRoot)) {
    throw new SmokeError(`Playwright browser spawnfile resolved outside selected package-local headless-shell: ${spawnfileRealpath}`);
  }
  observed.spawnfileRealpath = spawnfileRealpath;
}

function appendBounded(observations, value, state) {
  if (observations.length >= MAX_OBSERVATIONS) {
    state.overflow = true;
    return;
  }
  observations.push(value);
}

function validateLoopbackWebSocketEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new SmokeError(`Playwright browser server returned an invalid WebSocket endpoint: ${boundedText(error)}`);
  }
  if (url.protocol !== "ws:" || url.hostname !== LOOPBACK || url.port === "") {
    throw new SmokeError(`Playwright browser server WebSocket endpoint is not loopback: ${endpoint}`);
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new SmokeError(`Playwright browser server WebSocket endpoint has an invalid port: ${endpoint}`);
  }
  return Object.freeze({ protocol: url.protocol, host: url.hostname, port });
}

function isValidFixtureObservation(value) {
  return value?.kind === "analytics-browser-tooling-observation"
    && value.version === 1
    && value.reactCreateElementType === "function"
    && value.publicAppModuleType === "object"
    && value.installTestPluginRuntimeType === "function"
    && value.renderSlotType === "function";
}

async function runChildSmoke() {
  // This assignment must precede the dynamic Playwright import below.
  process.env.PLAYWRIGHT_BROWSERS_PATH = PLAYWRIGHT_BROWSERS_PATH;

  let viteServer = null;
  let httpServer = null;
  let browserServer = null;
  let browser = null;
  let context = null;
  let page = null;
  let browserProcessObservation = null;
  let browserProcessClosePromise = null;
  let browserServerCloseObserved = false;
  let browserServerLaunchPromise = null;
  let browserServerKillPromise = null;
  let browserServerAttached = false;
  let browserServerKillCalled = false;
  let browserServerWsEvidence = null;
  let temporaryDirectory = null;
  let temporaryDirectoryRemoved = false;
  let viteCloseObserved = false;
  let connectionObserved = 0;
  const sockets = new Set();
  const cleanupErrors = [];
  let cleanupPromise = null;
  let signalRequested = false;
  let signalCleanupError = null;
  let acquisitionsStoppedResolve;
  const acquisitionsStopped = new Promise((resolveAcquisitionsStopped) => {
    acquisitionsStoppedResolve = resolveAcquisitionsStopped;
  });
  let acquisitionsStoppedCalled = false;

  const throwIfSignalRequested = (stage) => {
    if (signalRequested) throw new BlockedError(`supervisor requested SIGTERM before ${stage}`);
  };

  const markAcquisitionsStopped = () => {
    if (acquisitionsStoppedCalled) return;
    acquisitionsStoppedCalled = true;
    acquisitionsStoppedResolve();
  };

  const attachBrowserServer = (server) => {
    if (browserServerAttached) return;
    browserServer = server;
    browserServerAttached = true;
    browserServer.once("close", () => {
      browserServerCloseObserved = true;
    });
    const browserProcess = browserServer.process();
    if (browserProcess == null) {
      cleanupErrors.push("Playwright browser server exposed no public process");
      return;
    }
    ({ observed: browserProcessObservation, closePromise: browserProcessClosePromise } = observeBrowserProcess(browserProcess));
  };

  const killBrowserServer = () => {
    if (browserServerKillPromise != null) return browserServerKillPromise;
    if (browserServer == null && browserServerLaunchPromise == null) return Promise.resolve(false);
    browserServerKillPromise = (async () => {
      let server = browserServer;
      if (server == null && browserServerLaunchPromise != null) {
        try {
          server = await browserServerLaunchPromise;
          attachBrowserServer(server);
        } catch (error) {
          cleanupErrors.push(`browserServer.launch: ${boundedText(error)}`);
          return;
        }
      }
      if (server == null) return;
      browserServerKillCalled = true;
      await server.kill();
      return true;
    })();
    return browserServerKillPromise;
  };

  const requestCleanup = (reason) => {
    if (cleanupPromise != null) return cleanupPromise;
    cleanupPromise = (async () => {
      const close = async (label, operation) => {
        if (operation == null) return;
        try {
          await operation();
        } catch (error) {
          cleanupErrors.push(`${label}: ${boundedText(error)}`);
        }
      };

      const emergency = reason === "sigterm" || signalRequested;
      if (emergency) {
        await close("browserServer.kill", async () => {
          await killBrowserServer();
        });
        if (browserProcessClosePromise != null) await waitForClose(browserProcessClosePromise);
      }
      // The signal handler may start this promise before an acquisition has
      // returned. The authoritative finally path resolves this fence after
      // the try/catch has stopped creating resources.
      await acquisitionsStopped;
      const cleanup = {
        reason,
        pageClosed: false,
        contextClosed: false,
        browserConnectionClosed: false,
        browserServerKillCalled: false,
        browserServerCloseObserved: false,
        browserProcessExitObserved: false,
        browserProcessCloseObserved: false,
        viteServerCloseObserved: false,
        viteListeningAfterClose: false,
        connectionObserved,
        openSocketsAfterClose: null,
        socketCleanupObserved: false,
        temporaryDirectory,
        temporaryDirectoryRemoved: false,
        errors: cleanupErrors,
      };
      if (signalRequested && !emergency) {
        await close("browserServer.kill", async () => {
          await killBrowserServer();
        });
        if (browserProcessClosePromise != null) await waitForClose(browserProcessClosePromise);
      }
      await close("page.close", async () => {
        if (page == null) return;
        await page.close();
        cleanup.pageClosed = page.isClosed();
      });
      await close("context.close", async () => {
        if (context == null) return;
        await context.close();
        cleanup.contextClosed = true;
      });
      await close("browser.close", async () => {
        if (browser == null) return;
        await browser.close();
        cleanup.browserConnectionClosed = !browser.isConnected();
      });
      if (!signalRequested && browserServerKillPromise == null) {
        await close("browserServer.close", async () => {
          if (browserServer == null) return;
          await browserServer.close();
        });
      }
      if (browserProcessClosePromise != null) await waitForClose(browserProcessClosePromise);
      cleanup.browserServerKillCalled = browserServerKillCalled;
      cleanup.browserServerCloseObserved = browserServerCloseObserved;
      cleanup.browserProcessExitObserved = browserProcessObservation?.exitObserved === true;
      cleanup.browserProcessCloseObserved = browserProcessObservation?.closeObserved === true;

      await close("vite.close", async () => {
        if (viteServer == null) return;
        await viteServer.close();
      });
      cleanup.viteServerCloseObserved = viteCloseObserved;
      cleanup.viteListeningAfterClose = httpServer != null && httpServer.listening === false;
      cleanup.openSocketsAfterClose = sockets.size;
      cleanup.socketCleanupObserved = httpServer != null
        && cleanup.viteListeningAfterClose
        && sockets.size === 0;
      if (httpServer != null) httpServer.removeAllListeners("connection");
      await close("temporaryDirectory.rm", async () => {
        if (temporaryDirectory == null) return;
        await rm(temporaryDirectory, { recursive: true, force: false });
        try {
          await realpath(temporaryDirectory);
          throw new SmokeError(`temporary Vite cache directory still exists: ${temporaryDirectory}`);
        } catch (error) {
          if (error?.code === "ENOENT") {
            temporaryDirectoryRemoved = true;
            cleanup.temporaryDirectoryRemoved = true;
            return;
          }
          throw error;
        }
      });
      cleanup.temporaryDirectoryRemoved = temporaryDirectoryRemoved;
      return cleanup;
    })();
    return cleanupPromise;
  };

  const onSigterm = () => {
    signalRequested = true;
    // Kill the Playwright-owned browser group before any graceful close can
    // block. This is intentionally independent of the idempotent cleanup
    // promise so a late SIGTERM also interrupts an in-flight page/server close.
    void killBrowserServer().catch((error) => {
      signalCleanupError = boundedText(error);
    });
    void requestCleanup("sigterm").catch((error) => {
      signalCleanupError = boundedText(error);
    });
  };
  process.once("SIGTERM", onSigterm);

  let status = "pass";
  let failure = null;
  let toolchain = null;
  let observation = null;
  let browserEvidence = null;
  let serverEvidence = null;
  try {
    throwIfSignalRequested("toolchain resolution");
    toolchain = await resolveToolchain();
    throwIfSignalRequested("Playwright import");
    const { chromium } = await import("@playwright/test");
    if (typeof chromium?.launchServer !== "function") {
      throw new SmokeError("@playwright/test chromium export lacks public launchServer()");
    }
    throwIfSignalRequested("Vite import");
    const { createServer } = await import("vite");
    if (typeof createServer !== "function") throw new SmokeError("vite export lacks public createServer()");

    throwIfSignalRequested("temporary Vite cache creation");
    temporaryDirectory = await mkdtemp(join(tmpdir(), "bb-analytics-tooling-smoke-"));
    throwIfSignalRequested("Vite server creation");
    viteServer = await createServer({
      root: analyticsRoot,
      cacheDir: temporaryDirectory,
      configFile: false,
      envFile: false,
      resolve: { alias: SDK_ALIASES },
      server: {
        host: LOOPBACK,
        port: 0,
        strictPort: true,
        watch: null,
        hmr: false,
      },
      plugins: [toolingFixturePlugin()],
    });
    throwIfSignalRequested("Vite server acquisition");
    httpServer = viteServer.httpServer;
    if (httpServer == null) throw new SmokeError("Vite did not expose its public HTTP server");
    httpServer.on("connection", (socket) => {
      connectionObserved += 1;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    httpServer.once("close", () => {
      viteCloseObserved = true;
    });
    throwIfSignalRequested("Vite listen");
    await viteServer.listen();
    throwIfSignalRequested("Vite listening address acquisition");
    const address = httpServer.address();
    if (address == null || typeof address === "string" || address.address !== LOOPBACK || !Number.isInteger(address.port) || address.port <= 0) {
      throw new SmokeError("Vite did not bind the required loopback ephemeral address");
    }
    const origin = `http://${LOOPBACK}:${address.port}`;
    serverEvidence = {
      root: analyticsRoot,
      cacheDir: temporaryDirectory,
      configFile: false,
      envFile: false,
      aliases: SDK_ALIASES,
      host: address.address,
      port: address.port,
      watch: null,
      hmr: false,
      listening: httpServer.listening,
      fixtureUrl: `${origin}${FIXTURE_HTML_PATH}`,
    };

    throwIfSignalRequested("browser launch");
    browserServerLaunchPromise = chromium.launchServer({
      headless: true,
      host: LOOPBACK,
      port: 0,
    });
    try {
      const launchedBrowserServer = await browserServerLaunchPromise;
      attachBrowserServer(launchedBrowserServer);
    } finally {
      browserServerLaunchPromise = null;
    }
    throwIfSignalRequested("browser server acquisition");
    browserEvidence = {
      browserVersion: null,
      executablePathOverride: null,
      process: browserProcessObservation,
      webSocketEndpoint: null,
      connectionEndpointUsed: false,
      headlessDefault: true,
    };
    await validateBrowserProcessObservation(
      browserProcessObservation,
      toolchain.browsers.selectedHeadlessShellRoot,
    );
    const browserServerWsEndpoint = browserServer.wsEndpoint();
    browserServerWsEvidence = validateLoopbackWebSocketEndpoint(browserServerWsEndpoint);
    browserEvidence = {
      ...browserEvidence,
      webSocketEndpoint: browserServerWsEvidence,
    };
    throwIfSignalRequested("browser connection");
    browser = await chromium.connect(browserServerWsEndpoint);
    throwIfSignalRequested("browser context creation");
    browserEvidence = {
      ...browserEvidence,
      browserVersion: browser.version(),
      connectionEndpointUsed: true,
    };
    context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    throwIfSignalRequested("browser route setup");
    await context.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.protocol !== "http:" || requestUrl.hostname !== LOOPBACK || requestUrl.port !== String(address.port)) {
        await route.abort();
        return;
      }
      await route.continue();
    });
    throwIfSignalRequested("browser page creation");
    page = await context.newPage();
    throwIfSignalRequested("browser page acquisition");
    const externalRequests = [];
    const pageErrors = [];
    const moduleResponses = [];
    const observationState = { overflow: false };
    page.on("request", (request) => {
      const requestUrl = new URL(request.url());
      if (requestUrl.protocol !== "http:" || requestUrl.hostname !== LOOPBACK || requestUrl.port !== String(address.port)) {
        appendBounded(externalRequests, request.url(), observationState);
      }
    });
    page.on("pageerror", (error) => appendBounded(pageErrors, boundedText(error), observationState));
    page.on("response", (response) => {
      if (response.url().includes(FIXTURE_MODULE_PATH)) {
        appendBounded(moduleResponses, {
          status: response.status(),
          contentType: response.headers()["content-type"] ?? null,
        }, observationState);
      }
    });
    const navigationResponse = await page.goto(`${origin}${FIXTURE_HTML_PATH}`, { waitUntil: "load", timeout: 10_000 });
    throwIfSignalRequested("fixture navigation");
    if (navigationResponse == null || navigationResponse.status() >= 400) {
      throw new SmokeError(`fixture HTML did not load successfully: ${navigationResponse?.status() ?? "no response"}`);
    }
    const marker = page.locator(`#${MARKER_ID}`);
    await marker.waitFor({ state: "attached", timeout: 10_000 });
    throwIfSignalRequested("fixture marker observation");
    const markerEvidence = await marker.evaluate((element) => ({
      text: element.textContent,
      observation: JSON.parse(element.getAttribute("data-observation") ?? "null"),
      datasets: {
        reactCreateElementType: element.getAttribute("data-react-create-element-type"),
        publicAppModuleType: element.getAttribute("data-public-app-module-type"),
        installTestPluginRuntimeType: element.getAttribute("data-install-test-plugin-runtime-type"),
        renderSlotType: element.getAttribute("data-render-slot-type"),
      },
    }));
    if (observationState.overflow) throw new SmokeError(`fixture observation exceeded its fixed ${MAX_OBSERVATIONS}-item limit`);
    if (markerEvidence.text !== MARKER_TEXT || !isValidFixtureObservation(markerEvidence.observation)) {
      throw new SmokeError("served fixture marker did not contain the schema-valid public tooling observation");
    }
    if (externalRequests.length > 0) throw new SmokeError(`fixture attempted external requests: ${externalRequests.join(", ")}`);
    if (pageErrors.length > 0) throw new SmokeError(`fixture page error: ${pageErrors.join("; ")}`);
    if (!moduleResponses.some((response) => response.status === 200)) {
      throw new SmokeError("served fixture ES module did not produce an HTTP 200 response");
    }
    observation = {
      ...markerEvidence.observation,
      markerText: markerEvidence.text,
      markerDatasets: markerEvidence.datasets,
      servedModuleResponses: moduleResponses,
      externalRequests,
      pageErrors,
      observationOverflow: observationState.overflow,
    };
  } catch (error) {
    status = error instanceof BlockedError ? "blocked" : "fail";
    failure = boundedText(error);
  } finally {
    markAcquisitionsStopped();
    const cleanup = await requestCleanup(signalRequested ? "sigterm" : "finally");
    if (signalCleanupError != null) cleanupErrors.push(`signal cleanup: ${signalCleanupError}`);
    if (signalRequested) {
      status = "blocked";
      failure = failure ?? "supervisor requested SIGTERM";
    } else if (status === "pass" && (
      cleanup.pageClosed !== true
      || cleanup.contextClosed !== true
      || cleanup.browserConnectionClosed !== true
      || cleanup.browserServerCloseObserved !== true
      || cleanup.browserProcessExitObserved !== true
      || cleanup.browserProcessCloseObserved !== true
      || cleanup.viteServerCloseObserved !== true
      || cleanup.viteListeningAfterClose !== true
      || cleanup.socketCleanupObserved !== true
      || cleanup.temporaryDirectoryRemoved !== true
      || cleanup.errors.length > 0
    )) {
      status = "fail";
      failure = "owned browser/Vite cleanup was not fully observed";
    }
    process.off("SIGTERM", onSigterm);
    return {
      kind: "analytics-browser-tooling-smoke",
      version: 1,
      status,
      failure,
      environment: {
        node: process.version,
        cwd: process.cwd(),
        playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
      },
      toolchain,
      server: serverEvidence,
      browser: browserEvidence,
      observation,
      cleanup,
    };
  }
}

function parseProtocol(stdout, prefix, expectedKind, expectedVersion) {
  const lines = String(stdout ?? "").slice(0, OUTPUT_CAP_BYTES).split(/\r?\n/);
  let matchCount = 0;
  let line = null;
  for (const entry of lines) {
    if (!entry.startsWith(prefix)) continue;
    matchCount += 1;
    if (line == null) line = entry;
  }
  if (matchCount === 0) return { receipt: null, error: "missing protocol receipt" };
  if (matchCount !== 1) return { receipt: null, error: "duplicate protocol receipts" };
  let receipt;
  try {
    receipt = JSON.parse(line.slice(prefix.length));
  } catch (error) {
    return { receipt: null, error: `malformed protocol receipt: ${boundedText(error)}` };
  }
  if (receipt?.kind !== expectedKind || receipt?.version !== expectedVersion) {
    return { receipt: null, error: `protocol receipt kind/version mismatch (expected ${expectedKind} v${expectedVersion})` };
  }
  return { receipt, error: null };
}

async function runParentSmoke() {
  const supervised = await runSupervisedNode({
    args: [sourcePath, CHILD_ARGUMENT],
    cwd: analyticsRoot,
    timeoutMs: CHILD_TIMEOUT_MS,
    outputCapBytes: OUTPUT_CAP_BYTES,
    killGraceMs: KILL_GRACE_MS,
    closeGraceMs: CLOSE_GRACE_MS,
  });
  const stdout = Buffer.isBuffer(supervised.stdout) ? supervised.stdout.toString("utf8") : String(supervised.stdout ?? "");
  const stderr = Buffer.isBuffer(supervised.stderr) ? supervised.stderr.toString("utf8") : String(supervised.stderr ?? "");
  const protocol = parseProtocol(
    stdout,
    CHILD_PREFIX,
    "analytics-browser-tooling-smoke",
    1,
  );
  const child = protocol.receipt;
  let status = "pass";
  let failure = null;
  if (supervised.reason === "deadline") {
    status = "blocked";
    failure = "tooling smoke child exceeded the fixed 45-second deadline";
  } else if (supervised.reason != null || supervised.code !== 0 || supervised.signal != null || supervised.closeObserved !== true || supervised.exitObserved !== true) {
    status = child?.status === "blocked" ? "blocked" : "fail";
    failure = child?.failure ?? `child process was not cleanly completed (code ${supervised.code}, signal ${supervised.signal}, reason ${supervised.reason})`;
  } else if (protocol.error != null) {
    status = "fail";
    failure = protocol.error;
  } else if (!["pass", "blocked", "fail"].includes(child.status)) {
    status = "fail";
    failure = "child returned an invalid tooling smoke status";
  } else {
    status = child.status;
    failure = child.failure ?? null;
  }
  return {
    kind: "analytics-browser-tooling-smoke-parent",
    version: 1,
    status,
    failure,
    supervisor: {
      code: supervised.code,
      signal: supervised.signal,
      reason: supervised.reason,
      terminationReason: supervised.terminationReason,
      exitObserved: supervised.exitObserved,
      closeObserved: supervised.closeObserved,
      capturedBytes: supervised.capturedBytes,
      receivedBytes: supervised.receivedBytes,
      stderr: boundedText(stderr, 1_500),
    },
    child,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === CHILD_ARGUMENT) {
    try {
      const result = await runChildSmoke();
      process.stdout.write(`${CHILD_PREFIX}${JSON.stringify(result)}\n`);
      process.exitCode = result.status === "pass" ? 0 : result.status === "blocked" ? 2 : 1;
    } catch (error) {
      const result = {
        kind: "analytics-browser-tooling-smoke",
        version: 1,
        status: error instanceof BlockedError ? "blocked" : "fail",
        failure: boundedText(error),
      };
      process.stdout.write(`${CHILD_PREFIX}${JSON.stringify(result)}\n`);
      process.exitCode = result.status === "blocked" ? 2 : 1;
    }
    return;
  }
  if (args.length !== 0) {
    process.stderr.write("usage: node test/architecture/browser/tooling-smoke.mjs\n");
    process.exitCode = 1;
    return;
  }
  const result = await runParentSmoke();
  process.stdout.write(`${PARENT_PREFIX}${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "pass" ? 0 : result.status === "blocked" ? 2 : 1;
}

if (process.argv[1] === sourcePath) await main();

export {
  CHILD_ARGUMENT,
  CHILD_TIMEOUT_MS,
  OUTPUT_CAP_BYTES,
  SDK_ALIASES,
  runChildSmoke,
  runParentSmoke,
};
