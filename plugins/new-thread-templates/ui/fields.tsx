import { validNumericEntry, type NumericText } from "./editor-checkpoint.ts";
import { useEffect, useId, useRef, useState } from "react";
import type {
  Inputs,
  TemplateDefinition,
  TemplateField,
  ValidationIssue,
} from "../model.ts";

export function InputFields({
  definition,
  inputs,
  onChange,
  disabled,
  issues = [],
}: {
  definition: TemplateDefinition;
  inputs: Inputs;
  onChange(inputs: Inputs): void;
  disabled?: boolean;
  issues?: ValidationIssue[];
}) {
  const prefix = useId();
  return (
    <>
      {[...definition.fields]
        .sort((a, b) => a.order - b.order)
        .map((field) => {
          const id = `${prefix}-${field.key}`,
            error = issues.find((issue) => issue.path === field.key)?.message;
          const value =
            inputs[field.key] ??
            field.default ??
            (field.type === "checkbox" ? false : "");
          const set = (v: string | boolean | number) =>
            onChange({ ...inputs, [field.key]: v });
          const common = {
            id,
            "data-field": field.key,
            disabled,
            "aria-invalid": !!error,
            "aria-describedby":
              [field.help ? `${id}-help` : null, error ? `${id}-error` : null]
                .filter(Boolean)
                .join(" ") || undefined,
            className: "ntt-input",
            required: field.required,
          };
          return (
            <div className="ntt-field" key={field.key}>
              {field.type !== "checkbox" && (
                <label htmlFor={id}>
                  {field.label}{" "}
                  <span className="ntt-muted ntt-small">
                    {field.required ? "*" : "(optional)"}
                  </span>
                </label>
              )}
              {field.type === "textarea" ? (
                <textarea
                  {...common}
                  rows={3}
                  value={String(value)}
                  onChange={(e) => set(e.target.value)}
                  minLength={field.validation?.minLength}
                  maxLength={field.validation?.maxLength}
                />
              ) : field.type === "select" ? (
                <select
                  {...common}
                  value={String(value)}
                  onChange={(e) => set(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : field.type === "checkbox" ? (
                <label className="ntt-check" htmlFor={id}>
                  <input
                    {...common}
                    className=""
                    type="checkbox"
                    checked={value === true}
                    onChange={(e) => set(e.target.checked)}
                  />
                  {field.label}
                  {field.required && " *"}
                </label>
              ) : (
                <input
                  {...common}
                  type={field.type === "text" ? "text" : field.type}
                  value={String(value)}
                  onChange={(e) =>
                    set(
                      field.type === "number" && e.target.value !== ""
                        ? Number(e.target.value)
                        : e.target.value,
                    )
                  }
                  min={field.validation?.min}
                  max={field.validation?.max}
                  minLength={field.validation?.minLength}
                  maxLength={field.validation?.maxLength}
                  step={field.type === "number" ? "any" : undefined}
                />
              )}
              {field.help && (
                <span id={`${id}-help`} className="ntt-help">
                  {field.help}
                </span>
              )}
              {error && (
                <span id={`${id}-error`} className="ntt-error">
                  {error}
                </span>
              )}
            </div>
          );
        })}
    </>
  );
}
export function TextField({
  label,
  value,
  onChange,
  multiline,
  id,
  type = "text",
  step,
  elementRef,
  onSelection,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  multiline?: boolean;
  id?: string;
  type?: "text" | "number";
  step?: string;
  elementRef?(element: HTMLInputElement | HTMLTextAreaElement | null): void;
  onSelection?(element: HTMLInputElement | HTMLTextAreaElement): void;
}) {
  const generated = useId(),
    inputId = id ?? generated;
  return (
    <div className="ntt-field">
      <label htmlFor={inputId}>{label}</label>
      {multiline ? (
        <textarea
          rows={3}
          ref={elementRef}
          onFocus={(event) => onSelection?.(event.currentTarget)}
          onSelect={(event) => onSelection?.(event.currentTarget)}
          id={inputId}
          className="ntt-input"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            onSelection?.(e.currentTarget);
          }}
        />
      ) : (
        <input
          ref={elementRef}
          onFocus={(event) => onSelection?.(event.currentTarget)}
          onSelect={(event) => onSelection?.(event.currentTarget)}
          id={inputId}
          type={type}
          step={step}
          className="ntt-input"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            onSelection?.(e.currentTarget);
          }}
        />
      )}
    </div>
  );
}
export const FIELD_TYPES: { value: TemplateField["type"]; label: string }[] = [
  { value: "text", label: "Short text" },
  { value: "textarea", label: "Long text" },
  { value: "url", label: "URL" },
  { value: "number", label: "Number" },
  { value: "select", label: "Select" },
  { value: "checkbox", label: "Checkbox" },
];

export function FieldsEditor({
  fields,
  numericText,
  focusPath,
  onChange,
}: {
  fields: TemplateField[];
  numericText: NumericText;
  focusPath: string | null;
  onChange(fields: TemplateField[], numericText: NumericText): void;
}) {
  const [selected, setSelected] = useState(0);
  const prefix = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusPath) return;
    setSelected(Number(focusPath.split(".")[1]));
    requestAnimationFrame(() => {
      const input = [
        ...(root.current?.querySelectorAll<HTMLInputElement>(
          "[data-numeric-path]",
        ) ?? []),
      ].find((node) => node.dataset.numericPath === focusPath);
      const disclosure = input?.closest("details");
      if (disclosure) disclosure.open = true;
      input?.focus();
    });
  }, [focusPath]);
  const update = (
    index: number,
    patch: Partial<TemplateField>,
    numbers = numericText,
  ) =>
    onChange(
      fields.map((f, i) => (i === index ? { ...f, ...patch } : f)),
      numbers,
    );
  const remapNumbers = (map: (index: number) => number | null) =>
    Object.fromEntries(
      Object.entries(numericText).flatMap(([path, text]) => {
        const [, old, part] = path.split(".");
        const next = map(Number(old));
        return next === null ? [] : [[`fields.${next}.${part}`, text]];
      }),
    );
  const setNumber = (
    index: number,
    part: "default" | "min" | "max" | "minLength" | "maxLength",
    text: string,
  ) => {
    const numbers = { ...numericText, [`fields.${index}.${part}`]: text };
    if (!validNumericEntry(`fields.${index}.${part}`, text)) {
      onChange(fields, numbers);
      return;
    }
    const value = text === "" ? undefined : Number(text);
    update(
      index,
      part === "default"
        ? { default: value }
        : { validation: { ...fields[index]!.validation, [part]: value } },
      numbers,
    );
  };
  const numberField = (
    index: number,
    part: "default" | "min" | "max" | "minLength" | "maxLength",
    label: string,
  ) => {
    const field = fields[index]!;
    const path = `fields.${index}.${part}`;
    const text =
      numericText[path] ??
      String(
        (part === "default" ? field.default : field.validation?.[part]) ?? "",
      );
    const invalid = !validNumericEntry(path, text);
    const id = `${prefix}-${index}-${part}`;
    return (
      <div className="ntt-field" key={part}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          className="ntt-input"
          type="text"
          inputMode="decimal"
          maxLength={80}
          data-numeric-path={path}
          value={text}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error` : undefined}
          onChange={(event) => setNumber(index, part, event.target.value)}
        />
        {invalid && (
          <span id={`${id}-error`} className="ntt-error">
            Complete this number.
          </span>
        )}
      </div>
    );
  };
  const move = (index: number, delta: number) => {
    const next = [...fields],
      target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(
      next.map((f, i) => ({ ...f, order: i })),
      remapNumbers((i) => (i === index ? target : i === target ? index : i)),
    );
    setSelected(target);
    requestAnimationFrame(() =>
      root.current
        ?.querySelectorAll<HTMLElement>(".ntt-field-toggle")
        [target]?.focus(),
    );
  };
  return (
    <div className="ntt-stack" ref={root}>
      {fields.map((f, i) => (
        <section
          className="ntt-definition ntt-stack"
          key={i}
          aria-label={`Field ${i + 1}`}
        >
          <div className="ntt-row ntt-between ntt-field-heading">
            <button
              type="button"
              className="ntt-field-toggle"
              aria-expanded={selected === i}
              aria-controls={`${prefix}-config-${i}`}
              onClick={() => setSelected(selected === i ? -1 : i)}
            >
              <strong>{f.label || `Field ${i + 1}`}</strong>{" "}
              <span className="ntt-help">
                {FIELD_TYPES.find((type) => type.value === f.type)?.label}
                {f.required ? " · Required" : ""}
              </span>
            </button>
            <div className="ntt-row">
              <button
                type="button"
                className="ntt-link"
                disabled={i === 0}
                aria-label={`Move ${f.label || "field"} up`}
                onClick={() => move(i, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="ntt-link"
                disabled={i === fields.length - 1}
                aria-label={`Move ${f.label || "field"} down`}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="ntt-link"
                aria-label={`Remove ${f.label || "field"}`}
                onClick={() => {
                  onChange(
                    fields
                      .filter((_, index) => index !== i)
                      .map((x, index) => ({ ...x, order: index })),
                    remapNumbers((index) =>
                      index === i ? null : index > i ? index - 1 : index,
                    ),
                  );
                  const next = Math.min(i, fields.length - 2);
                  setSelected(next);
                  requestAnimationFrame(() =>
                    (
                      root.current?.querySelectorAll<HTMLElement>(
                        ".ntt-field-toggle",
                      )[next] ??
                      root.current?.querySelector<HTMLElement>(".ntt-add-field")
                    )?.focus(),
                  );
                }}
              >
                Remove
              </button>
            </div>
          </div>
          <div
            hidden={selected !== i}
            id={`${prefix}-config-${i}`}
            className="ntt-stack ntt-field-config"
          >
            <div className="ntt-columns">
              <TextField
                label="Label"
                value={f.label}
                onChange={(label) => update(i, { label })}
              />
              <TextField
                label="Stable key"
                value={f.key}
                onChange={(key) => update(i, { key })}
              />
              <div className="ntt-field">
                <label htmlFor={`type-${i}`}>Type</label>
                <select
                  id={`type-${i}`}
                  className="ntt-input"
                  value={f.type}
                  onChange={(e) =>
                    update(
                      i,
                      {
                        type: e.target.value as TemplateField["type"],
                        default: undefined,
                      },
                      remapNumbers((index) => (index === i ? null : index)),
                    )
                  }
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <label className="ntt-check ntt-required-control">
                <input
                  type="checkbox"
                  checked={f.required}
                  onChange={(e) => update(i, { required: e.target.checked })}
                />
                Required
              </label>
            </div>
            <details className="ntt-field-options">
              <summary>Help, defaults and validation</summary>
              <div className="ntt-stack">
                <TextField
                  label="Help text"
                  value={f.help ?? ""}
                  onChange={(help) => update(i, { help })}
                />
                {f.type === "checkbox" ? (
                  <label className="ntt-check">
                    <input
                      type="checkbox"
                      checked={f.default === true}
                      onChange={(e) => update(i, { default: e.target.checked })}
                    />
                    Checked by default
                  </label>
                ) : f.type === "number" ? (
                  numberField(i, "default", "Default value")
                ) : (
                  <TextField
                    label="Default value"
                    value={String(f.default ?? "")}
                    onChange={(value) =>
                      update(i, {
                        default: value === "" ? undefined : value,
                      })
                    }
                  />
                )}
                {f.type === "select" && (
                  <TextField
                    label="Options (one value | label per line)"
                    multiline
                    value={
                      f.options
                        ?.map((o) => `${o.value} | ${o.label}`)
                        .join("\n") ?? ""
                    }
                    onChange={(text) =>
                      update(i, {
                        options: text.split("\n").map((line) => {
                          const [value, ...label] = line.split("|");
                          return {
                            value: value!.trim(),
                            label: label.join("|").trim() || value!.trim(),
                          };
                        }),
                      })
                    }
                  />
                )}
                {f.type !== "checkbox" && f.type !== "select" && (
                  <div className="ntt-columns">
                    {(f.type === "number"
                      ? (["min", "max"] as const)
                      : (["minLength", "maxLength"] as const)
                    ).map((key) =>
                      numberField(
                        i,
                        key,
                        key === "min"
                          ? "Minimum"
                          : key === "max"
                            ? "Maximum"
                            : key === "minLength"
                              ? "Minimum length"
                              : "Maximum length",
                      ),
                    )}
                  </div>
                )}
              </div>
            </details>
          </div>
        </section>
      ))}
      <button
        type="button"
        className="ntt-button ntt-add-field"
        onClick={() => {
          let n = fields.length + 1;
          while (fields.some((f) => f.key === `field_${n}`)) n++;
          setSelected(fields.length);
          onChange(
            [
              ...fields,
              {
                key: `field_${n}`,
                label: "New field",
                type: "text",
                order: fields.length,
                required: false,
              },
            ],
            numericText,
          );
        }}
      >
        + Add field
      </button>
    </div>
  );
}
