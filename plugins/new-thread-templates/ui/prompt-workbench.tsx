import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import {
  useIdentitySession,
  useIdentityViewSnapshot,
} from "@phosphorco/bb-identity/react";
import {
  createRenderContext,
  defaultInputs,
  isValidTimeZone,
  renderText,
  validateInputs,
  validateTemplate,
  type Inputs,
  type InvocationSample,
  type RenderContext,
  type TemplateDefinition,
} from "../model.ts";
import { templatesContract, TEMPLATES_CHANGED } from "../rpc-contract.ts";
import { InputFields } from "./fields.tsx";
import { useMountedRead } from "./read.ts";
import { RenderClock, TimeZoneField } from "./render-clock.tsx";

export function PromptWorkbench({
  definition,
  revision,
  incomplete,
  source,
  onChange,
}: {
  definition: TemplateDefinition;
  revision: number;
  incomplete: boolean;
  source: ReactNode;
  onChange(definition: TemplateDefinition): void;
}) {
  const session = useIdentitySession(),
    view = useIdentityViewSnapshot();
  const owner =
    session.status === "ready" && !(view.status === "ready" && view.overriding)
      ? `${session.instanceId}:${session.actor.identity.key}:${session.stamp}`
      : "";
  // Remount preview-only state at the same owner/template boundary as its reads.
  return (
    <PersonalPromptWorkbench
      key={`${owner}:${definition.id}`}
      definition={definition}
      revision={revision}
      incomplete={incomplete}
      source={source}
      onChange={onChange}
      eligible={!!owner}
      sampleOwner={
        session.status === "ready"
          ? `${session.actor.presentation.displayName}${session.actor.identity.kind === "machine" ? " (machine identity)" : ""}`
          : ""
      }
    />
  );
}
function PersonalPromptWorkbench({
  definition,
  revision,
  incomplete,
  source,
  onChange,
  eligible,
  sampleOwner,
}: {
  definition: TemplateDefinition;
  revision: number;
  incomplete: boolean;
  source: ReactNode;
  onChange(definition: TemplateDefinition): void;
  eligible: boolean;
  sampleOwner: string;
}) {
  const rpc = useRpc<typeof templatesContract>();
  const sampleId = useId();
  const [inputs, setInputs] = useState<Inputs>(() => defaultInputs(definition));
  const [context, setContext] = useState<RenderContext>(() =>
    createRenderContext(
      isValidTimeZone(definition.timeZone ?? "UTC")
        ? definition.timeZone
        : "UTC",
    ),
  );
  const [selected, setSelected] = useState<InvocationSample | null>(null);
  const load = useCallback(
    async () =>
      eligible
        ? rpc.call("recentSamples", { templateId: definition.id })
        : { samples: [] },
    [rpc, eligible, definition.id],
  );
  const recent = useMountedRead(load, TEMPLATES_CHANGED);
  const validation = useMemo(
    () => validateInputs(definition, inputs),
    [definition, inputs],
  );
  const extras = Object.keys(inputs).filter(
    (key) => !definition.fields.some((field) => field.key === key),
  );
  const render = (
    label: string,
    text: string,
    limit?: number,
  ): { text: string; error: string | null } => {
    try {
      if (incomplete)
        throw new Error("Complete the unfinished number before previewing.");
      if (!isValidTimeZone(definition.timeZone ?? "UTC"))
        throw new Error("Choose a valid template time zone.");
      const diagnostic = validateTemplate(
        text,
        definition.fields.map((field) => field.key),
      )[0];
      if (diagnostic)
        throw new Error(
          `${diagnostic.message} (line ${diagnostic.line}, column ${diagnostic.column})`,
        );
      return {
        text: renderText(text, validation.inputs, limit, context),
        error: null,
      };
    } catch (problem) {
      return {
        text: "",
        error: `${label}: ${problem instanceof Error ? problem.message : String(problem)}`,
      };
    }
  };
  const renderedTitle = render("Thread title", definition.titleTemplate, 4000),
    renderedPrompt = render("First message", definition.promptTemplate);
  const title = renderedTitle.text,
    prompt = renderedPrompt.text;
  const error = [renderedTitle.error, renderedPrompt.error]
    .filter(Boolean)
    .join("; ");
  const choose = (operationId: string) => {
    const sample = recent.value?.samples.find(
      (item) => item.operationId === operationId,
    );
    setSelected(sample ?? null);
    setInputs(
      sample ? structuredClone(sample.inputs) : defaultInputs(definition),
    );
    setContext(
      sample
        ? structuredClone(sample.renderContext)
        : createRenderContext(
            isValidTimeZone(definition.timeZone ?? "UTC")
              ? definition.timeZone
              : "UTC",
          ),
    );
  };
  return (
    <div className="ntt-prompt-workbench">
      <div className="ntt-stack ntt-prompt-source">
        {source}
        <TimeZoneField
          value={definition.timeZone}
          onChange={(timeZone) => {
            onChange({ ...definition, timeZone });
            if (isValidTimeZone(timeZone)) setContext({ ...context, timeZone });
          }}
        />
        <details className="ntt-template-help">
          <summary>Template syntax and examples</summary>
          <div className="ntt-stack ntt-help">
            <p>
              Plain text; values are inserted without HTML escaping.{" "}
              <code>{"{{field|literal fallback}}"}</code> keeps its fallback
              literally, including pipes and spaces.
            </p>
            <p>
              <code>
                {
                  '{{upper subject}} · {{trim focus}} · {{concat "Review: " subject}}'
                }
              </code>
            </p>
            <p>
              <code>
                {
                  "{{#if (and subject (not focus))}}Add focus{{else}}Ready{{/if}}"
                }
              </code>
            </p>
            <p>
              Helpers: upper, lower, trim, concat, default, eq, not, and, or.
              Blocks: if/unless with optional else. default replaces only
              missing/empty text; false and 0 are preserved. Conditions treat
              missing, empty text, false and 0 as false; eq compares values and
              types.
            </p>
            <p>
              <code>{'{{date @now "yyyy-MM-dd HH:mm"}}'}</code> or{" "}
              <code>{'{{date "2026-11-02T09:30:00Z" "EEE HH:mm"}}'}</code>.
              Formats: yyyy MM dd HH mm ss EEE. MM means month; mm means minute.
              Dates always append their actual GMT offset and [IANA zone].
            </p>
            <p>
              A bounded subset, not full Handlebars or Hugo: no loops, property
              access, custom helpers, scripts or file/network access. Unknown
              fields and malformed syntax block publication.
            </p>
          </div>
        </details>
      </div>
      <section
        className="ntt-stack ntt-prompt-preview"
        aria-label="Sample preview"
      >
        <div>
          <h3>Live preview</h3>
          <p className="ntt-help">
            Current draft, with preview-only inputs. Nothing is sent or saved to
            your launch form.
          </p>
        </div>
        <RenderClock
          context={context}
          onRefresh={() => setContext(createRenderContext(context.timeZone))}
        />
        <div>
          <strong>Thread title</strong>
          <pre className="ntt-preview" aria-label="Rendered thread title">
            {title || (!error ? "(No title)" : "")}
          </pre>
        </div>
        <div>
          <strong>First message</strong>
          <pre className="ntt-preview" aria-label="Rendered first message">
            {prompt}
          </pre>
        </div>
        {error && (
          <p className="ntt-alert" role="alert">
            Preview unavailable: {error}
          </p>
        )}
        <div className="ntt-field">
          <label htmlFor={sampleId}>Sample inputs</label>
          <select
            id={sampleId}
            className="ntt-input"
            value={selected?.operationId ?? ""}
            onChange={(event) => choose(event.target.value)}
            disabled={!eligible}
          >
            <option value="">Editable example inputs</option>
            {selected &&
              !recent.value?.samples.some(
                (item) => item.operationId === selected.operationId,
              ) && (
                <option value={selected.operationId}>
                  Selected original submission · revision {selected.revision}
                </option>
              )}
            {recent.value?.samples.map((sample) => (
              <option key={sample.operationId} value={sample.operationId}>
                Revision {sample.revision} · submitted{" "}
                {new Date(sample.submittedAt).toISOString()} (UTC) · observed{" "}
                {sample.renderContext.timeZone}
              </option>
            ))}
          </select>
        </div>
        {eligible && (
          <p className="ntt-help">
            Recent submissions for {sampleOwner}. Only your actual submitting
            identity’s records are shown.
          </p>
        )}
        {recent.loading && (
          <p className="ntt-help">Loading your recent submissions…</p>
        )}
        {recent.error && (
          <div className="ntt-alert" role="alert">
            Your recent samples could not refresh: {recent.error}{" "}
            <button type="button" className="ntt-link" onClick={recent.refresh}>
              Retry samples
            </button>
          </div>
        )}
        {!eligible && (
          <p className="ntt-help">
            Personal samples are available only in your own identity view.
          </p>
        )}
        {selected && (
          <details className="ntt-template-help">
            <summary>
              Original submission · revision {selected.revision}
              {selected.revision !== revision
                ? " (different from current publication)"
                : ""}
            </summary>
            <p className="ntt-help">
              Original values and time remain below. The rendered output uses
              the current edited source; check field compatibility before using
              it.
            </p>
            <RenderClock context={selected.renderContext} />
            <pre className="ntt-preview">
              {JSON.stringify(selected.inputs, null, 2)}
            </pre>
          </details>
        )}
        {selected && validation.issues.length > 0 && (
          <p className="ntt-status">
            This sample needs correction for the current fields. Its original
            values are retained above.
          </p>
        )}
        <InputFields
          definition={definition}
          inputs={inputs}
          onChange={setInputs}
          issues={validation.issues}
        />
        {extras.map((key) => (
          <div className="ntt-row ntt-help" key={key}>
            <span>
              Unknown field {key}: {JSON.stringify(inputs[key])}
            </span>
            <button
              type="button"
              className="ntt-link"
              onClick={() =>
                setInputs((previous) => {
                  const next = { ...previous };
                  delete next[key];
                  return next;
                })
              }
            >
              Remove {key} from preview
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
