import type { TimingRow } from "./timing.ts";

export interface RequestEvent {
  seq: number;
  createdAt: number;
  type: string;
  data: { requestId?: string; clientRequestId?: string };
}

export function attachRequestTimes(rows: TimingRow[], events: RequestEvent[]): void {
  const requests = new Map(events.filter(event => event.type === "client/turn/requested").map(event => [event.data.requestId, event]));
  const accepted = new Map(events.filter(event => event.type === "turn/input/accepted").map(event => [event.seq, event.data.clientRequestId]));
  function visit(row: TimingRow) {
    if (row.role === "user" && row.turnRequest?.kind === "steer" && row.turnRequest.status === "accepted") {
      const requestId = accepted.get(row.sourceSeqStart);
      const request = requestId ? requests.get(requestId) : undefined;
      row.sentAt = request?.createdAt ?? null;
      if (request) row.sentSeq = request.seq;
    }
    if (row.kind === "turn") row.children?.forEach(visit);
  }
  rows.forEach(visit);
}
