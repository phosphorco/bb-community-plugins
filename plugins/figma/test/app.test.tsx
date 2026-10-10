// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { SettingsSnapshot } from "../contract.ts";
import type { rpcContract } from "../rpc-contract.ts";

const connection = { phase: "disconnected" as const, detail: null, connectedAt: null, serverVersion: null };
function snapshot(): SettingsSnapshot {
  return { scope: "shared", config: { officialMode: "direct", codexBinaryPath: "/usr/local/bin/codex", codexServerName: "figma_bb_diagnostic", codexEnabled: false, binaryPath: "figmog", mirrorEnabled: true, binaryAvailable: true, tokenConfigured: true, clientId: "public-client", clientSecretConfigured: true, redirectUri: "https://bb.example/callback" }, official: { ...connection }, mirror: { ...connection }, tools: { official: [], mirror: [] }, aliasesNeedReload: false };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}
async function mount(overrides: Partial<PluginRpcTestHandlers<typeof rpcContract>> = {}) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  expect(app.settingsSections).toHaveLength(1);
  const rpc: PluginRpcTestHandlers<typeof rpcContract> = {
    status: () => snapshot(), configure: () => snapshot(),
    connectOfficial: () => ({ authorizationUrl: "https://www.figma.com/oauth?state=test" }),
    finishCodexAuth: () => snapshot(), disconnect: () => snapshot(), testConnection: () => snapshot(), refreshTools: () => snapshot(), syncMirror: () => ({}), ...overrides,
  };
  return renderSlot(app.settingsSections[0]!, {}, { rpc });
}
beforeEach(() => {
  // Vitest preserves Node 26's native storage globals; use this test DOM's stores.
  const browser = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom.window;
  vi.stubGlobal("localStorage", browser.localStorage);
  vi.stubGlobal("sessionStorage", browser.sessionStorage);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("missing optional figmog offers installation help while official Connect stays usable", async () => {
  let current = snapshot();
  current.config = { ...current.config, mirrorEnabled: false, binaryAvailable: false };
  const configure = vi.fn((input: { mirrorEnabled?: boolean }) => {
    current = { ...current, config: { ...current.config, ...input } };
    return current;
  });
  const slot = await mount({ status: () => current, configure });
  const toggle = await slot.findByRole("checkbox", { name: "Use figmog for cached reads" });
  expect((toggle as HTMLInputElement).checked).toBe(false);
  expect(slot.getByRole("link", { name: "Optional figmog installation instructions" }).getAttribute("href")).toContain("sanctuarycomputer/figmog");
  expect((slot.getByRole("button", { name: "Connect Figma" }) as HTMLButtonElement).disabled).toBe(false);
  expect((slot.getByRole("button", { name: "Refresh read tools" }) as HTMLButtonElement).disabled).toBe(true);
  expect(slot.queryByRole("button", { name: "Sync read cache" })).toBeNull();
  fireEvent.click(toggle);
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(configure).toHaveBeenCalledWith({ mirrorEnabled: true }));
});

test("native settings page has labelled write-only secrets, shared scope and empty inventory", async () => {
  const slot = await mount();
  const token = await slot.findByLabelText("Replace Figma read token");
  expect((token as HTMLInputElement).value).toBe("");
  const secret = slot.getByLabelText("Replace Figma OAuth client secret") as HTMLInputElement;
  expect(secret.type).toBe("password"); expect(secret.value).toBe("");
  expect(slot.getByText(/shared across this BB deployment/)).toBeTruthy();
  expect(slot.getByText("After a BB restart, Test Figma resumes saved authorization; Connect Figma starts a new sign-in.")).toBeTruthy();
  expect(slot.getByLabelText("Figma OAuth client ID").getAttribute("value")).toBe("public-client");
  expect(slot.getAllByText(/No tools discovered/)).toHaveLength(2);
  const summary = slot.getByText("Advanced configuration");
  expect(summary.tagName).toBe("SUMMARY");
  summary.focus(); expect(document.activeElement).toBe(summary);
  token.focus(); expect(document.activeElement).toBe(token);
  const button = slot.getByRole("button", { name: "Connect Figma" });
  button.focus(); expect(document.activeElement).toBe(button);
  expect((slot.getByRole("button", { name: "Test read" }) as HTMLButtonElement).disabled).toBe(true);
});

test("saving omits unchanged secrets and clears successful replacement inputs", async () => {
  const configure = vi.fn(() => snapshot());
  const slot = await mount({ configure });
  await slot.findByLabelText("Replace Figma read token");
  fireEvent.change(slot.getByLabelText("Figma OAuth client ID"), { target: { value: "updated-client" } });
  fireEvent.submit(slot.getByRole("button", { name: "Save settings" }).closest("form")!);
  await waitFor(() => expect(configure).toHaveBeenCalledWith({ clientId: "updated-client" }));
  await slot.findByText(/Settings saved/);
  fireEvent.change(slot.getByLabelText("Replace Figma read token"), { target: { value: "read-secret" } });
  fireEvent.change(slot.getByLabelText("Replace Figma OAuth client secret"), { target: { value: "oauth-secret" } });
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(configure).toHaveBeenLastCalledWith({ readToken: "read-secret", clientSecret: "oauth-secret" }));
  await waitFor(() => expect((slot.getByLabelText("Replace Figma read token") as HTMLInputElement).value).toBe(""));
  expect((slot.getByLabelText("Replace Figma OAuth client secret") as HTMLInputElement).value).toBe("");
  expect(window.localStorage.length).toBe(0); expect(window.sessionStorage.length).toBe(0);
});

test("Connect gives an explicit link and refreshes on OAuth return without opening a popup", async () => {
  const begin = deferred<{ authorizationUrl: string }>();
  const popup = vi.spyOn(window, "open");
  let current = snapshot();
  const status = vi.fn(() => current);
  const slot = await mount({ status, connectOfficial: () => begin.promise });
  await slot.findByLabelText("Replace Figma read token");
  fireEvent.click(slot.getByRole("button", { name: "Connect Figma" }));
  expect(slot.queryByRole("link")).toBeNull();
  current = { ...current, official: { ...connection, phase: "authorizing" } };
  await act(async () => begin.resolve({ authorizationUrl: "https://www.figma.com/oauth?state=test" }));
  const link = await slot.findByRole("link", { name: "Authorize Figma in a new tab" });
  expect(link.getAttribute("href")).toBe("https://www.figma.com/oauth?state=test");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(popup).not.toHaveBeenCalled();
  current = { ...current, official: { ...connection, phase: "connected" } };
  fireEvent(window, new Event("focus"));
  await slot.findByText("Status: connected");
  expect(slot.queryByRole("link")).toBeNull();
  const count = status.mock.calls.length;
  await slot.behavior.emitRealtime("figma", {});
  await waitFor(() => expect(status.mock.calls.length).toBe(count + 1));
});

test("automatic registration needs no manual credentials and displays a sanitized rejection without replay", async () => {
  let current = snapshot();
  current.config = { ...current.config, clientId: "", clientSecretConfigured: false };
  const connectOfficial = vi.fn(async () => {
    current = { ...current, official: { ...connection, phase: "error", detail: "Figma rejected BB client registration (HTTP 403). Request admission or configure your own registered client." } };
    throw new Error("untrusted upstream body with secret");
  });
  const slot = await mount({ status: () => current, connectOfficial });
  const button = await slot.findByRole("button", { name: "Connect Figma" });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(slot.queryByRole("button", { name: "Use automatic registration" })).toBeNull();
  fireEvent.click(button);
  await slot.findByText(/Figma rejected BB client registration \(HTTP 403\)/);
  expect(slot.getByRole("alert").textContent).not.toContain("untrusted upstream");
  expect(slot.queryByRole("link", { name: "Authorize Figma in a new tab" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Refresh status" }));
  await slot.findByText("Status: error");
  expect(connectOfficial).toHaveBeenCalledTimes(1);
});

test("removing the manual client override keeps the read token and does not start registration", async () => {
  const next = snapshot(); next.config = { ...next.config, clientId: "", clientSecretConfigured: false };
  const configure = vi.fn(() => next);
  const connectOfficial = vi.fn();
  const slot = await mount({ configure, connectOfficial });
  fireEvent.click(await slot.findByRole("button", { name: "Use automatic registration", hidden: true }));
  await waitFor(() => expect(configure).toHaveBeenCalledWith({ clientId: "", clientSecret: "" }));
  await slot.findByText(/Client override removed/);
  expect(slot.getByText("A token is configured. Leave blank to keep the current token. Disconnect read removes it.")).toBeTruthy();
  expect(connectOfficial).not.toHaveBeenCalled();
});

test("late status cannot overwrite disconnect and refresh coalesces invalidations", async () => {
  const old = deferred<SettingsSnapshot>();
  let reads = 0;
  const disconnected = snapshot(); disconnected.mirror.phase = "unconfigured"; disconnected.config.tokenConfigured = false;
  const status = vi.fn(() => ++reads === 2 ? old.promise : reads > 2 ? disconnected : snapshot());
  const disconnect = vi.fn(() => disconnected);
  const slot = await mount({ status, disconnect });
  await slot.findByLabelText("Replace Figma read token");
  fireEvent(window, new Event("focus"));
  fireEvent(window, new Event("focus"));
  fireEvent.click(slot.getByRole("button", { name: "Disconnect read" }));
  await slot.findByText("Status: unconfigured");
  expect(disconnect).toHaveBeenCalledWith({ source: "mirror" });
  const stale = snapshot(); stale.mirror.phase = "connected";
  await act(async () => old.resolve(stale));
  await waitFor(() => expect(status).toHaveBeenCalledTimes(3));
  expect(slot.queryByText("Status: connected")).toBeNull();
  expect(slot.getByText(/No token is configured/)).toBeTruthy();
});

test("failed load has retry; file test and inventory refresh use only contract RPC", async () => {
  const status = vi.fn().mockRejectedValueOnce(new Error("internal failure")).mockResolvedValue(snapshot());
  const tested = snapshot(); tested.mirror = { ...connection, phase: "error", detail: "File access denied" };
  const testConnection = vi.fn(() => tested);
  const catalog = snapshot(); catalog.tools.official = [{ name: "figma_read", description: "Read the design", inputSchema: {} }]; catalog.aliasesNeedReload = true;
  const refreshTools = vi.fn(() => catalog);
  const slot = await mount({ status, testConnection, refreshTools });
  await slot.findByRole("alert");
  fireEvent.click(slot.getByRole("button", { name: "Retry status" }));
  await slot.findByLabelText("Replace Figma read token");
  fireEvent.change(slot.getByLabelText("Figma file URL for connection test"), { target: { value: "https://www.figma.com/design/abc" } });
  fireEvent.click(slot.getByRole("button", { name: "Test read" }));
  await slot.findByText("File access denied");
  expect(testConnection).toHaveBeenCalledWith({ source: "mirror", file: "https://www.figma.com/design/abc" });
  fireEvent.click(slot.getByRole("button", { name: "Refresh figma tools" }));
  await slot.findByText("figma_read");
  expect(refreshTools).toHaveBeenCalledWith({ source: "official" });
  expect(slot.getByText(/shortcuts need a plugin reload/)).toBeTruthy();
});

test("failed saves keep drafts, suppress secret-bearing errors and permit retry", async () => {
  const configure = vi.fn().mockRejectedValueOnce(new Error("secret input: private-token")).mockResolvedValue(snapshot());
  const slot = await mount({ configure });
  await slot.findByLabelText("Replace Figma read token");
  fireEvent.change(slot.getByLabelText("Replace Figma read token"), { target: { value: "private-token" } });
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  const alert = await slot.findByRole("alert");
  expect(alert.textContent).not.toContain("private-token");
  expect((slot.getByLabelText("Replace Figma read token") as HTMLInputElement).value).toBe("private-token");
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText(/Settings saved/);
  expect(configure).toHaveBeenCalledTimes(2);
});

test("unmount removes focus subscription and ignores late OAuth result", async () => {
  const begin = deferred<{ authorizationUrl: string }>();
  const status = vi.fn(() => snapshot());
  const slot = await mount({ status, connectOfficial: () => begin.promise });
  await slot.findByLabelText("Replace Figma read token");
  fireEvent.click(slot.getByRole("button", { name: "Connect Figma" }));
  slot.unmount();
  fireEvent(window, new Event("focus"));
  await act(async () => begin.resolve({ authorizationUrl: "https://www.figma.com/oauth" }));
  expect(status).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".figma-settings")).toBeNull();
});

test("unsafe authorization links fail explicitly", async () => {
  const slot = await mount({ connectOfficial: () => ({ authorizationUrl: "javascript:alert(1)" }) });
  await slot.findByLabelText("Replace Figma read token");
  fireEvent.click(slot.getByRole("button", { name: "Connect Figma" }));
  await slot.findByRole("alert");
  expect(slot.queryByRole("link")).toBeNull();
});

test("explicit cache sync uses file URL and preserves returned unverified freshness disclosure", async () => {
  const freshness = { state: "rebaselined", mutationVisibilityVerified: false, detail: "No prior version baseline was available." };
  const syncMirror = vi.fn(() => ({ _meta: { bbFigmaFreshness: freshness } }));
  const slot = await mount({ syncMirror });
  await slot.findByLabelText("Replace Figma read token");
  const button = slot.getByRole("button", { name: "Sync read cache" }) as HTMLButtonElement;
  const accept = slot.getByRole("checkbox", { name: "Accept refreshed cache without verifying the prior edit" }) as HTMLInputElement;
  expect(accept.checked).toBe(false);
  expect(button.disabled).toBe(true);
  fireEvent.change(slot.getByLabelText("Figma file URL for connection test"), { target: { value: "https://www.figma.com/design/abc" } });
  button.focus(); expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  const disclosure = await slot.findByText(/The read cache now has a new version baseline/);
  expect(syncMirror).toHaveBeenCalledWith({ file: "https://www.figma.com/design/abc", acceptUnverified: false });
  expect(disclosure.textContent).toContain("Visibility of the earlier edit is unverified.");
  expect(disclosure.textContent).toContain(freshness.detail);
  expect(slot.container.querySelector("pre")).toBeNull();
  expect(slot.getByText("A cache pull alone does not verify that a prior edit is visible.")).toBeTruthy();
  await slot.behavior.emitRealtime("figma", {});
  expect(slot.getByText(/The read cache now has a new version baseline/).textContent).toContain("Visibility of the earlier edit is unverified.");
  accept.focus(); expect(document.activeElement).toBe(accept);
  fireEvent.click(accept);
  expect(accept.checked).toBe(true);
  fireEvent.click(button);
  await waitFor(() => expect(syncMirror).toHaveBeenLastCalledWith({ file: "https://www.figma.com/design/abc", acceptUnverified: true }));
  await waitFor(() => expect(accept.checked).toBe(false));
  fireEvent.click(accept);
  fireEvent.change(slot.getByLabelText("Figma file URL for connection test"), { target: { value: "https://www.figma.com/design/other" } });
  expect(accept.checked).toBe(false);
  expect(slot.queryByText(/The read cache now has a new version baseline/)).toBeNull();
});

test("failed file tests remain visible after queued realtime and focus refresh", async () => {
  const request = deferred<SettingsSnapshot>();
  const slot = await mount({ testConnection: () => request.promise });
  await slot.findByLabelText("Replace Figma read token");
  fireEvent.change(slot.getByLabelText("Figma file URL for connection test"), { target: { value: "https://www.figma.com/design/abc" } });
  fireEvent.click(slot.getByRole("button", { name: "Test read" }));
  await slot.behavior.emitRealtime("figma", {});
  await act(async () => request.reject(new Error("File access denied")));
  expect((await slot.findByRole("alert")).textContent).toContain("Test read failed");
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(slot.queryByText("Loading Figma settings…")).toBeNull());
  expect(slot.getByRole("alert").textContent).toContain("Test read failed");
});

test("file-test error snapshots retain their failure after status refresh", async () => {
  const failed = snapshot(); failed.mirror = { ...connection, phase: "error", detail: "File permission denied" };
  const slot = await mount({ testConnection: () => failed });
  await slot.findByLabelText("Replace Figma read token");
  fireEvent.change(slot.getByLabelText("Figma file URL for connection test"), { target: { value: "https://www.figma.com/design/abc" } });
  fireEvent.click(slot.getByRole("button", { name: "Test read" }));
  expect((await slot.findByRole("alert")).textContent).toContain("File permission denied");
  await slot.behavior.emitRealtime("figma", {});
  expect(slot.getByRole("alert").textContent).toContain("Test read did not verify access");
});

function codexSnapshot(): SettingsSnapshot {
  const next = snapshot();
  next.config = { ...next.config, officialMode: "codex", codexEnabled: true, mirrorEnabled: false };
  return next;
}

test("connection mode and advanced Codex settings persist without starting registration", async () => {
  let current = snapshot();
  const configure = vi.fn((input) => {
    current = { ...current, config: { ...current.config, ...input } };
    return current;
  });
  const connectOfficial = vi.fn();
  const testConnection = vi.fn(() => current);
  const slot = await mount({ status: () => current, configure, connectOfficial, testConnection });
  fireEvent.click(await slot.findByRole("radio", { name: "Via Codex" }));
  expect(slot.queryByLabelText("Figma OAuth client ID")).toBeNull();
  expect(slot.queryByRole("button", { name: "Use automatic registration", hidden: true })).toBeNull();
  expect((slot.getByRole("button", { name: "Connect Figma" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(slot.getByLabelText("Codex executable absolute path"), { target: { value: "/opt/codex/bin/codex" } });
  fireEvent.change(slot.getByLabelText("Codex MCP server name"), { target: { value: "custom_figma" } });
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText(/Settings saved/);
  expect(configure).toHaveBeenCalledWith({ officialMode: "codex", codexBinaryPath: "/opt/codex/bin/codex", codexServerName: "custom_figma" });
  expect((slot.getByRole("radio", { name: "Via Codex" }) as HTMLInputElement).checked).toBe(true);
  expect(slot.getByText(/Prompts, completion, tasks and subscriptions are unavailable/)).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Test figma" }));
  await waitFor(() => expect(testConnection).toHaveBeenCalledWith({ source: "official" }));
  expect(connectOfficial).not.toHaveBeenCalled();
});

test("Codex callback is visible, permits correction after failure, and clears on acceptance", async () => {
  let current = codexSnapshot();
  const callback = ' "localhost:1234/callback?code=private-code&state=private-state" ';
  const finishCodexAuth = vi.fn().mockImplementationOnce(async () => {
    current = { ...current, official: { ...connection, phase: "error", detail: "Callback address was not accepted. Paste the full browser address and retry." } };
    throw new Error(callback);
  }).mockImplementationOnce(() => {
    current = { ...current, official: { ...connection, phase: "connected" } };
    return current;
  });
  const slot = await mount({ status: () => current, finishCodexAuth, connectOfficial: () => {
    current = { ...current, official: { ...connection, phase: "authorizing" } };
    return { authorizationUrl: "https://www.figma.com/oauth", callbackRequired: true };
  } });
  fireEvent.click(await slot.findByRole("button", { name: "Connect Figma" }));
  const input = await slot.findByLabelText("Figma callback URL") as HTMLInputElement;
  expect(input.type).toBe("text");
  expect(input.autocomplete).toBe("off");
  expect(slot.getByText(/This failure to load is expected/)).toBeTruthy();
  fireEvent.change(input, { target: { value: callback } });
  fireEvent.click(slot.getByRole("button", { name: "Finish sign-in" }));
  await slot.findByText(/Callback address was not accepted/);
  expect(slot.getByRole("alert").textContent).not.toContain("private-code");
  expect(slot.container.textContent).not.toContain("private-state");
  expect(input.value).toBe(callback);
  expect(finishCodexAuth).toHaveBeenCalledWith({ callbackUrl: callback });
  fireEvent.change(input, { target: { value: "http://localhost:1234/callback?code=corrected&state=unchanged" } });
  fireEvent.click(slot.getByRole("button", { name: "Finish sign-in" }));
  await slot.findByText(/Figma sign-in completed/);
  expect(slot.queryByLabelText("Figma callback URL")).toBeNull();
  expect(input.value).toBe("");
  expect(slot.queryByRole("alert")).toBeNull();
  expect(window.localStorage.length).toBe(0); expect(window.sessionStorage.length).toBe(0);
});

for (const cancellation of ["disconnect", "cancel", "mode", "save"] as const) {
  test(`Codex callback clears on ${cancellation} and stale status cannot restore it`, async () => {
    let current = codexSnapshot();
    let pendingRead: ReturnType<typeof deferred<SettingsSnapshot>> | null = null;
    const disconnect = vi.fn(() => {
      current = { ...current, config: { ...current.config, codexEnabled: false }, official: { ...connection } };
      return current;
    });
    const finishCodexAuth = vi.fn();
    const configure = vi.fn((input) => {
      current = { ...current, config: { ...current.config, ...input }, official: { ...connection } };
      return current;
    });
    const slot = await mount({ status: () => pendingRead?.promise ?? current, disconnect, finishCodexAuth, configure,
      connectOfficial: () => {
        current = { ...current, official: { ...connection, phase: "authorizing" } };
        return { authorizationUrl: "https://www.figma.com/oauth", callbackRequired: true };
      } });
    fireEvent.click(await slot.findByRole("button", { name: "Connect Figma" }));
    const input = await slot.findByLabelText("Figma callback URL") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "http://localhost/callback?code=sensitive&state=sensitive" } });
    const stale = current;
    if (cancellation !== "mode") {
      pendingRead = deferred<SettingsSnapshot>();
      fireEvent(window, new Event("focus"));
    }
    if (cancellation === "mode") fireEvent.click(slot.getByRole("radio", { name: "Direct independent BB client (advanced)" }));
    else if (cancellation === "save") {
      fireEvent.click(slot.getByRole("checkbox", { name: "Use figmog for cached reads" }));
      fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
      await slot.findByText(/Settings saved/);
    } else {
      fireEvent.click(slot.getByRole("button", { name: cancellation === "cancel" ? "Cancel sign-in" : "Disconnect figma" }));
      await slot.findByText(/completed. Connection status/);
      expect(disconnect).toHaveBeenCalledWith({ source: "official" });
    }
    if (pendingRead) {
      const old = pendingRead;
      pendingRead = null;
      await act(async () => old.resolve(stale));
    }
    expect(slot.queryByLabelText("Figma callback URL")).toBeNull();
    expect(slot.queryByRole("link", { name: "Authorize Figma in a new tab" })).toBeNull();
    expect(input.value).toBe("");
    expect(finishCodexAuth).not.toHaveBeenCalled();
  });
}

test("unmount clears callback input and ignores a late sign-in result", async () => {
  let current = codexSnapshot();
  const finish = deferred<SettingsSnapshot>();
  const status = vi.fn(() => current);
  const slot = await mount({ status, finishCodexAuth: () => finish.promise, connectOfficial: () => {
    current = { ...current, official: { ...connection, phase: "authorizing" } };
    return { authorizationUrl: "https://www.figma.com/oauth", callbackRequired: true };
  } });
  fireEvent.click(await slot.findByRole("button", { name: "Connect Figma" }));
  const input = await slot.findByLabelText("Figma callback URL") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "http://localhost/callback?code=sensitive&state=sensitive" } });
  fireEvent.click(slot.getByRole("button", { name: "Finish sign-in" }));
  slot.unmount();
  expect(input.value).toBe("");
  const reads = status.mock.calls.length;
  current = { ...current, official: { ...connection, phase: "connected" } };
  await act(async () => finish.resolve(current));
  fireEvent(window, new Event("focus"));
  expect(status).toHaveBeenCalledTimes(reads);
  expect(document.querySelector(".figma-settings")).toBeNull();
});


test("callback entry is not shown unless the Codex connect response requires it", async () => {
  let current = codexSnapshot();
  const slot = await mount({ status: () => current, connectOfficial: () => {
    current = { ...current, official: { ...connection, phase: "authorizing" } };
    return { authorizationUrl: "https://www.figma.com/oauth" };
  } });
  fireEvent.click(await slot.findByRole("button", { name: "Connect Figma" }));
  await slot.findByRole("link", { name: "Authorize Figma in a new tab" });
  expect(slot.queryByLabelText("Figma callback URL")).toBeNull();
  expect(slot.queryByRole("button", { name: "Finish sign-in" })).toBeNull();
});

test("an authoritative route change clears a pending Codex callback even while authorizing", async () => {
  let current = codexSnapshot();
  const slot = await mount({ status: () => current, connectOfficial: () => {
    current = { ...current, official: { ...connection, phase: "authorizing" } };
    return { authorizationUrl: "https://www.figma.com/oauth", callbackRequired: true };
  } });
  fireEvent.click(await slot.findByRole("button", { name: "Connect Figma" }));
  const input = await slot.findByLabelText("Figma callback URL") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "http://localhost/callback?code=sensitive&state=sensitive" } });
  current = { ...current, config: { ...current.config, officialMode: "direct" } };
  await slot.behavior.emitRealtime("figma", {});
  await waitFor(() => expect(slot.queryByRole("link", { name: "Authorize Figma in a new tab" })).toBeNull());
  expect(input.value).toBe("");
  expect(slot.queryByLabelText("Figma callback URL")).toBeNull();
});
