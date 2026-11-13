import type { Occurrence, TestResult } from "../state/store.ts";
import type { Draft, ProjectState } from "./types.ts";
export function groupDraftCounts(
  p: ProjectState | null | undefined,
  drafts: Map<string, Draft>,
  catalogId: string,
) {
  const counts = new Map<string, number>();
  const add = (kind: string, id: string, group: string) => {
    const d = drafts.get(catalogId + ":" + kind + ":" + id);
    if (d && d.value !== d.base)
      counts.set(group, (counts.get(group) ?? 0) + 1);
  };
  for (const g of p?.groups ?? []) add("group", g.id, g.id);
  for (const r of p?.rules ?? []) add("rule", r.id, r.groupId);
  for (const o of p?.occurrences ?? [])
    if (o.enabled && o.groupId) add("test", o.occurrenceId, o.groupId);
  return counts;
}
export function groupSummary(
  tests: Occurrence[],
  savedTests: Occurrence[],
  results: Map<string, TestResult>,
  stale: boolean,
  draftCount: number,
) {
  const enabled = tests.filter((o) => o.enabled),
    parts = [enabled.length + " enabled"];
  const counts = new Map<string, number>();
  for (const o of savedTests) {
    const state = results.get(o.occurrenceId)?.status ?? "untested";
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  if (savedTests.length) {
    const labels: Record<string, string> = {
      fail: "failed",
      error: "errors",
      unknown: "unknown",
      untested: "not tested",
    };
    const pass = counts.get("pass") ?? 0;
    const saved = [
      `${pass} / ${savedTests.length} passed`,
      ...Array.from(counts)
        .filter(([k]) => k !== "pass")
        .map(([k, n]) => n + " " + labels[k]),
    ].join(", ");
    parts.push((stale || draftCount ? "Saved: " : "") + saved);
  } else if (enabled.length) parts.push("Not tested");
  if (stale) parts.push("Stale");
  if (draftCount)
    parts.push(draftCount + " draft" + (draftCount === 1 ? "" : "s"));
  const errors = enabled.filter((o) => o.error).length;
  if (errors && (stale || draftCount || !savedTests.length))
    parts.push(errors + " current error" + (errors === 1 ? "" : "s"));
  if (tests.length > enabled.length)
    parts.push(tests.length - enabled.length + " disabled");
  return parts.join(" · ");
}
