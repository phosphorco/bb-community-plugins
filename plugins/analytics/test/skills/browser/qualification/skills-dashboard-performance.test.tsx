// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { SkillsDashboard, type SkillsDashboardData } from "../../../../skills-dashboard/skills-dashboard.tsx";

afterEach(cleanup);

const capturedApp = vi.hoisted(() => ({ component: null as null | (() => React.ReactElement), calls: [] as string[] }));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp(register: (app: { slots: { navPanel(input: { component: () => React.ReactElement }): void } }) => void) {
    register({ slots: { navPanel(input) { capturedApp.component = input.component; } } });
    return {};
  },
  useRpc: () => ({ call: async (method: string) => { capturedApp.calls.push(method); return null; } }),
  useComposer: () => null,
  useRealtime: () => null,
  useRealtimeConnectionState: () => "connected",
}));

function data(): SkillsDashboardData {
  const coverage = { observed: 100, unknown: 0, unsupported: 1 } as const;
  const contributors = Array.from({ length: 100 }, (_, index) => ({ factId: `fact-${index}`, sessionId: `session-${index}`, threadId: `thread-${index}`, providerTurnId: index % 2 === 0 ? `turn-${index}` : null, observation: "registered-skill-md-read", evidence: "exact Claude Read", path: `/skills/skill-${index}/SKILL.md`, deliveredFragment: "SKILL.md" }));
  const revisions = Array.from({ length: 101 }, (_, index) => ({ key: `revision-${index}`, skillId: `skill-${index}`, name: `skill-${index}`, revision: `${index}`.padStart(64, "0"), source: "project", path: `/skills/skill-${index}/SKILL.md`, resolved: 1, active: 1, configured: 1, providerObserved: 1, readObserved: 1, noReadObserved: null, nativeActivation: "Unsupported" as const, coverage, contributingFactIds: [`fact-${index}`] }));
  const aggregate = (id: string, ids: readonly string[]) => ({ id, label: id, count: ids.length, method: "qualification", coverage, contributingFactIds: ids });
  return {
    filters: { provider: "claude-code" }, filterOptions: { provider: ["claude-code", "codex"] },
    lifecycleCards: [aggregate("resolved", ["fact-0"]), aggregate("active", ["fact-0"]), aggregate("read", ["fact-0"])],
    noReadObserved: aggregate("no-read-observed", []), nativeActivation: aggregate("native-activation", []), revisions,
    measurements: [{ ...aggregate("context", ["fact-0"]), family: "context", total: 22, average: 22, unit: "tokens", provider: "claude-code", model: "claude-sonnet", serializer: "skills.skillFrontmatter", tokenizer: "provider-undisclosed" }],
    contributors,
  };
}

it("renders a bounded 101-revision qualification workload and drills into an exact contributor", async () => {
  const started = performance.now();
  render(<SkillsDashboard data={data()} onLoadContributors={async (factIds) => data().contributors.filter((row) => factIds.includes(row.factId))} />);
  const renderMs = performance.now() - started;
  expect(renderMs).toBeLessThan(10_000);
  expect(screen.getByRole("heading", { name: "Skills" })).not.toBeNull();
  expect(screen.getByRole("table", { name: /Skill revisions keyed/i }).querySelectorAll("tbody tr")).toHaveLength(100);
  expect(screen.getByText("Showing 100 of 101 revisions. Refine filters to inspect the rest.")).not.toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: /Open raw contributors/u })[0]!);
  expect(screen.getByRole("dialog", { name: /raw contributors/i })).not.toBeNull();
  expect(await screen.findByText("fact-0")).not.toBeNull();
});

it("observes zero Skills RPC work from the real captured AnalyticsPanel until Skills is selected", async () => {
  capturedApp.calls.length = 0;
  await import("../../../../app.tsx");
  expect(capturedApp.component).not.toBeNull();
  const Panel = capturedApp.component!;
  render(<Panel />);
  await Promise.resolve();
  expect(capturedApp.calls.filter((method) => method === "skillsQuery" || method === "skillsRawContributors")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Skills" }));
  await waitFor(() => expect(capturedApp.calls).toContain("skillsQuery"));
});
