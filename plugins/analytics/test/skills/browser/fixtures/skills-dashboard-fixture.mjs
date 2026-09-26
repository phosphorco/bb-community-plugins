import { activationAggregate, lifecycleCohortAggregates, measurementAggregates, rawContributors } from "../../fixtures/query-ui/skill-query-fixture.mjs";

export function dashboardFixture(filters = {}) {
  const lifecycle = rawContributors(filters, (row) => row.kind === "lifecycle");
  const lifecycleCohorts = lifecycleCohortAggregates(filters);
  const measurements = measurementAggregates(filters);
  const activation = activationAggregate(filters);
  const revisions = [...new Map(lifecycle.map((row) => [`${row.skill.skillId}|${row.skill.revision}`, row.skill])).values()];
  return {
    appliedFilters: { ...filters },
    cards: {
      resolved: lifecycleCohorts.filter((row) => row.evidence === "resolved" && row.lifecycleCoverage === "observed"),
      active: lifecycleCohorts.filter((row) => row.evidence === "active-staged" && row.lifecycleCoverage === "observed"),
      activation,
      coverage: activation.coverage,
    },
    revisions: revisions.map((skill) => ({ key: `${skill.skillId}|${skill.revision}`, ...skill })),
    measurements,
    drawer: (aggregate) => rawContributors(aggregate.filters, (row) => aggregate.contributingFactIds.includes(row.factId)),
  };
}
