import { definePluginApp } from "@get-bb/plugin-sdk/app";

export default definePluginApp((app) => {
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
