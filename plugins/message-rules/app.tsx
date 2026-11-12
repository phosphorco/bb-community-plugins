import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { MessageRulesBody } from "./ui/message-rules-body.tsx";
import type { Draft } from "./ui/types.ts";
import "./app.css";

export default definePluginApp((app) => {
  const drafts = new Map<string, Draft>();
  function MessageRules(props: PluginNavPanelProps) {
    return <MessageRulesBody {...props} drafts={drafts} />;
  }
  app.slots.navPanel({
    id: "rules",
    title: "Message Rules",
    path: "rules",
    icon: "message-circle",
    component: MessageRules,
  });
  app.slots.settingsSection({
    id: "connection",
    title: "Message Rules",
    component: () => (
      <p>
        JEV uses the shared Topics connection by default. The optional dedicated
        Message Rules JEV API key is used only when explicitly selected in this plugin’s settings. Open
        Message Rules to manage shared groups, host directories, model, and run
        limits. Tests use saved revisions. Explicit configured JEV checks can
        use provider context checking when a verified local counter is
        unavailable; engineering/call limits and no implicit retry still apply.
      </p>
    ),
  });
});
