import { test, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { decisionsFixture } from "../admission/decisions.fixture.ts";
import { renderToStaticMarkup } from "react-dom/server";
import type { Client, Snapshot } from "../../ui/types.ts";
import type { RecentDecisions } from "../../admission/decisions-contract.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://message-rules.test/", pretendToBeVisual: true });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Event", "MouseEvent", "Node", "MutationObserver"] as const) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? dom.window : name === "document" ? dom.window.document : dom.window[name] });
}
previous.set("IS_REACT_ACT_ENVIRONMENT", Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"));
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
const { act } = await import("react");
const { renderSlot, installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { MessageRulesBody } = await import("../../ui/message-rules-body.tsx");
const { RecentNativeDecisions } = await import("../../ui/recent-decisions.tsx");
const { EnforcementBanner } = await import("../../ui/enforcement-banner.tsx");
const { contract } = await import("../../suite-rpc-contract.ts");
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
async function click(element: HTMLElement) { await act(async () => { element.click(); }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("actual mounted panel reads decisions only on demand, renders rejected/unresolved and all diagnostics; More/Refresh failures retain the last page", async () => {
  const app = await decisionsFixture();
  app.setActive(null);
  for (let n = 0; n < 12; n++) await app.capture("callback-" + n, n % 2 ? "unresolved" : "rejected");
  let fail = false, reads = 0;
  const initial = deferred<any>();
  let first = true;
  const rpc = Object.fromEntries(Object.keys(contract).map(method => [method, async (input: unknown) => {
    if (method === "snapshot" && first) { first = false; return initial.promise; }
    if (method === "listRecentDecisions") { reads++; if (fail) throw Error("fixture page read offline"); }
    return app.rpc(method, input as object);
  }]));
  const slot = renderSlot({ component: MessageRulesBody }, { subPath: "", drafts: new Map() }, {
    pluginId: "message-rules", rpc,
    sdk: { projects: { list: async () => [{ id: "project-test", name: "Testing project" }] } } as never,
  });
  try {
    assert.match(slot.getByRole("status", { name: "Message Rules enforcement" }).textContent!, /Enforcement status unknown/);
    assert.equal(reads, 0);
    await act(async () => { initial.resolve(await app.snapshot()); });
    await slot.findByText("Not enforcing");
    assert.equal(reads, 0);
    await click(slot.getByText("Recent native decisions"));
    assert.equal(reads, 0, "opening the section alone does not fetch");
    await click(slot.getByRole("button", { name: "Read recent decisions" }));
    assert.equal((await slot.findAllByText("Native outcome: unresolved")).length, 5);
    const page = slot.getByRole("region", { name: "Recent native decisions" });
    assert.match(page.textContent!, /Native outcome: rejected/);
    for (const text of ["All advice 1", "All advice 2", "rule-1", "rule-2", "sender-id", "destination-id", "Sender name", "Destination name", "operation-callback-11", "frozen-publication", "configuration 17", "message-rules-v1.7", "scoped-group", "project-test", "Feedback: uncertain", "Delivery: none", "machine-id", "user-id", "10.20.30.40"])
      assert.ok(page.textContent!.includes(text), text);
    assert.match(page.textContent!, /Local MR evaluation — diagnostic, not native finality/);
    assert.match(page.textContent!, /MR evaluator callbacks retained here/);
    assert.doesNotMatch(page.textContent!, new RegExp(app.secret + "|snapshotBytes|policyBytes"));
    assert.equal(reads, 1);
    const calls = { ...app.counters };
    fail = true;
    await click(slot.getByRole("button", { name: "More" }));
    await slot.findByRole("alert");
    assert.match(slot.getByRole("alert").textContent!, /Decision read failed.*Last successful page retained/);
    assert.match(page.textContent!, /callback-11/);
    fail = false;
    await click(slot.getByRole("button", { name: "More" }));
    await slot.findByText(/· callback-1$/, { selector: "summary" });
    assert.doesNotMatch(page.textContent!, /callback-11/);
    assert.match(page.textContent!, /callback-0/);
    assert.equal(slot.queryByRole("alert"), null);
    assert.equal(slot.queryByRole("button", { name: "More" }), null);
    fail = true;
    await click(slot.getByRole("button", { name: "Refresh" }));
    assert.match((await slot.findByRole("alert")).textContent!, /fixture page read offline/);
    assert.match(page.textContent!, /callback-0/);
    fail = false;
    await click(slot.getByRole("button", { name: "Refresh" }));
    await slot.findByText(/· callback-11$/, { selector: "summary" });
    assert.equal(slot.queryByRole("alert"), null);
    const before = reads;
    slot.rerender(<MessageRulesBody subPath="group/no-such-group" drafts={new Map()} />);
    await act(async () => {});
    assert.equal(reads, before, "navigation/rerenders do not fetch native history");
    const callback = slot.getByText(/· callback-11$/, { selector: "summary" });
    await click(callback);
    const detailButton = callback.closest("details")!.querySelector("button")!;
    assert.equal(detailButton.textContent, "Read callback detail");
    await click(detailButton);
    await slot.findByRole("region", { name: "Recent native decisions", busy: false });
    assert.doesNotMatch(page.textContent!, /callback-10/);
    assert.match(page.textContent!, /operation-callback-11/);
    assert.equal(app.counters.evaluate, calls.evaluate);
    assert.equal(app.counters.paid, 0); assert.equal(app.counters.writes, 0);
  } finally { slot.unmount(); await app.close(); }
});

test("banner requires a current authoritative pointer and ready generation, names exact frozen scope/version, and never asserts global current-project membership", async () => {
  const app = await decisionsFixture();
  try {
    const publication = app.publication;
    const projects = [{ id: "project-test", name: "Testing project" }];
    const ready: Snapshot["delivery"] = { state: "available", reason: "fixture ready", activeKnown: true, generationReady: true, activePublication: publication };
    const html = renderToStaticMarkup(<EnforcementBanner delivery={ready} projects={projects} />);
    for (const text of ["Enforcing Message Rules", "frozen-publication", "configuration 17", "message-rules-v1.7", "Testing project (project-test)", "frozen project scope", "never enroll a project"]) assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /current project|this project|preview/i);
    for (const delivery of [
      { ...ready, generationReady: false, state: "unavailable" },
      { ...ready, activeKnown: false },
      { ...ready, state: "unsupported", activePublication: null, activeKnown: false },
      { state: "unconfigured", reason: "unknown pointer", activeKnown: false, generationReady: false, activePublication: null },
    ]) {
      const unknown = renderToStaticMarkup(<EnforcementBanner delivery={delivery} projects={projects} />);
      assert.match(unknown, /Enforcement status unavailable/);
      assert.doesNotMatch(unknown, /Not enforcing|Enforcing Message Rules/);
    }
    const failed = renderToStaticMarkup(<EnforcementBanner delivery={ready} readError="fixture read failed" projects={projects} />);
    assert.match(failed, /Last observed publication/);
    assert.match(failed, /current native pointer is unknown/);
    const inactive = renderToStaticMarkup(<EnforcementBanner delivery={{ ...ready, generationReady: false, activePublication: null }} projects={projects} />);
    assert.match(inactive, /Not enforcing/);
  } finally { await app.close(); }
});

test("read lifetime resets an obsolete busy client and fences late responses and unmount; explicit retry clears a same-content error", async () => {
  const empty: RecentDecisions = { coverage: "MR evaluator callbacks retained here", retention: "no-retained-callbacks", rows: [], nextCursor: null };
  const old = deferred<RecentDecisions>();
  const oldClient: Client = { call: async () => { throw Error("unused"); }, listRecentDecisions: () => old.promise };
  let fail = false, reads = 0;
  const nextClient: Client = { call: oldClient.call, listRecentDecisions: async () => { reads++; if (fail) throw Error("same-content read offline"); return empty; } };
  const slot = renderSlot({ component: RecentNativeDecisions }, { client: oldClient });
  try {
    await click(slot.getByText("Recent native decisions"));
    await click(slot.getByRole("button", { name: "Read recent decisions" }));
    assert.equal((slot.getByRole("button", { name: "Read recent decisions" }) as HTMLButtonElement).disabled, true);
    slot.rerender(<RecentNativeDecisions client={nextClient} />);
    assert.equal((slot.getByRole("button", { name: "Read recent decisions" }) as HTMLButtonElement).disabled, false);
    assert.equal(reads, 0);
    fail = true;
    await click(slot.getByRole("button", { name: "Read recent decisions" }));
    assert.match((await slot.findByRole("alert")).textContent!, /No decision page has been read/);
    assert.doesNotMatch(slot.container.textContent!, /No retained MR evaluator callbacks/);
    fail = false;
    await click(slot.getByRole("button", { name: "Read recent decisions" }));
    await slot.findByText("No retained MR evaluator callbacks; the ledger does not exist yet.");
    await act(async () => { old.resolve({ ...empty, retention: "present" }); });
    assert.match(slot.container.textContent!, /ledger does not exist yet/);
    fail = true;
    await click(slot.getByRole("button", { name: "Refresh" }));
    await slot.findByRole("alert");
    fail = false;
    await click(slot.getByRole("button", { name: "Refresh" }));
    assert.equal(slot.queryByRole("alert"), null);
    assert.match(slot.container.textContent!, /ledger does not exist yet/);
  } finally { slot.unmount(); }
  const pending = deferred<RecentDecisions>();
  const retired = renderSlot({ component: RecentNativeDecisions }, { client: { ...oldClient, listRecentDecisions: () => pending.promise } });
  await click(retired.getByText("Recent native decisions"));
  await click(retired.getByRole("button", { name: "Read recent decisions" }));
  retired.unmount();
  await act(async () => { pending.resolve(empty); });
});
