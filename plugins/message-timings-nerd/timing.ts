// Project by source sequence, not by wall-clock order: clocks can jump and
// steering messages can arrive inside an existing turn.
export interface TimingRow {
  id: string;
  threadId: string;
  kind: string;
  role?: string;
  initiator?: string;
  turnId: string | null;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: number;
  children?: TimingRow[] | null;
  turnRequest?: { kind: "message" | "steer"; status: "accepted" | "pending" | "rejected" } | null;
  sentAt?: number | null;
  sentSeq?: number;
}

export interface Completion {
  turnId: string;
  seq: number;
  at: number;
  status: string;
}

export interface Stamp {
  rowId: string;
  kind: "user" | "finish";
  at: number | null;
  previousUserAt: number | null;
  previousFinishAt: number | null;
  nextUserAt: number | null;
  latest: boolean;
  status: string | null;
}

export function projectTiming(threadId: string, rows: TimingRow[], completions: Completion[]): Stamp[] {
  const users = new Map<string, TimingRow>();
  const finished = new Map<string, Completion>();
  for (const completion of completions) {
    if (!finished.has(completion.turnId) || finished.get(completion.turnId)!.seq < completion.seq) finished.set(completion.turnId, completion);
  }
  const anchors = new Map<string, TimingRow>();
  function visit(row: TimingRow, topLevel: boolean) {
    if (row.threadId !== threadId) return;
    if (row.kind === "conversation" && row.role === "user" && row.initiator === "user") users.set(row.id, row);
    const end = row.turnId ? finished.get(row.turnId) : null;
    if (topLevel && row.turnId && end && row.sourceSeqEnd <= end.seq && !(row.kind === "conversation" && row.role === "user")) {
      const prior = anchors.get(row.turnId);
      if (!prior || row.sourceSeqEnd > prior.sourceSeqEnd) anchors.set(row.turnId, row);
    }
    if (row.kind === "turn") row.children?.forEach(child => visit(child, false));
  }
  rows.forEach(row => visit(row, true));
  const time = (row: TimingRow) => row.sentAt !== undefined ? row.sentAt
    : row.turnRequest?.kind === "steer" && row.turnRequest.status === "accepted" ? null : row.createdAt;

  // Acceptance order determines which input influenced a turn. Send order
  // separately determines the human-message gaps and historical waits.
  const originEvents = [
    ...[...users.values()].filter(row => !row.turnRequest || row.turnRequest.status === "accepted")
      .map(row => ({ seq: row.sourceSeqStart, row, completion: null as Completion | null })),
    ...[...finished.values()].map(completion => ({ seq: completion.seq, row: null as TimingRow | null, completion })),
  ].sort((a, b) => a.seq - b.seq);
  const origins = new Map<string, TimingRow>();
  let unassigned: TimingRow | null = null;
  const completionOrigins = new Map<string, number | null>();
  for (const event of originEvents) {
    if (event.row) {
      if (event.row.turnId) origins.set(event.row.turnId, event.row);
      else unassigned = event.row;
    } else if (event.completion) {
      const origin: TimingRow | null = origins.get(event.completion.turnId) ?? unassigned;
      completionOrigins.set(event.completion.turnId, origin ? time(origin) : null);
      if (origin === unassigned) unassigned = null;
    }
  }
  const points: { seq: number; at: number | null; kind: "user" | "finish"; stamp: Stamp | null }[] = [];
  for (const user of users.values()) points.push({ seq: user.sentSeq ?? user.sourceSeqStart, at: time(user), kind: "user", stamp: {
    rowId: user.id, kind: "user", at: time(user), previousUserAt: null, previousFinishAt: null,
    nextUserAt: null, latest: false, status: user.turnRequest?.status ?? null,
  } });
  // Unrendered completions remain boundaries even though they have no footer.
  for (const completion of finished.values()) {
    const anchor = anchors.get(completion.turnId);
    points.push({ seq: completion.seq, at: completion.at, kind: "finish", stamp: anchor ? {
      rowId: anchor.id, kind: "finish", at: completion.at,
      previousUserAt: completionOrigins.get(completion.turnId) ?? null,
      previousFinishAt: null, nextUserAt: null, latest: false, status: completion.status,
    } : null });
  }
  points.sort((a, b) => a.seq - b.seq);
  let previousUserAt: number | null = null;
  let previousFinishAt: number | null = null;
  for (const point of points) {
    if (point.kind === "user") {
      if (point.stamp) { point.stamp.previousUserAt = previousUserAt; point.stamp.previousFinishAt = previousFinishAt; }
      previousUserAt = point.at; previousFinishAt = null;
    } else previousFinishAt = point.at;
  }
  let nextUserAt: number | null = null;
  let latestAssigned = false;
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i]!;
    if (point.stamp) {
      point.stamp.nextUserAt = nextUserAt;
      point.stamp.latest = !latestAssigned;
      latestAssigned = true;
    }
    if (point.kind === "user") nextUserAt = point.at;
  }
  return points.flatMap(point => point.stamp ? [point.stamp] : []);
}

export function duration(from: number, to: number): string | null {
  const ms = to - from;
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 60_000) return "<1m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function sentAt(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return time;
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) })}, ${time}`;
}

export function label(stamp: Stamp, now: number): string {
  const state = stamp.status === "interrupted" ? "Stopped" : stamp.status === "failed" ? "Failed" : "Finished";
  const parts = [stamp.at == null ? "Send time unavailable" : stamp.kind === "user" ? sentAt(stamp.at, now) : `${state} ${sentAt(stamp.at, now)}`];
  if (stamp.kind === "user" && (stamp.status === "rejected" || stamp.status === "pending")) parts.push(stamp.status);
  const add = (from: number | null, to: number | null, suffix: string) => {
    if (from == null || to == null) return;
    const value = duration(from, to);
    if (value != null) parts.push(`${value} ${suffix}`);
  };
  add(stamp.previousUserAt, stamp.at, stamp.kind === "user" ? "since previous message" : "from your message");
  if (stamp.kind === "user") add(stamp.previousFinishAt, stamp.at, "after agent finished");
  if (stamp.kind === "finish" && stamp.nextUserAt != null) add(stamp.at, stamp.nextUserAt, "until next message");
  if (stamp.latest) {
    add(stamp.at, now, stamp.kind === "user" ? "since sent" : "since finish");
    if (stamp.kind === "finish") add(stamp.previousUserAt, now, "since your message");
  }
  return parts.join(" · ");
}
