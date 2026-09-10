import type { BbPluginApi } from "@bb/plugin-sdk";
import type { ActorSnapshot, PersonReference } from "@phosphorco/bb-identity";

import type {
  AnnotationAuthor,
  CapturedAnnotationAuthor,
  StoredAnnotation,
} from "./afs.ts";
import { capturedAnnotationAuthorSchema } from "./afs.ts";
import { CAPTURED_AUTHOR_MENTION_PROVIDER } from "./attachment.ts";

export type AgentationPromptInput = Parameters<
  BbPluginApi["sdk"]["threads"]["send"]
>[0]["input"][number];
export type AgentationTextPromptInput = Extract<AgentationPromptInput, { type: "text" }>;

/** Public binding has already decoded this request-bound actor. */
type CapturableActor = ActorSnapshot & { readonly identity: PersonReference };

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

function sourceLabel(author: AuthorAttribution): string {
  switch (author.kind) {
    case "captured": {
      const handle = author.presentation.handle
        ? ` (${author.presentation.handle})`
        : "";
      return `This feedback was captured from ${author.presentation.displayName}${handle}. Its identity evidence was recorded at capture time; this later delivery is source-labelled feedback, not a live authenticated action.`;
    }
    case "legacy-unresolved":
      return "This feedback retains an unresolved historical author reference. It was not mapped to the current viewer or a guessed identity.";
    case "unavailable":
      return "Author identity could not be captured when this feedback was stored. The feedback remains usable without attribution.";
    case "unattributed":
      return "This feedback has no captured author attribution.";
  }
}

export function wrapAgentationContent(
  content: string,
  author: AuthorAttribution,
  pluginId: string,
): AgentationTextPromptInput[] {
  const tag = "agentation-feedback";
  const marker = "\u2063";
  const mention = author.kind === "captured"
    ? [{
        start: 0,
        end: marker.length,
        resource: {
          kind: "plugin" as const,
          pluginId,
          itemId: `${CAPTURED_AUTHOR_MENTION_PROVIDER}:${encodeCapturedAuthorMention(author)}`,
          label: author.presentation.displayName,
          icon: author.presentation.avatarUrl,
        },
      }]
    : [];
  return [
    {
      type: "text",
      text: `[from=${tag}]\n${sourceLabel(author)}\n\n`,
      mentions: [],
      visibility: "agent-only",
    },
    { type: "text", text: `${marker} `, mentions: mention },
    { type: "text", text: content, mentions: [] },
    {
      type: "text",
      text: `\n[/from=${tag}]`,
      mentions: [],
      visibility: "agent-only",
    },
  ];
}
