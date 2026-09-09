import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./rpc-contract.ts";
import { projectTiming, type TimingRow } from "./timing.ts";
import { createCache } from "./cache.ts";
import { attachRequestTimes } from "./request-times.ts";
import type { Stamp } from "./timing.ts";

export default function plugin(bb: BbPluginApi) {
  const cache = createCache(load);
  // Retain timing metadata, never expanded message/tool content. A cheap head
  // probe avoids rereading the same historical pages after TTL or invalidation.
  const history = new Map<string, { maxSeq: number; result: { stamps: Stamp[]; coveredIds: string[]; truncated: boolean; historyStartId: string | null } }>();
  for (const event of ["thread.active", "thread.idle", "thread.failed", "thread.deleted"] as const) {
    bb.events.on(event, ({ thread }) => {
      cache.invalidate(thread.id);
      bb.realtime.publish("timings-changed", { threadId: thread.id });
    });
  }
  bb.rpc.register(rpcContract, {
    timings({ threadId }) { return cache.get(threadId); },
  });
  async function load(threadId: string) {
    const rows: TimingRow[] = [];
    let cursor: { anchorSeq: number; anchorId: string } | null = null;
    let truncated = false;
    let maxSeq = 0;
    // Bound full-history work; missing predecessors stay unknown.
    for (let page = 0; page < 12; page++) {
      const result = await bb.sdk.threads.timeline({ threadId, includeNestedRows: "true",
        ...(cursor ? { beforeAnchorSeq: String(cursor.anchorSeq), beforeAnchorId: cursor.anchorId } : {}),
      });
      if (page === 0 && history.get(threadId)?.maxSeq === result.maxSeq) return history.get(threadId)!.result;
      rows.push(...result.rows);
      if (page === 0) maxSeq = result.maxSeq;
      truncated = result.timelinePage.hasOlderRows;
      cursor = result.timelinePage.olderCursor;
      if (!truncated || !cursor) break;
    }
    const firstSeq = rows.reduce((seq, row) => Math.min(seq, row.sourceSeqStart), maxSeq);
    const events = await bb.sdk.threads.events.list({ threadId, types: ["turn/completed"], order: "desc", limit: "1000",
        afterSeq: String(Math.max(0, firstSeq - 1)), beforeSeq: String(maxSeq + 1) });
    const requests = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested", "turn/input/accepted"],
      order: "desc", limit: "1000", beforeSeq: String(maxSeq + 1) });
    attachRequestTimes(rows, requests.filter(event => event.type === "client/turn/requested" || event.type === "turn/input/accepted"));
    const completions = events.flatMap(event => event.type === "turn/completed" && event.scope.kind === "turn"
      ? [{ turnId: event.scope.turnId, seq: event.seq, at: event.createdAt, status: event.data.status }] : []);
    const coveredIds: string[] = [];
    const collect = (row: TimingRow) => { coveredIds.push(row.id); if (row.kind === "turn") row.children?.forEach(collect); };
    rows.forEach(collect);
    const oldest = rows.reduce<TimingRow | null>((prior, row) => !prior || row.sourceSeqStart < prior.sourceSeqStart ? row : prior, null);
    const result = { stamps: projectTiming(threadId, rows, completions), coveredIds,
      historyStartId: truncated ? oldest?.id ?? null : null,
      truncated: truncated || events.length >= 1000 || requests.length >= 1000 };
    history.delete(threadId);
    history.set(threadId, { maxSeq, result });
    if (history.size > 32) history.delete(history.keys().next().value!);
    return result;
  }
}
