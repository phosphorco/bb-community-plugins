// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { SettingsSnapshot } from "../contract.ts";
import type { rpcContract } from "../rpc-contract.ts";

const connection = { phase: "disconnected" as const, detail: null, connectedAt: null, serverVersion: null };
function snapshot(): SettingsSnapshot {
  return { scope: "shared", config: { clientId: "public-client", clientSecretConfigured: true, redirectUri: "https://bb.example/callback" }, official: { ...connection }, tools: { official: [] }, aliasesNeedReload: false };
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
    finishAuthorization: () => snapshot(), connectOfficial: () => ({ authorizationUrl: "https://mcp.sentry.dev/oauth/authorize?state=test" }),
    disconnect: () => snapshot(), testConnection: () => snapshot(), refreshTools: () => snapshot(), ...overrides,
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

test("starting an unrelated action cannot clear a failed status read; an authoritative snapshot recovers it", async () => {
  let unavailable = false;
  const begin = deferred<{ authorizationUrl: string }>();
  const slot = await mount({
    status: () => { if (unavailable) throw new Error("private failure"); return snapshot(); },
    connectOfficial: () => begin.promise,
  });
  await slot.findByRole("button", { name: "Connect Sentry" });
  unavailable = true;
  fireEvent(window, new Event("focus"));
  await slot.findByText("Couldn't check Sentry status.");
  fireEvent.click(button(slot, "Connect Sentry"));
  expect(slot.getByText("Couldn't check Sentry status.")).toBeTruthy();
  await act(async () => begin.reject(new Error("private action failure")));
  expect(slot.getByText("Couldn't check Sentry status.")).toBeTruthy();
  unavailable = false;
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(slot.queryByText("Couldn't check Sentry status.")).toBeNull());
  expect(slot.getByText("Couldn't start sign-in.")).toBeTruthy();
});

test("host chrome states the shared scope once and the body does not repeat it", async () => {
  const section = await load();
  expect(section.title).toBe("Connection");
  expect(section.description).toMatch(/shared by everyone using this BB deployment/);
  const slot = await mount();
  await slot.findByRole("button", { name: "Connect Sentry" });
  expect(slot.container.textContent).not.toMatch(/shared|deployment/i);
});

test("disconnected saved grant is explained once and recovered with Test Sentry", async () => {
  let current = snapshot();
  current.official = { ...connection, detail: "Saved Sentry authorization is available. Test Sentry or an agent call resumes it without a new sign-in." };
  const testConnection = vi.fn(() => { current = { ...current, official: { ...connection, phase: "connected" } }; return current; });
  const slot = await mount({ status: () => current, testConnection });
  await slot.findByText("Not connected");
  expect(slot.getAllByText(/Saved Sentry authorization is available/)).toHaveLength(1);
  expect(button(slot, "Connect Sentry").className).toContain("sentry-button-primary");
  expect(slot.queryByRole("button", { name: "Disconnect" })).toBeNull();
  fireEvent.click(button(slot, "Test Sentry"));
  await slot.findByText("Sentry is working.");
  expect(testConnection).toHaveBeenCalledWith({ source: "official" });
  expect(slot.getByText("Connected")).toBeTruthy();
  expect(slot.queryByText(/Saved Sentry authorization/)).toBeNull();
});

test("error phase shows the problem as text, not only colour", async () => {
  const current = snapshot(); current.official = { ...connection, phase: "error", detail: "Sentry returned HTTP 401." };
  const slot = await mount({ status: () => current });
  expect(await slot.findByText("Connection problem")).toBeTruthy();
  expect(slot.getByText("Sentry returned HTTP 401.").className).toBe("sentry-error");
  expect(slot.container.querySelector(".sentry-dot")?.getAttribute("aria-hidden")).toBe("true");
});

test("Connect shows busy state, then an explicit link, and refreshes on return without a popup", async () => {
  const begin = deferred<{ authorizationUrl: string }>();
  const popup = vi.spyOn(window, "open");
  let current = snapshot();
  const status = vi.fn(() => current);
  const slot = await mount({ status, connectOfficial: () => begin.promise });
  fireEvent.click(await slot.findByRole("button", { name: "Connect Sentry" }));
  expect(slot.getByText("Starting sign-in…").getAttribute("role")).toBe("status");
  expect(button(slot, "Test Sentry").disabled).toBe(true);
  expect(slot.container.querySelector(".sentry-settings")?.getAttribute("aria-busy")).toBe("true");
  expect(slot.queryByRole("link")).toBeNull();
  current = { ...current, official: { ...connection, phase: "authorizing" } };
  await act(async () => begin.resolve({ authorizationUrl: "https://mcp.sentry.dev/oauth/authorize?state=test" }));
  const link = await slot.findByRole("link", { name: "Approve access in Sentry" });
  expect(link.getAttribute("href")).toBe("https://mcp.sentry.dev/oauth/authorize?state=test");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
  expect(popup).not.toHaveBeenCalled();
  expect(await slot.findByText("Waiting for sign-in")).toBeTruthy();
  expect(button(slot, "Start over").className).not.toContain("sentry-button-primary");
  current = { ...current, official: { ...connection, phase: "connected" } };
  fireEvent(window, new Event("focus"));
  await slot.findByText("Connected");
  expect(slot.queryByRole("link")).toBeNull();
  const count = status.mock.calls.length;
  await slot.behavior.emitRealtime("sentry", {});
  await waitFor(() => expect(status.mock.calls.length).toBe(count + 1));
});

test("automatic registration needs no manual credentials and displays a sanitized rejection without replay", async () => {
  let current = snapshot();
  current.config = { ...current.config, clientId: "", clientSecretConfigured: false };
  const connectOfficial = vi.fn(async () => {
    current = { ...current, official: { ...connection, phase: "error", detail: "Sentry rejected Codex-compatible client registration (HTTP 403). Check the callback URL or use preregistered client credentials." } };
    throw new Error("untrusted upstream body with secret");
  });
  const slot = await mount({ status: () => current, connectOfficial });
  const connect = await slot.findByRole("button", { name: "Connect Sentry" });
  expect(slot.queryByRole("button", { name: "Use automatic registration" })).toBeNull();
  fireEvent.click(connect);
  await slot.findByText(/Sentry rejected Codex-compatible client registration \(HTTP 403\)/);
  expect(slot.getByRole("alert").textContent).toBe("Couldn't start sign-in.");
  expect(slot.queryByRole("link", { name: "Approve access in Sentry" })).toBeNull();
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(slot.queryByText("Connection problem")).toBeTruthy());
  expect(connectOfficial).toHaveBeenCalledTimes(1);
});

test("failed saves keep drafts, suppress secret-bearing errors and permit retry", async () => {
  const configure = vi.fn().mockRejectedValueOnce(new Error("secret input: private-token")).mockResolvedValue(snapshot());
  const slot = await mount({ configure });
  const token = await slot.findByLabelText("Client secret") as HTMLInputElement;
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
  fireEvent.click(await slot.findByRole("button", { name: "Connect Sentry" }));
  slot.unmount();
  fireEvent(window, new Event("focus"));
  await act(async () => begin.resolve({ authorizationUrl: "https://mcp.sentry.dev/oauth/authorize" }));
  expect(status).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".sentry-settings")).toBeNull();
});

test("unsafe authorization links fail explicitly", async () => {
  const slot = await mount({ finishAuthorization: () => snapshot(), connectOfficial: () => ({ authorizationUrl: "javascript:alert(1)" }) });
  fireEvent.click(await slot.findByRole("button", { name: "Connect Sentry" }));
  expect((await slot.findByRole("alert")).textContent).toBe("Couldn't start sign-in.");
  expect(slot.queryByRole("link")).toBeNull();
});

test("direct sign-in has no Codex process settings or retired callback RPC", async () => {
  const current = snapshot(); current.official.phase = "authorizing";
  const slot = await mount({ status: () => current });
  await slot.findByText("Waiting for sign-in");
  expect(slot.queryByRole("radio")).toBeNull();
  expect(slot.queryByLabelText(/Codex/)).toBeNull();
  expect(slot.queryByLabelText("Callback URL")).toBeNull();
  fireEvent.click(button(slot, "Start over"));
  const link = await slot.findByRole("link", { name: "Approve access in Sentry" });
  expect(link.getAttribute("href")).toContain("https://mcp.sentry.dev/");
  expect(slot.getByText("This page updates when you return.")).toBeTruthy();
});

test("pending loopback consent can finish after settings remount without a new Connect", async () => {
  const current = snapshot();
  current.config.redirectUri = "http://127.0.0.1:38560/callback";
  current.official.phase = "authorizing";
  const done = snapshot(); done.official.phase = "connected";
  const finish = vi.fn(() => done), connect = vi.fn();
  const slot = await mount({ status: () => current, finishAuthorization: finish, connectOfficial: connect });
  const input = await slot.findByLabelText("Callback URL");
  expect(slot.queryByRole("link", { name: "Approve access in Sentry" })).toBeNull();
  expect(slot.container.textContent).not.toMatch(/http:\/\/ is|whitespace|quotes/i);
  expect(button(slot, "Finish sign-in").disabled).toBe(true);
  fireEvent.change(input, { target: { value: "127.0.0.1:38560/callback?code=test&state=test" } });
  fireEvent.click(button(slot, "Finish sign-in"));
  await slot.findByText("Signed in to Sentry.");
  expect(connect).not.toHaveBeenCalled(); expect(finish).toHaveBeenCalledTimes(1);
});

test("loopback callback stays visible and editable after failure and clears after BB-owned exchange", async () => {
  let current = snapshot();
  current.config.redirectUri = "http://127.0.0.1:38560/callback";
  const finish = vi.fn(async (_input: { callbackUrl: string }) => {
    if (finish.mock.calls.length === 1) { current.official = { ...connection, phase: "error" }; throw new Error("private callback value"); }
    current.official = { ...connection, phase: "connected" }; return current;
  });
  const slot = await mount({ status: () => current, finishAuthorization: finish,
    connectOfficial: () => { current.official = { ...connection, phase: "authorizing" }; return { authorizationUrl: "https://mcp.sentry.dev/oauth/authorize?state=fixture" }; } });
  fireEvent.click(await slot.findByRole("button", { name: "Connect Sentry" }));
  const input = await slot.findByLabelText("Callback URL");
  expect(input.getAttribute("type")).toBe("text");
  const copied = ' "127.0.0.1:38560/callback?code=test&state=test" ';
  fireEvent.change(input, { target: { value: copied } });
  fireEvent.click(button(slot, "Finish sign-in"));
  await slot.findByRole("alert");
  expect(field(slot, "Callback URL").value).toBe(copied);
  expect(slot.getByRole("alert").textContent).not.toContain("private callback");
  expect(slot.getByRole("alert").textContent).toMatch(/use Test Sentry/);
  expect(finish).toHaveBeenCalledWith({ callbackUrl: copied });
  fireEvent.click(button(slot, "Finish sign-in"));
  await slot.findByText("Signed in to Sentry.");
  expect(slot.queryByLabelText("Callback URL")).toBeNull();
  expect(slot.queryByRole("alert")).toBeNull();
  expect(document.activeElement).toBe(slot.getByText("Connected").closest("p"));
});
