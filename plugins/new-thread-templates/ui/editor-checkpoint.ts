import { definitionSchema, type TemplateDefinition } from "../model.ts";
export type NumericText = Record<string, string>;
/** Object insertion order is not editor content; arrays and raw numeric text are. */
export function canonicalEditorValue(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .filter((key) => item[key] !== undefined)
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
export function definitionFingerprint(value: TemplateDefinition): string {
  return canonicalEditorValue(definitionSchema.parse(value));
}
export function matchesEditorBaseline(
  value: TemplateDefinition,
  baseline: string,
): boolean {
  try {
    return (
      definitionFingerprint(value) ===
      definitionFingerprint(JSON.parse(baseline))
    );
  } catch {
    return false;
  }
}
export function matchesEditorWork(
  checkpoint: EditorCheckpoint,
  definition: TemplateDefinition,
  numericText: NumericText = {},
): boolean {
  try {
    return (
      definitionFingerprint(checkpoint.definition) ===
        definitionFingerprint(definition) &&
      canonicalEditorValue(checkpoint.numericText ?? {}) ===
        canonicalEditorValue(numericText)
    );
  } catch {
    return false;
  }
}
export const completeNumericText = (text: string) =>
  text === "" ||
  (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) &&
    Number.isFinite(Number(text)));
export const validNumericEntry = (path: string, text: string) =>
  completeNumericText(text) &&
  (text === "" ||
    !/(?:minLength|maxLength)$/.test(path) ||
    (Number.isInteger(Number(text)) && Number(text) >= 0));
export const unfinishedNumericText = (text: NumericText) =>
  Object.entries(text).find(([path, value]) => !validNumericEntry(path, value));
function validNumericText(value: unknown): value is NumericText {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).length <= 250 &&
    Object.entries(value).every(
      ([path, text]) =>
        /^fields\.\d+\.(default|min|max|minLength|maxLength)$/.test(path) &&
        typeof text === "string" &&
        text.length <= 80,
    )
  );
}
export type EditorCheckpoint = {
  definition: TemplateDefinition;
  baseline: string;
  generation: number | null;
  numericText?: NumericText;
};
const key = (owner: string, id: string) =>
  `new-thread-templates:editor:v1:${JSON.stringify([owner, id])}`;
export function readEditorCheckpoint(
  owner: string,
  id: string,
): { value: EditorCheckpoint | null; error: string | null } {
  try {
    const raw = localStorage.getItem(key(owner, id));
    if (!raw) return { value: null, error: null };
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("definition" in parsed) ||
      !("baseline" in parsed) ||
      typeof parsed.baseline !== "string" ||
      !("generation" in parsed) ||
      (parsed.generation !== null &&
        (!Number.isSafeInteger(parsed.generation) ||
          (parsed.generation as number) < 0))
    )
      throw new Error("Unreadable checkpoint");
    const numericText = "numericText" in parsed ? parsed.numericText : {};
    if (!validNumericText(numericText))
      throw new Error("Unreadable numeric edits");
    const definition = definitionSchema.safeParse(parsed.definition);
    if (!definition.success || definition.data.id !== id)
      throw new Error("Unreadable checkpoint");
    return {
      value: {
        definition: definition.data,
        baseline: parsed.baseline,
        generation: parsed.generation as number | null,
        numericText,
      },
      error: null,
    };
  } catch {
    return {
      value: null,
      error:
        "Your local editor checkpoint could not be read. It has been retained.",
    };
  }
}
export function writeEditorCheckpoint(
  owner: string,
  definition: TemplateDefinition,
  baseline: string,
  generation: number | null,
  numericText: NumericText = {},
): string | null {
  const existing = readEditorCheckpoint(owner, definition.id);
  if (existing.error) return existing.error;
  try {
    if (!validNumericText(numericText))
      return "Numeric edits could not be preserved. Shorten the number before leaving.";
    const bytes = JSON.stringify({
      definition,
      baseline,
      generation,
      numericText,
    });
    const valid = definitionSchema.safeParse(JSON.parse(bytes).definition);
    if (!valid.success)
      return "These edits need a valid number or value before they can be preserved. The last recovery checkpoint is retained.";
    let normalizedBaseline = baseline;
    try {
      normalizedBaseline = definitionFingerprint(JSON.parse(baseline));
    } catch {
      /* Retain an older unreadable baseline for explicit recovery. */
    }
    localStorage.setItem(
      key(owner, definition.id),
      canonicalEditorValue({
        definition: valid.data,
        baseline: normalizedBaseline,
        generation,
        numericText,
      }),
    );
    return null;
  } catch {
    return "Local recovery storage is unavailable. Save the shared draft before leaving this page.";
  }
}
export function removeEditorCheckpoint(
  owner: string,
  definition: TemplateDefinition,
  numericText: NumericText = {},
): string | null {
  const current = readEditorCheckpoint(owner, definition.id);
  if (current.error) return current.error;
  if (
    current.value &&
    !matchesEditorWork(current.value, definition, numericText)
  )
    return "A newer local editor checkpoint was retained.";
  try {
    localStorage.removeItem(key(owner, definition.id));
    return null;
  } catch {
    return "Cannot remove the local editor checkpoint.";
  }
}

/** Discover unfinished NEW templates too; they have no shared catalog row yet. */
export function listEditorCheckpoints(owner: string): {
  items: { id: string; checkpoint: EditorCheckpoint }[];
  error: string | null;
} {
  const items: { id: string; checkpoint: EditorCheckpoint }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (!storageKey?.startsWith("new-thread-templates:editor:v1:")) continue;
      let scope: unknown;
      try {
        scope = JSON.parse(
          storageKey.slice("new-thread-templates:editor:v1:".length),
        );
      } catch {
        continue;
      }
      if (
        !Array.isArray(scope) ||
        scope[0] !== owner ||
        typeof scope[1] !== "string"
      )
        continue;
      const checkpoint = readEditorCheckpoint(owner, scope[1]);
      if (checkpoint.error) return { items, error: checkpoint.error };
      if (checkpoint.value)
        items.push({ id: scope[1], checkpoint: checkpoint.value });
    }
    return { items, error: null };
  } catch {
    return {
      items,
      error:
        "Unfinished local templates could not be listed. Existing checkpoints have been retained.",
    };
  }
}
