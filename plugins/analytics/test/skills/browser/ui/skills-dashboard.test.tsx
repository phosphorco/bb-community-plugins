// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  SkillsDashboard,
  type SkillsDashboardData,
  type SkillsDashboardFilters,
} from "../../../../skills-dashboard/skills-dashboard.tsx";

const coverage = { observed: 2, unknown: 1, unsupported: 1, missing: 1 } as const;
const contributorRows = [
  {
    factId: "life-a", sessionId: "session-a", threadId: "thread-a", providerTurnId: "turn-a",
    observation: "active-staged", evidence: "active-staged", path: "/work/release-notes/SKILL.md", deliveredFragment: "catalog entry",
  },
  {
    factId: "context-a", sessionId: "session-a", threadId: "thread-a", providerTurnId: null,
    observation: "provider context report", evidence: "provider-context-report", path: "/work/release-notes/SKILL.md", deliveredFragment: "skills.skillFrontmatter",
  },
  {
    factId: "consumption-a", sessionId: "session-a", threadId: "thread-a", providerTurnId: "turn-a",
    observation: "provider native event", evidence: "provider-native-event", path: "/work/release-notes/SKILL.md", deliveredFragment: null,
  },
] as const;

function aggregate(id: string, label: string, factIds: readonly string[]) {
  return { id, label, count: factIds.length, method: "runtime-observation-v1", coverage, contributingFactIds: factIds } as const;
}

function dashboardData(overrides: Partial<SkillsDashboardData> = {}): SkillsDashboardData {
  return {
    filters: { provider: "claude-code", project: "alpha", principal: "alice" },
    filterOptions: {
      provider: ["claude-code", "codex"], model: ["claude-sonnet", "gpt-5"], project: ["alpha"], environment: ["preview"], principal: ["alice"], source: ["project", "user"], evidence: ["active-staged", "provider-context-report"],
    },
    lifecycleCards: [
      aggregate("resolved", "Resolved", ["life-a"]),
      aggregate("active", "Active staged", ["life-a"]),
      aggregate("configured", "Bridge configured", ["life-a"]),
      aggregate("provider-observed", "Provider observed", ["life-a"]),
      aggregate("read", "Read evidence", ["life-a"]),
    ],
    noReadObserved: aggregate("no-read-observed", "No read observed (qualified Claude cohort)", ["life-a"]),
    nativeActivation: aggregate("native-activation", "Native activation unsupported", []),
    revisions: [
      { key: "project|a", skillId: "release-notes-project", name: "release-notes", revision: "a".repeat(64), source: "project", path: "/work/release-notes/SKILL.md", resolved: 1, active: 1, configured: 1, providerObserved: 1, readObserved: 1, noReadObserved: null, nativeActivation: "Unsupported", coverage, contributingFactIds: ["life-a", "context-a"] },
      { key: "user|b", skillId: "release-notes-user", name: "release-notes", revision: "b".repeat(64), source: "user", path: "/home/alice/.agents/skills/release-notes/SKILL.md", resolved: 1, active: 1, configured: 1, providerObserved: 0, readObserved: 0, noReadObserved: "Qualified: 1", nativeActivation: "Unsupported", coverage, contributingFactIds: ["life-a"] },
    ],
    measurements: [
      { ...aggregate("content-a", "release-notes · a", ["life-a"]), family: "content", total: 100, average: 100, unit: "bytes", provider: "claude-code", model: "claude-sonnet", serializer: "utf8-frontmatter", tokenizer: "none", method: "local-content-estimate" },
      { ...aggregate("context-a", "release-notes · a", ["context-a"]), family: "context", total: 22, average: 22, unit: "tokens", provider: "claude-code", model: "claude-sonnet", serializer: "skills.skillFrontmatter", tokenizer: "provider-undisclosed", method: "provider-reported-named-context-estimate" },
      { ...aggregate("consumption-a", "release-notes · a", ["consumption-a"]), family: "consumption", total: 8, average: 8, unit: "tokens", provider: "claude-code", model: "claude-sonnet", serializer: "claude-usage-v1", tokenizer: "claude-tokenizer-v1", method: "provider-attributed-token-usage" },
    ],
    contributors: contributorRows,
    ...overrides,
  };
}

function ControlledDashboard({ initial = dashboardData() }: Readonly<{ initial?: SkillsDashboardData }>) {
  const [filters, setFilters] = useState<SkillsDashboardFilters>(initial.filters);
  return <SkillsDashboard data={{ ...initial, filters }} onFiltersChange={setFilters} onRetry={() => undefined} />;
}

describe("SkillsDashboard", () => {
  afterEach(cleanup);

  it("keeps all raw-query filter dimensions controlled and shows exact same-name revisions", () => {
    render(<ControlledDashboard />);
    for (const label of ["Provider", "Model", "Project", "Environment", "Actor provenance", "Source", "Evidence"]) {
      expect(screen.getByLabelText(label)).not.toBeNull();
    }
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet" } });
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("claude-sonnet");
    expect(screen.getAllByText("release-notes")).toHaveLength(2);
    expect(screen.getByText("a".repeat(64))).not.toBeNull();
    expect(screen.getByText("b".repeat(64))).not.toBeNull();
    expect(screen.getAllByText(/observed 2 · unknown 1 · unsupported 1 · missing 1/).length).toBeGreaterThan(0);
  });

  it("separates measurement families and reconciles the context drawer to nullable-turn contributors", () => {
    render(<ControlledDashboard />);
    expect(screen.getByText(/Local revision footprint; it does not prove loading/)).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Context occupancy" }));
    expect(screen.getByText(/Provider-reported named context estimate; it does not prove body or asset reads/)).not.toBeNull();
    expect(screen.getByText("provider-reported-named-context-estimate")).not.toBeNull();
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog", { name: /raw contributors/i });
    expect(within(dialog).getByText("No turn (session-scoped)")).not.toBeNull();
    expect(within(dialog).getByText("skills.skillFrontmatter")).not.toBeNull();
    expect(within(dialog).getByText("N 1 of 1 requested contributor rows.")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sorts accessibly and exposes loading and failure states", () => {
    const { rerender } = render(<ControlledDashboard initial={dashboardData({ loading: true, error: "Query snapshot expired" })} />);
    expect(screen.getByRole("status").textContent).toContain("Loading filtered skill evidence");
    expect(screen.getByRole("alert").textContent).toContain("Query snapshot expired");
    const sort = screen.getByRole("button", { name: "Revision" });
    fireEvent.click(sort);
    expect(sort.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(sort);
    expect(sort.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    rerender(<ControlledDashboard initial={dashboardData()} />);
  });

  it("bounds the revision table without dropping its disclosure", () => {
    const revisions = Array.from({ length: 101 }, (_, index) => ({
      ...dashboardData().revisions[0]!, key: `revision-${index}`, skillId: `skill-${index}`, name: `skill-${index}`, revision: String(index),
    }));
    render(<ControlledDashboard initial={dashboardData({ revisions })} />);
    expect(screen.getByText("Showing 100 of 101 revisions. Refine filters to inspect the rest.")).not.toBeNull();
    expect(screen.getByRole("table", { name: /Skill revisions keyed/ }).querySelectorAll("tbody tr")).toHaveLength(100);
  });
});
