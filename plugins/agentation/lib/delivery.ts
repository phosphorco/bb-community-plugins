import type { BbPluginApi } from "@bb/plugin-sdk";

export type AnnotationDelivery = "send" | "queue";

type ThreadInput = Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0]["input"];

type AnnotationThreadDelivery = {
  send(args: {
    threadId: string;
    mode: "auto";
    input: ThreadInput;
  }): Promise<unknown>;
  queuedMessages: {
    create(args: { threadId: string; input: ThreadInput }): Promise<unknown>;
  };
};

export async function deliverAnnotationInput(
  threads: AnnotationThreadDelivery,
  threadId: string,
  input: ThreadInput,
  delivery: AnnotationDelivery,
): Promise<void> {
  if (delivery === "queue") {
    await threads.queuedMessages.create({ threadId, input });
    return;
  }

  await threads.send({ threadId, mode: "auto", input });
}
