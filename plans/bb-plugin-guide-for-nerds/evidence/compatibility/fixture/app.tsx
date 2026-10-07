import { useState } from "react";
import { createPortal } from "react-dom";
import { definePluginApp, experimental_Icon, useSdk } from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils";
import { Switch } from "./components/ui/switch";
import { PluginBrandIcon } from "./components/ui/plugin-icon";
const Icon = experimental_Icon;
function Overlay() {
  const sdk = useSdk();
  const [opened, setOpened] = useState(false);
  return createPortal(<button className={cn("text-foreground")} onClick={() => {
    setOpened(!opened); void import("./lazy").then(module => module.readMarker()); void sdk;
  }}><Icon name="Zap" /><Switch checked={opened} /><PluginBrandIcon icon="Zap" iconUrl={null} iconTinted={false} />probe</button>, document.body);
}
export default definePluginApp(app => {
  app.slots.sidebarFooterAction({id:"probe", title:"Probe", icon:"Zap", run(){}});
  app.slots.experimental_appOverlay({id:"probe-overlay", component:Overlay});
});
