/** Data attributes that make a copied Agentation location actionable in bb. */
export const SPECIAL_LOCATION_ATTRIBUTES = [
  "data-panel-id",
  "data-bb-plugin",
  "data-testid",
] as const;

function parentElement(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;

  const root = element.getRootNode?.();
  if (root && typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot) {
    return root.host;
  }
  return null;
}

function attributeSuffix(element: Element | null): string {
  if (!element) return "";
  return SPECIAL_LOCATION_ATTRIBUTES
    .filter((name) => element.hasAttribute(name))
    .map((name) => `[${name}=${JSON.stringify(element.getAttribute(name) ?? "")}]`)
    .join("");
}

/** Add bb's identifying attributes to the matching segments of an Agentation path. */
export function decorateElementPath(path: string, target: Element | null): string {
  if (!path || !target) return path;

  const parts = path.split(" > ");
  let current: Element | null = target;
  for (let offset = 0; offset < parts.length && current; offset += 1) {
    const suffix = attributeSuffix(current);
    const partIndex = parts.length - 1 - offset;
    if (suffix && !parts[partIndex]!.includes(suffix)) parts[partIndex] += suffix;
    current = parentElement(current);
  }
  return parts.join(" > ");
}

type LocatedAnnotation = {
  id: string;
  elementPath?: string;
  fullPath?: string;
};

type LocationOverride = Pick<LocatedAnnotation, "elementPath" | "fullPath">;

/**
 * Preserve bb-aware paths across Agentation's delayed localStorage effect.
 * The dependency writes its undecorated annotation after the add callback;
 * this small in-memory overlay restores only the two location fields and
 * leaves annotation order and every other field untouched.
 */
export function createLocationOverrides() {
  const byId = new Map<string, LocationOverride>();

  const apply = <T extends LocatedAnnotation>(annotation: T): T => {
    const override = byId.get(annotation.id);
    return override ? { ...annotation, ...override } : annotation;
  };

  return {
    capture<T extends LocatedAnnotation>(annotation: T, target: Element | null): T {
      const decorated = {
        ...annotation,
        ...(annotation.elementPath !== undefined
          ? { elementPath: decorateElementPath(annotation.elementPath, target) }
          : {}),
        ...(annotation.fullPath !== undefined
          ? { fullPath: decorateElementPath(annotation.fullPath, target) }
          : {}),
      };
      byId.set(annotation.id, {
        ...(decorated.elementPath !== undefined ? { elementPath: decorated.elementPath } : {}),
        ...(decorated.fullPath !== undefined ? { fullPath: decorated.fullPath } : {}),
      });
      return decorated;
    },
    apply,
    applyAll<T extends LocatedAnnotation>(annotations: readonly T[]): T[] {
      return annotations.map(apply);
    },
    delete(id: string): void {
      byId.delete(id);
    },
    clear(): void {
      byId.clear();
    },
  };
}

/** Replace Agentation's generated locations with the persisted bb-aware ones. */
export function replaceCopiedLocations(
  output: string,
  annotations: readonly Pick<LocatedAnnotation, "elementPath" | "fullPath">[],
): string {
  let index = 0;
  return output.replace(
    /^\*\*(Location|Full DOM Path):\*\* .*$/gm,
    (line, label: "Location" | "Full DOM Path") => {
      const annotation = annotations[index++];
      const location = label === "Location" ? annotation?.elementPath : annotation?.fullPath;
      return location ? `**${label}:** ${location}` : line;
    },
  );
}
