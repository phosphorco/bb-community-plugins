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
