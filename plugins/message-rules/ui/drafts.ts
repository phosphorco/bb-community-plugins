import type { Draft, ProjectState } from "./types.ts";
export function hasRelevantDrafts(
  projectId: string | null,
  p: ProjectState | null | undefined,
  drafts: Map<string, Draft>,
) {
  return [...drafts].some(([key, d]) => {
    if (!key.startsWith(projectId + ":") || d.value === d.base) return false;
    const saved =
      d.kind === "test"
        ? p?.occurrences.find(
            (o) => key === projectId + ":test:" + o.occurrenceId,
          )
        : d.kind === "group"
          ? p?.groups?.find((g) => key === projectId + ":group:" + g.id)
          : p?.rules.find((r) => key === projectId + ":rule:" + r.id);
    if (!saved) return false;
    let enabled = false;
    if (d.kind === "rule" || d.kind === "group")
      try {
        enabled = JSON.parse(d.value).enabled === true;
      } catch {
        enabled = true;
      }
    return d.kind === "group" || !!saved?.enabled || enabled;
  });
}
