/** One-shot contextual navigation only. Personal work stays with bb-identity/native drafts. */
import { z } from "zod";
import { revisionSchema, type PublishedRevision } from "../model.ts";
const handoffSchema = z
  .object({
    revision: revisionSchema,
    projectId: z.string().nullable(),
    armed: z.boolean(),
  })
  .strict();
const key = (owner: string) => `new-thread-templates:return:${owner}`;
export function rememberFormReturn(
  owner: string,
  revision: PublishedRevision,
  projectId: string | null,
): string | null {
  try {
    sessionStorage.setItem(
      key(owner),
      JSON.stringify({ revision, projectId, armed: false }),
    );
    return null;
  } catch {
    return "The selected form could not be retained for return. Try again or open Manage.";
  }
}
export function armFormReturn(
  owner: string,
  templateId: string,
): string | null {
  try {
    const raw = sessionStorage.getItem(key(owner));
    if (!raw) throw new Error("Missing selected form return");
    const value = handoffSchema.parse(JSON.parse(raw));
    if (value.revision.templateId !== templateId)
      throw new Error("Selected form return changed");
    sessionStorage.setItem(
      key(owner),
      JSON.stringify({ ...value, armed: true }),
    );
    return null;
  } catch {
    return "The selected form could not be retained for return. Try again or open Manage.";
  }
}
export function takeFormReturn(
  owner: string,
): { revision: PublishedRevision; projectId: string | null } | null {
  try {
    const raw = sessionStorage.getItem(key(owner));
    if (!raw) return null;
    const value = handoffSchema.parse(JSON.parse(raw));
    if (!value.armed) return null;
    sessionStorage.removeItem(key(owner));
    return value;
  } catch {
    return null;
  }
}
