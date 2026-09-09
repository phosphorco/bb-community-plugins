import { labelParts, type Stamp } from "./timing.ts";

const ROW = "[data-timeline-row-id]";
const OWNED = "data-message-timings-nerd";

// This owns DOM resources, not a React store. Streamed text never invalidates
// the row index; only added/removed row wrappers and realization changes do.
export function createDecorations(root: HTMLElement, onRowsChanged: () => void) {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const rows = new Set<HTMLElement>();
  const nodes = new Map<HTMLElement, { node: HTMLElement; stamp: Stamp }>();
  const liveRows = new Set<HTMLElement>();
  let stamps = new Map<string, Stamp>();
  let coveredIds = new Set<string>();
  const announced = new Set<string>();
  let timer: number | undefined;
  let disposed = false;
  let calendarDeadline = nextMidnight(Date.now());
  function nextMidnight(now: number) {
    const date = new Date(now);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  }

  function paint(row: HTMLElement) {
    const stamp = stamps.get(row.dataset.timelineRowId ?? "");
    const old = nodes.get(row);
    if (!stamp || row.dataset.timelineWindowedRealized === "false") {
      old?.node.remove(); nodes.delete(row); liveRows.delete(row); return;
    }
    const node = old?.node ?? doc.createElement("div");
    if (!old) node.setAttribute(OWNED, "");
    const className = `message-timings-nerd__stamp message-timings-nerd__stamp--${stamp.kind}`;
    if (node.className !== className) node.className = className;
    const parts = labelParts(stamp, Date.now());
    // Preserve the existing spans and selection when a snapshot is unchanged;
    // minute ticks update only the value whose visible text changed.
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      const span = node.children[index] ?? doc.createElement("span");
      const partClass = `message-timings-nerd__${part.kind}`;
      if (span.className !== partClass) span.className = partClass;
      if (span.textContent !== part.text) span.textContent = part.text;
      if (!span.parentElement) node.append(span);
    }
    while (node.children.length > parts.length) node.lastElementChild!.remove();
    if (!old || old.stamp.at !== stamp.at || old.stamp.kind !== stamp.kind) {
      node.title = stamp.at == null ? "The original send timestamp is outside the available history."
        : `${stamp.kind === "user" ? "Sent" : "Agent ended"} ${new Date(stamp.at).toLocaleString()}. Durations are approximate wall-clock time.`;
    }
    if (node.parentElement !== row) row.append(node);
    nodes.set(row, { node, stamp });
    if (stamp.latest) liveRows.add(row); else liveRows.delete(row);
  }

  function schedule() {
    win.clearTimeout(timer);
    if (disposed || doc.hidden || nodes.size === 0) return;
    const now = Date.now();
    let delay = Math.max(0, calendarDeadline - now);
    for (const row of liveRows) {
      const stamp = nodes.get(row)!.stamp;
      for (const origin of [stamp.at, stamp.kind === "finish" ? stamp.previousUserAt : null]) {
        if (origin != null) {
          const elapsed = Math.max(0, now - origin);
          const bucket = elapsed >= 86_400_000 ? 3_600_000 : 60_000;
          delay = Math.min(delay, bucket - (elapsed % bucket));
        }
      }
    }
    timer = win.setTimeout(() => {
      // Only the live footer changes, even on a thousand-message timeline.
      if (Date.now() >= calendarDeadline) {
        calendarDeadline = nextMidnight(Date.now());
        for (const row of nodes.keys()) paint(row);
      } else for (const row of liveRows) paint(row);
      schedule();
    }, delay + 20);
  }

  function visit(element: Element, callback: (row: HTMLElement) => void) {
    if (element.matches(ROW)) callback(element as HTMLElement);
    element.querySelectorAll<HTMLElement>(ROW).forEach(callback);
  }
  root.querySelectorAll<HTMLElement>(ROW).forEach(row => rows.add(row));
  const observer = new win.MutationObserver(records => {
    let changed = false;
    let removed = false;
    let needsData = false;
    const checkCoverage = (row: HTMLElement) => {
      const id = row.dataset.timelineRowId;
      if (id && row.dataset.timelineWindowedRealized !== "false" && !coveredIds.has(id) && !announced.has(id)) {
        announced.add(id); needsData = true;
      }
    };
    for (const record of records) {
      if (record.type === "attributes") {
        paint(record.target as HTMLElement);
        checkCoverage(record.target as HTMLElement);
        changed = true;
        continue;
      }
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1 || (node as Element).hasAttribute(OWNED)) continue;
        visit(node as Element, row => {
          if (root.contains(row)) return;
          rows.delete(row); nodes.get(row)?.node.remove(); nodes.delete(row); liveRows.delete(row);
          removed = true;
        });
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1 || (node as Element).hasAttribute(OWNED)) continue;
        visit(node as Element, row => { rows.add(row); paint(row); checkCoverage(row); changed = true; });
      }
    }
    if (changed || removed) schedule();
    if (needsData) onRowsChanged();
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["data-timeline-row-id", "data-timeline-windowed-realized"] });
  function resume() {
    if (!doc.hidden) for (const row of rows) paint(row);
    calendarDeadline = nextMidnight(Date.now());
    schedule();
  }
  doc.addEventListener("visibilitychange", resume);
  win.addEventListener("pageshow", resume);
  win.addEventListener("focus", resume);
  return {
    update(next: Stamp[], covered: string[] = next.map(stamp => stamp.rowId)) {
      if (disposed) return;
      stamps = new Map(next.map(stamp => [stamp.rowId, stamp]));
      coveredIds = new Set(covered);
      for (const row of rows) paint(row);
      schedule();
    },
    dispose() {
      disposed = true;
      observer.disconnect(); win.clearTimeout(timer);
      doc.removeEventListener("visibilitychange", resume);
      win.removeEventListener("pageshow", resume);
      win.removeEventListener("focus", resume);
      for (const { node } of nodes.values()) node.remove();
      nodes.clear(); rows.clear(); liveRows.clear(); stamps.clear(); coveredIds.clear(); announced.clear();
    },
  };
}
