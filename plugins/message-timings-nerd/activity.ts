import { duration, type TurnSpan } from "./timing.ts";

const ANCHOR = "[data-follow-up-composer-anchor]";
const PRIMARY_ANCHOR = `[data-app-composer-role="primary"] ${ANCHOR}`;
const OWNED = "data-message-timings-nerd";
// Idle stretches longer than this are drawn at this width, so a thread's
// recent turns stay legible after an overnight gap. Percentages use real time.
export const IDLE_DISPLAY_CAP = 20 * 60_000;

export interface Activity {
  start: number;
  end: number;
  spans: { from: number; to: number; running: boolean }[];
  activeMs: number;
  running: boolean;
  // Display positions, in [0, 1], after compressing long idle gaps.
  layout: { left: number; width: number }[];
  breaks: number[];
}

export function activitySpans(turns: TurnSpan[], now: number): Activity | null {
  if (!turns.length) return null;
  const spans: Activity["spans"] = [];
  for (const turn of [...turns].sort((a, b) => a.from - b.from)) {
    const running = turn.to == null;
    const to = Math.max(turn.from, running ? now : turn.to!);
    const prior = spans[spans.length - 1];
    if (prior && turn.from <= prior.to) { prior.to = Math.max(prior.to, to); prior.running ||= running; }
    else spans.push({ from: turn.from, to, running });
  }
  const start = spans[0]!.from;
  // Server clocks can run ahead of the browser; never draw past the end.
  const end = Math.max(now, spans[spans.length - 1]!.to);
  const activeMs = spans.reduce((sum, span) => sum + span.to - span.from, 0);
  const shown = (gap: number) => Math.min(gap, IDLE_DISPLAY_CAP);
  const breaks: number[] = [];
  const offsets: { left: number; width: number }[] = [];
  let cursor = 0;
  let previous = start;
  for (const span of spans) {
    const gap = span.from - previous;
    if (gap > IDLE_DISPLAY_CAP) breaks.push(cursor + IDLE_DISPLAY_CAP / 2);
    cursor += shown(gap);
    offsets.push({ left: cursor, width: span.to - span.from });
    cursor += span.to - span.from;
    previous = span.to;
  }
  if (end - previous > IDLE_DISPLAY_CAP) breaks.push(cursor + IDLE_DISPLAY_CAP / 2);
  cursor += shown(end - previous);
  const total = Math.max(1, cursor);
  return {
    start, end, spans, activeMs, running: spans.some(span => span.running),
    layout: offsets.map(({ left, width }) => ({ left: left / total, width: width / total })),
    breaks: breaks.map(at => at / total),
  };
}

export function activityPercent(activity: Activity): string {
  const ratio = activity.activeMs / Math.max(1, activity.end - activity.start);
  return ratio > 0 && ratio < 0.01 ? "<1%" : `${Math.round(ratio * 100)}%`;
}

// One small strip above the primary composer. It owns a single DOM node and
// only looks for the composer in newly added subtrees while detached.
export function createActivityStrip(root: HTMLElement) {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const node = doc.createElement("div");
  node.setAttribute(OWNED, "");
  node.className = "message-timings-nerd__activity";
  node.setAttribute("role", "img");
  const track = doc.createElement("div");
  track.className = "message-timings-nerd__activity-track";
  const caption = doc.createElement("span");
  caption.className = "message-timings-nerd__activity-caption";
  caption.setAttribute("aria-hidden", "true");
  node.append(track, caption);
  let turns: TurnSpan[] = [];
  let partial = false;
  let wanted = false;
  let timer: number | undefined;
  let disposed = false;

  function guarded(action: () => void) {
    if (disposed) return;
    try { action(); }
    catch (error) { dispose(); console.warn("Message timings could not draw the activity strip.", error); }
  }
  function findAnchor() {
    return root.querySelector(PRIMARY_ANCHOR) ?? root.querySelector(ANCHOR);
  }
  // A pending approval or question hides the composer; don't sit between them.
  const blocked = (anchor: Element) => !!anchor.querySelector(":scope > [data-follow-up-composer][hidden]");
  function place(anchor: Element | null = findAnchor()) {
    if (!wanted || doc.hidden || !anchor || blocked(anchor)) { node.remove(); return; }
    if (node.nextElementSibling !== anchor) anchor.before(node);
  }
  function paint() {
    win.clearTimeout(timer);
    if (disposed || doc.hidden) return;
    const activity = activitySpans(turns, Date.now());
    wanted = !!activity;
    place();
    if (!activity) return;
    while (track.childElementCount) track.lastElementChild!.remove();
    for (const at of activity.breaks) {
      const mark = track.appendChild(doc.createElement("div"));
      mark.className = "message-timings-nerd__activity-break";
      mark.style.left = `${at * 100}%`;
    }
    activity.spans.forEach((span, index) => {
      const bar = track.appendChild(doc.createElement("div"));
      bar.className = "message-timings-nerd__activity-span";
      bar.toggleAttribute("data-running", span.running);
      bar.style.left = `${activity.layout[index]!.left * 100}%`;
      bar.style.width = `${activity.layout[index]!.width * 100}%`;
    });
    const percent = activityPercent(activity);
    const text = `${percent} active${activity.running ? " · running" : ""}`;
    if (caption.textContent !== text) caption.textContent = text;
    const since = new Date(activity.start).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const summary = `${activity.running ? "Agent running. " : ""}Active ${duration(0, activity.activeMs) ?? "<1m"} of ${duration(activity.start, activity.end) ?? "<1m"} (${percent}) since ${since}${partial ? ", within loaded history" : ""}. Long idle gaps are shortened.`;
    if (node.title !== summary) { node.title = summary; node.setAttribute("aria-label", summary); }
    timer = win.setTimeout(() => guarded(paint), activity.running ? 60_000 : 600_000);
  }
  const observer = new win.MutationObserver(records => guarded(() => {
    if (!wanted || doc.hidden) return;
    if (node.isConnected) {
      const anchor = node.nextElementSibling;
      if (anchor?.matches(ANCHOR) && !blocked(anchor)) return;
      place();
      return;
    }
    // Detached: streamed text cannot contain a composer, so inspect only
    // added element subtrees or a composer whose "hidden" state changed.
    for (const record of records) {
      if (record.type === "attributes") {
        if ((record.target as Element).matches("[data-follow-up-composer]")) { place(); return; }
        continue;
      }
      for (const added of record.addedNodes) {
        if (added.nodeType !== 1) continue;
        const element = added as Element;
        if (element.matches(ANCHOR) || (element.childElementCount && element.querySelector(ANCHOR))) { place(); return; }
      }
    }
  }));
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
  const resume = () => guarded(paint);
  doc.addEventListener("visibilitychange", resume);
  win.addEventListener("pageshow", resume);
  win.addEventListener("focus", resume);
  function dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect(); win.clearTimeout(timer);
    doc.removeEventListener("visibilitychange", resume);
    win.removeEventListener("pageshow", resume);
    win.removeEventListener("focus", resume);
    node.remove();
  }
  return {
    update(next: TurnSpan[], historyPartial = false) { guarded(() => { turns = next; partial = historyPartial; paint(); }); },
    dispose,
  };
}
