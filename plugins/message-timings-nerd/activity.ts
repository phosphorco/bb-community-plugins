import { duration, type TurnSpan } from "./timing.ts";

const ANCHOR = "[data-follow-up-composer-anchor]";
const PRIMARY_ANCHOR = `[data-app-composer-role="primary"] ${ANCHOR}`;
const OWNED = "data-message-timings-nerd";
// Idle stretches longer than this count as exactly this much idle in the
// percentage, and are drawn log-compressed so longer gaps still look longer
// (2h ≈ 1.7h wide, 12h ≈ 3.5h, 3 days ≈ 5.3h) without drowning recent turns.
export const IDLE_CAP = 60 * 60_000;

export function gapDisplayWidth(idleMs: number): number {
  return idleMs <= IDLE_CAP ? idleMs : IDLE_CAP * (1 + Math.log(idleMs / IDLE_CAP));
}

export interface Segment {
  // "gap" is an idle stretch longer than IDLE_CAP, drawn compressed.
  kind: "active" | "idle" | "gap";
  from: number;
  to: number;
  running: boolean;
  // Display position in [0, 1].
  left: number;
  width: number;
}

export interface Activity {
  start: number;
  end: number;
  segments: Segment[];
  activeMs: number;
  // Idle time removed from the drawing and from the percentage.
  hiddenIdleMs: number;
  running: boolean;
}

export function activitySpans(turns: TurnSpan[], now: number): Activity | null {
  if (!turns.length) return null;
  const spans: { from: number; to: number; running: boolean }[] = [];
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
  const segments: Segment[] = [];
  let cursor = 0;
  let hiddenIdleMs = 0;
  const idle = (from: number, to: number) => {
    if (to <= from) return;
    const gap = to - from > IDLE_CAP;
    const shown = gapDisplayWidth(to - from);
    if (gap) hiddenIdleMs += to - from - IDLE_CAP;
    segments.push({ kind: gap ? "gap" : "idle", from, to, running: false, left: cursor, width: shown });
    cursor += shown;
  };
  let previous = start;
  for (const span of spans) {
    idle(previous, span.from);
    segments.push({ kind: "active", from: span.from, to: span.to, running: span.running, left: cursor, width: span.to - span.from });
    cursor += span.to - span.from;
    previous = span.to;
  }
  idle(previous, end);
  const total = Math.max(1, cursor);
  for (const segment of segments) { segment.left /= total; segment.width /= total; }
  const activeMs = spans.reduce((sum, span) => sum + span.to - span.from, 0);
  return { start, end, segments, activeMs, hiddenIdleMs, running: spans.some(span => span.running) };
}

// Share of time spent active, with each idle gap over an hour counted as one
// hour flat, so an overnight pause doesn't drown out the session.
export function activityPercent(activity: Activity): string {
  const ratio = activity.activeMs / Math.max(1, activity.end - activity.start - activity.hiddenIdleMs);
  return ratio > 0 && ratio < 0.01 ? "<1%" : `${Math.round(ratio * 100)}%`;
}

function clock(at: number, reference: number) {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === new Date(reference).toDateString() ? time
    : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

export function segmentLabel(segment: Segment, now: number): { title: string; detail: string } {
  const length = duration(segment.from, segment.to) ?? "<1m";
  const range = `${clock(segment.from, now)} – ${segment.running ? "now" : clock(segment.to, segment.from)}`;
  if (segment.kind === "active") return { title: segment.running ? `Running · ${length}` : `Active · ${length}`, detail: range };
  if (segment.kind === "gap") return { title: `Idle · ${length}`, detail: `${range} · counted as 1h` };
  return { title: `Idle · ${length}`, detail: range };
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
  // Floats above the strip; absolutely positioned so hovering never shifts layout.
  const tip = doc.createElement("div");
  tip.className = "message-timings-nerd__activity-tip";
  tip.setAttribute("aria-hidden", "true");
  tip.hidden = true;
  const tipTitle = tip.appendChild(doc.createElement("div"));
  tipTitle.className = "message-timings-nerd__activity-tip-title";
  const tipDetail = tip.appendChild(doc.createElement("div"));
  tipDetail.className = "message-timings-nerd__activity-tip-detail";
  const tipSummary = tip.appendChild(doc.createElement("div"));
  tipSummary.className = "message-timings-nerd__activity-tip-summary";
  node.append(track, caption, tip);
  let turns: TurnSpan[] = [];
  let partial = false;
  let wanted = false;
  let current: Activity | null = null;
  let pointer: number | null = null;
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
  function summary(activity: Activity) {
    const hidden = activity.hiddenIdleMs > 0 ? ` · ${duration(0, activity.hiddenIdleMs) ?? "<1m"} idle beyond 1h not counted` : "";
    return `${activityPercent(activity)} active${hidden}${partial ? " · loaded history only" : ""}`;
  }
  // Narrow active spans are drawn at 2px; let the pointer snap to them.
  function segmentAt(fraction: number): number {
    const segments = current?.segments ?? [];
    const slack = 4 / Math.max(1, track.clientWidth);
    let best = -1;
    let distance = Infinity;
    segments.forEach((segment, index) => {
      if (segment.kind !== "active") return;
      const gap = Math.max(0, segment.left - fraction, fraction - (segment.left + segment.width));
      if (gap <= slack && gap < distance) { best = index; distance = gap; }
    });
    if (best >= 0) return best;
    return segments.findIndex(segment => fraction >= segment.left && fraction <= segment.left + segment.width);
  }
  function showTip() {
    const hovered = track.querySelector("[data-hover]");
    if (pointer == null || !current) { tip.hidden = true; hovered?.removeAttribute("data-hover"); return; }
    const index = segmentAt(pointer);
    const segment = current.segments[index];
    if (!segment) { tip.hidden = true; return; }
    const bar = track.children[index];
    if (hovered !== bar) { hovered?.removeAttribute("data-hover"); bar?.setAttribute("data-hover", ""); }
    const label = segmentLabel(segment, Date.now());
    if (tipTitle.textContent !== label.title) tipTitle.textContent = label.title;
    if (tipDetail.textContent !== label.detail) tipDetail.textContent = label.detail;
    const text = summary(current);
    if (tipSummary.textContent !== text) tipSummary.textContent = text;
    // Anchor at the segment's centre; the matching translate keeps the tip
    // inside the strip at both edges.
    const centre = Math.min(1, Math.max(0, segment.left + segment.width / 2)) * 100;
    tip.style.left = `${centre}%`;
    tip.style.transform = `translateX(-${centre}%)`;
    tip.hidden = false;
  }
  function paint() {
    win.clearTimeout(timer);
    if (disposed || doc.hidden) return;
    const activity = current = activitySpans(turns, Date.now());
    wanted = !!activity;
    place();
    if (!activity) return;
    while (track.childElementCount > activity.segments.length) track.lastElementChild!.remove();
    activity.segments.forEach((segment, index) => {
      const bar = (track.children[index] as HTMLElement | undefined) ?? track.appendChild(doc.createElement("div"));
      const className = `message-timings-nerd__activity-segment message-timings-nerd__activity-segment--${segment.kind}`;
      if (bar.className !== className) bar.className = className;
      bar.toggleAttribute("data-running", segment.running);
      bar.style.left = `${segment.left * 100}%`;
      bar.style.width = `${segment.width * 100}%`;
    });
    const percent = activityPercent(activity);
    const text = `${percent} active${activity.running ? " · running" : ""}`;
    if (caption.textContent !== text) caption.textContent = text;
    const since = new Date(activity.start).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const label = `${activity.running ? "Agent running. " : ""}Active ${duration(0, activity.activeMs) ?? "<1m"} since ${since}; ${summary(activity)}.`;
    if (node.getAttribute("aria-label") !== label) node.setAttribute("aria-label", label);
    showTip();
    timer = win.setTimeout(() => guarded(paint), activity.running ? 60_000 : 600_000);
  }
  function hover(event: PointerEvent) { guarded(() => {
    const box = track.getBoundingClientRect();
    pointer = box.width > 0 ? Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) : null;
    showTip();
  }); }
  function leave() { guarded(() => { pointer = null; showTip(); }); }
  node.addEventListener("pointermove", hover);
  node.addEventListener("pointerleave", leave);
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
    node.removeEventListener("pointermove", hover);
    node.removeEventListener("pointerleave", leave);
    node.remove();
  }
  return {
    update(next: TurnSpan[], historyPartial = false) { guarded(() => { turns = next; partial = historyPartial; paint(); }); },
    dispose,
  };
}
