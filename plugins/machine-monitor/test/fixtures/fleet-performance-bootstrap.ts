/** This string runs before the production bundle, so every required probe is present first. */
export const FLEET_PERFORMANCE_INSTRUMENTATION_VERSION = "fleet-performance-browser-v1";

export const FLEET_PERFORMANCE_BOOTSTRAP = String.raw`(() => {
  const state = {
    version: "fleet-performance-browser-v1",
    instrumentation: { longTask: false, animationFrame: typeof requestAnimationFrame === "function", chartProxy: false, rpcProbe: false, timerProbe: true },
    counters: { rpc: {}, hostCalls: 0, chartInit: 0, chartDispose: 0, chartUpdate: 0, setIntervalCalls: 0, activeIntervals: 0, domMutations: 0, idleCallbacks: 0 },
    longTasks: [],
    measurement: null,
  };
  const originalSetInterval = window.setInterval.bind(window);
  const originalClearInterval = window.clearInterval.bind(window);
  const intervals = new Set();
  window.setInterval = (...args) => {
    const id = originalSetInterval(...args);
    intervals.add(id);
    state.counters.setIntervalCalls += 1;
    state.counters.activeIntervals = intervals.size;
    return id;
  };
  window.clearInterval = (id) => {
    intervals.delete(id);
    state.counters.activeIntervals = intervals.size;
    return originalClearInterval(id);
  };
  let nextIdle = 0;
  const idleCallbacks = new Map();
  window.requestIdleCallback = (callback) => {
    const id = ++nextIdle;
    idleCallbacks.set(id, callback);
    state.counters.idleCallbacks += 1;
    return id;
  };
  window.cancelIdleCallback = (id) => { idleCallbacks.delete(id); };
  try {
    const observer = new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    });
    observer.observe({ type: "longtask", buffered: true });
    state.instrumentation.longTask = true;
  } catch (error) {
    state.longTaskError = String(error);
  }
  const mutationObserver = new MutationObserver(() => {
    state.counters.domMutations += 1;
    if (state.measurement != null) match(state.measurement);
  });
  document.addEventListener("DOMContentLoaded", () => mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true }), { once: true });
  function counters() { return structuredClone(state.counters); }
  function diff(before, after) {
    const rpc = {};
    for (const key of new Set([...Object.keys(before.rpc), ...Object.keys(after.rpc)])) rpc[key] = (after.rpc[key] || 0) - (before.rpc[key] || 0);
    return { rpc, hostCalls: after.hostCalls - before.hostCalls, chartInit: after.chartInit - before.chartInit, chartDispose: after.chartDispose - before.chartDispose, chartUpdate: after.chartUpdate - before.chartUpdate, setIntervalCalls: after.setIntervalCalls - before.setIntervalCalls, activeIntervals: after.activeIntervals, domMutations: after.domMutations - before.domMutations, idleCallbacks: after.idleCallbacks - before.idleCallbacks };
  }
  function match(measurement) {
    if (measurement.inputAt == null) return;
    const heading = document.querySelector("#machine-monitor-selected-title");
    const chart = document.querySelector('.machine-monitor__dashboard-chart [aria-label*="' + measurement.expectedMachineId + '"]');
    if (heading?.textContent !== measurement.expectedLabel || chart == null || measurement.usefulDomAt != null) return;
    measurement.usefulDomAt = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (state.measurement === measurement && measurement.paintAt == null) measurement.paintAt = performance.now();
    }));
  }
  document.addEventListener("click", (event) => {
    const measurement = state.measurement;
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (measurement == null || button == null || measurement.inputAt != null || !button.getAttribute("aria-label")?.startsWith(measurement.targetLabel)) return;
    measurement.inputAt = performance.now();
    measurement.overviewAtInput = document.querySelector(".machine-monitor__fleet-picker") != null;
    measurement.chartAtInput = document.querySelector('.machine-monitor__dashboard-chart') != null;
    match(measurement);
  }, true);
  window.__fleetPerformance = Object.assign(state, {
    begin({ id, targetLabel, expectedLabel, expectedMachineId }) {
      if (state.measurement != null) throw new Error("A fleet performance measurement is already active.");
      state.measurement = { id, targetLabel, expectedLabel, expectedMachineId, before: counters(), inputAt: null, usefulDomAt: null, paintAt: null, overviewAtInput: false, chartAtInput: false };
      return state.measurement;
    },
    ready(id) { return state.measurement?.id === id && state.measurement.paintAt != null; },
    finish(id) {
      const measurement = state.measurement;
      if (measurement?.id !== id || measurement.inputAt == null || measurement.paintAt == null) throw new Error("Fleet performance measurement did not reach a browser frame.");
      const after = counters();
      const value = {
        id,
        usefulPaintMs: measurement.paintAt - measurement.inputAt,
        usefulDomMs: measurement.usefulDomAt - measurement.inputAt,
        overviewRetained: measurement.overviewAtInput && document.querySelector(".machine-monitor__fleet-picker") != null,
        chartRetainedAtInput: measurement.chartAtInput,
        staleContentVisible: document.body.textContent.includes("Showing retained timeline") || document.body.textContent.includes("Refreshing timeline data"),
        counterDelta: diff(measurement.before, after),
        // The witness ends at the first useful painted frame.  Work scheduled
        // after that point belongs to the next browser turn, not the measured
        // selection transition (and must not be attributed to this click).
        longTasks: state.longTasks.filter((entry) => entry.startTime >= measurement.inputAt && entry.startTime <= measurement.paintAt),
        heap: performance.memory == null ? null : { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize },
      };
      state.measurement = null;
      return value;
    },
    preflight() {
      return { version: state.version, instrumentation: structuredClone(state.instrumentation), counters: counters(), hasPerformanceMemory: performance.memory != null };
    },
    flushIdle() {
      const callbacks = [...idleCallbacks.values()];
      idleCallbacks.clear();
      for (const callback of callbacks) callback({ didTimeout: false, timeRemaining: () => 50 });
      return callbacks.length;
    },
    quietSnapshot() { return counters(); },
    quietDelta(before) { return diff(before, counters()); },
  });
})();`;
