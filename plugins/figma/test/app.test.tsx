// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { SettingsSnapshot } from "../contract.ts";
import type { rpcContract } from "../rpc-contract.ts";

const connection = { phase: "disconnected" as const, detail: null, connectedAt: null, serverVersion: null };
function snapshot(): SettingsSnapshot {
  return { scope: "shared", config: { binaryPath: "figmog", mirrorEnabled: true, binaryAvailable: true, tokenConfigured: true, clientId: "public-client", clientSecretConfigured: true, redirectUri: "https://bb.example/callback" }, official: { ...connection }, mirror: { ...connection }, tools: { official: [], mirror: [] }, aliasesNeedReload: false };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}
async function load() {
  const app = await loadPluginApp(() => import("../app.tsx"));
  expect(app.settingsSections).toHaveLength(1);
  return app.settingsSections[0]!;
}
async function mount(overrides: Partial<PluginRpcTestHandlers<typeof rpcContract>> = {}) {
  const section = await load();
  const rpc: PluginRpcTestHandlers<typeof rpcContract> = {
    status: () => snapshot(), configure: () => snapshot(),
    finishAuthorization: () => snapshot(), connectOfficial: () => ({ authorizationUrl: "https://www.figma.com/oauth?state=test" }),
    disconnect: () => snapshot(), testConnection: () => snapshot(), refreshTools: () => snapshot(), syncMirror: () => ({}), ...overrides,
  };
  return renderSlot(section, {}, { rpc });
}
const button = (slot: Awaited<ReturnType<typeof mount>>, name: string) => slot.getByRole("button", { name }) as HTMLButtonElement;
const field = (slot: Awaited<ReturnType<typeof mount>>, label: string) => slot.getByLabelText(label) as HTMLInputElement;
const form = (element: HTMLElement) => element.closest("form")!;
beforeEach(() => {
  // Vitest preserves Node 26's native storage globals; use this test DOM's stores.
  const browser = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom.window;
  vi.stubGlobal("localStorage", browser.localStorage);
  vi.stubGlobal("sessionStorage", browser.sessionStorage);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("host chrome states the shared scope once and the body does not repeat it", async () => {
  const section = await load();
  expect(section.title).toBe("Connection");
  expect(section.description).toMatch(/shared by everyone using this BB deployment/);
  const slot = await mount();
  await slot.findByRole("button", { name: "Connect Figma" });
  expect(slot.container.textContent).not.toMatch(/shared|deployment/i);
});

test("connected state is a compact status row without backend prose or sign-in controls", async () => {
  const current = snapshot();
  current.official = { ...connection, phase: "connected", detail: "Connected through the official MCP endpoint.", serverVersion: "1.0.0" };
  current.config.mirrorEnabled = false;
  current.mirror = { ...connection, phase: "unconfigured", detail: "Optional figmog cache is off. Use the official Figma MCP connection for reads and writes." };
  const slot = await mount({ status: () => current });
  expect((await slot.findByText("Connected")).closest("p")?.getAttribute("tabindex")).toBe("-1");
  expect(slot.queryByRole("button", { name: "Connect Figma" })).toBeNull();
  expect(button(slot, "Test Figma").disabled).toBe(false);
  expect(button(slot, "Disconnect").disabled).toBe(false);
  expect(slot.queryByText(/official MCP endpoint/)).toBeNull();
  expect(slot.queryByText(/figmog cache is off/)).toBeNull();
  expect(slot.queryByText(/1\.0\.0/)).toBeNull();
  expect(slot.queryByLabelText("Callback URL")).toBeNull();
  expect(slot.queryByText("Loading…")).toBeNull();
  const cacheSummary = slot.getByText("Read cache").closest("summary")!;
  expect(cacheSummary.textContent).toContain("Off");
  expect(slot.container.querySelector("pre")).toBeNull();
});

test("disconnected saved grant is explained once and recovered with Test Figma", async () => {
  let current = snapshot();
  current.official = { ...connection, detail: "Saved Figma authorization is available. Test Figma or an agent call resumes it without a new sign-in." };
  const testConnection = vi.fn(() => { current = { ...current, official: { ...connection, phase: "connected" } }; return current; });
  const slot = await mount({ status: () => current, testConnection });
  await slot.findByText("Not connected");
  expect(slot.getAllByText(/Saved Figma authorization is available/)).toHaveLength(1);
  expect(button(slot, "Connect Figma").className).toContain("figma-button-primary");
  expect(slot.queryByRole("button", { name: "Disconnect" })).toBeNull();
  fireEvent.click(button(slot, "Test Figma"));
  await slot.findByText("Figma is working.");
  expect(testConnection).toHaveBeenCalledWith({ source: "official" });
  expect(slot.getByText("Connected")).toBeTruthy();
  expect(slot.queryByText(/Saved Figma authorization/)).toBeNull();
});

test("error phase shows the problem as text, not only colour", async () => {
  const current = snapshot(); current.official = { ...connection, phase: "error", detail: "Figma returned HTTP 401." };
  const slot = await mount({ status: () => current });
  expect(await slot.findByText("Connection problem")).toBeTruthy();
  expect(slot.getByText("Figma returned HTTP 401.").className).toBe("figma-error");
  expect(slot.container.querySelector(".figma-dot")?.getAttribute("aria-hidden")).toBe("true");
});

test("missing optional figmog offers installation help while official Connect stays usable", async () => {
  let current = snapshot();
  current.config = { ...current.config, mirrorEnabled: false, binaryAvailable: false };
  const configure = vi.fn((input: { mirrorEnabled?: boolean }) => {
    current = { ...current, config: { ...current.config, ...input } };
    return current;
  });
  const slot = await mount({ status: () => current, configure });
  const toggle = await slot.findByRole("checkbox", { name: "Cache reads with figmog" }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  expect(field(slot, "Read token").disabled).toBe(true);
  expect(slot.getByRole("link", { name: "Install figmog" }).getAttribute("href")).toContain("sanctuarycomputer/figmog");
  expect(button(slot, "Connect Figma").disabled).toBe(false);
  expect(slot.queryByRole("button", { name: "Sync" })).toBeNull();
  expect(slot.queryByLabelText("Figma file URL")).toBeNull();
  const cache = form(toggle);
  expect(within(cache).getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
  fireEvent.click(toggle);
  expect(field(slot, "Read token").disabled).toBe(false);
  fireEvent.click(within(cache).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(configure).toHaveBeenCalledWith({ mirrorEnabled: true }));
  await within(cache.closest("details")!).findByText("Saved.");
  expect(slot.getByText("Read cache").closest("summary")!.textContent).toContain("figmog not found");
});

test("secrets are write-only and controls stay keyboard reachable", async () => {
  const slot = await mount();
  const token = await slot.findByLabelText("Read token") as HTMLInputElement;
  expect(token.type).toBe("password"); expect(token.value).toBe("");
  expect(slot.getAllByText("Saved. Leave blank to keep it.")).toHaveLength(2);
  const secret = field(slot, "Client secret");
  expect(secret.type).toBe("password"); expect(secret.value).toBe("");
  expect(field(slot, "Client ID").value).toBe("public-client");
  expect(field(slot, "Redirect URL").value).toBe("https://bb.example/callback");
  expect(slot.getAllByText("No tools yet")).toHaveLength(2);
  for (const summary of [slot.getByText("Read cache").closest("summary")!, slot.getByText("Advanced").closest("summary")!, slot.getAllByText("No tools yet")[0]!]) {
    expect(summary.tagName).toBe("SUMMARY");
    summary.focus(); expect(document.activeElement).toBe(summary);
  }
  token.focus(); expect(document.activeElement).toBe(token);
  const connect = button(slot, "Connect Figma");
  connect.focus(); expect(document.activeElement).toBe(connect);
  expect(slot.queryByText(/Refresh status/)).toBeNull();
});

test("cache and advanced saves are independent and omit unchanged secrets", async () => {
  const configure = vi.fn(() => snapshot());
  const slot = await mount({ configure });
  const token = await slot.findByLabelText("Read token") as HTMLInputElement;
  const cache = form(token), advanced = form(field(slot, "Client ID"));
  fireEvent.change(token, { target: { value: "read-secret" } });
  fireEvent.click(slot.getByRole("checkbox", { name: "Cache reads with figmog" }));
  fireEvent.change(field(slot, "Client ID"), { target: { value: "updated-client" } });
  fireEvent.change(field(slot, "Client secret"), { target: { value: "oauth-secret" } });

  fireEvent.click(within(advanced).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(configure).toHaveBeenCalledWith({ clientId: "updated-client", clientSecret: "oauth-secret" }));
  await within(advanced).findByText("Saved.");
  expect(field(slot, "Client secret").value).toBe("");
  expect(token.value).toBe("read-secret");
  expect((slot.getByRole("checkbox", { name: "Cache reads with figmog" }) as HTMLInputElement).checked).toBe(false);

  fireEvent.change(field(slot, "Client secret"), { target: { value: "second-secret" } });
  fireEvent.change(field(slot, "Redirect URL"), { target: { value: "https://bb.example/other" } });
  fireEvent.click(within(cache).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(configure).toHaveBeenLastCalledWith({ mirrorEnabled: false, readToken: "read-secret" }));
  await waitFor(() => expect(token.value).toBe(""));
  expect(field(slot, "Client secret").value).toBe("second-secret");
  expect(field(slot, "Redirect URL").value).toBe("https://bb.example/other");

  fireEvent.submit(advanced);
  await waitFor(() => expect(configure).toHaveBeenLastCalledWith({ redirectUri: "https://bb.example/other", clientSecret: "second-secret" }));
  expect(within(advanced).getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
  expect(window.localStorage.length).toBe(0); expect(window.sessionStorage.length).toBe(0);
});

test("Connect shows busy state, then an explicit link, and refreshes on return without a popup", async () => {
  const begin = deferred<{ authorizationUrl: string }>();
  const popup = vi.spyOn(window, "open");
  let current = snapshot();
  const status = vi.fn(() => current);
  const slot = await mount({ status, connectOfficial: () => begin.promise });
  fireEvent.click(await slot.findByRole("button", { name: "Connect Figma" }));
  expect(slot.getByText("Starting sign-in…").getAttribute("role")).toBe("status");
  expect(button(slot, "Test Figma").disabled).toBe(true);
  expect(slot.container.querySelector(".figma-settings")?.getAttribute("aria-busy")).toBe("true");
  expect(slot.queryByRole("link")).toBeNull();
  current = { ...current, official: { ...connection, phase: "authorizing" } };
  await act(async () => begin.resolve({ authorizationUrl: "https://www.figma.com/oauth?state=test" }));
  const link = await slot.findByRole("link", { name: "Approve access in Figma" });
  expect(link.getAttribute("href")).toBe("https://www.figma.com/oauth?state=test");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
  expect(popup).not.toHaveBeenCalled();
  expect(await slot.findByText("Waiting for sign-in")).toBeTruthy();
  expect(button(slot, "Start over").className).not.toContain("figma-button-primary");
  current = { ...current, official: { ...connection, phase: "connected" } };
  fireEvent(window, new Event("focus"));
  await slot.findByText("Connected");
  expect(slot.queryByRole("link")).toBeNull();
  const count = status.mock.calls.length;
  await slot.behavior.emitRealtime("figma", {});
  await waitFor(() => expect(status.mock.calls.length).toBe(count + 1));
});

test("automatic registration needs no manual credentials and displays a sanitized rejection without replay", async () => {
  let current = snapshot();
  current.config = { ...current.config, clientId: "", clientSecretConfigured: false };
  const connectOfficial = vi.fn(async () => {
    current = { ...current, official: { ...connection, phase: "error", detail: "Figma rejected Codex-compatible client registration (HTTP 403). Check the callback URL or use preregistered client credentials." } };
    throw new Error("untrusted upstream body with secret");
  });
  const slot = await mount({ status: () => current, connectOfficial });
  const connect = await slot.findByRole("button", { name: "Connect Figma" });
  expect(slot.queryByRole("button", { name: "Use automatic registration" })).toBeNull();
  fireEvent.click(connect);
  await slot.findByText(/Figma rejected Codex-compatible client registration \(HTTP 403\)/);
  expect(slot.getByRole("alert").textContent).toBe("Couldn't start sign-in.");
  expect(slot.queryByRole("link", { name: "Approve access in Figma" })).toBeNull();
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(slot.queryByText("Connection problem")).toBeTruthy());
  expect(connectOfficial).toHaveBeenCalledTimes(1);
});

test("removing the manual client override keeps the read token and does not start registration", async () => {
  const next = snapshot(); next.config = { ...next.config, clientId: "", clientSecretConfigured: false };
  const configure = vi.fn(() => next);
  const connectOfficial = vi.fn();
  const slot = await mount({ configure, connectOfficial });
  const remove = await slot.findByRole("button", { name: "Use automatic registration" });
  expect(remove.getAttribute("aria-describedby")).toBeTruthy();
  expect(slot.getByText("Removes the override and signs Figma out.")).toBeTruthy();
  fireEvent.click(remove);
  await waitFor(() => expect(configure).toHaveBeenCalledWith({ clientId: "", clientSecret: "" }));
  await slot.findByText(/Client override removed/);
  expect(slot.queryByRole("button", { name: "Use automatic registration" })).toBeNull();
  expect(slot.getByText("Saved. Leave blank to keep it.").id).toMatch(/token-hint$/);
  expect(connectOfficial).not.toHaveBeenCalled();
});

test("late status cannot overwrite disconnect and refresh coalesces invalidations", async () => {
  const old = deferred<SettingsSnapshot>();
  let reads = 0;
  const disconnected = snapshot(); disconnected.mirror.phase = "unconfigured"; disconnected.config.tokenConfigured = false;
  const status = vi.fn(() => ++reads === 2 ? old.promise : reads > 2 ? disconnected : snapshot());
  const disconnect = vi.fn(() => disconnected);
  const slot = await mount({ status, disconnect });
  await slot.findByLabelText("Read token");
  fireEvent(window, new Event("focus"));
  fireEvent(window, new Event("focus"));
  fireEvent.click(button(slot, "Remove read token"));
  await slot.findByText("Read token removed.");
  expect(disconnect).toHaveBeenCalledWith({ source: "mirror" });
  const stale = snapshot(); stale.mirror.phase = "connected";
  await act(async () => old.resolve(stale));
  await waitFor(() => expect(status).toHaveBeenCalledTimes(3));
  const summary = slot.getByText("Read cache").closest("summary")!;
  expect(summary.textContent).toContain("Needs a read token");
  expect(summary.textContent).not.toContain("Running");
  expect(slot.queryByRole("button", { name: "Remove read token" })).toBeNull();
});

test("failed load has retry; file test and inventory refresh use only contract RPC", async () => {
  const status = vi.fn().mockRejectedValueOnce(new Error("internal failure")).mockResolvedValue(snapshot());
  const tested = snapshot(); tested.mirror = { ...connection, phase: "error", detail: "File access denied" };
  const testConnection = vi.fn(() => tested);
  const catalog = snapshot(); catalog.tools.official = [{ name: "figma_read", description: "Read the design", inputSchema: {} }]; catalog.aliasesNeedReload = true;
  const refreshTools = vi.fn(() => catalog);
  const slot = await mount({ status, testConnection, refreshTools });
  expect((await slot.findByRole("alert")).textContent).not.toContain("internal failure");
  fireEvent.click(button(slot, "Retry"));
  await slot.findByLabelText("Read token");
  fireEvent.change(field(slot, "Figma file URL"), { target: { value: " https://www.figma.com/design/abc " } });
  fireEvent.click(button(slot, "Test read"));
  expect((await slot.findByRole("alert")).textContent).toBe("Couldn't verify read access. File access denied");
  expect(slot.getAllByText(/File access denied/)).toHaveLength(1);
  expect(testConnection).toHaveBeenCalledWith({ source: "mirror", file: "https://www.figma.com/design/abc" });
  fireEvent.click(slot.getAllByRole("button", { name: "Refresh tools" })[0]!);
  await slot.findByText("figma_read");
  expect(slot.getByText("1 tool").tagName).toBe("SUMMARY");
  expect(slot.getByText("figma_read").closest("li")?.getAttribute("title")).toBe("Read the design");
  expect(refreshTools).toHaveBeenCalledWith({ source: "official" });
  expect(slot.getByText("Reload the Figma plugin to update tool shortcuts.")).toBeTruthy();
});

test("failed saves keep drafts, suppress secret-bearing errors and permit retry", async () => {
  const configure = vi.fn().mockRejectedValueOnce(new Error("secret input: private-token")).mockResolvedValue(snapshot());
  const slot = await mount({ configure });
  const token = await slot.findByLabelText("Read token") as HTMLInputElement;
  fireEvent.change(token, { target: { value: "private-token" } });
  const save = within(form(token)).getByRole("button", { name: "Save" });
  fireEvent.click(save);
  const alert = await slot.findByRole("alert");
  expect(alert.textContent).not.toContain("private-token");
  expect(token.value).toBe("private-token");
  fireEvent.click(save);
  await slot.findByText("Saved.");
  expect(slot.queryByRole("alert")).toBeNull();
  expect(configure).toHaveBeenCalledTimes(2);
});

test("unmount removes focus subscription and ignores late OAuth result", async () => {
  const begin = deferred<{ authorizationUrl: string }>();
  const status = vi.fn(() => snapshot());
  const slot = await mount({ status, connectOfficial: () => begin.promise });
  fireEvent.click(await slot.findByRole("button", { name: "Connect Figma" }));
  slot.unmount();
  fireEvent(window, new Event("focus"));
  await act(async () => begin.resolve({ authorizationUrl: "https://www.figma.com/oauth" }));
  expect(status).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".figma-settings")).toBeNull();
});

test("unsafe authorization links fail explicitly", async () => {
  const slot = await mount({ finishAuthorization: () => snapshot(), connectOfficial: () => ({ authorizationUrl: "javascript:alert(1)" }) });
  fireEvent.click(await slot.findByRole("button", { name: "Connect Figma" }));
  expect((await slot.findByRole("alert")).textContent).toBe("Couldn't start sign-in.");
  expect(slot.queryByRole("link")).toBeNull();
});

test("explicit cache sync uses file URL and preserves returned unverified freshness disclosure", async () => {
  const freshness = { state: "rebaselined", mutationVisibilityVerified: false, detail: "No prior version baseline was available." };
  const syncMirror = vi.fn(() => ({ _meta: { bbFigmaFreshness: freshness } }));
  const slot = await mount({ syncMirror });
  await slot.findByLabelText("Read token");
  const sync = button(slot, "Sync");
  const accept = slot.getByRole("checkbox", { name: "Accept the sync without verifying the earlier edit" }) as HTMLInputElement;
  expect(accept.checked).toBe(false);
  expect(document.getElementById(accept.getAttribute("aria-describedby")!)?.textContent).toMatch(/earlier edit may not be visible/);
  expect(sync.disabled).toBe(true);
  fireEvent.change(field(slot, "Figma file URL"), { target: { value: "https://www.figma.com/design/abc" } });
  sync.focus(); expect(document.activeElement).toBe(sync);
  fireEvent.click(sync);
  const disclosure = await slot.findByText(/The cache has a new version baseline/);
  expect(syncMirror).toHaveBeenCalledWith({ file: "https://www.figma.com/design/abc", acceptUnverified: false });
  expect(disclosure.textContent).toContain("The earlier edit isn't verified as visible.");
  expect(disclosure.textContent).toContain(freshness.detail);
  expect(slot.container.querySelector("pre")).toBeNull();
  await slot.behavior.emitRealtime("figma", {});
  expect(slot.getByText(/The cache has a new version baseline/).textContent).toContain(freshness.detail);
  accept.focus(); expect(document.activeElement).toBe(accept);
  fireEvent.click(accept);
  expect(accept.checked).toBe(true);
  fireEvent.click(sync);
  await waitFor(() => expect(syncMirror).toHaveBeenLastCalledWith({ file: "https://www.figma.com/design/abc", acceptUnverified: true }));
  await waitFor(() => expect(accept.checked).toBe(false));
  fireEvent.click(accept);
  fireEvent.change(field(slot, "Figma file URL"), { target: { value: "https://www.figma.com/design/other" } });
  expect(accept.checked).toBe(false);
  expect(slot.queryByText(/The cache has a new version baseline/)).toBeNull();
});

test("sync without freshness metadata still discloses that the earlier edit is unverified", async () => {
  const slot = await mount({ syncMirror: () => ({ isError: true }) });
  await slot.findByLabelText("Read token");
  fireEvent.change(field(slot, "Figma file URL"), { target: { value: "https://www.figma.com/design/abc" } });
  fireEvent.click(button(slot, "Sync"));
  expect((await slot.findByRole("alert")).textContent).toMatch(/freshness is unverified/);
  expect(slot.getByText(/Synced https:\/\/www\.figma\.com\/design\/abc/).textContent).toContain("isn't verified as visible");
});

test("failed file tests remain visible after queued realtime and focus refresh", async () => {
  const request = deferred<SettingsSnapshot>();
  const slot = await mount({ testConnection: () => request.promise });
  await slot.findByLabelText("Read token");
  fireEvent.change(field(slot, "Figma file URL"), { target: { value: "https://www.figma.com/design/abc" } });
  fireEvent.click(button(slot, "Test read"));
  await slot.behavior.emitRealtime("figma", {});
  await act(async () => request.reject(new Error("File access denied")));
  expect((await slot.findByRole("alert")).textContent).toBe("Couldn't verify read access. Try again.");
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(slot.container.querySelector(".figma-settings")?.getAttribute("aria-busy")).toBe("false"));
  expect(slot.getByRole("alert").textContent).toContain("Couldn't verify read access");
});

test("file-test error snapshots retain their failure after status refresh", async () => {
  const failed = snapshot(); failed.mirror = { ...connection, phase: "error", detail: "File permission denied" };
  const slot = await mount({ testConnection: () => failed });
  await slot.findByLabelText("Read token");
  fireEvent.change(field(slot, "Figma file URL"), { target: { value: "https://www.figma.com/design/abc" } });
  fireEvent.click(button(slot, "Test read"));
  expect((await slot.findByRole("alert")).textContent).toContain("File permission denied");
  await slot.behavior.emitRealtime("figma", {});
  expect(slot.getByRole("alert").textContent).toContain("Couldn't verify read access");
});

test("direct sign-in has no Codex process settings or retired callback RPC", async () => {
  const current = snapshot(); current.official.phase = "authorizing";
  const slot = await mount({ status: () => current });
  await slot.findByText("Waiting for sign-in");
  expect(slot.queryByRole("radio")).toBeNull();
  expect(slot.queryByLabelText(/Codex/)).toBeNull();
  expect(slot.queryByLabelText("Callback URL")).toBeNull();
  fireEvent.click(button(slot, "Start over"));
  const link = await slot.findByRole("link", { name: "Approve access in Figma" });
  expect(link.getAttribute("href")).toContain("https://www.figma.com/");
  expect(slot.getByText("This page updates when you return.")).toBeTruthy();
});

test("pending loopback consent can finish after settings remount without a new Connect", async () => {
  const current = snapshot();
  current.config.redirectUri = "http://127.0.0.1:38559/callback";
  current.official.phase = "authorizing";
  const done = snapshot(); done.official.phase = "connected";
  const finish = vi.fn(() => done), connect = vi.fn();
  const slot = await mount({ status: () => current, finishAuthorization: finish, connectOfficial: connect });
  const input = await slot.findByLabelText("Callback URL");
  expect(slot.queryByRole("link", { name: "Approve access in Figma" })).toBeNull();
  expect(slot.container.textContent).not.toMatch(/http:\/\/ is|whitespace|quotes/i);
  expect(button(slot, "Finish sign-in").disabled).toBe(true);
  fireEvent.change(input, { target: { value: "127.0.0.1:38559/callback?code=test&state=test" } });
  fireEvent.click(button(slot, "Finish sign-in"));
  await slot.findByText("Signed in to Figma.");
  expect(connect).not.toHaveBeenCalled(); expect(finish).toHaveBeenCalledTimes(1);
});

test("loopback callback stays visible and editable after failure and clears after BB-owned exchange", async () => {
  let current = snapshot();
  current.config.redirectUri = "http://127.0.0.1:38559/callback";
  const finish = vi.fn(async (_input: { callbackUrl: string }) => {
    if (finish.mock.calls.length === 1) { current.official = { ...connection, phase: "error" }; throw new Error("private callback value"); }
    current.official = { ...connection, phase: "connected" }; return current;
  });
  const slot = await mount({ status: () => current, finishAuthorization: finish,
    connectOfficial: () => { current.official = { ...connection, phase: "authorizing" }; return { authorizationUrl: "https://www.figma.com/oauth/mcp?state=fixture" }; } });
  fireEvent.click(await slot.findByRole("button", { name: "Connect Figma" }));
  const input = await slot.findByLabelText("Callback URL");
  expect(input.getAttribute("type")).toBe("text");
  const copied = ' "127.0.0.1:38559/callback?code=test&state=test" ';
  fireEvent.change(input, { target: { value: copied } });
  fireEvent.click(button(slot, "Finish sign-in"));
  await slot.findByRole("alert");
  expect(field(slot, "Callback URL").value).toBe(copied);
  expect(slot.getByRole("alert").textContent).not.toContain("private callback");
  expect(slot.getByRole("alert").textContent).toMatch(/use Test Figma/);
  expect(finish).toHaveBeenCalledWith({ callbackUrl: copied });
  fireEvent.click(button(slot, "Finish sign-in"));
  await slot.findByText("Signed in to Figma.");
  expect(slot.queryByLabelText("Callback URL")).toBeNull();
  expect(slot.queryByRole("alert")).toBeNull();
  expect(document.activeElement).toBe(slot.getByText("Connected").closest("p"));
});

test("disconnect clears a pending callback and an unrelated success cannot dismiss a failed file test", async () => {
  const configure = vi.fn(() => snapshot());
  const pending = snapshot(); pending.official.phase = "authorizing"; pending.config.redirectUri = "http://127.0.0.1:38559/callback";
  const slot = await mount({ status: () => pending, configure, disconnect: () => snapshot(), testConnection: async () => { throw new Error("private failure"); } });
  fireEvent.change(await slot.findByLabelText("Callback URL"), { target: { value: "127.0.0.1:38559/callback?code=x" } });
  fireEvent.change(field(slot, "Figma file URL"), { target: { value: "https://www.figma.com/design/abc" } });
  fireEvent.click(button(slot, "Test read"));
  expect((await slot.findByRole("alert")).textContent).toContain("Couldn't verify read access");
  fireEvent.click(button(slot, "Disconnect"));
  await slot.findByText("Disconnected.");
  expect(slot.queryByLabelText("Callback URL")).toBeNull();
  fireEvent.change(field(slot, "Client ID"), { target: { value: "updated" } });
  fireEvent.click(within(form(field(slot, "Client ID"))).getByRole("button", { name: "Save" }));
  await slot.findByText("Saved.");
  expect(slot.getByRole("alert").textContent).toContain("Couldn't verify read access");
});
