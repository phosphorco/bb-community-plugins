import * as Popover from "@radix-ui/react-popover";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";

import {
  useComposer,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";

import type { StoredAnnotation } from "@/lib/afs.ts";
import {
  AGENTATION_MENTION_PROVIDER,
  encodeAgentationAttachment,
  MAX_ATTACHED_ANNOTATIONS,
} from "@/lib/attachment.ts";
import { createRealtimeRefreshGate } from "@/lib/public-loop.ts";
import {
  getAttachedAnnotationSnapshot,
  markAttachedAnnotationIds,
  subscribeToDrafts,
} from "@/lib/draft-attachments.ts";
import {
  createLatestRequestGate,
  selectExactStagedIds,
  snapshotSelection,
} from "@/lib/composer-state.ts";
import type { rpcContract } from "@/server.ts";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";

function annotationLabel(annotation: StoredAnnotation): string {
  return (
    annotation.bb.routeLabel ??
    annotation.bb.route ??
    annotation.element ??
    "Untitled annotation"
  );
}

function annotationComment(annotation: StoredAnnotation): string {
  const comment = annotation.comment.replace(/\s+/g, " ").trim();
  return comment.length > 140 ? `${comment.slice(0, 137)}…` : comment;
}

function annotationContext(annotation: StoredAnnotation): string {
  return [annotation.bb.pluginId, annotation.bb.surface, annotation.element]
    .filter(Boolean)
    .join(" · ");
}

export function AgentationPromptAction() {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const view = useComposerView();
  const realtimeConnection = useRealtimeConnectionState();
  const refreshGate = useRef(createRealtimeRefreshGate());
  const requestGate = useRef(createLatestRequestGate());
  const selectionInitialized = useRef(false);
  const removeSelectedRef = useRef<HTMLButtonElement>(null);
  const restoreFocusAfterConfirmation = useRef(false);
  const popoverId = useId();
  const popoverTitleId = useId();
  const confirmationId = useId();
  const [annotations, setAnnotations] = useState<StoredAnnotation[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [confirmedDiscardIds, setConfirmedDiscardIds] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const attachedAnnotationSnapshot = useSyncExternalStore(
    subscribeToDrafts,
    () => getAttachedAnnotationSnapshot(view.scope),
  );
  const attachedAnnotationIds = useMemo(
    () => new Set<string>(JSON.parse(attachedAnnotationSnapshot) as string[]),
    [attachedAnnotationSnapshot],
  );

  const refresh = useCallback(async () => {
    const request = requestGate.current.issue();
    try {
      const result = await rpc.call("listStagedAnnotations");
      if (!requestGate.current.isLatest(request)) return;
      setAnnotations(result.annotations);
      setSelectedIds((current) => {
        const availableIds = new Set(
          result.annotations
            .filter((annotation) => !attachedAnnotationIds.has(annotation.id))
            .map((annotation) => annotation.id),
        );
        if (!selectionInitialized.current) {
          selectionInitialized.current = true;
          return new Set(
            result.annotations
              .filter((annotation) => !attachedAnnotationIds.has(annotation.id))
              .slice(0, MAX_ATTACHED_ANNOTATIONS)
              .map((annotation) => annotation.id),
          );
        }
        return new Set([...current].filter((id) => availableIds.has(id)));
      });
    } catch {
      // Keep the last confirmed list through transient RPC failures. The next
      // realtime event or reconnect will retry the read.
    } finally {
      if (requestGate.current.isLatest(request)) setIsLoading(false);
    }
  }, [attachedAnnotationIds, rpc]);

  useEffect(() => () => {
    requestGate.current.invalidate();
    refreshGate.current = createRealtimeRefreshGate();
  }, []);

  useEffect(() => {
    if (refreshGate.current.observe(realtimeConnection)) void refresh();
  }, [realtimeConnection, refresh]);

  useRealtime("annotations", useCallback(() => void refresh(), [refresh]));

  useEffect(() => {
    if (annotations.length === 0) {
      setOpen(false);
      setConfirmedDiscardIds(null);
    }
  }, [annotations.length]);

  useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set(
        [...current].filter((id) => !attachedAnnotationIds.has(id)),
      );
      return next.size === current.size ? current : next;
    });
  }, [attachedAnnotationIds]);

  useEffect(() => {
    if (!confirmedDiscardIds) return;
    const availableIds = new Set(
      annotations
        .filter((annotation) => !attachedAnnotationIds.has(annotation.id))
        .map((annotation) => annotation.id),
    );
    if (confirmedDiscardIds.some((id) => !availableIds.has(id))) {
      restoreFocusAfterConfirmation.current = true;
      setConfirmedDiscardIds(null);
    }
  }, [annotations, attachedAnnotationIds, confirmedDiscardIds]);

  useEffect(() => {
    if (confirmedDiscardIds || !restoreFocusAfterConfirmation.current) return;
    restoreFocusAfterConfirmation.current = false;
    if (removeSelectedRef.current) removeSelectedRef.current.focus();
    else composer.focus();
  }, [confirmedDiscardIds, composer, annotations]);

  const toggleSelected = (annotationId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(annotationId)) {
        next.delete(annotationId);
      } else if (next.size >= MAX_ATTACHED_ANNOTATIONS) {
        toast.info(
          `A prompt can include up to ${MAX_ATTACHED_ANNOTATIONS} annotations.`,
        );
        return current;
      } else {
        next.add(annotationId);
      }
      return next;
    });
  };

  const availableAnnotations = annotations.filter(
    (annotation) => !attachedAnnotationIds.has(annotation.id),
  );

  const selectAll = () => {
    setSelectedIds(
      new Set(
        availableAnnotations
          .slice(0, MAX_ATTACHED_ANNOTATIONS)
          .map((annotation) => annotation.id),
      ),
    );
  };

  const addAnnotations = async () => {
    if (isAdding || selectedIds.size === 0) return;
    setIsAdding(true);
    const addRequest = requestGate.current.issue();
    try {
      const result = await rpc.call("listStagedAnnotations");
      if (!requestGate.current.isLatest(addRequest)) {
        toast.info("Feedback changed. Review the current selection before adding it.");
        return;
      }
      const selected = selectExactStagedIds(
        result.annotations,
        annotations,
        selectedIds,
        attachedAnnotationIds,
      );
      if (!selected) {
        await refresh();
        setSelectedIds(new Set());
        toast.info("Feedback changed. Review the current selection before adding it.");
        return;
      }
      composer.insertMention({
        provider: AGENTATION_MENTION_PROVIDER,
        id: encodeAgentationAttachment({
          annotationIds: selected,
        }),
        label: `${selected.length} annotation${selected.length === 1 ? "" : "s"}`,
      });
      markAttachedAnnotationIds(view.scope, selected);
      setOpen(false);
      composer.focus();
    } catch (cause) {
      toast.error("Could not add Agentation feedback", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setIsAdding(false);
    }
  };

  const discardAnnotations = async () => {
    if (isDiscarding || !confirmedDiscardIds?.length) return;
    setIsDiscarding(true);
    try {
      const result = await rpc.call("discardStagedAnnotations", {
        annotationIds: confirmedDiscardIds,
      });
      if (result.outcome === "stale") {
        toast.info("Some feedback changed; the staged list was refreshed.");
      } else {
        toast.success(result.message);
      }
      await refresh();
      restoreFocusAfterConfirmation.current = true;
      setConfirmedDiscardIds(null);
    } catch (cause) {
      toast.error("Could not remove staged feedback", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setIsDiscarding(false);
    }
  };

  if (isLoading || availableAnnotations.length === 0) return null;

  const selectedCount = selectedIds.size;
  const countLabel = `${availableAnnotations.length} staged annotation${availableAnnotations.length === 1 ? "" : "s"}`;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setConfirmedDiscardIds(null);
      }}
    >
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-muted-foreground data-[state=open]:bg-state-active data-[state=open]:text-foreground"
          disabled={isAdding || isDiscarding || view.run.isSubmitting}
          aria-label={`Choose Agentation feedback (${countLabel})`}
          aria-haspopup="dialog"
          aria-controls={popoverId}
          data-testid="agentation-composer-action"
        >
          <Icon name="ChatFeedback" className="h-4 w-4" aria-hidden="true" />
          <span>{availableAnnotations.length}</span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          id={popoverId}
          role="dialog"
          aria-labelledby={popoverTitleId}
          align="end"
          side="top"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-[min(24rem,calc(100vw-2rem))] rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none"
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id={popoverTitleId} className="text-sm font-medium">
                  Add feedback
                </h2>
                <p className="text-xs text-muted-foreground">{countLabel}</p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {selectedCount}/{MAX_ATTACHED_ANNOTATIONS} selected
              </span>
            </div>

            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={confirmedDiscardIds !== null}
                onClick={selectAll}
              >
                Select all
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={confirmedDiscardIds !== null}
                onClick={() => setSelectedIds(new Set())}
              >
                Select none
              </Button>
            </div>

            <fieldset
              className="max-h-64 overflow-y-auto rounded-md border border-border"
              disabled={confirmedDiscardIds !== null}
            >
              <legend className="sr-only">Staged feedback</legend>
              {availableAnnotations.map((annotation) => {
                const context = annotationContext(annotation);
                return (
                  <label
                    key={annotation.id}
                    className="flex cursor-pointer gap-2 border-b border-border p-2.5 last:border-b-0 hover:bg-state-hover"
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(annotation.id)}
                      onChange={() => toggleSelected(annotation.id)}
                      className="mt-0.5 size-4 shrink-0 accent-primary"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium">
                        {annotationLabel(annotation)}
                      </span>
                      {context ? (
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {context}
                        </span>
                      ) : null}
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {annotationComment(annotation) || "No comment"}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>

            {confirmedDiscardIds ? (
              <div
                className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5"
                role="group"
                aria-labelledby={confirmationId}
              >
                <p id={confirmationId} className="text-xs">
                  Remove {confirmedDiscardIds.length} selected feedback item{confirmedDiscardIds.length === 1 ? "" : "s"} from staging? It will remain in
                  history as dismissed.
                </p>
                <div className="mt-2 flex justify-end gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    autoFocus
                    onClick={() => {
                      restoreFocusAfterConfirmation.current = true;
                      setConfirmedDiscardIds(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    className="h-7 px-2 text-xs"
                    disabled={isDiscarding || confirmedDiscardIds.length === 0}
                    onClick={() => void discardAnnotations()}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <Button
                  ref={removeSelectedRef}
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  disabled={selectedCount === 0 || isDiscarding || isAdding}
                  onClick={() => setConfirmedDiscardIds(snapshotSelection(selectedIds))}
                >
                  Remove selected
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={
                    selectedCount === 0 || isAdding || isDiscarding || view.run.isSubmitting
                  }
                  onClick={() => void addAnnotations()}
                >
                  Add {selectedCount || "selected"}
                </Button>
              </div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
