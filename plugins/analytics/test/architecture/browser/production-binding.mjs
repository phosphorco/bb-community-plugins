/**
 * Test-owned browser router. Host/service acceptance is intentionally not a
 * browser lane: host-execution has a direct Node binding of its own.
 */
const browserSuiteBindings = Object.freeze({
  ui: "./bindings/ui.mjs",
  composition: "./bindings/composition.mjs",
  "vertical-slice": "./bindings/vertical-slice.mjs",
  "end-to-end": "./bindings/end-to-end.mjs",
  performance: "./bindings/performance.mjs",
});

export const productionBindingRoutes = browserSuiteBindings;

function isExactMissingModule(error, href) {
  return error?.code === "ERR_MODULE_NOT_FOUND" && error?.url === href;
}

export async function bindProduction({ suite, signal } = {}) {
  const hasOwnRoute = Object.prototype.hasOwnProperty.call(browserSuiteBindings, suite);
  const route = hasOwnRoute ? browserSuiteBindings[suite] : undefined;
  if (route == null)
    throw new Error(`No browser production binding route is registered for ${String(suite)}.`);
  const href = new URL(route, import.meta.url).href;
  let module;
  try {
    module = await import(href);
  } catch (error) {
    if (isExactMissingModule(error, href)) {
      return {
        kind: "missing",
        reason: `missing test-owned browser binding ${route} for suite ${suite}`,
      };
    }
    throw error;
  }
  if (typeof module.bindProduction !== "function")
    throw new Error(`Browser binding ${route} must export bindProduction({ suite, signal }).`);
  return module.bindProduction({ suite, signal });
}
