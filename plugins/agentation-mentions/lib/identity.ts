import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ActorReference, ActorSnapshot } from "@phosphorco/bb-identity";

import type {
  AnnotationAuthor,
  CapturedAnnotationAuthor,
  StoredAnnotation,
} from "./afs.ts";
import { capturedAnnotationAuthorSchema } from "./afs.ts";

export type AgentationPromptInput = Parameters<
  BbPluginApi["sdk"]["threads"]["send"]
>[0]["input"][number];
export type AgentationTextPromptInput = Extract<AgentationPromptInput, { type: "text" }>;

/** Public binding has already decoded this request-bound actor. */
type CapturableActor = ActorSnapshot & { readonly identity: ActorReference };

export type AuthorAttribution =
  | AnnotationAuthor
  | { readonly kind: "legacy-unresolved"; readonly identityId: string }
  | { readonly kind: "unattributed" };

/** Captured only by the interactive server handler at the first durable write. */
export function captureAnnotationAuthor(
  actor: CapturableActor,
  capturedAt = new Date().toISOString(),
): CapturedAnnotationAuthor {
  return {
    kind: "captured",
    identity: { ...actor.identity },
    presentation: { ...actor.presentation },
    evidence: actor.evidence,
    capturedAt,
  };
}

export function unavailableAnnotationAuthor(
  reason: "unavailable" | "unauthenticated" | "incompatible",
  capturedAt = new Date().toISOString(),
): AnnotationAuthor {
  return { kind: "unavailable", reason, capturedAt };
}

/** Never turn a historical Identity Boundaries ID into a current identity key. */
export function annotationAuthor(
  annotation: Pick<StoredAnnotation, "author" | "authorIdentityId">,
): AuthorAttribution {
  if (annotation.author) return annotation.author;
  if (annotation.authorIdentityId) {
    return { kind: "legacy-unresolved", identityId: annotation.authorIdentityId };
  }
  return { kind: "unattributed" };
}

export function authorGroupKey(author: AuthorAttribution): string {
  switch (author.kind) {
    case "captured":
      return `captured:${author.identity.key}`;
    case "legacy-unresolved":
      return `legacy:${author.identityId}`;
    case "unavailable":
      return `unavailable:${author.reason}`;
    case "unattributed":
      return "unattributed";
  }
}

export function encodeCapturedAuthorMention(author: CapturedAnnotationAuthor): string {
  return encodeURIComponent(JSON.stringify(author));
}

export function decodeCapturedAuthorMention(itemId: string): CapturedAnnotationAuthor {
  if (itemId.length > 12_000) throw new Error("Invalid captured feedback author");
  return capturedAnnotationAuthorSchema.parse(JSON.parse(decodeURIComponent(itemId)));
}

function escapeWrapperLabel(label: string): string {
  return label.replace(/[\[\]\r\n%]/g, (character) => encodeURIComponent(character));
}

export function capturedAuthorLabel(author: CapturedAnnotationAuthor): string {
  const label = author.identity.kind === "machine"
    ? "machine:" + author.presentation.displayName
    : author.presentation.handle ?? author.presentation.displayName;
  return escapeWrapperLabel(label);
}

export function wrapAgentationContent(
  content: string,
  author: AuthorAttribution,
): AgentationTextPromptInput[] {
  if (author.kind !== "captured") {
    return [{ type: "text", text: content, mentions: [] }];
  }

  const label = capturedAuthorLabel(author);
  return [
    {
      type: "text",
      text: `[from=${label}]\n`,
      mentions: [],
      visibility: "agent-only",
    },
    { type: "text", text: content, mentions: [] },
    {
      type: "text",
      text: `\n[/from=${label}]`,
      mentions: [],
      visibility: "agent-only",
    },
  ];
}
