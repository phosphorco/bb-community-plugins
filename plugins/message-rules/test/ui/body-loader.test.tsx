import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createElement, type ComponentType, type ReactElement } from "react";
import { renderToPipeableStream, renderToStaticMarkup } from "react-dom/server";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { createMessageRulesPanel, registerMessageRules } from "../../ui/registration.tsx";
import type { MessageRulesBodyProps } from "../../ui/message-rules-body.tsx";
import type { Draft } from "../../ui/types.ts";

const draft: Draft = { value: "kept draft", base: "saved", hash: null, kind: "rule", enabled: true };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function serverProjection(element: ReactElement) {
  return new Promise<{ html: string; errors: unknown[] }>((resolve, reject) => {
    const output = new PassThrough();
    const errors: unknown[] = [];
    let html = "";
    let renderer!: ReturnType<typeof renderToPipeableStream>;
    const timeout = setTimeout(() => {
      renderer.abort();
      output.destroy();
      reject(new Error("Controlled server projection did not settle"));
    }, 1500);
    output.on("data", chunk => { html += String(chunk); });
    output.once("error", error => { clearTimeout(timeout); reject(error); });
    output.once("end", () => { clearTimeout(timeout); resolve({ html, errors }); });
    renderer = renderToPipeableStream(element, {
      onAllReady() { renderer.pipe(output); },
      onShellError(error) { clearTimeout(timeout); output.destroy(); reject(error); },
      onError(error) { errors.push(error); },
    });
  });
}

// These cases use the package's existing Node/tsx + React server renderer.
// They do not execute client effects, recovery focus or actual browser modules.
test("native registration retains one shared draft Map and exact settings and route identities", async () => {
  const captured = await loadPluginApp(definePluginApp(registerMessageRules));
  assert.deepEqual(captured.navPanels.map(({ id, title, icon, path }) => [id, title, icon, path]), [["rules", "Message Rules", "message-circle", "rules"]]);
  assert.deepEqual(captured.settingsSections.map(({ id, title }) => [id, title]), [["connection", "Message Rules"]]);
  const registered = captured.navPanels[0]!.component as (props: PluginNavPanelProps) => ReactElement<MessageRulesBodyProps>;
  const first = registered({ subPath: "project/one" });
  const second = registered({ subPath: "project/two" });
  assert.ok(first.props.drafts instanceof Map);
  assert.equal(first.props.drafts, second.props.drafts);
  first.props.drafts.set("rule", draft);
  assert.equal(second.props.drafts.get("rule"), draft);
  assert.equal(first.props.subPath, "project/one");
  assert.equal(second.props.subPath, "project/two");
  const independent = await loadPluginApp(definePluginApp(registerMessageRules));
  const other = (independent.navPanels[0]!.component as typeof registered)({ subPath: "project/one" });
  assert.notEqual(other.props.drafts, first.props.drafts);
  assert.equal(other.props.drafts.size, 0);
  const settings = renderToStaticMarkup(createElement(captured.settingsSections[0]!.component as ComponentType));
  assert.match(settings, /Message Rules JEV API key/);
  assert.match(settings, /Explicit configured JEV checks/);
});

test("body demand defers module admission and forwards the exact draft Map and native route", async () => {
  const module = deferred<{ MessageRulesBody: ComponentType<MessageRulesBodyProps> }>();
  const drafts = new Map([["rule", draft]]);
  let loads = 0;
  let received: MessageRulesBodyProps | undefined;
  const Registered = createMessageRulesPanel(drafts, () => { loads++; return module.promise; });
  const element = createElement(Registered, { subPath: "project/one/group" });
  assert.equal(loads, 0);
  const projection = serverProjection(element);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(loads, 1);
  module.resolve({ MessageRulesBody(props) { received = props; return <output>{props.drafts.get("rule")?.value}</output>; } });
  const result = await projection;
  assert.deepEqual(result.errors, []);
  assert.equal(received?.drafts, drafts);
  assert.equal(received?.subPath, "project/one/group");
  assert.match(result.html, /kept draft/);
});

test("later server projections reuse selected module while retaining shared draft edits", async () => {
  const drafts = new Map([["rule", { ...draft }]]);
  let loads = 0;
  const received: Map<string, Draft>[] = [];
  const Registered = createMessageRulesPanel(drafts, async () => {
    loads++;
    return { MessageRulesBody({ drafts: shared, subPath }) { received.push(shared); return <output>{subPath}:{shared.get("rule")?.value}</output>; } };
  });
  const first = await serverProjection(createElement(Registered, { subPath: "one" }));
  drafts.set("rule", { ...draft, value: "changed draft" });
  const second = await serverProjection(createElement(Registered, { subPath: "two" }));
  assert.match(first.html, /kept draft/);
  assert.match(second.html, /changed draft/);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(second.errors, []);
  assert.equal(loads, 1);
  assert.equal(received.length, 2);
  assert.equal(received[0], drafts);
  assert.equal(received[1], drafts);
});

test("independent registration factories keep their supplied draft owners distinct", async () => {
  const one = new Map([["rule", { ...draft, value: "first owner" }]]);
  const two = new Map([["rule", { ...draft, value: "second owner" }]]);
  const received: Map<string, Draft>[] = [];
  const load = async () => ({ MessageRulesBody({ drafts }: MessageRulesBodyProps) { received.push(drafts); return <output>{drafts.get("rule")?.value}</output>; } });
  const First = createMessageRulesPanel(one, load);
  const Second = createMessageRulesPanel(two, load);
  const result = await serverProjection(<><First subPath="same" /><Second subPath="same" /></>);
  assert.deepEqual(result.errors, []);
  assert.match(result.html, /first owner/);
  assert.match(result.html, /second owner/);
  assert.equal(received.length, 2);
  assert.ok(received.includes(one));
  assert.ok(received.includes(two));
});

test("module rejection retains the supplied cause for the server renderer", async () => {
  const cause = new Error("Controlled module rejection");
  const Registered = createMessageRulesPanel(new Map(), async () => { throw cause; });
  const result = await serverProjection(<Registered subPath="" />);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0] instanceof Error);
  assert.equal(result.errors[0].cause, cause);
  assert.equal(result.errors[0].message, cause.message);
});

test("loaded body render errors reach the outer renderer without import retagging", async () => {
  const cause = new Error("Controlled body render failure");
  const Registered = createMessageRulesPanel(new Map(), async () => ({ MessageRulesBody() { throw cause; } }));
  const result = await serverProjection(<Registered subPath="" />);
  assert.deepEqual(result.errors, [cause]);
});
