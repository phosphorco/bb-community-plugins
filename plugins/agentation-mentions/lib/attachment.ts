export const AGENTATION_MENTION_PROVIDER = "feedback-batch";
export const MAX_ATTACHED_ANNOTATIONS = 50;
const MAX_ANNOTATION_ID_LENGTH = 256;

export interface AgentationAttachment {
  annotationIds: string[];
}

export function encodeAgentationAttachment(
  attachment: AgentationAttachment,
): string {
  return encodeURIComponent(JSON.stringify(attachment));
}

export function decodeAgentationAttachment(
  value: string,
): AgentationAttachment {
  if (value.length > 20_000) {
    throw new Error("Invalid Agentation attachment");
  }
  const parsed: unknown = JSON.parse(decodeURIComponent(value));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("annotationIds" in parsed) ||
    !Array.isArray(parsed.annotationIds) ||
    parsed.annotationIds.length === 0 ||
    parsed.annotationIds.length > MAX_ATTACHED_ANNOTATIONS ||
    parsed.annotationIds.some(
      (annotationId) =>
        typeof annotationId !== "string" ||
        annotationId.length === 0 ||
        annotationId.length > MAX_ANNOTATION_ID_LENGTH,
    ) ||
    new Set(parsed.annotationIds).size !== parsed.annotationIds.length
  ) {
    throw new Error("Invalid Agentation attachment");
  }

  return {
    annotationIds: parsed.annotationIds,
  };
}
