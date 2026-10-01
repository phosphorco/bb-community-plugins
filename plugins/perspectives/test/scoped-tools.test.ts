import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import plugin from "../server.ts";

type Tool = {
  name: string;
  parameters: { safeParse(input: unknown): { success: boolean; data?: unknown; error?: Error } };
  execute(input: any, context: any): Promise<any> | any;
};

function makeHarness(options: {
  failWakes?: boolean;
  failWakeSends?: readonly ("wrap-up" | "deadline")[];
  failWakeRows?: boolean | readonly ("wrap-up" | "deadline")[];
  failOutputReadFor?: readonly string[];
  fileWriteFault?: "before-commit" | "after-commit";
} = {}) {
  const tools = new Map<string, Tool>();
  let configure!: (context: any) => { tools: string[]; skills: string[]; instructions?: string };
  const threads = new Map<string, any>();
  const initialPrompts = new Map<string, string>();
  const rows: Array<Record<string, any>> = [];
  const bytesByPath = new Map<string, Buffer>();
  const events: string[] = [];
  const storageLocationOfflineFor = new Set<string>();
  const fileReadOfflineFor = new Set<string>();
  const fileWriteAttempts: string[] = [];
  const fileWriteCommits: string[] = [];
  let fileWriteFault = options.fileWriteFault;
  const outputs = new Map<string, string>();
  const metadata = new Map<string, Record<string, any>>();
  const requestedMessages = new Map<string, string[]>();
  const completionSendFault = { mode: "" };
  const failedDeletes = new Set<string>();
  const failedQueueLists = new Set<string>();
  const failedGets = new Set<string>();
  const failedEventLists = new Set<string>();
  const completeOnQueueRead = new Set<string>();
  const outputReadFailures = new Set(options.failOutputReadFor ?? []);
  const completedTurns = new Map<string, { turnId: string; status: string; sequence: number; messages: Array<Record<string, any>> }>();
  let nextId = 0;
  let nextRowId = 0;

  threads.set("caller", {
    id: "caller",
    projectId: "project-1",
    environmentId: "environment-1",
    providerId: "provider-1",
    parentThreadId: null, lifecycleOwnerThreadId: null,
    visibility: "visible",
    title: "caller",
    status: "idle",
  });

  const bb = {
    pluginId: "perspectives",
    settings: {
      define: (descriptors: Record<string, any>) => ({
        get: async () => Object.fromEntries(Object.entries(descriptors).map(([key, item]) => [key, item.default])),
      }),
    },
    agents: {
      registerTool: (registration: Tool) => tools.set(registration.name, registration),
      configure: (provider: typeof configure) => { configure = provider; },
    },
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
        updatePluginMetadata: async ({ threadId, set }: { threadId: string; set: Record<string, any> }) => {
          const value = { ...metadata.get(threadId), ...set }; metadata.set(threadId, value); return value;
        },
        get: async ({ threadId }: { threadId: string }) => {
          if (failedGets.has(threadId)) throw new Error("get unavailable");
          const thread = threads.get(threadId);
          if (!thread) throw Object.assign(new Error(`missing thread ${threadId}`), { status: 404 });
          return { ...thread };
        },
        defaultExecutionOptions: async () => ({ model: "model-1", reasoningLevel: "high", permissionMode: "auto" }),
        spawn: async (args: Record<string, any>) => {
          const id = args.lifecycleOwnerThreadId === "caller" ? "coordinator-1" : `worker-${++nextId}`;
          const environmentId = args.environment.type === "reuse" ? args.environment.environmentId : "environment-1";
          const child = {
            id,
            projectId: args.projectId,
            environmentId,
            providerId: args.providerId,
            parentThreadId: args.parentThreadId ?? null,
            lifecycleOwnerThreadId: args.lifecycleOwnerThreadId ?? null,
            visibility: args.visibility,
            title: args.title,
            status: "active",
          };
          threads.set(id, child);
          initialPrompts.set(id, args.prompt);
          events.push(`spawn:${id}`);
          return { ...child };
        },
        list: async ({ parentThreadId, limit = 100, offset = 0 }: { parentThreadId?: string; limit?: number; offset?: number }) =>
          [...threads.values()].filter((thread) => parentThreadId === undefined || thread.parentThreadId === parentThreadId).slice(offset, offset + limit),
        events: {
          list: async ({ threadId, order, types, beforeSeq, limit }: { threadId: string; order: string; types?: readonly string[]; beforeSeq?: string; limit?: string }) => {
            if (failedEventLists.has(threadId)) throw new Error("events unavailable");
            if (types?.includes("turn/completed")) {
              if (outputReadFailures.has(threadId)) throw new Error("event listing unavailable");
              const turn = completedTurns.get(threadId);
              return turn ? [{
                type: "turn/completed",
                seq: turn.sequence,
                scope: { kind: "turn", turnId: turn.turnId },
                data: { status: turn.status },
              }] : [];
            }
            if (types?.includes("item/completed")) {
              if (outputReadFailures.has(threadId)) throw new Error("event listing unavailable");
              const turn = completedTurns.get(threadId);
              if (!turn) return [];
              const limitCount = Number(limit ?? "100");
              return turn.messages
                .filter((row) => beforeSeq === undefined || row.seq < Number(beforeSeq))
                .sort((left, right) => order === "desc" ? right.seq - left.seq : left.seq - right.seq)
                .slice(0, limitCount);
            }
            if (requestedMessages.has(threadId)) return requestedMessages.get(threadId)!.map(text => ({ type: "client/turn/requested", data: { input: [{ type: "text", text }] } }));
            const prompt = initialPrompts.get(threadId);
            if (!prompt) return [];
            return [{ type: "client/turn/requested", data: { input: [{ type: "text", text: prompt }] } }];
          },
        },
        send: async (args: Record<string, any>) => {
          const text = args.input.map((part: any) => part.text).join("\n");
          events.push(`send:${text}`);
          const wakeKind = text.match(/tag=(wrap-up|deadline)/)?.[1] as "wrap-up" | "deadline" | undefined;
          if (text.startsWith("Perspectives coordinator wake:") &&
              (options.failWakes || (wakeKind && options.failWakeSends?.includes(wakeKind)))) {
            throw new Error("queue service unavailable");
          }
          if (args.sendAt !== undefined) {
            const isWake = text.startsWith("Perspectives coordinator wake:");
            const selectedWakeFailure = options.failWakeRows === true ||
              (Array.isArray(options.failWakeRows) && options.failWakeRows.includes(wakeKind!));
            const row = {
              id: `queue-${++nextRowId}`,
              threadId: args.threadId,
              sendAt: args.sendAt,
              content: args.input,
              failureReason: selectedWakeFailure && isWake ? "dispatch failed" : null,
              editable: !(selectedWakeFailure && isWake),
            };
            rows.push(row);
            return { delivery: "queued", queuedMessage: row };
          }
          if (text.startsWith("Perspectives panel result ready")) {
            if (completionSendFault.mode === "before") throw new Error("ambiguous response without commit");
            requestedMessages.set(args.threadId, [...requestedMessages.get(args.threadId) ?? [], text]);
            if (completionSendFault.mode === "after") throw new Error("response lost after acceptance");
          }
          return { delivery: "sent" };
        },
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) => {
            if (failedQueueLists.has(threadId)) throw new Error("queue listing unavailable");
            if (completeOnQueueRead.has(threadId)) threads.get(threadId)!.status = "idle";
            return rows.filter((row) => row.threadId === threadId);
          },
          delete: async ({ queuedMessageId }: { queuedMessageId: string }) => {
            events.push(`delete:${queuedMessageId}`);
            if (failedDeletes.has(queuedMessageId)) throw new Error("delete unavailable");
            const index = rows.findIndex((row) => row.id === queuedMessageId);
            if (index >= 0) rows.splice(index, 1);
            return { ok: true };
          },
        },
        output: async ({ threadId }: { threadId: string }) => ({ output: outputs.get(threadId) ?? null }),
        stop: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (thread) thread.status = "idle";
          return { ok: true };
        },
        storageLocation: async ({ threadId }: { threadId: string }) => {
          if (storageLocationOfflineFor.has(threadId)) {
            throw Object.assign(new Error("simulated unavailable artifact host"), { code: "host_unavailable" });
          }
          return {
            hostId: "host-1",
            storageRootPath: `/tmp/perspectives-test/${threadId}`,
          };
        },
      },
      providers: {
        list: async () => [],
        models: async () => ({ models: [], selectedOnlyModels: [], permissionCeiling: "auto" }),
      },
      files: {
        write: async ({ path, content, expectedSha256 }: { path: string; content: string; expectedSha256: string | null }) => {
          fileWriteAttempts.push(path);
          if (expectedSha256 !== null) throw new Error("test expects create-only file writes");
          if (bytesByPath.has(path)) throw Object.assign(new Error("already exists"), { status: 409, code: "conflict" });
          if (fileWriteFault === "before-commit") {
            fileWriteFault = undefined;
            throw Object.assign(new Error("simulated file host disconnect before commit"), { code: "host_disconnected" });
          }
          bytesByPath.set(path, Buffer.from(content, "utf8"));
          fileWriteCommits.push(path);
          events.push("file-write");
          if (fileWriteFault === "after-commit") {
            fileWriteFault = undefined;
            throw Object.assign(new Error("simulated file host disconnect after commit"), { code: "host_disconnected" });
          }
          return { outcome: "created" };
        },
        read: async ({ path }: { path: string }) => {
          if (fileReadOfflineFor.has(path)) {
            throw Object.assign(new Error("simulated disconnected artifact host"), { code: "host_disconnected" });
          }
          const bytes = bytesByPath.get(path);
          if (!bytes) throw Object.assign(new Error("not found"), { status: 404, code: "not_found" });
          events.push("file-read");
          return {
            contentEncoding: "utf8",
            content: bytes.toString("utf8"),
            sha256: createHash("sha256").update(bytes).digest("hex"),
            sizeBytes: bytes.byteLength,
          };
        },
      },
    },
    log: { info: () => undefined },
  };

  plugin(bb as any);

  const context = (threadId: string) => ({
    threadId,
    projectId: "project-1",
    signal: new AbortController().signal,
  });
  const call = async (name: string, input: unknown, threadId: string) => {
    const tool = tools.get(name);
    assert.ok(tool, `registered tool ${name}`);
    const parsed = tool.parameters.safeParse(input);
    assert.ok(parsed.success, `tool ${name} input is valid`);
    return tool.execute(parsed.data, context(threadId));
  };
  const text = (result: any): string => typeof result === "string" ? result : result?.content?.[0]?.text ?? "";
  const setFinalOutput = (
    threadId: string,
    output: string,
    options: { readonly precedingAgentMessages?: readonly string[]; readonly trailingNonAgentItems?: number; readonly status?: string } = {},
  ) => {
    outputs.set(threadId, output);
    const turnId = `${threadId}-completed-turn`;
    const items = [
      ...(options.precedingAgentMessages ?? []).map((text) => ({ type: "agentMessage", text })),
      { type: "agentMessage", text: output },
      ...Array.from({ length: options.trailingNonAgentItems ?? 0 }, () => ({ type: "toolCall", text: "tool result" })),
    ];
    const messages = items.map((item, index) => ({
      type: "item/completed",
      seq: index + 1,
      scope: { kind: "turn", turnId },
      data: { item },
    }));
    completedTurns.set(threadId, {
      turnId,
      status: options.status ?? "completed",
      sequence: messages.length + 1,
      messages,
    });
  };

  return {
    metadata, requestedMessages, completionSendFault,
    tools,
    configure,
    threads,
    initialPrompts,
    rows,
    bytesByPath,
    events,
    outputs,
    failedDeletes, failedQueueLists, failedGets, failedEventLists, completeOnQueueRead,
    outputReadFailures,
    completedTurns,
    storageLocationOfflineFor,
    fileReadOfflineFor,
    fileWriteAttempts,
    fileWriteCommits,
    setFinalOutput,
    call,
    text,
  };
}

async function launch(harness: ReturnType<typeof makeHarness>) {
  const receipt = await harness.call("gather_perspectives", {
    question: "How should this coordinator recover?",
    context: "Keep evidence limits clear.",
    lenses: ["restart recovery", "queue delivery"],
  }, "caller");
  assert.match(harness.text(receipt), /Perspectives panel launched/);
  return "coordinator-1";
}

async function readyToPublishRun(harness: ReturnType<typeof makeHarness>) {
  const coordinatorId = await launch(harness);
  await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  for (const [index, worker] of [...harness.threads.values()].filter((thread) => thread.parentThreadId === coordinatorId).entries()) {
    worker.status = "idle";
    harness.outputs.set(worker.id, `Lens ${index + 1} inspected a primary source and reports bounded findings.`);
  }
  const ready = await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  assert.equal((JSON.parse(harness.text(ready)) as any).readyToPublish, true);
  return coordinatorId;
}

async function publishRun(harness: ReturnType<typeof makeHarness>, coverage?: string) {
  const coordinatorId = await readyToPublishRun(harness);
  const input: Record<string, string> = { synthesis: "Bounded synthesis with cited evidence and stated unknowns." };
  if (coverage !== undefined) input.coverage = coverage;
  const publication = await harness.call("perspectives_publish_result", input, coordinatorId);
  assert.notEqual(publication.isError, true, harness.text(publication));
  return coordinatorId;
}

test("registered SDK tools reconcile, publish exact bytes, survive rename, and retrieve only from the parent", async () => {
  const harness = makeHarness();
  const coordinatorId = await launch(harness);
  const coordinator = harness.threads.get(coordinatorId)!;
  coordinator.title = "renamed coordinator";
  harness.initialPrompts.set(coordinatorId, `${harness.initialPrompts.get(coordinatorId)}\nUpdated non-identity instructions.`);
  const coordinatorConfig = harness.configure({
    origin: { kind: null, pluginId: "perspectives" },
    thread: { id: coordinatorId, title: coordinator.title, parentThreadId: "caller", sourceThreadId: null },
  });
  assert.deepEqual(coordinatorConfig.tools, ["help", "perspectives_coordinator_step", "perspectives_publish_result"]);

  const firstStep = await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  assert.equal((JSON.parse(harness.text(firstStep)) as any).readyToPublish, false);
  assert.equal([...harness.threads.values()].filter((thread) => thread.parentThreadId === coordinatorId).length, 2);
  assert.equal(harness.rows.filter((row) => row.threadId === coordinatorId).length, 4, "two run wakes and two durable per-lens launch intents are pending");

  const workers = [...harness.threads.values()].filter((thread) => thread.parentThreadId === coordinatorId);
  for (const [index, worker] of workers.entries()) {
    worker.status = "idle";
    harness.outputs.set(worker.id, `Lens ${index + 1} inspected one primary source and reports bounded findings.`);
  }

  const workerConfig = harness.configure({
    origin: { kind: null, pluginId: "perspectives" },
    thread: { id: workers[0]!.id, title: workers[0]!.title, parentThreadId: coordinatorId, sourceThreadId: null },
  });
  assert.deepEqual(workerConfig.tools, [], "recognizable worker receives no Perspectives tools");
  workers[0]!.title = "renamed worker 1";
  workers[1]!.title = "renamed worker 2";
  const renamedWorkerConfig = harness.configure({
    origin: { kind: null, pluginId: "perspectives" },
    thread: { id: workers[0]!.id, title: workers[0]!.title, parentThreadId: coordinatorId, sourceThreadId: null },
  });
  assert.deepEqual(renamedWorkerConfig.tools, ["help", "perspectives_coordinator_step", "perspectives_publish_result"]);

  const invalidWorker = await harness.call("perspectives_coordinator_step", {}, workers[0]!.id);
  assert.equal(invalidWorker.isError, true);
  assert.match(harness.text(invalidWorker), /Unauthorized Perspectives coordinator operation/);
  const invalidWorkerPublish = await harness.call("perspectives_publish_result", { synthesis: "worker attempt" }, workers[0]!.id);
  assert.equal(invalidWorkerPublish.isError, true);
  assert.match(harness.text(invalidWorkerPublish), /Unauthorized Perspectives coordinator operation/);
  const nestedGather = await harness.call("gather_perspectives", {
    question: "nested", lenses: ["one", "two"],
  }, workers[0]!.id);
  assert.equal(nestedGather.isError, true);
  assert.match(harness.text(nestedGather), /cannot start another panel/);
  const nestedHelp = await harness.call("help", { question: "delegate research" }, workers[0]!.id);
  assert.equal(nestedHelp.isError, true);
  assert.match(harness.text(nestedHelp), /cannot delegate to help/);

  await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  const published = await harness.call("perspectives_publish_result", {
    synthesis: "The outputs support a limited conclusion with two cited lens reports; they do not establish exhaustive coverage.",
    coverage: "complete",
  }, coordinatorId);
  const receipt = JSON.parse(harness.text(published));
  assert.equal(receipt.phase, "published");
  assert.match(receipt.bodySha256, /^[0-9a-f]{64}$/);
  assert.match(receipt.fileSha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.pendingRunRowsRemoved, true);
  assert.equal(harness.rows.filter((row) => row.threadId === coordinatorId).length, 0);
  assert.ok(harness.events.indexOf("file-read") < harness.events.findIndex((event) => event.startsWith("delete:")), "pending wakes are deleted after artifact readback");

  const callerRead = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.equal(typeof callerRead, "string");
  assert.match(callerRead, /Full-file SHA-256:/);
  assert.match(callerRead, /This tool creates no requesting-thread follow-up/);
  assert.match(callerRead, /<!-- perspectives-presented run-id=coordinator-1 file-sha256=[0-9a-f]{64} -->/);
  assert.match(callerRead, /terminal run-id=coordinator-1 status=complete/);
  assert.equal(harness.rows.filter((row) => row.threadId === "caller").length, 0, "verified retrieval creates no caller reminder");

  const fileDigest = harness.text(callerRead).match(/Full-file SHA-256: ([0-9a-f]{64})/)![1]!;
  harness.setFinalOutput("caller", `Presented the verified panel.\n<!-- perspectives-presented run-id=${coordinatorId} file-sha256=${fileDigest} -->`);
  const alreadyPresented = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(alreadyPresented), /already presented according to the exact receipt in the latest successfully completed caller turn's final agent message/);
  assert.match(harness.text(alreadyPresented), /remains retrievable on a user request/);
  assert.match(harness.text(alreadyPresented), /This tool creates no requesting-thread follow-up/);
  assert.match(harness.text(alreadyPresented), new RegExp(`\\n<!-- perspectives-presented run-id=${coordinatorId} file-sha256=${fileDigest} -->$`));
  assert.doesNotMatch(harness.text(alreadyPresented), /## Synthesis/);
  const explicitlyRetrieved = await harness.call("perspectives_read_result", { coordinatorId, includeArtifact: true }, "caller");
  assert.match(harness.text(explicitlyRetrieved), /## Synthesis/);
  assert.match(harness.text(explicitlyRetrieved), /This tool creates no requesting-thread follow-up/);
  const unrelatedRead = await harness.call("perspectives_read_result", { coordinatorId }, "unrelated-caller");
  assert.equal(unrelatedRead.isError, true);
  assert.match(harness.text(unrelatedRead), /not a verified hidden coordinator owned/);
});

test("a synthesis containing artifact delimiters publishes and reads back as exact body text", async () => {
  const harness = makeHarness();
  const coordinatorId = await readyToPublishRun(harness);
  const synthesis = "Quoted source:\n<!-- perspectives-body:end -->\n<!-- perspectives-body:start -->\nFinding remains bounded.";
  const publication = await harness.call("perspectives_publish_result", { synthesis, coverage: "complete" }, coordinatorId);
  assert.notEqual(publication.isError, true, harness.text(publication));
  const receipt = JSON.parse(harness.text(publication));
  assert.equal(receipt.phase, "published");
  const callerRead = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(callerRead), /Finding remains bounded\./);
  assert.match(harness.text(callerRead), /<!-- perspectives-body:end -->/);
  assert.match(harness.text(callerRead), /<!-- perspectives-body:start -->/);
});

test("ambiguous wake setup launches no workers and keeps publication closed", async () => {
  const harness = makeHarness({ failWakes: true });
  const coordinatorId = await launch(harness);
  const result = await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  const step = JSON.parse(harness.text(result));
  assert.equal(step.phase, "wake-setup-uncertain");
  assert.equal(step.readyToPublish, false);
  assert.match(step.limitation, /explicit recovery or operator action/);
  assert.equal([...harness.threads.values()].filter((thread) => thread.parentThreadId === coordinatorId).length, 0);
  const publish = await harness.call("perspectives_publish_result", { synthesis: "No synthesis until work is terminal." }, coordinatorId);
  assert.equal(publish.isError, true);
  assert.match(harness.text(publish), /not all terminal yet/);
  assert.equal(harness.bytesByPath.size, 0);
});

test("a persisted wake failure does not permit early publication when the other wake is ambiguous", async () => {
  const harness = makeHarness({ failWakeSends: ["wrap-up"], failWakeRows: ["deadline"] });
  const coordinatorId = await launch(harness);
  const result = await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  const step = JSON.parse(harness.text(result));
  assert.equal(step.phase, "wake-setup-uncertain");
  assert.equal(step.readyToPublish, false);
  assert.equal([...harness.threads.values()].filter((thread) => thread.parentThreadId === coordinatorId).length, 0);
  const publish = await harness.call("perspectives_publish_result", { synthesis: "No synthesis without established wake state." }, coordinatorId);
  assert.equal(publish.isError, true);
  assert.equal(harness.bytesByPath.size, 0);
});

test("one failed required wake publishes no-research failure when the other is confirmed", async () => {
  const harness = makeHarness({ failWakeRows: ["deadline"] });
  const coordinatorId = await launch(harness);
  const result = await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  const step = JSON.parse(harness.text(result));
  assert.equal(step.phase, "wake-setup-failed", harness.text(result));
  assert.equal(step.readyToPublish, true);
  assert.equal(step.wakeReports[0].state, "confirmed");
  assert.equal(step.wakeReports[1].state, "failed");
  assert.equal([...harness.threads.values()].filter((thread) => thread.parentThreadId === coordinatorId).length, 0);
  assert.equal(harness.rows.filter((row) => row.threadId === coordinatorId && row.content[0]?.text.startsWith("Perspectives worker launch intent:")).length, 0);
  assert.equal(harness.bytesByPath.size, 0);

  const publication = await harness.call("perspectives_publish_result", { synthesis: "Do not invent research findings." }, coordinatorId);
  assert.notEqual(publication.isError, true, harness.text(publication));
  assert.equal(JSON.parse(harness.text(publication)).status, "failed");
  const callerRead = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(callerRead), /No research was performed/);
});

test("definite failure of both wake rows publishes a failed no-research artifact for the caller", async () => {
  const harness = makeHarness({ failWakeRows: true });
  const coordinatorId = await launch(harness);
  const result = await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  const step = JSON.parse(harness.text(result));
  assert.equal(step.phase, "wake-setup-failed");
  assert.equal(step.readyToPublish, true);
  assert.equal(step.outcomes.every((outcome: any) => outcome.state === "not-launched"), true);

  const publication = await harness.call("perspectives_publish_result", { synthesis: "Do not invent research findings." }, coordinatorId);
  assert.notEqual(publication.isError, true, harness.text(publication));
  assert.equal(JSON.parse(harness.text(publication)).status, "failed");
  const callerRead = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.equal(typeof callerRead, "string");
  assert.match(callerRead, /Status: failed/);
  assert.match(callerRead, /No research was performed/);
  assert.match(callerRead, /not-launched/);
  assert.equal([...harness.threads.values()].filter((thread) => thread.parentThreadId === coordinatorId).length, 0);
});

test("caller retrieval rejects a corrupt artifact even when the host digest matches its bytes", async () => {
  const harness = makeHarness();
  const coordinatorId = await launch(harness);
  await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  for (const [index, worker] of [...harness.threads.values()].filter((thread) => thread.parentThreadId === coordinatorId).entries()) {
    worker.status = "idle";
    harness.outputs.set(worker.id, `Evidence ${index + 1}.`);
  }
  const ready = await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  assert.equal((JSON.parse(harness.text(ready)) as any).readyToPublish, true, harness.text(ready));
  const publication = await harness.call("perspectives_publish_result", { synthesis: "Bounded synthesis." }, coordinatorId);
  assert.notEqual(publication.isError, true, harness.text(publication));

  const artifactPath = [...harness.bytesByPath.keys()][0]!;
  const original = harness.bytesByPath.get(artifactPath)!;
  harness.bytesByPath.set(artifactPath, Buffer.concat([original, Buffer.from("corruption", "utf8")]));
  const read = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.equal(read.isError, true);
  assert.match(harness.text(read), /corrupt or failed byte verification/);
});

test("caller retrieval reports host offline when storage resolution or file read disconnects", async () => {
  for (const failurePoint of ["storage-location", "file-read"] as const) {
    const harness = makeHarness();
    const coordinatorId = await publishRun(harness, "complete");
    if (failurePoint === "storage-location") {
      harness.storageLocationOfflineFor.add(coordinatorId);
    } else {
      const [artifactPath] = harness.bytesByPath.keys();
      assert.ok(artifactPath);
      harness.fileReadOfflineFor.add(artifactPath);
    }

    const read = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
    assert.equal(read.isError, true, failurePoint);
    assert.match(harness.text(read), /artifact host is offline/, failurePoint);
    assert.doesNotMatch(harness.text(read), /artifact is missing|Verified Perspectives artifact/, failurePoint);
  }
});

test("publish reconciles a committed create-only write after its response is lost", async () => {
  const harness = makeHarness({ fileWriteFault: "after-commit" });
  const coordinatorId = await readyToPublishRun(harness);
  const publication = await harness.call("perspectives_publish_result", {
    synthesis: "The committed bytes must be recovered by exact readback.",
    coverage: "partial",
  }, coordinatorId);

  assert.notEqual(publication.isError, true, harness.text(publication));
  const receipt = JSON.parse(harness.text(publication));
  assert.equal(receipt.phase, "published");
  assert.equal(harness.fileWriteAttempts.length, 1, "the ambiguous write is not retried");
  assert.equal(harness.fileWriteCommits.length, 1, "the create-only artifact is committed once");
  assert.equal(harness.events.filter((event) => event === "file-read").length, 1, "publication verifies the committed bytes by readback");

  const [artifactPath] = harness.bytesByPath.keys();
  assert.ok(artifactPath);
  const bytes = harness.bytesByPath.get(artifactPath)!;
  assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.fileSha256);
  const callerRead = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(callerRead), /Verified Perspectives artifact/);
  assert.match(harness.text(callerRead), /The committed bytes must be recovered by exact readback/);
  assert.equal(harness.fileWriteAttempts.length, 1, "caller retrieval does not write or duplicate the artifact");
});

test("pre-commit write failure reports missing readback and leaves publication retryable", async () => {
  const harness = makeHarness({ fileWriteFault: "before-commit" });
  const coordinatorId = await readyToPublishRun(harness);
  const input = {
    synthesis: "The persisted worker outputs remain available for a later publication attempt.",
    coverage: "partial",
  };
  const failed = await harness.call("perspectives_publish_result", input, coordinatorId);

  assert.equal(failed.isError, true);
  assert.match(harness.text(failed), /was not readable after ambiguous write/);
  assert.match(harness.text(failed), /simulated file host disconnect before commit/);
  assert.equal(harness.bytesByPath.size, 0, "the injected failure happened before artifact commit");
  assert.equal(harness.fileWriteAttempts.length, 1);
  assert.equal(harness.fileWriteCommits.length, 0);
  assert.equal(harness.outputs.size, 2, "both persisted worker outputs remain available");
  assert.equal(harness.rows.filter((row) => row.threadId === "caller").length, 0, "no caller reminder is queued");

  const recovered = await harness.call("perspectives_publish_result", input, coordinatorId);
  assert.notEqual(recovered.isError, true, harness.text(recovered));
  assert.equal(JSON.parse(harness.text(recovered)).phase, "published");
  assert.equal(harness.fileWriteAttempts.length, 2);
  assert.equal(harness.fileWriteCommits.length, 1);
  assert.equal(harness.bytesByPath.size, 1);
});

test("coverage choice can keep status partial even when every worker output is available", async () => {
  const harness = makeHarness();
  const coordinatorId = await publishRun(harness, "partial");
  const read = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(read), /Status: partial/);
  assert.match(harness.text(read), /Worker output availability: complete/);
  assert.match(harness.text(read), /Coordinator coverage assessment \(not mechanically verified\): partial/);
  assert.match(harness.text(read), /Bounded synthesis with cited evidence/);
});

test("complete coverage choice is capped when a requested lens lacks persisted final output", async () => {
  const harness = makeHarness();
  const coordinatorId = await launch(harness);
  await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  const workers = [...harness.threads.values()].filter((thread) => thread.parentThreadId === coordinatorId);
  workers.forEach((worker) => { worker.status = "idle"; });
  harness.outputs.set(workers[0]!.id, "One lens has persisted final findings.");
  await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  const publication = await harness.call("perspectives_publish_result", {
    synthesis: "One requested lens has no stored final answer.",
    coverage: "complete",
  }, coordinatorId);
  assert.equal((JSON.parse(harness.text(publication)) as any).status, "partial");

  const read = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(read), /Status: partial/);
  assert.match(harness.text(read), /Worker output availability: partial/);
  assert.match(harness.text(read), /output-unavailable/);
});

test("legacy synthesis-only publication defaults to partial with complete persisted worker outputs", async () => {
  const harness = makeHarness();
  const coordinatorId = await publishRun(harness);
  const read = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(read), /Status: partial/);
  assert.match(harness.text(read), /Worker output availability: complete/);
  assert.match(harness.text(read), /Coordinator coverage assessment \(not mechanically verified\): partial/);
});

test("unknown publication coverage defaults to partial", async () => {
  const harness = makeHarness();
  const coordinatorId = await publishRun(harness, "certain");
  const read = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(read), /Status: partial/);
  assert.match(harness.text(read), /Coordinator coverage assessment \(not mechanically verified\): partial/);
});

test("artifact read before a caller final answer returns the artifact without scheduling reminders", async () => {
  const harness = makeHarness();
  const coordinatorId = await publishRun(harness, "complete");
  const read = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(read), /Verified Perspectives artifact/);
  assert.match(harness.text(read), /This tool creates no requesting-thread follow-up/);
  assert.match(harness.text(read), /No exact presentation marker was found/);
  assert.match(harness.text(read), /## Synthesis/);
  assert.equal(harness.outputs.has("caller"), false, "a read result is not treated as durable presentation evidence");
  assert.equal(harness.rows.filter((row) => row.threadId === "caller").length, 0);
});

test("matching exact receipt in the latest persisted final agent output suppresses only repeat body", async () => {
  const harness = makeHarness();
  const coordinatorId = await publishRun(harness, "complete");
  const first = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  const digest = harness.text(first).match(/Full-file SHA-256: ([0-9a-f]{64})/)![1]!;
  harness.setFinalOutput("caller", `Presented the verified result.\n<!-- perspectives-presented run-id=${coordinatorId} file-sha256=${digest} -->`);

  const repeated = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(repeated), /already presented according to the exact receipt in the latest successfully completed caller turn's final agent message/);
  assert.match(harness.text(repeated), /This tool creates no requesting-thread follow-up/);
  assert.match(harness.text(repeated), /remains retrievable on a user request/);
  assert.doesNotMatch(harness.text(repeated), /## Synthesis/);
  assert.equal(harness.rows.filter((row) => row.threadId === "caller").length, 0);
});

test("an intermediate assistant message receipt cannot stand in for the completed turn's final message", async () => {
  const harness = makeHarness();
  const coordinatorId = await publishRun(harness, "complete");
  const first = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  const digest = harness.text(first).match(/Full-file SHA-256: ([0-9a-f]{64})/)![1]!;
  const staleReceipt = `<!-- perspectives-presented run-id=${coordinatorId} file-sha256=${digest} -->`;
  harness.setFinalOutput("caller", "Final response without the receipt.", { precedingAgentMessages: [staleReceipt] });

  const read = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(read), /Verified Perspectives artifact/);
  assert.match(harness.text(read), /## Synthesis/);
  assert.match(harness.text(read), /This tool creates no requesting-thread follow-up/);
});

test("a matching receipt from an interrupted turn is not durable presentation evidence", async () => {
  const harness = makeHarness();
  const coordinatorId = await publishRun(harness, "complete");
  const first = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  const digest = harness.text(first).match(/Full-file SHA-256: ([0-9a-f]{64})/)![1]!;
  harness.setFinalOutput("caller", `<!-- perspectives-presented run-id=${coordinatorId} file-sha256=${digest} -->`, { status: "interrupted" });

  const read = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(read), /Verified Perspectives artifact/);
  assert.match(harness.text(read), /## Synthesis/);
});

test("a receipt on a non-final item cannot suppress the artifact even in a completed turn", async () => {
  const harness = makeHarness();
  const coordinatorId = await publishRun(harness, "complete");
  const first = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  const digest = harness.text(first).match(/Full-file SHA-256: ([0-9a-f]{64})/)![1]!;
  harness.setFinalOutput("caller", `<!-- perspectives-presented run-id=${coordinatorId} file-sha256=${digest} -->`, { trailingNonAgentItems: 1 });

  const read = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(read), /Verified Perspectives artifact/);
  assert.match(harness.text(read), /## Synthesis/);
});

test("a presentation receipt with a mismatched digest does not suppress the artifact", async () => {
  const harness = makeHarness();
  const coordinatorId = await publishRun(harness, "complete");
  const first = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  const digest = harness.text(first).match(/Full-file SHA-256: ([0-9a-f]{64})/)![1]!;
  const wrongDigest = `${digest[0] === "0" ? "1" : "0"}${digest.slice(1)}`;
  harness.setFinalOutput("caller", `<!-- perspectives-presented run-id=${coordinatorId} file-sha256=${wrongDigest} -->`);

  const repeated = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(repeated), /Verified Perspectives artifact/);
  assert.match(harness.text(repeated), /## Synthesis/);
  assert.match(harness.text(repeated), /This tool creates no requesting-thread follow-up/);
});

test("caller final-output discovery failure returns full artifact without suppressing", async () => {
  const harness = makeHarness({ failOutputReadFor: ["caller"] });
  const coordinatorId = await publishRun(harness, "complete");
  const read = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(read), /latest persisted final output could not be read/);
  assert.match(harness.text(read), /## Synthesis/);
  assert.match(harness.text(read), /This tool creates no requesting-thread follow-up/);
});

test("possible duplicate coordinator runs keep their artifacts separate without scheduling reminders", async () => {
  const harness = makeHarness();
  const coordinatorId = await publishRun(harness, "complete");
  const prompt = harness.initialPrompts.get(coordinatorId)!;
  const marker = prompt.match(/"invocationMarker":\s*"([^"]+)"/)![1]!;
  const original = harness.threads.get(coordinatorId)!;
  const duplicateId = "coordinator-duplicate";
  harness.threads.set(duplicateId, { ...original, id: duplicateId, status: "idle" });
  harness.initialPrompts.set(duplicateId, prompt);

  const result = await harness.call("perspectives_read_result", { invocationMarker: marker }, "caller");
  assert.equal(JSON.parse(harness.text(result)).phase, "possible-duplicate-runs");
  assert.equal(harness.rows.filter((row) => row.threadId === "caller").length, 0);
});

test("publisher replaces unsupported synthesis when no persisted final worker output exists", async () => {
  const harness = makeHarness();
  const coordinatorId = await launch(harness);
  await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  for (const worker of [...harness.threads.values()].filter((thread) => thread.parentThreadId === coordinatorId)) {
    worker.status = "idle";
  }
  const ready = await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  assert.equal((JSON.parse(harness.text(ready)) as any).readyToPublish, true);

  const publication = await harness.call("perspectives_publish_result", {
    synthesis: "Delivery is guaranteed and the panel has complete coverage.",
    coverage: "complete",
  }, coordinatorId);
  assert.notEqual(publication.isError, true, harness.text(publication));
  const callerRead = await harness.call("perspectives_read_result", { coordinatorId }, "caller");
  assert.match(harness.text(callerRead), /No usable persisted final worker output is available/);
  assert.doesNotMatch(harness.text(callerRead), /Delivery is guaranteed/);
  assert.match(harness.text(callerRead), /Status: failed/);
});


test("reconciliation removes only this run's stale wrap-up from a finished worker", async () => {
  const harness = makeHarness();
  const coordinatorId = await launch(harness);
  await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  const worker = [...harness.threads.values()].find((thread) => thread.parentThreadId === coordinatorId)!;
  worker.status = "idle";
  harness.outputs.set(worker.id, "Persisted final findings.");
  const stale = { id: "stale-wrap-up", threadId: worker.id, editable: true, failureReason: null, content: [{ type: "text", text: `Perspectives wrap-up request for run ${coordinatorId}; return the strongest supported findings and important unknowns now.` }] };
  const unrelated = { ...stale, id: "unrelated-request", content: [{ type: "text", text: "Another task's request" }] };
  harness.rows.push(stale, unrelated);
  await harness.call("perspectives_coordinator_step", {}, coordinatorId);
  assert.ok(!harness.rows.some((row) => row.id === stale.id));
  assert.ok(harness.rows.some((row) => row.id === unrelated.id));
  assert.ok(harness.rows.some((row) => row.threadId === coordinatorId), "internal recovery wakes remain pending");
});


function staleWrapUp(workerId: string, runId: string, id: string, editable = true) {
  return { id, threadId: workerId, editable, failureReason: null, content: [{ type: "text", text: `Perspectives wrap-up request for run ${runId}; return the strongest supported findings and important unknowns now.` }] };
}

test("published tools retry failed cleanup, isolate row failures, and preserve unrelated or claimed requests", async () => {
  const harness = makeHarness();
  const runId = await publishRun(harness, "complete");
  const worker = [...harness.threads.values()].find((t) => t.parentThreadId === runId)!;
  worker.status = "error";
  harness.rows.push(staleWrapUp(worker.id, runId, "fails"), staleWrapUp(worker.id, runId, "succeeds"), staleWrapUp(worker.id, runId, "claimed", false), staleWrapUp(worker.id, "other-run", "other"));
  harness.failedDeletes.add("fails");
  const step = JSON.parse(harness.text(await harness.call("perspectives_coordinator_step", {}, runId)));
  assert.equal(step.phase, "already-published");
  assert.equal(step.workerCleanup.workers[0].failed, 1);
  assert.equal(step.workerCleanup.workers[0].removed, 1);
  assert.ok(!harness.rows.some(r => r.id === "succeeds"));
  harness.failedDeletes.clear();
  harness.failedQueueLists.add(worker.id);
  const unavailable = JSON.parse(harness.text(await harness.call("perspectives_publish_result", { synthesis: "unchanged" }, runId)));
  assert.equal(unavailable.workerCleanup.workers[0].unavailable, true);
  harness.failedQueueLists.clear();
  await harness.call("perspectives_publish_result", { synthesis: "unchanged" }, runId);
  assert.deepEqual(harness.rows.map(r => r.id).sort(), ["claimed", "other"]);
});

test("post-publication cleanup preserves active workers and retries when they later stop", async () => {
  const harness = makeHarness();
  const runId = await publishRun(harness, "complete");
  const worker = [...harness.threads.values()].find((t) => t.parentThreadId === runId)!;
  worker.status = "active";
  harness.rows.push(staleWrapUp(worker.id, runId, "later"));
  await harness.call("perspectives_coordinator_step", {}, runId);
  assert.ok(harness.rows.some(r => r.id === "later"));
  worker.status = "idle";
  await harness.call("perspectives_coordinator_step", {}, runId);
  assert.ok(!harness.rows.some(r => r.id === "later"));
});

test("marker discovery reports unavailable verification instead of hiding a candidate", async () => {
  const harness = makeHarness();
  const runId = await publishRun(harness, "complete");
  const prompt = harness.initialPrompts.get(runId)!;
  const marker = prompt.match(/"invocationMarker":\s*"([^"]+)"/)![1]!;
  harness.failedGets.add(runId);
  let result = await harness.call("perspectives_read_result", { invocationMarker: marker }, "caller");
  assert.equal(result.isError, true);
  assert.match(harness.text(result), /discovery is unavailable/);
  harness.failedGets.clear();
  const duplicate = "unavailable-duplicate";
  harness.threads.set(duplicate, { ...harness.threads.get(runId), id: duplicate });
  harness.initialPrompts.set(duplicate, prompt);
  harness.failedEventLists.add(duplicate);
  result = await harness.call("perspectives_read_result", { invocationMarker: marker }, "caller");
  assert.equal(result.isError, true);
  assert.match(harness.text(result), /discovery is unavailable/);
});

test("wrap-up rechecks worker status after queue reads and retains exact internal schedules", async () => {
  const harness = makeHarness();
  const started = Date.now();
  const runId = await launch(harness);
  await harness.call("perspectives_coordinator_step", {}, runId);
  const runRows = harness.rows.filter(r => r.threadId === runId);
  assert.equal(runRows.length, 4);
  const wrap = runRows.find(r => r.content[0].text.includes("tag=wrap-up"))!;
  const deadline = runRows.find(r => r.content[0].text.includes("tag=deadline"))!;
  assert.ok(wrap.sendAt >= started + 20 * 60_000 && wrap.sendAt <= Date.now() + 20 * 60_000);
  assert.equal(deadline.sendAt - wrap.sendAt, 5 * 60_000);
  assert.ok(runRows.filter(r => r.content[0].text.startsWith("Perspectives worker launch intent:")).every(r => r.sendAt === deadline.sendAt + 60_000));
  assert.equal(harness.rows.filter(r => r.threadId === "caller").length, 0);
  const workers = [...harness.threads.values()].filter(t => t.parentThreadId === runId);
  harness.completeOnQueueRead.add(workers[0]!.id);
  const realNow = Date.now;
  try {
    Date.now = () => wrap.sendAt + 1;
    await harness.call("perspectives_coordinator_step", {}, runId);
  } finally { Date.now = realNow; }
  const sends = harness.events.filter(e => e.startsWith("send:Perspectives wrap-up request"));
  assert.equal(sends.length, 1, "only the worker still active at the final status check is steered");
});

test("legacy queued caller reminders are not misrepresented by read receipts", async () => {
  const harness = makeHarness();
  const runId = await publishRun(harness, "complete");
  harness.rows.push({ id: "legacy-backstop", threadId: "caller", editable: true, content: [{ type: "text", text: "Perspectives panel result caller backstop" }] });
  const read = await harness.call("perspectives_read_result", { coordinatorId: runId }, "caller");
  assert.match(harness.text(read), /older runs may retain a previously queued reminder/);
  assert.ok(harness.rows.some(r => r.id === "legacy-backstop"));
});


test("lifecycle coordinator sends a completion only after verified publication and replays do not resend", async () => {
  const harness = makeHarness();
  const runId = await readyToPublishRun(harness);
  const coordinator = harness.threads.get(runId)!;
  assert.equal(coordinator.parentThreadId, null);
  assert.equal(coordinator.lifecycleOwnerThreadId, "caller");
  assert.equal(harness.requestedMessages.get("caller"), undefined, "research/progress turns do not send caller messages");
  for (const worker of [...harness.threads.values()].filter(t => t.parentThreadId === runId)) assert.equal(worker.lifecycleOwnerThreadId, runId);
  const result = JSON.parse(harness.text(await harness.call("perspectives_publish_result", { synthesis: "Final evidence", coverage: "complete" }, runId)));
  assert.equal(result.completionDelivery, "accepted");
  assert.equal(harness.requestedMessages.get("caller")!.length, 1);
  const send = harness.events.findIndex(e => e.startsWith("send:Perspectives panel result ready"));
  assert.ok(harness.events.lastIndexOf("file-read", send) >= 0);
  await harness.call("perspectives_coordinator_step", {}, runId);
  await harness.call("perspectives_publish_result", { synthesis: "again" }, runId);
  assert.equal(harness.requestedMessages.get("caller")!.length, 1);
  const read = await harness.call("perspectives_read_result", { coordinatorId: runId }, "caller");
  assert.equal(read.isError, undefined);
});

test("completion response loss reconciles acceptance and uncertain attempts never blindly resend", async () => {
  for (const mode of ["before", "after"]) {
    const harness = makeHarness();
    const runId = await readyToPublishRun(harness);
    harness.completionSendFault.mode = mode;
    const first = JSON.parse(harness.text(await harness.call("perspectives_publish_result", { synthesis: "Final evidence" }, runId)));
    assert.equal(first.completionDelivery, mode === "after" ? "accepted" : "uncertain-no-blind-retry");
    harness.completionSendFault.mode = "";
    await harness.call("perspectives_coordinator_step", {}, runId);
    assert.equal(harness.events.filter(e => e.startsWith("send:Perspectives panel result ready")).length, 1);
    assert.match(harness.text(await harness.call("perspectives_read_result", { coordinatorId: runId }, "caller")), /Verified Perspectives artifact/);
  }
});

test("legacy parented protocol remains readable and uses native final reporting", async () => {
  const harness = makeHarness();
  const runId = await launch(harness);
  const coordinator = harness.threads.get(runId)!;
  coordinator.parentThreadId = "caller";
  coordinator.lifecycleOwnerThreadId = null;
  const prompt = harness.initialPrompts.get(runId)!.replace("Perspectives coordinator protocol: 2", "Perspectives coordinator protocol: 1").replace('"protocolVersion": 2', '"protocolVersion": 1');
  harness.initialPrompts.set(runId, prompt);
  await harness.call("perspectives_coordinator_step", {}, runId);
  for (const t of harness.threads.values()) if (t.parentThreadId === runId) { t.status = "idle"; harness.outputs.set(t.id, "Legacy evidence"); }
  const result = JSON.parse(harness.text(await harness.call("perspectives_publish_result", { synthesis: "Legacy synthesis" }, runId)));
  assert.equal(result.completionDelivery, "legacy-native-parent-report");
  assert.equal(harness.requestedMessages.get("caller"), undefined);
  assert.match(harness.text(await harness.call("perspectives_read_result", { coordinatorId: runId }, "caller")), /Verified Perspectives artifact/);
});


test("v2 coordinator authentication rejects wrong lifecycle ownership or an added parent", async () => {
  const harness = makeHarness();
  const runId = await launch(harness);
  const thread = harness.threads.get(runId)!;
  thread.lifecycleOwnerThreadId = "someone-else";
  let result = await harness.call("perspectives_coordinator_step", {}, runId);
  assert.equal(result.isError, true);
  thread.lifecycleOwnerThreadId = "caller";
  thread.parentThreadId = "caller";
  result = await harness.call("perspectives_coordinator_step", {}, runId);
  assert.equal(result.isError, true);
  result = await harness.call("perspectives_read_result", { coordinatorId: runId }, "caller");
  assert.equal(result.isError, true);
});


test("persisted completion intent without a send freezes retries while leaving the artifact readable", async () => {
  const harness = makeHarness();
  const runId = await publishRun(harness, "complete");
  const digest = harness.metadata.get(runId)!.completionAttempt;
  harness.metadata.set(runId, { completionAttempt: digest });
  harness.requestedMessages.delete("caller");
  const before = harness.events.filter(e => e.startsWith("send:Perspectives panel result ready")).length;
  const replay = JSON.parse(harness.text(await harness.call("perspectives_coordinator_step", {}, runId)));
  assert.equal(replay.completionDelivery, "uncertain-no-blind-retry");
  assert.equal(harness.events.filter(e => e.startsWith("send:Perspectives panel result ready")).length, before);
  assert.match(harness.text(await harness.call("perspectives_read_result", { coordinatorId: runId }, "caller")), /Verified Perspectives artifact/);
});
