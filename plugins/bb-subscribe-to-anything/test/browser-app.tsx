import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import appDefinition from "../app";
const app = await loadPluginApp(appDefinition);
const now = Date.now();
const base = {
  owner: "thread-a",
  owner_title: "Ship release",
  project: "Phosphor",
  kind: "observation",
  state: "watching",
  created_at: now - 3600000,
  next_at: now + 60000,
  expires_at: now + 3600000,
  generation: 1,
  last_check_at: now - 30000,
  classification: "pending",
  delivery: null,
  problem: null,
  stop_pending: false,
};
const rows = [
  { ...base, id: "release", subject: "Release PR #482" },
  {
    ...base,
    id: "deployment",
    subject: "Production deployment",
    state: "reviewing",
    classification: "candidate match",
  },
  {
    ...base,
    id: "commits",
    subject: "New default-branch commits",
    state: "preparing",
    last_check_at: null,
    classification: null,
  },
  {
    ...base,
    id: "docs",
    subject: "Website content changes",
    delivery: "uncertain",
    problem: "Delivery response lost; inspect before retrying",
  },
  {
    ...base,
    id: "stretch",
    subject: "Stretch reminder",
    kind: "after",
    last_check_at: null,
    classification: null,
  },
];
const rpc = {
  subscriptionsList: async (input: any) => ({
    rows:
      input.view === "history"
        ? []
        : rows.filter((r) =>
            r.subject.toLowerCase().includes(input.query.toLowerCase()),
          ),
    total: input.view === "history" ? 0 : rows.length,
    projects: ["Phosphor"],
    observed_at: now,
  }),
  subscriptionDetail: async ({ id }: any) => ({
    row: rows.find((r) => r.id === id) ?? rows[1],
    mode: "changes",
    condition:
      "Notify when the deployed revision changes and the deployment is healthy.",
    evidence_requirement:
      "Revision, health status, source URL, observation time.",
    interpretation: "A changed revision with a current healthy response.",
    coverage:
      "Periodic samples every 60 seconds; intervening changes may be missed.",
    interval_seconds: 60,
    classifier: "json_changes",
    checks: 43,
    observer_turns: 3,
    recipe_revisions: 1,
    runs: [
      {
        id: "run-a",
        started_at: now - 30000,
        ended_at: now - 29816,
        duration_ms: 184,
        exit_code: 0,
        problem: null,
        classification: "candidate change",
        output:
          '{\n  "revision": "b82d4f",\n  "healthy": true,\n  "http_status": 200\n}',
        output_truncated: false,
        stdout: "",
        stderr: "",
      },
    ],
    findings: [
      {
        id: "finding-a",
        occurrence: "run-a",
        created_at: now - 20000,
        outcome: "matched",
        summary: "Production is now on b82d4f and healthy.",
        evidence:
          "Revision changed from a91c7e to b82d4f. HTTPS response was 200 with health=true.",
        delivery: "accepted",
        problem: null,
        withdrawal_pending: false,
      },
    ],
  }),
  subscriptionDiagnostics: async () => ({
    observer_thread_id: "debug-only",
    launch: "confirmed",
    review_wake: null,
    script: 'curl --fail "$TARGET_URL" >> "$SUB_OUTPUT"',
    revisions: [],
  }),
  cancelSubscription: async () => ({
    state: "cancelled",
    shutdown: "stop-requested",
    already_dispatched: "Dispatched messages cannot be recalled.",
  }),
};
let slot: ReturnType<typeof renderSlot>;
function mount(panel: boolean, id = "") {
  slot?.lifecycle.unmount();
  slot?.container.remove();
  slot = panel
    ? renderSlot(
        app.threadPanelActions[0]!,
        { threadId: "thread-a", params: null },
        { rpc },
      )
    : renderSlot(app.navPanels[0]!, { subPath: id }, { rpc });
  slot.container.dataset.bbPlugin = "bb-subscribe-to-anything";
  slot.container.style.height = "100vh";
}
Object.assign(window, {
  subscriptionsHarness: { mount, stats: () => slot.inspection.rpcCalls.length },
});
mount(false);
