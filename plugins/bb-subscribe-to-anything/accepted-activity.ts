import { bindMessageAdmission } from "@phosphorco/bb-message-admission/bb";
import type { Database } from "./store.ts";

/** Called by the existing idle check. Native acceptance, not delivery, owns this clock. */
export function createAcceptedActivityReader(bb: unknown, db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS subscription_admission_activity (
    subscription_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, accepted_at INTEGER NOT NULL)`);
  let binding: ReturnType<typeof bindMessageAdmission> | undefined;
  return async (subscriptionId: string, threadId: string, apply: (at: number) => void) => {
    const admission = await (binding ??= bindMessageAdmission(bb));
    if (admission.status === "unavailable") binding = undefined;
    // Only an absent legacy host may use request-event heuristics. An advertised
    // but unavailable/incompatible capability must not quietly conceal activity.
    if (admission.status === "unsupported" && admission.reason === "absent") return "legacy" as const;
    if (admission.status !== "available" || !admission.capabilities.activity) return "offline" as const;
    const previous = db.prepare(`SELECT sequence, accepted_at FROM subscription_admission_activity WHERE subscription_id = ?`).get(subscriptionId) as { sequence: number; accepted_at: number } | undefined;
    const summary = await admission.client.readThreadActivity({ version: 1, threadId });
    const page = await admission.client.listAcceptedActivity({ version: 1, threadId, afterSequence: previous?.sequence ?? 0, limit: 100 });
    if (summary.messageAcceptanceSequence < (previous?.sequence ?? 0)) throw new Error("Native acceptance sequence regressed");
    let anchor = Math.max(previous?.accepted_at ?? 0, summary.lastVisibleHumanAcceptedAt === null ? 0 : Date.parse(summary.lastVisibleHumanAcceptedAt));
    for (const item of page.items) if (item.source.visibleHumanActivity) anchor = Math.max(anchor, Date.parse(item.acceptedAt));
    db.transaction(() => {
      apply(anchor);
      db.prepare(`INSERT INTO subscription_admission_activity VALUES (?, ?, ?)
        ON CONFLICT(subscription_id) DO UPDATE SET sequence = MAX(sequence, excluded.sequence), accepted_at = MAX(accepted_at, excluded.accepted_at)`)
        .run(subscriptionId, page.throughSequence, anchor);
    })();
    return page.complete ? "available" as const : "offline" as const;
  };
}
