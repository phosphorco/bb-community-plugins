const snapshots = new Map<string, string>();
const listeners = new Set<() => void>();

function scopeKey(scope: object): string {
  return JSON.stringify(scope);
}

export function getAttachedAnnotationSnapshot(scope: object): string {
  return snapshots.get(scopeKey(scope)) ?? "[]";
}

function writeAttachedAnnotationIds(scope: object, ids: Iterable<string>): void {
  const key = scopeKey(scope);
  const previous = getAttachedAnnotationSnapshot(scope);
  const next = JSON.stringify([...new Set(ids)].sort());
  if (next === "[]") snapshots.delete(key);
  else snapshots.set(key, next);
  if (next !== previous) for (const listener of listeners) listener();
}

/** Called by the host's debounced, authoritative draft observation. */
export function observeAttachedAnnotationIds(
  scope: object,
  ids: Iterable<string>,
): void {
  writeAttachedAnnotationIds(scope, ids);
}

/** Protect the period between mention insertion and the host's draft callback. */
export function markAttachedAnnotationIds(
  scope: object,
  ids: Iterable<string>,
): void {
  const current = JSON.parse(getAttachedAnnotationSnapshot(scope)) as string[];
  writeAttachedAnnotationIds(scope, [...current, ...ids]);
}

export function subscribeToDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
