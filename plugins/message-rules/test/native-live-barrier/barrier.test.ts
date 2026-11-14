import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import fixture, { TASK_PROJECT, RECEIVER_TITLE } from "./server.ts";

test("controlled barrier checks persisted target and only holds nonempty native originals, release wakes core", async () => {
  const {bb,harness} = createFakePluginHost({ pluginId: "native-live-barrier",
    sdk: { projects: { get: async ({projectId}) => ({id:projectId,name:projectId === "task" ? TASK_PROJECT : "unrelated"}) },
      threads: {get: async ({threadId}) => makeThreadResponse({id:threadId,projectId:"task",title:threadId === "receiver" ? RECEIVER_TITLE : "Sender"})} } });
  try {
    fixture(bb);
    await assert.rejects(harness.behavior.callRpc("arm", {projectId:"unrelated",receiverTitle:RECEIVER_TITLE}), /task project/);
    await assert.rejects(harness.behavior.callRpc("arm", {projectId:"task",receiverTitle:"Other receiver"}));
    await harness.behavior.callRpc("arm", {projectId:"task",receiverTitle:RECEIVER_TITLE});
    const hook = harness.inspection.registrations.hooks["message.dispatch"]!;
    const context = (id:string,phase:string,submissions:unknown[]) => Object.assign(makeMessageDispatchHookContext({thread:makeThreadResponse({id})}), {experimental_admission:{phase,submissions}});
    assert.deepEqual(await hook(context("receiver","accepted",[])),{action:"proceed"});
    assert.deepEqual(await hook(context("sender","prepared",[{}])),{action:"proceed"});
    for (const phase of ["prepared","accepted"]) assert.equal((await hook(context("receiver",phase,[{}]))).action,"wait");
    // Misleading context title/project cannot authorize a hold: persisted row wins.
    const misleading = context("sender","prepared",[{}]);
    misleading.thread.title=RECEIVER_TITLE;misleading.thread.projectId="task";
    assert.deepEqual(await hook(misleading),{action:"proceed"});
    await harness.behavior.callRpc("release",{projectId:"task",receiverTitle:RECEIVER_TITLE});
    assert.equal(harness.inspection.recheckCount,1);
    assert.deepEqual(await hook(context("receiver","accepted",[{}])),{action:"proceed"});
    assert.equal(harness.inspection.sdk.callsTo("threads.send").length,0);
    assert.equal(harness.inspection.registrations.providerRegistrations.length,0);
  } finally { await harness.lifecycle.dispose(); }
});
