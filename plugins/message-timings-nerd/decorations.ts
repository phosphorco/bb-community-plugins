import { labelParts, type Stamp } from "./timing.ts";

const ROW = "[data-timeline-row-id]";
const OWNED = "data-message-timings-nerd";

function sameStamp(a: Stamp, b: Stamp) {
  return a === b || (a.rowId === b.rowId && a.kind === b.kind && a.at === b.at
    && a.previousUserAt === b.previousUserAt && a.previousFinishAt === b.previousFinishAt
    && a.nextUserAt === b.nextUserAt && a.latest === b.latest && a.status === b.status);
}

// This owns DOM resources, not a React store. Streamed text never invalidates
// the row index; only added/removed row wrappers and realization changes do.
export function createDecorations(root: HTMLElement, onRowsChanged: () => void, onError: (error: unknown) => void = () => {}) {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const rows = new Set<HTMLElement>();
  const nodes = new Map<HTMLElement, { node: HTMLElement; stamp: Stamp; calendar: string }>();
  const liveRows = new Set<HTMLElement>();
  const selectedRows = new Set<HTMLElement>();
  let stamps = new Map<string, Stamp>();
  let coveredIds = new Set<string>();
  const announced = new Set<string>();
  let historyStartId: string | null = null;
  let historyStartRow: HTMLElement | undefined;
  let timer: number | undefined;
  let disposed = false;
  let calendar = calendarKey();
  let calendarDeadline = nextMidnight(Date.now());
  function calendarKey() {
    const now = new Date(Date.now());
    return `${now.toDateString()}|${now.getTimezoneOffset()}`;
  }
  function guarded(action: () => void) {
    if (disposed) return;
    try { action(); }
    catch (error) { dispose(); onError(error); }
  }
  function nextMidnight(now: number) {
    const date = new Date(now);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  }

  function paint(row: HTMLElement) {
    const stamp = stamps.get(row.dataset.timelineRowId ?? "");
    const old = nodes.get(row);
    if (!stamp || row.dataset.timelineWindowedRealized === "false") {
      old?.node.remove(); nodes.delete(row); liveRows.delete(row); selectedRows.delete(row); return;
    }
    if (doc.hidden) return;
    if (!stamp.latest && old?.node.parentElement === row && old.calendar === calendar && sameStamp(old.stamp, stamp)) return;
    const node = old?.node ?? doc.createElement("div");
    if (!old) node.setAttribute(OWNED, "");
    const className = `message-timings-nerd__stamp message-timings-nerd__stamp--${stamp.kind}`;
    if (node.className !== className) node.className = className;
    const parts = labelParts(stamp, Date.now());
    const selection = doc.getSelection();
    if (old && selection && !selection.isCollapsed && Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index)).some(range => range.intersectsNode(node))) {
      selectedRows.add(row);
      return;
    }
    selectedRows.delete(row);
    // Preserve the existing spans and selection when a snapshot is unchanged;
    // minute ticks update only the value whose visible text changed.
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      const span = node.children[index] ?? doc.createElement("span");
      const partClass = `message-timings-nerd__${part.kind}`;
      if (span.className !== partClass) span.className = partClass;
      if (span.textContent !== part.text) {
        if (span.firstChild?.nodeType === 3) span.firstChild.nodeValue = part.text;
        else span.append(doc.createTextNode(part.text));
      }
      if (!span.parentElement) node.append(span);
    }
    while (node.children.length > parts.length) node.lastElementChild!.remove();
    if (!old || old.stamp.at !== stamp.at || old.stamp.kind !== stamp.kind || old.calendar !== calendar) {
      node.title = stamp.at == null ? "The original send timestamp is outside the available history."
        : `${stamp.kind === "user" ? "Sent" : "Agent ended"} ${new Date(stamp.at).toLocaleString()}. Durations are approximate wall-clock time.`;
    }
    if (node.parentElement !== row) row.append(node);
    nodes.set(row, { node, stamp, calendar });
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
    timer = win.setTimeout(() => guarded(() => {
      // Only the live footer changes, even on a thousand-message timeline.
      if (Date.now() >= calendarDeadline) {
        calendar = calendarKey();
        calendarDeadline = nextMidnight(Date.now());
        for (const row of nodes.keys()) paint(row);
      } else for (const row of liveRows) paint(row);
      schedule();
    }), delay + 20);
  }

  function visit(element: Element, callback: (row: HTMLElement) => void) {
    if (element.matches(ROW)) callback(element as HTMLElement);
    // Streamed text and leaf markup cannot contain timeline wrappers.
    if (element.childElementCount) element.querySelectorAll<HTMLElement>(ROW).forEach(callback);
  }
  root.querySelectorAll<HTMLElement>(ROW).forEach(row => rows.add(row));
  const observer = new win.MutationObserver(records => guarded(() => {
    let changed = false;
    let removed = false;
    let needsData = false;
    const checkCoverage = (row: HTMLElement) => {
      const id = row.dataset.timelineRowId;
      if (id && row.dataset.timelineWindowedRealized !== "false" && !coveredIds.has(id) && !announced.has(id)) {
        if (historyStartRow && root.contains(historyStartRow)
          && (historyStartRow.compareDocumentPosition(row) & 2)) return;
        announced.add(id); needsData = true;
        if (announced.size > 2048) announced.delete(announced.values().next().value!);
      }
    };
    for (const record of records) {
      const target = record.target as HTMLElement;
      if (target.closest(`[${OWNED}]`)) continue;
      if (record.type === "attributes") {
        // Removed subtrees can still deliver queued attribute records. Their
        // new pane owns them; never reattach our footer outside this root.
        if (!target.matches(ROW) || !root.contains(target)) continue;
        paint(target);
        checkCoverage(target);
        changed = true;
        continue;
      }
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1) continue;
        if ((node as Element).hasAttribute(OWNED)) {
          // A host render may replace a row's children while keeping its
          // wrapper. Restore the same owned node, retaining its span identity.
          if (nodes.get(target)?.node === node && root.contains(target)) {
            paint(target); changed = true;
          }
          continue;
        }
        visit(node as Element, row => {
          if (root.contains(row)) return;
          rows.delete(row); nodes.get(row)?.node.remove(); nodes.delete(row); liveRows.delete(row);
          selectedRows.delete(row);
          if (historyStartRow === row) historyStartRow = undefined;
          removed = true;
        });
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1 || (node as Element).hasAttribute(OWNED)) continue;
        visit(node as Element, row => {
          if (!root.contains(row)) return;
          if (row.dataset.timelineRowId === historyStartId) historyStartRow = row;
          rows.add(row); paint(row); checkCoverage(row); changed = true;
        });
      }
    }
    if (changed || removed) schedule();
    if (needsData) onRowsChanged();
  }));
  observer.observe(root, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["data-timeline-row-id", "data-timeline-windowed-realized"] });
  function resume() { guarded(() => {
    calendar = calendarKey();
    if (!doc.hidden) for (const row of rows) paint(row);
    calendarDeadline = nextMidnight(Date.now());
    schedule();
  }); }
  function selectionChanged() { guarded(() => {
    if (selectedRows.size === 0) return;
    for (const row of selectedRows) paint(row);
    if (selectedRows.size === 0) schedule();
  }); }
  doc.addEventListener("visibilitychange", resume);
  win.addEventListener("pageshow", resume);
  win.addEventListener("focus", resume);
  doc.addEventListener("selectionchange", selectionChanged);
  function dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect(); win.clearTimeout(timer);
    doc.removeEventListener("visibilitychange", resume);
    win.removeEventListener("pageshow", resume);
    win.removeEventListener("focus", resume);
    doc.removeEventListener("selectionchange", selectionChanged);
    for (const { node } of nodes.values()) node.remove();
    nodes.clear(); rows.clear(); liveRows.clear(); selectedRows.clear(); stamps.clear(); coveredIds.clear(); announced.clear();
  }
  return {
    update(next: Stamp[], covered: string[] = next.map(stamp => stamp.rowId), startId: string | null = null) { guarded(() => {
      stamps = new Map(next.map(stamp => [stamp.rowId, stamp]));
      coveredIds = new Set(covered);
      historyStartId = startId;
      historyStartRow = startId ? [...rows].find(row => row.dataset.timelineRowId === startId) : undefined;
      for (const id of coveredIds) announced.delete(id);
      if (doc.hidden) return;
      calendar = calendarKey();
      for (const row of rows) {
        const value = stamps.get(row.dataset.timelineRowId ?? "");
        const old = nodes.get(row);
        if (!value && !old) continue;
        if (value && !value.latest && old?.node.parentElement === row && old.calendar === calendar && sameStamp(old.stamp, value)) {
          old.stamp = value;
          continue;
        }
        paint(row);
      }
      schedule();
    }); },
    dispose,
  };
}
