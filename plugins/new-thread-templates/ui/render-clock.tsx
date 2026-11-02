import { useId, useMemo } from "react";
import { isValidTimeZone, type RenderContext } from "../model.ts";

/** A displayed observation, never a ticking clock or host-local date. */
export function RenderClock({
  context,
  onRefresh,
  disabled = false,
}: {
  context: RenderContext;
  onRefresh?: () => void;
  disabled?: boolean;
}) {
  const observed = useMemo(() => {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: context.timeZone,
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "longOffset",
      }).format(context.instant);
    } catch {
      return new Date(context.instant).toISOString();
    }
  }, [context.instant, context.timeZone]);
  return (
    <div className="ntt-clock ntt-help" aria-label="Template time">
      <span>
        Observed{" "}
        <time dateTime={new Date(context.instant).toISOString()}>
          {observed}
        </time>{" "}
        · {context.timeZone}
      </span>
      {onRefresh && (
        <button
          type="button"
          className="ntt-link"
          disabled={disabled}
          onClick={onRefresh}
        >
          Refresh time
        </button>
      )}
    </div>
  );
}

export function TimeZoneField({
  value,
  onChange,
}: {
  value?: string;
  onChange(value: string): void;
}) {
  const id = useId();
  const zones = useMemo(() => {
    const supported =
      typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : [];
    return ["UTC", ...supported.filter((zone) => zone !== "UTC")];
  }, []);
  const invalid = value !== undefined && !isValidTimeZone(value);
  return (
    <div className="ntt-field">
      <label htmlFor={id}>Time zone</label>
      <input
        id={id}
        className="ntt-input"
        list={`${id}-zones`}
        value={value ?? "UTC"}
        aria-invalid={invalid}
        aria-describedby={`${id}-help`}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={`${id}-zones`}>
        {zones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      <span className={invalid ? "ntt-error" : "ntt-help"} id={`${id}-help`}>
        {invalid
          ? "Choose a valid IANA time zone, such as Europe/Berlin."
          : "IANA time zone. UTC is the default; the machine’s local clock is never used."}
      </span>
    </div>
  );
}
