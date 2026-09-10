import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const projectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    message: z.string().nullable(),
  })
  .strict();

const statusSchema = z
  .object({
    automatic: z.boolean(),
    pending: z.number().int().nonnegative(),
    resumed: z.number().int().nonnegative(),
  })
  .strict();

const outcomeSchema = z
  .object({
    outcome: z.enum([
      "sent",
      "already-handled",
      "not-interrupted",
      "not-eligible",
      "failed",
    ]),
    detail: z.string(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  listProjects: {
    input: z.null(),
    output: z.object({ projects: z.array(projectSchema) }).strict(),
  },
  saveProjectMessage: {
    input: z
      .object({
        projectId: z.string().min(1),
        message: z.string().max(4000),
      })
      .strict(),
    output: projectSchema,
  },
  clearProjectMessage: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: projectSchema,
  },
  status: {
    input: z.null(),
    output: statusSchema,
  },
  resumeThread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: outcomeSchema,
  },
});

export type RestartResumeProject = z.infer<typeof projectSchema>;
export type RestartResumeOutcome = z.infer<typeof outcomeSchema>;
