import type {
  Capture,
  Criterion,
  History,
  HistoryEvent,
} from "../contracts/model.ts";
export type CapturePorts = {
  title(id: string): Promise<string>;
  history(
    id: string,
    limit: number,
  ): Promise<{ events: HistoryEvent[]; complete: boolean; through: number }>;
};
export async function captureProduction(
  message: string,
  senderId: string | null,
  destinationId: string,
  rules: { criteria: Criterion[] }[],
  ports: CapturePorts,
): Promise<Capture> {
  const needs = rules.flatMap((x) => x.criteria);
  const s = Math.max(0, ...needs.map((x) => x.context.senderHistory)),
    d = Math.max(0, ...needs.map((x) => x.context.destinationHistory));
  const title = async (id: string | null) =>
    id ? ports.title(id).catch(() => null) : null;
  const history = async (
    id: string | null,
    limit: number,
  ): Promise<History> => {
    if (!limit)
      return { events: [], coverage: "empty-confirmed", through: null };
    if (!id) return { events: [], coverage: "unavailable", through: null };
    try {
      const r = await ports.history(id, limit);
      return {
        events: r.events,
        through: r.through,
        coverage: r.complete
          ? r.events.length
            ? "complete"
            : "empty-confirmed"
          : "truncated",
      };
    } catch {
      return { events: [], through: null, coverage: "unavailable" };
    }
  };
  const [senderTitle, destinationTitle, sender, destination] =
    await Promise.all([
      title(senderId),
      title(destinationId),
      history(senderId, s),
      history(destinationId, d),
    ]);
  return {
    projectTitle: null,
    message,
    senderTitle,
    destinationTitle,
    sender,
    destination,
    provenance: { senderId, destinationId },
  };
}
export function selection(c: Capture, q: Criterion) {
  const select = (h: History, n: number, prefix: string) => ({
    coverage: n === 0 ? "not-requested" : h.coverage,
    through: h.through,
    refs: n === 0 ? [] : h.events.slice(-n).map((e) => prefix + ":" + e.id),
  });
  return {
    message: q.context.message ? ["message"] : [],
    sender: select(c.sender, q.context.senderHistory, "sender"),
    destination: select(
      c.destination,
      q.context.destinationHistory,
      "destination",
    ),
  };
}
