import type { Evaluation } from "../contracts/model.ts";
export type Original = {
  id: string;
  revision: string;
  senderId: string | null;
  evaluation: Evaluation | null;
  verifiedReceipt: boolean;
};
export function groupAdmission(
  rows: Original[],
  exactEligibleBatch: boolean,
  separationProved = false,
) {
  if (!rows.length)
    return {
      action: "wait" as const,
      reason: "Waiting for durable original message identities.",
    };
  const ordinary = rows.filter((x) => !x.verifiedReceipt),
    unknown = ordinary.some(
      (x) => !x.evaluation || x.evaluation.policy === "unknown",
    ),
    reject = ordinary.filter((x) => x.evaluation?.policy === "reject");
  if (!ordinary.length) return { action: "proceed" as const };
  if (unknown)
    return {
      action: "wait" as const,
      reason: "Message Rules: mandatory checks or context are unresolved.",
    };
  if (reject.length && reject.length !== rows.length)
    return {
      action: "wait" as const,
      reason:
        "Message Rules: mixed originals require safe separation; no allowed neighbor is rejected.",
    };
  if (reject.length === rows.length)
    return {
      action: "reject" as const,
      message: reject
        .flatMap((x) => x.evaluation!.advice.map((a) => a.text))
        .filter((x, i, a) => a.indexOf(x) === i)
        .join("\n\n"),
    };
  if (!exactEligibleBatch || !separationProved)
    return {
      action: "wait" as const,
      reason:
        "All-eligible-sender delivery is unproved on this BB target. Originals are preserved.",
    };
  return { action: "proceed" as const };
}
export function plannedBatch(
  rows: {
    id: string;
    senderId: string | null;
    eligible: boolean;
    reason?: string;
  }[],
) {
  return {
    included: rows.filter((x) => x.eligible).map((x) => x.id),
    excluded: rows
      .filter((x) => !x.eligible)
      .map((x) => ({ id: x.id, reason: x.reason ?? "Not eligible" })),
    nativeDeliveryProved: false,
  };
}
