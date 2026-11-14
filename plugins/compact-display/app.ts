import "./thread-width.css";
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

/* Thread measure lives in thread-width.css, also the native appearance theme. */
/* Composer density retains its app-lifecycle stylesheet. */
[data-promptbox-action-row] {
    padding: 0 0.25rem;
}

[data-promptbox-editor-scroll] {
    /* The keyboard can shrink the visual viewport without shrinking dvh.
       Respect BB's corrected shell height and its tighter home-editor budget;
       otherwise a long draft can push the composer above the visible area. */
    max-height: min(
        calc(30dvh - 3rem),
        calc(var(--bb-shell-height, 100dvh) * 0.3 - 3rem),
        var(--composer-editor-available-height, 100dvh)
    ) !important;
    padding-top: 0.25rem !important;
}

/* Keep typing controls legible before focus as well as during it. Cover touch
   devices in landscape and narrow WebViews even if pointer detection differs.
   Apply across the app, including plugin forms and editors mounted later.
   Exclude non-typing input controls; keep larger inherited text sizes. */
@media (any-pointer: coarse), (max-width: 767px) {
    :where(
        input:not([type="button"], [type="checkbox"], [type="color"],
            [type="file"], [type="hidden"], [type="image"], [type="radio"],
            [type="range"], [type="reset"], [type="submit"]),
        textarea,
        select,
        [contenteditable=""],
        [contenteditable="true" i],
        [contenteditable="plaintext-only" i]
    ) {
        font-size: max(16px, 1em) !important;
    }
}
`;
      document.head.append(style);
      return () => style.remove();
    },
  });
});
