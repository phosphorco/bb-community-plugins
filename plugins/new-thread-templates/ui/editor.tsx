import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  validateDefinition,
  type TemplateDefinition,
  type ValidationIssue,
} from "../model.ts";
import {
  readEditorCheckpoint,
  writeEditorCheckpoint,
  removeEditorCheckpoint,
  unfinishedNumericText,
  definitionFingerprint,
  matchesEditorBaseline,
  matchesEditorWork,
  type NumericText,
} from "./editor-checkpoint.ts";
import { FIELD_TYPES, FieldsEditor, TextField } from "./fields.tsx";

import { PromptWorkbench } from "./prompt-workbench.tsx";

type Tab = "Fields" | "Destination" | "Model" | "Prompt";
const tabs: Tab[] = ["Fields", "Destination", "Model", "Prompt"];
export function TemplateEditor({
  initial,
  checkpointOwner,
  checkpointGeneration,
  restored,
  onRestoreGeneration,
  publishedRevision,
  renderDestination,
  renderModel,
  onSave,
  onPublish,
  onBack,
  onRemove,
  navigationRequest,
  saving,
  error,
}: {
  initial: TemplateDefinition;
  checkpointOwner: string;
  checkpointGeneration: number | null;
  restored?: import("./editor-checkpoint.ts").EditorCheckpoint | null;
  onRestoreGeneration(generation: number | null): void;
  publishedRevision: number;
  renderDestination(
    definition: TemplateDefinition,
    change: (next: TemplateDefinition) => void,
  ): ReactNode;
  renderModel(
    definition: TemplateDefinition,
    change: (next: TemplateDefinition) => void,
  ): ReactNode;
  onSave(
    definition: TemplateDefinition,
  ): Promise<{ generation: number } | false>;
  onPublish(
    definition: TemplateDefinition,
  ): Promise<{ generation: number } | false>;
  onBack(): void;
  onRemove(definition: TemplateDefinition): Promise<boolean>;
  navigationRequest?: { id: string; go(): void; cancel(): void } | null;
  saving: boolean;
  error: string | null;
}) {
  const [definition, setDefinition] = useState(restored?.definition ?? initial),
    [baseline, setBaseline] = useState(
      restored?.baseline ?? definitionFingerprint(initial),
    );
  const [tab, setTab] = useState<Tab>("Fields");
  const [checkpoint, setCheckpoint] = useState(() =>
    restored
      ? { value: null, error: null }
      : readEditorCheckpoint(checkpointOwner, initial.id),
  );
  const [checkpointError, setCheckpointError] = useState<string | null>(
    checkpoint.error,
  );
  const [issues, setIssues] = useState<ValidationIssue[]>([]),
    [leave, setLeave] = useState(false),
    [status, setStatus] = useState("");
  const [numericText, setNumericText] = useState<NumericText>(
    restored?.numericText ?? {},
  );
  const [numericFocus, setNumericFocus] = useState<string | null>(null);
  const numericRef = useRef(numericText),
    definitionRef = useRef(definition),
    editVersion = useRef(0),
    active = useRef(true);
  numericRef.current = numericText;
  definitionRef.current = definition;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const incomplete = unfinishedNumericText(numericText);
  const dirty =
    !matchesEditorBaseline(definition, baseline) ||
    Object.keys(numericText).length > 0;
  const root = useRef<HTMLDivElement>(null),
    pendingNavigation = useRef<(() => void) | null>(null),
    previousFocus = useRef<HTMLElement | null>(null),
    pendingCancel = useRef<(() => void) | null>(null);
  const change = (
    next: TemplateDefinition,
    numbers: NumericText = numericText,
  ) => {
    setCheckpointError(
      writeEditorCheckpoint(
        checkpointOwner,
        next,
        baseline,
        checkpointGeneration,
        numbers,
      ),
    );
    definitionRef.current = next;
    numericRef.current = numbers;
    editVersion.current++;
    setDefinition(next);
    setNumericText(numbers);
    setNumericFocus(null);
    setIssues((previous) =>
      previous.length ? validateDefinition(next) : previous,
    );
    setStatus("");
  };
  const requestLeave = (next: () => void, cancel?: () => void) => {
    if (!dirty) {
      next();
      return;
    }
    previousFocus.current = document.activeElement as HTMLElement;
    pendingNavigation.current = next;
    pendingCancel.current = cancel ?? null;
    setLeave(true);
  };
  useEffect(() => {
    if (navigationRequest)
      requestLeave(navigationRequest.go, navigationRequest.cancel);
  }, [navigationRequest?.id]);
  useEffect(() => {
    if (!dirty) return;
    const anchor = (event: MouseEvent) => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (
        !target ||
        root.current?.contains(target) ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        target.target === "_blank"
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      requestLeave(() => {
        window.location.assign(target.href);
      });
    };
    document.addEventListener("click", anchor, true);
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", anchor, true);
    };
  }, [dirty, definition, baseline]);
  useEffect(() => {
    if (!leave) return;
    const dialog = root.current?.querySelector<HTMLElement>("[role=dialog]");
    dialog?.querySelector<HTMLElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setLeave(false);
        pendingCancel.current?.();
        previousFocus.current?.focus();
      }
      if (event.key === "Tab" && dialog) {
        const items = [
          ...dialog.querySelectorAll<HTMLElement>("button:not(:disabled)"),
        ];
        const first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [leave]);
  const checkNumbers = () => {
    if (!incomplete) return true;
    setTab("Fields");
    setNumericFocus(incomplete[0]);
    setStatus("Complete the unfinished number before saving or publishing.");
    return false;
  };
  const acknowledge = (
    snapshot: TemplateDefinition,
    numbers: NumericText,
    version: number,
    generation: number,
  ) => {
    const nextBaseline = definitionFingerprint(snapshot);
    setBaseline(nextBaseline);
    if (editVersion.current === version) {
      setCheckpointError(
        removeEditorCheckpoint(checkpointOwner, snapshot, numbers),
      );
      setNumericText({});
      numericRef.current = {};
    } else {
      const current = readEditorCheckpoint(checkpointOwner, snapshot.id);
      if (current.error) setCheckpointError(current.error);
      else if (
        current.value &&
        !matchesEditorWork(
          current.value,
          definitionRef.current,
          numericRef.current,
        )
      )
        setCheckpointError("A newer local editor checkpoint was retained.");
      else
        setCheckpointError(
          writeEditorCheckpoint(
            checkpointOwner,
            definitionRef.current,
            nextBaseline,
            generation,
            numericRef.current,
          ),
        );
    }
    setStatus("");
  };
  const save = async () => {
    if (!checkNumbers()) return false;
    const snapshot = structuredClone(definition),
      numbers = structuredClone(numericText),
      version = editVersion.current;
    const result = await onSave(snapshot);
    if (result && active.current) {
      acknowledge(snapshot, numbers, version, result.generation);
      return editVersion.current === version;
    }
    return false;
  };
  const publish = async () => {
    if (!checkNumbers()) return;
    const invalid = [
      ...(root.current?.querySelectorAll<HTMLInputElement>("input:invalid") ??
        []),
    ].find((input) => !input.closest(".ntt-prompt-preview"));
    if (invalid) {
      invalid.reportValidity();
      invalid.focus();
      setStatus("Correct the invalid field before publishing.");
      return;
    }
    const errors = validateDefinition(definition);
    setIssues(errors);
    setStatus("");
    if (errors.length) {
      const first = errors[0]!.path;
      if (first.startsWith("fields")) setTab("Fields");
      else if (first.startsWith("destination")) setTab("Destination");
      else if (first.startsWith("execution")) setTab("Model");
      else if (first.includes("Template")) setTab("Prompt");
      requestAnimationFrame(() =>
        root.current
          ?.querySelector<HTMLElement>("[data-definition-errors]")
          ?.focus(),
      );
      return;
    }
    const snapshot = structuredClone(definition),
      numbers = structuredClone(numericText),
      version = editVersion.current;
    const result = await onPublish(snapshot);
    if (result && active.current)
      acknowledge(snapshot, numbers, version, result.generation);
  };
  type PromptTarget = "titleTemplate" | "promptTemplate";
  const promptElements = useRef<
    Partial<Record<PromptTarget, HTMLInputElement | HTMLTextAreaElement>>
  >({});
  const promptSelection = useRef<{
    target: PromptTarget;
    start: number;
    end: number;
  } | null>(null);
  const selectPrompt = (
    target: PromptTarget,
    element: HTMLInputElement | HTMLTextAreaElement,
  ) => {
    promptSelection.current = {
      target,
      start: element.selectionStart ?? element.value.length,
      end: element.selectionEnd ?? element.value.length,
    };
  };
  const keyIssues = validateDefinition(definition).filter((issue) =>
    /^fields\.\d+\.key$/.test(issue.path),
  );
  const placeholders = definition.fields
    .filter(
      (field, index) =>
        !keyIssues.some((issue) => issue.path === `fields.${index}.key`) &&
        definition.fields.filter((other) => other.key === field.key).length ===
          1,
    )
    .sort((a, b) => a.order - b.order);
  const insertPlaceholder = (key: string) => {
    const target = promptSelection.current?.target ?? "promptTemplate";
    const element = promptElements.current[target];
    if (!element) return;
    const text = definition[target],
      selection = promptSelection.current;
    const start = Math.min(selection?.start ?? text.length, text.length),
      end = Math.max(
        start,
        Math.min(selection?.end ?? text.length, text.length),
      );
    const token = `{{${key}}}`,
      caret = start + token.length;
    change({
      ...definition,
      [target]: text.slice(0, start) + token + text.slice(end),
    });
    promptSelection.current = { target, start: caret, end: caret };
    requestAnimationFrame(() => {
      if (!active.current || !root.current?.contains(element)) return;
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  };
  return (
    <div className="ntt-stack" ref={root}>
      <div className="ntt-row ntt-between">
        <button
          type="button"
          className="ntt-link"
          onClick={() => requestLeave(onBack)}
        >
          ‹ All templates
        </button>
        <span className="ntt-help">
          {publishedRevision
            ? `Published revision ${publishedRevision} · editing shared draft`
            : "Shared draft · not published"}
          {dirty ? " · unsaved changes" : ""}
        </span>
      </div>
      <h2>{definition.name || "New template"}</h2>
      <div className="ntt-columns">
        <TextField
          id="template-name"
          label="Name"
          value={definition.name}
          onChange={(name) => change({ ...definition, name })}
        />
        <TextField
          label="Description"
          value={definition.description}
          onChange={(description) => change({ ...definition, description })}
        />
      </div>
      {checkpointError && (
        <div className="ntt-alert" role="alert">
          {checkpointError}
        </div>
      )}
      {checkpoint.value && (
        <section
          className="ntt-status ntt-stack"
          aria-label="Unfinished editor work"
        >
          <p>
            Unfinished edits from your previous visit are available. Restoring
            them does not save or publish the shared template.
          </p>
          <div className="ntt-row">
            <button
              type="button"
              className="ntt-button"
              disabled={saving}
              onClick={() => {
                const saved = checkpoint.value!;
                definitionRef.current = saved.definition;
                numericRef.current = saved.numericText ?? {};
                editVersion.current++;
                setDefinition(saved.definition);
                setNumericText(saved.numericText ?? {});
                setBaseline(saved.baseline);
                onRestoreGeneration(saved.generation);
                setCheckpoint({ value: null, error: null });
              }}
            >
              Restore unfinished edits
            </button>
            <button
              type="button"
              className="ntt-button"
              onClick={() => {
                setCheckpointError(
                  removeEditorCheckpoint(
                    checkpointOwner,
                    checkpoint.value!.definition,
                    checkpoint.value!.numericText,
                  ),
                );
                setCheckpoint({ value: null, error: null });
              }}
              disabled={saving}
            >
              Discard unfinished edits
            </button>
          </div>
        </section>
      )}
      {error && (
        <div className="ntt-alert" role="alert">
          {error}
        </div>
      )}
      {status && (
        <p className="ntt-status" role="status">
          {status}
        </p>
      )}
      {issues.length > 0 && (
        <div
          className="ntt-alert"
          role="alert"
          tabIndex={-1}
          data-definition-errors
        >
          {issues.map((issue, i) => (
            <p key={i}>
              {issue.path}: {issue.message}
            </p>
          ))}
        </div>
      )}
      <div className="ntt-tabs" role="tablist" aria-label="Template editor">
        {tabs.map((name, i) => (
          <button
            type="button"
            key={name}
            id={`ntt-tab-${name}`}
            aria-controls={`ntt-panel-${name}`}
            role="tab"
            tabIndex={tab === name ? 0 : -1}
            aria-selected={tab === name}
            className="ntt-tab"
            onClick={() => setTab(name)}
            onKeyDown={(e) => {
              const delta =
                e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (delta) {
                e.preventDefault();
                const next = tabs[(i + delta + tabs.length) % tabs.length]!;
                setTab(next);
                document.getElementById(`ntt-tab-${next}`)?.focus();
              }
              if (e.key === "Home" || e.key === "End") {
                e.preventDefault();
                const next = e.key === "Home" ? tabs[0]! : tabs.at(-1)!;
                setTab(next);
                document.getElementById(`ntt-tab-${next}`)?.focus();
              }
            }}
          >
            {name === "Destination" ? "Project" : name}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id={`ntt-panel-${tab}`}
        aria-labelledby={`ntt-tab-${tab}`}
        className="ntt-stack"
      >
        {tab === "Fields" && (
          <>
            <FieldsEditor
              fields={definition.fields}
              numericText={numericText}
              focusPath={numericFocus}
              onChange={(fields, numbers) =>
                change({ ...definition, fields }, numbers)
              }
            />
          </>
        )}
        {tab === "Destination" && renderDestination(definition, change)}
        {tab === "Model" && renderModel(definition, change)}
        <div hidden={tab !== "Prompt"}>
          <PromptWorkbench
            definition={definition}
            revision={publishedRevision}
            incomplete={!!incomplete}
            onChange={change}
            source={
              <>
                <p className="ntt-help">
                  Use {"{{field_key}}"} or {"{{field_key|fallback}}"}. Unknown
                  tokens block publication.
                </p>
                <div
                  className="ntt-placeholders"
                  role="group"
                  aria-label="Field placeholders"
                >
                  {placeholders.map((field) => (
                    <button
                      key={field.key}
                      type="button"
                      className="ntt-token"
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => insertPlaceholder(field.key)}
                    >
                      <code>{`{{${field.key}}}`}</code>
                      <span>
                        {field.label || field.key} ·{" "}
                        {
                          FIELD_TYPES.find((type) => type.value === field.type)
                            ?.label
                        }
                      </span>
                    </button>
                  ))}
                </div>
                {keyIssues.length > 0 && (
                  <p className="ntt-error">
                    Fix field keys in Fields:{" "}
                    {keyIssues
                      .map(
                        (issue) =>
                          `${definition.fields[Number(issue.path.split(".")[1])]?.label || "Unnamed field"}: ${issue.message}`,
                      )
                      .join("; ")}
                  </p>
                )}
                <TextField
                  label="Thread title template"
                  elementRef={(element) => {
                    if (element) promptElements.current.titleTemplate = element;
                    else delete promptElements.current.titleTemplate;
                  }}
                  onSelection={(element) =>
                    selectPrompt("titleTemplate", element)
                  }
                  value={definition.titleTemplate}
                  onChange={(titleTemplate) =>
                    change({ ...definition, titleTemplate })
                  }
                />
                <TextField
                  label="First message template"
                  elementRef={(element) => {
                    if (element)
                      promptElements.current.promptTemplate = element;
                    else delete promptElements.current.promptTemplate;
                  }}
                  onSelection={(element) =>
                    selectPrompt("promptTemplate", element)
                  }
                  multiline
                  value={definition.promptTemplate}
                  onChange={(promptTemplate) =>
                    change({ ...definition, promptTemplate })
                  }
                />
              </>
            }
          />
        </div>
      </section>
      <div className="ntt-footer">
        <div className="ntt-row">
          <button
            type="button"
            className="ntt-link"
            disabled={saving}
            onClick={async () => {
              if (
                !window.confirm(
                  "Remove this template? Historical launches remain available in History.",
                )
              )
                return;
              if (await onRemove(structuredClone(definition))) {
                setCheckpointError(
                  removeEditorCheckpoint(
                    checkpointOwner,
                    definition,
                    numericText,
                  ),
                );
                onBack();
              }
            }}
          >
            Remove
          </button>
          <button
            type="button"
            className="ntt-button"
            disabled={saving}
            onClick={() => void save()}
          >
            Save draft
          </button>
          <button
            type="button"
            className="ntt-button ntt-primary"
            disabled={saving}
            onClick={() => void publish()}
          >
            Publish
          </button>
        </div>
      </div>
      {leave && (
        <div className="ntt-dialog">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="ntt-leave-title"
            className="ntt-stack"
          >
            <h3 id="ntt-leave-title">Unsaved template changes</h3>
            <p>Save this shared draft before leaving?</p>
            <div className="ntt-row">
              <button
                type="button"
                className="ntt-button"
                onClick={() => {
                  setLeave(false);
                  pendingCancel.current?.();
                  previousFocus.current?.focus();
                }}
              >
                Stay
              </button>
              <button
                type="button"
                className="ntt-button"
                disabled={saving}
                onClick={() => {
                  setCheckpointError(
                    removeEditorCheckpoint(
                      checkpointOwner,
                      definition,
                      numericText,
                    ),
                  );
                  setLeave(false);
                  pendingNavigation.current?.();
                }}
              >
                Discard changes
              </button>
              <button
                type="button"
                className="ntt-button ntt-primary"
                disabled={saving}
                onClick={async () => {
                  if (await save()) {
                    setLeave(false);
                    pendingNavigation.current?.();
                  }
                }}
              >
                Save and leave
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
