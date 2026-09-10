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


export function encodeCapturedAuthorSnapshot(author: CapturedAnnotationAuthor): string {
  return encodeURIComponent(JSON.stringify(author));
}

export function decodeCapturedAuthorSnapshot(value: string): CapturedAnnotationAuthor {
  if (value.length > 12_000) throw new Error("Invalid captured feedback author");
  return capturedAnnotationAuthorSchema.parse(JSON.parse(decodeURIComponent(value)));
}

function escapeWrapperLabel(label: string): string {
  return label.replace(/[\[\]\r\n%<>]/g, (character) => encodeURIComponent(character));
}

export function capturedAuthorLabel(author: CapturedAnnotationAuthor): string {
  const label = author.identity.kind === "machine"
    ? "machine:" + author.presentation.displayName
    : author.presentation.handle ?? author.presentation.displayName;
  return escapeWrapperLabel(label);
}

/**
 * Render one captured Agentation message. The annotation comment is the
 * original content. Selector, route, replies and other derived details are
 * supplied separately as an optional attachment so the host cannot mistake
 * them for words authored by the captured person.
 *
 * Unknown and legacy authors deliberately remain unwrapped. A historical
 * marker is evidence to preserve, not permission to invent a current sender.
 */
export function wrapAgentationContent(
  content: string,
  author: AuthorAttribution,
  attached?: string,
): AgentationTextPromptInput[] {
  const attachment = attached === undefined || attached.length === 0
    ? null
    : `\n<attached>\n${attached}\n</attached>`;

  if (author.kind !== "captured") {
    return [
      { type: "text" as const, text: content, mentions: [] },
      ...(attachment
        ? [{ type: "text" as const, text: attachment, mentions: [], visibility: "agent-only" as const }]
        : []),
    ];
  }

  const label = capturedAuthorLabel(author);
  return [
    {
      type: "text" as const,
      text: `[message posted via Agentation]\n[sender=${label}]\n`,
      mentions: [],
      visibility: "agent-only",
    },
    { type: "text" as const, text: content, mentions: [] },
    ...(attachment
      ? [{ type: "text" as const, text: attachment, mentions: [], visibility: "agent-only" as const }]
      : []),
    {
      type: "text" as const,
      text: `\n[/sender=${label}]`,
      mentions: [],
      visibility: "agent-only",
    },
  ];
}
