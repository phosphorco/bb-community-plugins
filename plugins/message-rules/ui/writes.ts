import { canonical } from "../contracts/value.ts";
import { fileLocation } from "../contracts/model.ts";
import type { Draft, Snapshot } from "./types.ts";
export type WriteIntent = {
  projectId: string;
  method: string;
  input: Record<string, unknown>;
};
export type PendingSave = { submitted: string; intent: WriteIntent };
export function operationKey(w: WriteIntent) {
  const i = w.input;
  return (
    w.projectId +
    ":" +
    w.method +
    ":" +
    String(
      i.path ??
        i.groupId ??
        (i.group as { id?: string })?.id ??
        i.ruleId ??
        (i.rule as { id?: string })?.id ??
        i.occurrenceId ??
        "suite",
    ) +
    (w.method === "saveFile" ? ":" + canonical(i.location) : "")
  );
}
function target(w: WriteIntent, s: Snapshot) {
  const p = s.project;
  if (!p || p.id !== w.projectId) return null;
  if (w.method === "saveFile") {
    const o = p.occurrences.find((o) =>
      w.input.occurrenceId
        ? o.occurrenceId === w.input.occurrenceId
        : o.path === w.input.path &&
          canonical(o.location ?? fileLocation(p.config)) ===
            canonical(w.input.location),
    );
    if (
      !o ||
      canonical(o.location ?? fileLocation(p.config)) !==
        canonical(w.input.location)
    )
      return null;
    return o && typeof o.source === "string" && !o.missing
      ? { value: o.source!, hash: o.hash }
      : null;
  }
  const name =
    w.method === "saveRule"
      ? "rule"
      : w.method === "saveGroup"
        ? "group"
        : null;
  if (!name) return null;
  const submitted = w.input[name] as { id: string };
  const item = (name === "rule" ? p.rules : p.groups).find(
    (o) => o.id === submitted.id,
  );
  return item ? { value: JSON.stringify(item), hash: null } : null;
}
function withoutRevision(value: unknown) {
  const { revision: _, ...body } = value as Record<string, unknown>;
  return body;
}
export function confirmsWrite(w: WriteIntent, s: Snapshot): boolean {
  if (s.project?.id !== w.projectId) return false;
  if (w.method === "startSuite")
    return (
      (s.acknowledgedRun ?? s.run)?.requestId === w.input.requestId &&
      (s.acknowledgedRun ?? s.run)?.frozen.basis === w.input.basis
    );
  if (w.method === "cancelSuite") {
    const target = s.acknowledgedRun?.id === w.input.runId ? s.acknowledgedRun : s.run;
    return target?.id === w.input.runId && target?.status !== "running";
  }
  if (w.method === "deleteRule")
    return !s.project.rules.some((r) => r.id === w.input.ruleId);
  if (w.method === "deleteGroup")
    return !s.project.groups.some((g) => g.id === w.input.groupId);
  if (w.method === "assignTest")
    return (
      s.project.occurrences.find((o) => o.occurrenceId === w.input.occurrenceId)
        ?.groupId === w.input.groupId
    );
  if (w.method === "toggleTest")
    return (
      s.project.occurrences.find((o) => o.occurrenceId === w.input.occurrenceId)
        ?.enabled === w.input.enabled
    );
  if (w.method === "configure")
    return (
      s.project.config.hostId === w.input.hostId &&
      s.project.config.root === w.input.root &&
      canonical(s.project.config.connection) === canonical(w.input.connection)
    );
  const saved = target(w, s);
  if (!saved) return false;
  if (w.method === "saveFile") return saved.value === w.input.source;
  const key = w.method === "saveRule" ? "rule" : "group";
  const expected = w.input[key] as { revision: number };
  const actual = JSON.parse(saved.value);
  return (
    actual.revision > expected.revision &&
    canonical(withoutRevision(actual)) === canonical(withoutRevision(expected))
  );
}
// A response acknowledges submitted A, not later edits B. Only a matching target can rebase them.
export function settleDraft(
  drafts: Map<string, Draft>,
  key: string,
  pending: PendingSave,
  s: Snapshot,
  acknowledged = false,
) {
  const d = drafts.get(key);
  if (!d || (!acknowledged && !confirmsWrite(pending.intent, s))) return false;
  if (d.value === pending.submitted) {
    drafts.delete(key);
    return true;
  }
  const saved = confirmsWrite(pending.intent, s)
    ? target(pending.intent, s)
    : null;
  const expected =
    d.kind === "test"
      ? pending.submitted
      : JSON.stringify({
          ...JSON.parse(pending.submitted),
          revision: JSON.parse(pending.submitted).revision + 1,
        });
  const base = saved?.value ?? expected;
  const value =
    d.kind === "test"
      ? d.value
      : JSON.stringify({
          ...JSON.parse(d.value),
          revision: JSON.parse(base).revision,
        });
  drafts.set(key, {
    ...d,
    value,
    base,
    hash: saved?.hash ?? d.hash,
    pending: undefined,
    conflict: saved
      ? undefined
      : "Saved target changed again; newer draft retained. Read current inputs before retrying.",
  });
  return true;
}
export function reconcileDrafts(drafts: Map<string, Draft>, s: Snapshot) {
  let changed = false;
  for (const [key, d] of drafts)
    if (d.pending && confirmsWrite(d.pending.intent, s))
      changed = settleDraft(drafts, key, d.pending, s) || changed;
  return changed;
}

// A confirmed write is newer than an in-flight read of older saved inputs.
// Keep incoming run/configuration observations, but never move saved revisions backward.
export function keepNewerSavedInputs(
  current: Snapshot | null,
  incoming: Snapshot,
): Snapshot {
  if (
    current?.project &&
    incoming.project?.id === current.project.id &&
    current.project.revision > incoming.project.revision
  ) {
    return {
      ...incoming,
      project: current.project,
      basis: current.basis,
      readError: current.readError,
    };
  }
  return incoming;
}
