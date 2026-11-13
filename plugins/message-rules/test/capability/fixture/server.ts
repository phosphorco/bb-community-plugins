import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
// Isolated native capability driver, never a real model or shipped product entry.
export default function capabilityProbe(bb: BbPluginApi) {
  bb.experimental_hooks.on("message.dispatch", (c) =>
    c.requestedExecution.providerId === "message-rules-proof"
      ? {
          action: "wait",
          reason:
            "Task-owned native capability capture; no provider execution.",
        }
      : { action: "proceed" },
  );
  type Probe = {
    operationId: string;
    originalId: string;
    target: string;
    text: string;
    state: string;
    ack: unknown;
    error: string | null;
  };
  const status = async (operationId: string) => {
    const probe = await bb.storage.kv.get<Probe>("receipt:" + operationId);
    if (!probe) return { state: "missing" };
    const queued = await bb.sdk.threads.queuedMessages.list({
      threadId: probe.target,
    });
    const correlated = queued.filter((message) =>
      message.content.some(
        (block) => block.type === "text" && block.text.includes(operationId),
      ),
    );
    return {
      ...probe,
      correlatedQueuedIds: correlated.map((x) => x.id),
      consumed: false,
      claim:
        "Native correlation only, not authenticated exemption or sender consumption. Controlled hook holds execution.",
    };
  };
  bb.rpc.register(
    {
      probeReceipt: {
        input: z.object({
          operationId: z.string().uuid(),
          originalId: z.string(),
          target: z.string(),
          text: z.string().max(4000),
        }),
        output: z.unknown(),
      },
      receiptStatus: {
        input: z.object({ operationId: z.string().uuid() }),
        output: z.unknown(),
      },
    },
    {
      async probeReceipt(input) {
        const existing = await bb.storage.kv.get<Probe>(
          "receipt:" + input.operationId,
        );
        if (existing) return status(input.operationId);
        const target = await bb.sdk.threads.get({ threadId: input.target });
        if (target.providerId !== "message-rules-proof")
          throw Error("Probe target is not task-owned inert provider.");
        const probe: Probe = {
          ...input,
          state: "sending",
          ack: null,
          error: null,
        };
        await bb.storage.kv.set("receipt:" + input.operationId, probe);
        try {
          probe.ack = await bb.sdk.threads.send({
            threadId: input.target,
            input: [
              { type: "text", text: JSON.stringify(input), mentions: [] },
            ],
            mode: "auto",
            model: "inert",
            reasoningLevel: "low",
            permissionMode: "auto",
          });
          probe.state = "acknowledged";
        } catch (e) {
          probe.state = "unknown";
          probe.error = String(e);
        }
        await bb.storage.kv.set("receipt:" + input.operationId, probe);
        return status(input.operationId);
      },
      receiptStatus: (input) => status(input.operationId),
    },
  );
  bb.providers.register({
    id: "message-rules-proof",
    displayName: "Inert Message Rules proof",
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["auto"],
      reasoningLevels: ["low"],
    },
    composerActions: [],
    models: {
      fallback: [
        {
          id: "inert",
          displayName: "Inert",
          description: "No model calls; scheduled queue proof only.",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Inert" },
          ],
          defaultReasoningEffort: "low",
          isDefault: true,
        },
      ],
    },
  });
}
