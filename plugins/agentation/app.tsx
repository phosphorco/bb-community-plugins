// @smsunarto/bb-plugin-agentation — frontend entry.
//
// Two surfaces, one job:
// - a content script that mounts the Agentation toolbar over the bb app shell,
//   so every route and every plugin-drawn element can be annotated;
// - a prompt action that shows the live staged count and attaches that feedback
//   as a native mention, resolved into durable agent context at submission.
import "./app.css";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  useComposer,
  useComposerView,
  useRealtime,
  useRpc,
} from "@bb/plugin-sdk/app";
import { toast } from "sonner";

import { AgentationSettingsSection } from "@/components/settings-section.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import {
  AGENTATION_MENTION_PROVIDER,
  encodeAgentationAttachment,
  MAX_ATTACHED_ANNOTATIONS,
} from "@/lib/attachment.ts";
import { mountAnnotationToolbar } from "@/lib/toolbar.ts";
import type { rpcContract } from "@/server.ts";

const attachedScopes = new Set<string>();
const draftListeners = new Set<() => void>();

function scopeKey(scope: object): string {
  return JSON.stringify(scope);
}

function publishDraftChange(): void {
  for (const listener of draftListeners) listener();
}

function subscribeToDrafts(listener: () => void): () => void {
  draftListeners.add(listener);
  return () => draftListeners.delete(listener);
}

function AgentationPromptAction() {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const view = useComposerView();
  const [count, setCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  useSyncExternalStore(
    subscribeToDrafts,
    () => attachedScopes.has(scopeKey(view.scope)),
  );
  const isAttached = attachedScopes.has(scopeKey(view.scope));

  const refresh = useCallback(async () => {
    try {
      const result = await rpc.call("listStagedAnnotations");
      setCount(result.annotations.length);
    } catch {
      setCount(0);
    } finally {
      setIsLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime("annotations", useCallback(() => void refresh(), [refresh]));

  if (isLoading || count === 0 || isAttached) return null;

  const addAnnotations = async () => {
    if (isAdding) return;
    setIsAdding(true);
    try {
      const result = await rpc.call("listStagedAnnotations");
      const annotations = result.annotations.slice(0, MAX_ATTACHED_ANNOTATIONS);
      if (annotations.length === 0) {
        setCount(0);
        return;
      }
      composer.insertMention({
        provider: AGENTATION_MENTION_PROVIDER,
        id: encodeAgentationAttachment({
          annotationIds: annotations.map((annotation) => annotation.id),
        }),
        label: `${annotations.length} annotation${annotations.length === 1 ? "" : "s"}`,
      });
      composer.focus();
    } catch (cause) {
      toast.error("Could not add Agentation feedback", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-muted-foreground"
      disabled={isAdding || view.run.isSubmitting}
      aria-label={`Add ${count} staged Agentation annotation${count === 1 ? "" : "s"} to this prompt`}
      onClick={() => void addAnnotations()}
    >
      <Icon name="ChatFeedback" className="h-4 w-4" aria-hidden="true" />
      <span>{count}</span>
    </Button>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "annotation-toolbar",
    mount: mountAnnotationToolbar,
  });

  app.composer.customize({
    id: "agentation",
    scopes: ["thread"],
    actions: [{ id: "add-annotations", component: AgentationPromptAction }],
    richText: {
      onDraftChange(draft, view) {
        const key = scopeKey(view.scope);
        const hasAgentationMention = draft.mentions.some(
          (mention) =>
            mention.provider === AGENTATION_MENTION_PROVIDER ||
            mention.provider.endsWith(`:${AGENTATION_MENTION_PROVIDER}`),
        );
        const changed = hasAgentationMention
          ? !attachedScopes.has(key)
          : attachedScopes.has(key);
        if (hasAgentationMention) attachedScopes.add(key);
        else attachedScopes.delete(key);
        if (changed) publishDraftChange();
      },
    },
  });

  app.slots.settingsSection({
    id: "about",
    title: "How this works",
    component: AgentationSettingsSection,
  });
});
