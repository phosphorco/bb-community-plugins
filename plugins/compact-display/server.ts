import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function compactDisplayPlugin(bb: BbPluginApi): void {
  bb.settings.define({
    hideUpdateReady: {
      type: "boolean",
      label: "Hide update-ready notifications",
      description:
        "Hide the sidebar's update-ready notification. Updates remain available in Settings → Updates.",
      default: true,
    },
  });
}
