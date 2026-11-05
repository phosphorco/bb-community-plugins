import { useEffect } from "react";
import { definePluginApp, useSettings } from "@get-bb/plugin-sdk/app";

function UpdateReadyPreference(): null {
  const { values } = useSettings();
  const hideUpdateReady = values?.hideUpdateReady;
  useEffect(() => {
    // Leave notifications visible until settings load; retain the last applied
    // preference when a later settings read is temporarily unavailable.
    if (hideUpdateReady === undefined) return;
    document.documentElement.toggleAttribute(
      "data-bb-compact-hide-updates",
      hideUpdateReady === true,
    );
  }, [hideUpdateReady]);
  useEffect(() => () => {
    document.documentElement.removeAttribute("data-bb-compact-hide-updates");
  }, []);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "update-ready-preference",
    component: UpdateReadyPreference,
  });
  app.contentScripts.register({
    id: "compact-display",
    mount() {
      // One stylesheet per app lifecycle. CSS also covers composers mounted later.
      // The host owns enablement and calls this disposer on disable/reload.
      const style = document.createElement("style");
      style.dataset.bbCompactDisplay = "";
      style.textContent = `
/* Native BB overrides belong together here so their layout interactions can be
   reviewed together. Keep feature-owned UI styles in their owning plugins. */

/* Hide update-ready sidebar badges when the setting is known to be enabled.
   The native settings hook updates the preference attribute without DOM watching.
   Restrict both URL forms to notification badges, leaving navigation available.
   BB reuses provider badges for progress; keep their loading indicator visible. */
:root[data-bb-compact-hide-updates] [data-sidebar="sidebar"]
:is([href="/settings/update"], [href="/settings/updates"])[data-testid^="sidebar-updates-badge-"]:not(:has([data-icon="Loading"])) {
    display: none !important;
}

/* Thread measure: BB currently uses this utility on both the timeline column
   and its composer footer. Scope to thread windows so settings/home stay native.
   Use a named container: BB's nested page containers must not determine the
   breakpoints, and a wide viewport must not widen a narrow split pane.
   max-width (rather than width) preserves narrow panes and mobile layouts. */
[data-thread-window] {
    container-type: inline-size;
    container-name: bb-compact-thread;
}

[data-thread-window] [class~="max-w-[760px]"] {
    max-width: 760px !important;
}

@container bb-compact-thread (min-width: 1080px) {
    [data-thread-window] [class~="max-w-[760px]"] {
        max-width: 1080px !important;
    }
}

@container bb-compact-thread (min-width: 1440px) {
    [data-thread-window] [class~="max-w-[760px]"] {
        max-width: 1440px !important;
    }
}

/* Markdown tables deliberately break out of the native column. BB writes this
   variable inline on each breakout wrapper as it measures available room.
   Override it there, not on an ancestor, so resize measurements cannot undo the
   cap. 100% means the local text column; BB's inner table retains x scrolling. */
[data-thread-window] [style*="--md-table-breakout-max"] {
    --md-table-breakout-max: 100% !important;
}

/* Composer density shares the same sheet as the thread measure above. */
[data-promptbox-action-row] {
    padding: 0 0.25rem;
}

[data-promptbox-editor-scroll] {
    max-height: calc(30dvh - 3rem) !important;
    padding-top: 0.25rem !important;
}
`;
      document.head.append(style);
      return () => style.remove();
    },
  });
});
