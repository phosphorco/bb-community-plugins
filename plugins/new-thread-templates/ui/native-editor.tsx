import {
  experimental_NewThreadComposer as NewThreadComposer,
  type NewThreadComposerProps,
} from "@get-bb/plugin-sdk/app";

/** BB owns the complete editor, mention completion, attachments, and all execution controls. */
export function NativeTemplateEditor({
  draftKey,
  seed,
  revision,
  originChanged,
  replacedInAnotherView,
  reopened,
  onSubmit,
  onBack,
  onReset,
}: {
  draftKey: string;
  seed: Pick<
    NewThreadComposerProps,
    | "defaultProjectId"
    | "defaultProviderId"
    | "defaultModel"
    | "defaultReasoningLevel"
    | "defaultServiceTier"
    | "defaultPermissionMode"
    | "defaultEnvironment"
    | "initialPrompt"
  >;
  revision: number;
  originChanged: boolean;
  replacedInAnotherView: boolean;
  reopened: boolean;
  onSubmit: NewThreadComposerProps["onSubmit"];
  onBack(): void;
  onReset(): void;
}) {
  return (
    <section className="ntt-stack" aria-label="Edit with BB">
      <div className="ntt-row ntt-between">
        <button type="button" className="ntt-link" onClick={onBack}>
          ‹ Back to form
        </button>
        <button type="button" className="ntt-link" onClick={onReset}>
          Reset to generated prompt
        </button>
      </div>
      <div>
        <h3>Edit with BB</h3>
        <p className="ntt-help">
          Started from template revision {revision}. The project, environment,
          model, and permission choices below determine where this edited
          request runs.
        </p>
      </div>
      {replacedInAnotherView && (
        <p className="ntt-status">
          Another view saved a different BB editor draft. This editor keeps your
          open draft.
        </p>
      )}
      {originChanged && (
        <p className="ntt-status">
          The form has changed. This editor keeps its existing draft and
          original template inputs. Reset explicitly to start from the updated
          form.
        </p>
      )}
      {reopened && (
        <p className="ntt-help">
          Text and attachments saved. Recheck destination and run settings after
          reopening.
        </p>
      )}
      <NewThreadComposer
        {...seed}
        draftKey={draftKey}
        layout="document"
        className="ntt-native-composer"
        onSubmit={onSubmit}
      />
    </section>
  );
}

/** Native prompt/attachment persistence is isolated from the main freeform draft and every other actor. */
export function nativeEditorDraftKey(
  instanceId: string,
  actor: string,
  templateId: string,
  revision: number,
  editorDraftId: string,
): string {
  return `new-thread-templates/native/${encodeURIComponent(JSON.stringify([instanceId, actor, templateId, revision, editorDraftId]))}`;
}
