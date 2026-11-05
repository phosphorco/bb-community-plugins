import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { uiContract } from "./ui-contract.ts";
import type { SubscriptionRow, ListInput } from "./ui-contract.ts";
import { terminal } from "./contracts.ts";
import type { Record as Subscription } from "./contracts.ts";
import type { Store } from "./store.ts";
import type { Engine } from "./engine.ts";

export function presentRow(
  r: Subscription,
  delivery: string | null = null,
): SubscriptionRow {
  const run = r.runs.at(-1);
  return {
    id: r.id,
    owner: r.owner,
    owner_title: null,
    project: r.project,
    subject: "subject" in r.request ? r.request.subject : r.request.message,
    kind: "subject" in r.request ? "observation" : r.request.trigger.kind,
    state: r.state,
    created_at: r.created_at,
    expires_at: r.expires_at,
    next_at: !terminal(r.state) && r.state === "watching" ? r.next_at : null,
    last_check_at: run?.ended_at ?? null,
    classification: run?.classification ?? null,
    delivery,
    problem: r.problem ?? null,
    stop_pending: r.stop_pending ?? false,
    generation: r.generation,
  };
}
export function readList(store: Store, input: ListInput) {
  const clauses = [
    input.view === "active"
      ? "state NOT IN ('fulfilled','failed','expired','cancelled')"
      : "state IN ('fulfilled','failed','expired','cancelled')",
  ];
  const args: (string | number)[] = [];
  if (input.state) {
    clauses.push("state=?");
    args.push(input.state);
  }
  if (input.threadId) {
    clauses.push("owner=?");
    args.push(input.threadId);
  }
  if (input.project) {
    clauses.push("json_extract(body,'$.project')=?");
    args.push(input.project);
  }
  if (input.query.trim()) {
    clauses.push(
      "(instr(lower(coalesce(json_extract(body,'$.request.subject'), json_extract(body,'$.request.message'))),lower(?))>0 OR instr(lower(owner),lower(?))>0 OR instr(lower(id),lower(?))>0)",
    );
    args.push(input.query.trim(), input.query.trim(), input.query.trim());
  }
  const where = clauses.join(" AND ");
  const total = (
    store.db
      .prepare(`SELECT count(*) AS total FROM subscriptions WHERE ${where}`)
      .get(...args) as { total: number }
  ).total;
  // Only this bounded page is decoded; no owner SDK enumeration and no output in list responses.
  const records = store.db
    .prepare(
      `SELECT body FROM subscriptions WHERE ${where} ORDER BY rowid DESC LIMIT 50 OFFSET ?`,
    )
    .all(...args, input.offset) as { body: string }[];
  const rows = records.map(({ body }) => {
    const r: Subscription = JSON.parse(body);
    return presentRow(
      r,
      (
        store.db
          .prepare(
            "SELECT json_extract(body,'$.delivery') AS delivery FROM findings WHERE subscription_id=? ORDER BY rowid DESC LIMIT 1",
          )
          .get(r.id) as { delivery: string } | undefined
      )?.delivery ?? null,
    );
  });
  const projects = (
    store.db
      .prepare(
        `SELECT DISTINCT json_extract(body,'$.project') AS project FROM subscriptions ${input.threadId ? "WHERE owner=?" : ""} ORDER BY project LIMIT 100`,
      )
      .all(...(input.threadId ? [input.threadId] : [])) as { project: string }[]
  ).map((r) => r.project);
  return { rows, total, projects, observed_at: Date.now() };
}
export function registerSubscriptionUi(
  bb: BbPluginApi,
  store: Store,
  engine: Engine,
) {
  function scoped(id: string, threadId?: string) {
    const r = store.get(id);
    if (threadId && r.owner !== threadId)
      throw new Error("This subscription belongs to another thread");
    return r;
  }
  async function title(row: SubscriptionRow) {
    try {
      const t = await bb.sdk.threads.get({
        threadId: row.owner,
        signal: AbortSignal.timeout(5000),
      });
      return t.title || t.titleFallback || row.owner;
    } catch {
      return null;
    }
  }
  bb.rpc.register(uiContract, {
    subscriptionsList: async (input) => {
      const snapshot = readList(store, input);
      const owners = [...new Set(snapshot.rows.map((r) => r.owner))];
      const titles = new Map<string, string | null>();
      // Bounded concurrency, resolved once per distinct owner in this visible page.
      for (let i = 0; i < owners.length; i += 6)
        await Promise.all(
          owners.slice(i, i + 6).map(async (owner) => {
            titles.set(
              owner,
              await title(snapshot.rows.find((r) => r.owner === owner)!),
            );
          }),
        );
      snapshot.rows.forEach(
        (row) => (row.owner_title = titles.get(row.owner) ?? null),
      );
      return snapshot;
    },
    subscriptionDetail: async ({ id, threadId }) => {
      const r = scoped(id, threadId),
        findings = store.findings(id);
      const row = presentRow(r, findings[0]?.delivery ?? null);
      row.owner_title = await title(row);
      return {
        row,
        mode: r.mode,
        condition:
          "subject" in r.request
            ? r.request.notify_when
            : JSON.stringify(r.request.trigger),
        evidence_requirement:
          "subject" in r.request
            ? r.request.required_evidence
            : "Native scheduling; no collection script or model required.",
        interpretation: r.recipe?.interpretation ?? null,
        coverage: r.recipe?.coverage ?? null,
        interval_seconds: r.recipe?.interval_seconds ?? null,
        classifier: r.recipe
          ? r.recipe.evaluation.kind === "semantic"
            ? "Jev"
            : r.recipe.evaluation.kind
          : null,
        checks: r.checks,
        observer_turns: r.observer_turns,
        recipe_revisions: r.revisions.length,
        runs: r.runs
          .slice(-5)
          .reverse()
          .map((run) => ({
            id: run.id,
            started_at: run.started_at,
            ended_at: run.ended_at,
            duration_ms: run.duration_ms,
            exit_code: run.exit_code,
            problem: run.problem ?? null,
            classification: run.classification ?? null,
            output: run.output.slice(0, 20000),
            output_truncated: run.output.length > 20000,
            stdout: run.stdout.slice(0, 16000),
            stderr: run.stderr.slice(0, 16000),
          })),
        findings: findings.map((f) => ({
          id: f.id,
          occurrence: f.occurrence,
          created_at: f.created_at,
          outcome: f.outcome,
          summary: f.summary,
          evidence: f.evidence,
          delivery: f.delivery,
          problem: f.problem ?? null,
          withdrawal_pending: f.withdraw_pending ?? false,
        })),
      };
    },
    subscriptionDiagnostics: ({ id, threadId }) => {
      const r = scoped(id, threadId);
      return {
        observer_thread_id: r.observer ?? null,
        launch: r.launch ?? null,
        review_wake: r.review_wake ?? null,
        script: r.recipe?.script ?? null,
        revisions: r.revisions.map((v) => ({
          script: v.script,
          interpretation: v.interpretation,
          coverage: v.coverage,
        })),
      };
    },
    cancelSubscription: ({ id, threadId, owner, generation }) => {
      const r = scoped(id, threadId);
      if (r.owner !== owner || r.generation !== generation)
        throw new Error(
          "Subscription changed. Refresh and review its current state before cancelling.",
        );
      return engine.cancel(id, r.owner);
    },
  });
}
