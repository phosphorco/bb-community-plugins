import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

/**
 * Documented native DOM dependency, limited to the New thread compact-home:
 * RootComposeCompactHome contains the exact Recent marker and our homepage slot.
 * Missing markers, unsupported :has, empty/unusable product state or deactivation
 * restore native layout. No native nodes, spacers, composer, or inline styles move.
 */
export function mountMobileTemplates(context: PluginContentScriptContext) {
  if (
    context.signal.aborted ||
    !document.head ||
    !document.defaultView?.CSS?.supports?.("selector(:has(*))")
  )
    return;
  const style = document.createElement("style");
  style.dataset.newThreadTemplatesMobileLayout = String(context.generation);
  style.textContent = `
@media (max-width: 767px) {
  [data-testid="root-compose-compact-home"]:has([data-new-thread-templates-homepage="usable"]) [data-root-compose-mobile-recents],
  [data-testid="root-compose-compact-home"]:has([data-new-thread-templates-homepage="selected"] [data-new-thread-templates-form="usable"]) [data-root-compose-mobile-recents],
  [data-testid="root-compose-compact-home"]:has([data-new-thread-templates-homepage="selected"] [data-new-thread-templates-form="recovery"]) [data-root-compose-mobile-recents] {
    display: none !important;
  }
}`;
  document.head.append(style);
  const dispose = () => {
    context.signal.removeEventListener("abort", dispose);
    style.remove();
  };
  context.signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
