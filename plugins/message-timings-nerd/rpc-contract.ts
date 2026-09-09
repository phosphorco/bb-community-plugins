import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  timings: {
    input: z.object({ threadId: z.string().min(1).max(128) }).strict(),
    output: z.object({
      truncated: z.boolean(),
      coveredIds: z.array(z.string()),
      historyStartId: z.string().nullable(),
      stamps: z.array(z.object({
        rowId: z.string(), kind: z.enum(["user", "finish"]), at: z.number().nullable(),
        previousUserAt: z.number().nullable(), previousFinishAt: z.number().nullable(),
        nextUserAt: z.number().nullable(), latest: z.boolean(), status: z.string().nullable(),
      })),
    }),
  },
});
