import {
  acceptanceMode,
  check,
  controlledClock,
  invalidBindingResult,
  isolatedNegativeControls,
  loadProductionBinding,
  missingBindingResult,
  requireMethods,
  sourceLimit,
  suiteResult,
} from "../browser/acceptance-binding.mjs";
import { makePerformanceDataset, PERFORMANCE_QUERIES } from "./ui/performance-fixtures.mjs";

const datasets = Object.freeze([25_000, 250_000, 1_000_000].map(makePerformanceDataset));
const baseline = datasets[0];
const scenario = (id, dataset, config, secondaryQuery) => ({
  id,
  dataset,
  query: PERFORMANCE_QUERIES.countSum,
  secondaryQuery,
  expected: dataset.expected.countSum,
  secondaryExpected: secondaryQuery ? dataset.expected.duration : null,
  config,
});
const scenarios = Object.freeze([
  ...datasets.map((dataset) => scenario(dataset.id, dataset, { views: 1, clients: 1, changedThreads: 0 })),
  scenario("shared-10", baseline, { views: 10, clients: 1, changedThreads: 0 }),
  scenario("shared-30", baseline, { views: 30, clients: 1, changedThreads: 0 }),
  scenario("distinct-query", baseline, { views: 10, clients: 1, changedThreads: 0 }, PERFORMANCE_QUERIES.duration),
  scenario("clients-4", baseline, { views: 1, clients: 4, changedThreads: 0 }),
  ...[1, 5, 20, 80].map((changedThreads) => scenario(`changed-${changedThreads}`, makePerformanceDataset(25_000, changedThreads), { views: 1, clients: 1, changedThreads })),
]);
const namedCounterKeys = ["extractionCalls", "sqlDispatches", "renderDispatches", "sourceEventReads", "sourceApiCalls"];
const namedResourceKeys = ["cpuMs", "peakRssBytes", "eventLoopDelayMs"];
const finite = (value) => Number.isFinite(value) && value >= 0;
const sameRows = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const namedFinite = (value, keys) => keys.every((key) => finite(value?.[key]));
function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { p50: at(.5), p95: at(.95), max: sorted.at(-1) };
}
function validScenarioRecord(record, definition) {
  return record?.configuration?.views === definition.config.views
    && record.configuration.clients === definition.config.clients
    && record.configuration.changedThreads === definition.config.changedThreads
    && sameRows(record.rows, definition.expected)
    && (definition.secondaryQuery == null || sameRows(record.secondaryRows, definition.secondaryExpected))
    && finite(record.requestToUsefulMs)
    && namedFinite(record.counters, namedCounterKeys)
    && namedFinite(record.resources, namedResourceKeys);
}
function verify(coldRecords, warmSamples, host, idle, instrumentSelfTest = false) {
  const byId = new Map(coldRecords.map((record) => [record.definition.id, record]));
  const warm = warmSamples.map((sample) => sample.requestToUsefulMs);
  const warmStats = warm.length === 30 && warm.every(finite) ? quantiles(warm) : null;
  return [
    check("cold-fixtures", scenarios.every((definition) => validScenarioRecord(byId.get(definition.id), definition)) ? "pass" : "fail", "every cold dataset/query/config has exact rows and finite named evidence"),
    check("shared-dispatch", byId.get("shared-10")?.counters.sqlDispatches === byId.get(baseline.id)?.counters.sqlDispatches && byId.get("shared-30")?.counters.sqlDispatches === byId.get(baseline.id)?.counters.sqlDispatches ? "pass" : "fail", "shared views match observed one-view SQL dispatches"),
    check("distinct-secondary-result", byId.get("distinct-query")?.counters.sqlDispatches > byId.get(baseline.id)?.counters.sqlDispatches && sameRows(byId.get("distinct-query")?.secondaryRows, baseline.expected.duration) ? "pass" : "fail", "distinct case executes and verifies both count/sum and duration queries"),
    check("warm-distribution", warmSamples.length === 30 && warmSamples.every((sample) => validScenarioRecord(sample, scenario("warm", baseline, { views: 1, clients: 1, changedThreads: 0 }))) && warmStats?.p95 < 1_000 ? "pass" : "fail", warmStats == null ? "need 30 warm samples" : `p50=${warmStats.p50}ms p95=${warmStats.p95}ms max=${warmStats.max}ms`),
    check("host-contention-gate", instrumentSelfTest ? "pass" : "blocked", "blocked until binding can overlap each host probe with observed noncached SQL dispatch work"),
    check("idle-window", idle?.intervalMs >= 1_000 && idle.extractionCalls === 0 && idle.sourceApiCalls === 0 && idle.chartInstances === 0 && (idle.retainedWorkers === 0 || idle.retainedWorkers === 1) ? "pass" : "fail", "bounded idle interval has no extraction/API reads"),
    check("source-mutation-gate", instrumentSelfTest ? "pass" : "blocked", "public source mutation/invalidation evidence remains unimplemented"),
  ];
}
async function runOne(binding, definition, clock) {
  const prepared = await binding.prepareDataset({ dataset: definition.dataset, facts: definition.dataset.facts, appendedFacts: definition.dataset.appendedFacts, configuration: definition.config, clock });
  const loaded = await binding.loadDataset({ prepared, clock });
  const view = await binding.openDashboard({ dataset: loaded, query: definition.query, configuration: definition.config, clock });
  try {
    const started = performance.now();
    await binding.execute({ view, query: definition.query, configuration: definition.config, clock });
    if (definition.secondaryQuery) await binding.execute({ view, query: definition.secondaryQuery, configuration: definition.config, clock });
    await binding.awaitUsefulResult({ view, clock });
    const requestToUsefulMs = performance.now() - started;
    const result = await binding.readResult({ view, query: definition.query, clock });
    const secondary = definition.secondaryQuery ? await binding.readResult({ view, query: definition.secondaryQuery, clock }) : null;
    return { definition, configuration: definition.config, rows: result.rows, secondaryRows: secondary?.rows ?? null, requestToUsefulMs, counters: await binding.readCounters({ view, clock }), resources: await binding.readResources({ view, clock }) };
  } finally { await binding.closeDashboard({ view, clock }); }
}
export async function runSuite(options = {}) {
  const mode = acceptanceMode(options);
  if (mode === "instrument-self-test") {
    const makeRecord = (definition, ms = 800) => ({ definition, configuration: definition.config, rows: definition.expected, secondaryRows: definition.secondaryExpected, requestToUsefulMs: ms, counters: { extractionCalls: 1, sqlDispatches: definition.secondaryQuery ? 2 : 1, renderDispatches: definition.config.views, sourceEventReads: 1, sourceApiCalls: 1 }, resources: { cpuMs: 1, peakRssBytes: 1, eventLoopDelayMs: 1 } });
    const warmDefinition = scenario("warm", baseline, { views: 1, clients: 1, changedThreads: 0 });
    const p = { cold: scenarios.map(makeRecord), warm: Array.from({ length: 30 }, () => makeRecord(warmDefinition)), host: {}, idle: { intervalMs: 1_000, extractionCalls: 0, sourceApiCalls: 0, chartInstances: 0, retainedWorkers: 1 } };
    return suiteResult("performance", isolatedNegativeControls((value) => verify(value.cold, value.warm, value.host, value.idle, true), p, [
      { id: "cold-fixtures", value: { ...p, cold: p.cold.map((record) => record.definition.id === baseline.id ? { ...record, rows: [] } : record) } },
      { id: "warm-distribution", value: { ...p, warm: p.warm.slice(1) } },
      { id: "warm-distribution", value: { ...p, warm: p.warm.map((record) => ({ ...record, resources: { ...record.resources, cpuMs: Number.NaN } })) } },
      { id: "warm-distribution", value: { ...p, warm: p.warm.map((record) => ({ ...record, requestToUsefulMs: 1_000 })) } },
      { id: "distinct-secondary-result", value: { ...p, cold: p.cold.map((record) => record.definition.id === "distinct-query" ? { ...record, secondaryRows: [] } : record) } },
    ]), [{ kind: "mode", value: mode }]);
  }
  const loaded = await loadProductionBinding(options, "performance");
  if (loaded.kind === "missing") return missingBindingResult("performance", loaded.reason);
  const missing = requireMethods(loaded.binding, ["prepareDataset", "loadDataset", "openDashboard", "execute", "awaitUsefulResult", "readResult", "readCounters", "readResources", "closeDashboard", "observeIdle", "dispose"]);
  if (missing) return invalidBindingResult("performance", missing);
  const clock = controlledClock();
  try {
    const coldRecords = [];
    for (const definition of scenarios) coldRecords.push(await runOne(loaded.binding, definition, clock));
    const warmDefinition = scenario("warm", baseline, { views: 1, clients: 1, changedThreads: 0 });
    const warmSamples = [];
    for (let index = 0; index < 30; index += 1) warmSamples.push(await runOne(loaded.binding, warmDefinition, clock));
    const idle = await loaded.binding.observeIdle({ intervalMs: 1_000, clock });
    return suiteResult("performance", verify(coldRecords, warmSamples, null, idle), [sourceLimit(loaded.sources)]);
  } finally { await loaded.binding.dispose(); }
}
