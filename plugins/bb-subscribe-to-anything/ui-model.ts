import type { SubscriptionRow } from "./ui-contract.ts";
export function deliveryLabel(value: string | null): string {
  return (
    (
      {
        accepted: "Accepted by BB",
        pending: "Awaiting delivery",
        sending: "Sending",
        uncertain: "Delivery uncertain",
        cancelled: "Delivery cancelled",
      } as { [key: string]: string }
    )[value ?? ""] ?? "No notification"
  );
}
export function needsAttention(row: SubscriptionRow): boolean {
  return (
    row.state === "uncertain" ||
    row.state === "failed" ||
    row.delivery === "uncertain" ||
    row.stop_pending ||
    Boolean(row.problem)
  );
}
