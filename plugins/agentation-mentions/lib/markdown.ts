// Rendering annotations for agents.
//
// The toolbar already produces markdown for copy/paste, but it knows nothing
// about bb: it cannot say which plugin owns the element or which thread the
// reviewer was looking at. These renderers add that, and they are what the
// agent tools, the CLI, and "Send to agent" all return, so an annotation reads
// the same wherever an agent meets it.

import type { Session, StoredAnnotation } from "./afs.ts";
import { capturedAuthorLabel } from "./identity.ts";

function line(label: string, value: string | null | undefined): string {
  return value ? `**${label}:** ${value}\n` : "";
}

function locationOf(annotation: StoredAnnotation): string {
  const { pluginId, surface, route } = annotation.bb;
  if (!pluginId) return `bb app shell · ${route}`;
  const surfaceLabel = surface ? ` (${surface})` : "";
  return `plugin \`${pluginId}\`${surfaceLabel} · ${route}`;
}

function describeKind(annotation: StoredAnnotation): string | null {
  if (annotation.kind === "placement" && annotation.placement) {
    const { componentType, width, height } = annotation.placement;
    return `place a \`${componentType}\` here, roughly ${Math.round(width)}×${Math.round(height)}px`;
  }
  if (annotation.kind === "rearrange" && annotation.rearrange) {
    const { label, originalRect, currentRect } = annotation.rearrange;
    const dx = Math.round(currentRect.y - originalRect.y);
    const direction = dx < 0 ? "earlier" : "later";
    return `move the \`${label}\` section ${Math.abs(dx)}px ${direction} in the page order`;
  }
  return null;
}

function annotationAuthorLabel(annotation: StoredAnnotation): string | null {
  if (annotation.author?.kind === "captured") {
    return capturedAuthorLabel(annotation.author);
  }
  if (annotation.author?.kind === "unavailable" || annotation.authorIdentityId) {
    return "unknown (historical author retained)";
  }
  return null;
}

function replyLabel(message: StoredAnnotation["thread"][number]): string {
  if (!message.author) return message.role;
  if (message.author.kind === "captured") return capturedAuthorLabel(message.author);
  return "unknown";
}

function renderAnnotationDetails(
  annotation: StoredAnnotation,
  options: { readonly includeOriginal: boolean },
): string {
  let out = "";
  out += line("Where", locationOf(annotation));
  out += line("Selector", `\`${annotation.elementPath}\``);
  out += line("React", annotation.reactComponents);
  out += line("Source", annotation.sourceFile);
  out += line("Classes", annotation.cssClasses);
  out += line("Selected text", annotation.selectedText ? `"${annotation.selectedText}"` : null);
  out += line("Nearby text", annotation.selectedText ? null : annotation.nearbyText?.slice(0, 160));
  out += line("Intent", annotation.intent);
  out += line("Severity", annotation.severity);
  out += line("Status", annotation.status);
  out += line("Author", annotationAuthorLabel(annotation));

  const kindNote = describeKind(annotation);
  out += line("Layout request", kindNote);

  if (options.includeOriginal) {
    out += `**Original feedback:** ${annotation.comment}\n`;
  }

  if (annotation.thread.length > 0) {
    out += `\n**Replies to this annotation:**\n`;
    for (const message of annotation.thread) {
      out += `- _${replyLabel(message)}_: ${message.content}\n`;
    }
  }
  if (annotation.resolution) {
    out += `\n**Resolution:** ${annotation.resolution}\n`;
  }
  return out;
}

/** Derived annotation context for an Agentation message's <attached> block. */
export function renderAnnotationAttachment(
  annotation: StoredAnnotation,
  options: { readonly includeOriginal?: boolean } = {},
): string {
  const heading = `### Annotation ${annotation.element} — ${annotation.id}\n`;
  return heading + renderAnnotationDetails(annotation, {
    includeOriginal: options.includeOriginal ?? true,
  }).trimEnd();
}

/** One annotation as a self-contained markdown section. */
export function renderAnnotation(annotation: StoredAnnotation, index?: number): string {
  const heading =
    index === undefined
      ? `### ${annotation.element} — ${annotation.id}`
      : `### ${index}. ${annotation.element} — ${annotation.id}`;

  const details = renderAnnotationDetails(annotation, { includeOriginal: true })
    .replace("**Original feedback:**", "**Feedback:**")
    .replace("**Replies to this annotation:**", "**Conversation:**");
  return `${heading}\n${details}`.trimEnd();
}

/** A batch of annotations, grouped so the agent reads one page at a time. */
export function renderAnnotations(
  annotations: StoredAnnotation[],
  options: { title?: string; sessions?: Session[] } = {},
): string {
  if (annotations.length === 0) {
    return "No annotations.";
  }

  const bySession = new Map<string, StoredAnnotation[]>();
  for (const annotation of annotations) {
    const bucket = bySession.get(annotation.sessionId);
    if (bucket) bucket.push(annotation);
    else bySession.set(annotation.sessionId, [annotation]);
  }

  const sessionsById = new Map((options.sessions ?? []).map((session) => [session.id, session]));

  let out = `## ${options.title ?? "bb UI feedback"}\n\n`;
  out += `${annotations.length} annotation${annotations.length === 1 ? "" : "s"} across ${bySession.size} page${bySession.size === 1 ? "" : "s"}. Element selectors are live bb DOM paths — pair them with the owning plugin or the bb app source to find the code.\n`;

  for (const [sessionId, sessionAnnotations] of bySession) {
    const session = sessionsById.get(sessionId);
    const label = session ? `${session.route} (${sessionId})` : sessionId;
    out += `\n---\n\n## Page: ${label}\n\n`;
    sessionAnnotations.forEach((annotation, index) => {
      out += `${renderAnnotation(annotation, index + 1)}\n`;
    });
  }

  return out.trimEnd();
}

/** A self-contained assignment sent directly to one bb thread. */
export function renderAnnotationAssignment(
  annotations: StoredAnnotation[],
  sessions: Session[],
): string {
  const markdown = renderAnnotations(annotations, {
    title: "bb UI feedback from Agentation",
    sessions,
  });

  return `${markdown}\n\nThe annotations above are the complete batch assigned to this thread. Work only on these annotation IDs. Do not call \`agentation_mentions_get_all_pending\`; it can include feedback assigned to other threads. Resolve each item with the \`agentation_mentions_resolve\` tool once it is fixed, or use \`agentation_mentions_reply\` if you need a decision from me.`;
}

/** One line per annotation, for CLI listings and tool summaries. */
export function renderAnnotationLine(annotation: StoredAnnotation): string {
  const owner = annotation.bb.pluginId ? `plugin:${annotation.bb.pluginId}` : "bb-shell";
  const severity = annotation.severity ? ` [${annotation.severity}]` : "";
  const comment = annotation.comment.replace(/\s+/g, " ").slice(0, 100);
  return `${annotation.id}  ${annotation.status.padEnd(12)} ${owner.padEnd(24)} ${annotation.element.padEnd(10)}${severity} ${comment}`;
}
