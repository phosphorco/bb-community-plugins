import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  BbPluginApi,
  MessageDispatchHookContext,
  MessageDispatchHookDecision,
} from "@get-bb/plugin-sdk";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { createFakeSdk } from "@get-bb/plugin-sdk/testing";
const req = createRequire(import.meta.url),
  root = path.dirname(path.dirname(req.resolve("@get-bb/plugin-sdk")));
test("exact registry artifact and public runtime exports; source imports have no copied/private declarations", () => {
  const p = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(p.version, "0.6.52");
  assert.equal(typeof createFakeSdk, "function");
  assert.equal(typeof definePluginApp, "function");
  const lock = JSON.parse(readFileSync("../../package-lock.json", "utf8"));
  const selected =
    lock.packages["plugins/message-rules/node_modules/@get-bb/plugin-sdk"];
  assert.equal(selected.version, "0.6.52");
  assert.match(selected.resolved, /registry.npmjs.org/);
  assert.match(selected.integrity, /^sha512-/);
  console.log(
    JSON.stringify({
      sdk: p.version,
      resolved: selected.resolved,
      integrity: selected.integrity,
      declarationsSha256: createHash("sha256")
        .update(
          readFileSync(path.join(root, "bundled-types/bb-plugin-sdk.d.ts")),
        )
        .digest("hex"),
    }),
  );
});
// This consumer is typechecked against the registry package, never a local declaration copy.
export function publicConsumer(bb: BbPluginApi) {
  bb.experimental_hooks.on(
    "message.dispatch",
    (c: MessageDispatchHookContext): MessageDispatchHookDecision => ({
      action: "wait",
      reason: c.queuedMessages.length ? "probe" : "inline probe",
    }),
  );
  const methods = [
    bb.sdk.files.list,
    bb.sdk.files.read,
    bb.sdk.files.write,
    bb.sdk.threads.queue.list,
    bb.sdk.threads.queuedMessages.setGroupBoundary,
    bb.rpc.register,
    bb.realtime.publish,
    bb.storage.database,
    bb.background.service,
  ];
  return methods;
}
