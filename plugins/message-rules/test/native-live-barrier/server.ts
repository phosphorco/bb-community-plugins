import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const TASK_PROJECT = "Native barrier case thr_4u2zyx4rb3";
export const RECEIVER_TITLE = "Native barrier receiver thr_4u2zyx4rb3";
type State = { projectId: string; receiverTitle: string; armed: boolean };

// Operational test synchronization only. Never installed in the normal state.
// This fixture supplies no admission verdict, original, source, grouping or output.
export default function nativeLiveBarrier(bb: BbPluginApi) {
  const scope = z.object({
    projectId: z.string().min(1),
    receiverTitle: z.literal(RECEIVER_TITLE),
  }).strict();
  async function verifyProject(projectId: string) {
    const project = await bb.sdk.projects.get({ projectId });
    if (project.name !== TASK_PROJECT) throw Error("Not the exact task project");
  }
  bb.rpc.register({
    arm: { input: scope, output: z.unknown() },
    release: { input: scope, output: z.unknown() },
    status: { input: z.object({}).strict(), output: z.unknown() },
  }, {
    async arm(input) {
      await verifyProject(input.projectId);
      const current = await bb.storage.kv.get<State>("barrier");
      if (current && (current.projectId !== input.projectId || current.receiverTitle !== input.receiverTitle))
        throw Error("Barrier already belongs to another scope");
      const state = { ...input, armed: true };
      await bb.storage.kv.set("barrier", state);
      return state;
    },
    async release(input) {
      await verifyProject(input.projectId);
      const current = await bb.storage.kv.get<State>("barrier");
      if (!current || current.projectId !== input.projectId || current.receiverTitle !== input.receiverTitle)
        throw Error("Release does not match configured barrier");
      const state = { ...current, armed: false };
      await bb.storage.kv.set("barrier", state);
      await bb.experimental_hooks.recheck("message.dispatch");
      return state;
    },
    async status() {
      return { state: await bb.storage.kv.get<State>("barrier"),
        lastHeld: await bb.storage.kv.get("lastHeld") };
    },
  });
  bb.experimental_hooks.on("message.dispatch", async (context) => {
    const state = await bb.storage.kv.get<State>("barrier");
    // The published SDK predates this additive candidate-native context member.
    const admission = (context as typeof context & {
      experimental_admission?: { phase: string; submissions: readonly unknown[] };
    }).experimental_admission;
    if (!state?.armed || !admission?.submissions.length) return { action: "proceed" };
    const thread = await bb.sdk.threads.get({ threadId: context.thread.id });
    if (thread.projectId !== state.projectId || thread.title !== state.receiverTitle)
      return { action: "proceed" };
    await bb.storage.kv.set("lastHeld", {
      threadId: thread.id, projectId: thread.projectId, title: thread.title,
      phase: admission.phase, submissionCount: admission.submissions.length,
    });
    return { action: "wait", reason: "Explicit task-only controlled lifecycle barrier" };
  });
}
