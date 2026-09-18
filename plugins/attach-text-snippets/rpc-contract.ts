import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { MAX_SNIPPET_BYTES } from "./snippet-model.ts";

export const snippetSummarySchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).max(120),
  relativePath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
}).strict();

export const rpcContract = defineRpcContract({
  createSnippet: {
    input: z.object({
      threadId: z.string().min(1),
      title: z.string().max(120),
      content: z.string().min(1).max(MAX_SNIPPET_BYTES),
    }).strict(),
    output: z.object({ snippet: snippetSummarySchema }).strict(),
  },
});

export type SnippetSummary = z.infer<typeof snippetSummarySchema>;
