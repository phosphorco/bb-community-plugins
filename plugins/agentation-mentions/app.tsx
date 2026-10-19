// Agentation → Mentions — based on Agentation by Scott Sunarto at 8bc27b91333e2228607b137d09b195d90e6aecfa.
//
// Three surfaces, one job:
// - a content script that mounts the Agentation toolbar over the bb app shell,
//   so every route and every plugin-drawn element can be annotated;
// - a prompt action that attaches staged feedback as a native mention;
// - the current upstream review panel for triage, replies, and outcomes.
import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { AgentationSettingsSection } from "@/components/settings-section.tsx";
import {
  AnnotationPanel,
  AnnotationPanelHeader,
} from "@/components/annotation-panel.tsx";
import {
  AgentationPromptAction,
} from "@/components/annotation-prompt-action.tsx";
import { observeAttachedAnnotationIds } from "@/lib/draft-attachments.ts";
import {
  AGENTATION_MENTION_PROVIDER,
  decodeAgentationAttachment,
} from "@/lib/attachment.ts";
import { mountAnnotationToolbar } from "@/lib/toolbar.ts";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "annotation-toolbar",
    mount: mountAnnotationToolbar,
  });

  app.composer.customize({
    id: "agentation-mentions",
    scopes: ["thread"],
    actions: [{ id: "add-annotations", component: AgentationPromptAction }],
    richText: {
      onDraftChange(draft, view) {
        const attachedAnnotationIds = new Set<string>();
        for (const mention of draft.mentions) {
          if (
            mention.provider !== AGENTATION_MENTION_PROVIDER &&
            !mention.provider.endsWith(`:${AGENTATION_MENTION_PROVIDER}`)
          ) {
            continue;
          }
          try {
            for (const annotationId of decodeAgentationAttachment(mention.id)
              .annotationIds) {
              attachedAnnotationIds.add(annotationId);
            }
          } catch {
            // Keep malformed legacy mentions attached, but do not use them to
            // filter individual current annotations from the prompt action.
          }
        }
        observeAttachedAnnotationIds(view.scope, attachedAnnotationIds);
      },
    },
  });

  app.slots.navPanel({
    id: "annotations",
    title: "Agentation → Mentions",
    icon: "ChatFeedback",
    path: "annotations",
    component: AnnotationPanel,
    headerContent: AnnotationPanelHeader,
  });

  app.slots.settingsSection({
    id: "about",
    title: "How this works",
    component: AgentationSettingsSection,
  });
});
