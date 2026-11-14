import type { LookupState } from "./types.ts";
import { useId, useState, useRef, useEffect } from "react";
import type {
  Rule,
  RuleGroup,
  Predicate,
  Criterion,
} from "../contracts/model.ts";
import { newRule, actionOf, usesJev } from "../contracts/model.ts";
export function RuleEditor({
  rule,
  onChange,
  groups,
  projects = [],
  projectLookup,
}: {
  rule: Rule;
  groups: RuleGroup[];
  projects?: { id: string; name: string }[];
  projectLookup?: LookupState;
  onChange: (r: Rule) => void;
}) {
  const actionId = useId();
  const patch = (p: Partial<Rule>) => onChange({ ...rule, ...p });
  return (
    <div className="mr-rule-form">
      <label className="mr-field">
        <span>Name</span>
        <input
          value={rule.title}
          onChange={(e) => patch({ title: e.target.value })}
        />
      </label>
      <section
        className="mr-form-card mr-scope-card"
        aria-label="Filter messages"
      >
        <h3>Filter messages</h3>
        <p className="mr-note">Check the group scope first, then this rule’s conditions. Only matching messages continue.</p>
        <label className="mr-field">
          <span>Group</span>
          <SearchValue
            label="Rule group"
            entity="group"
            value={rule.groupId}
            options={groups.map((g) => ({
              id: g.id,
              name: g.title + (!g.enabled ? " · disabled" : ""),
            }))}
            onChange={(groupId) => patch({ groupId })}
          />
        </label>
        <div className="mr-field">
          <span>Match</span>
          <Predicates
            projects={projects}
            projectLookup={projectLookup}
            value={rule.match}
            onChange={(match) => patch({ match })}
          />
        </div>
      </section>
      <section className="mr-form-card" aria-label="Classifier">
        <h3>Classifier</h3>
        <label className="mr-classifier-toggle">
          <input type="checkbox" checked={usesJev(rule)} onChange={(e) => patch({ action: actionOf(rule), check: e.target.checked ? "jev" : "always" })} />
          <span>Check with classifier</span>
        </label>
        <p className="mr-note">{usesJev(rule)
          ? "Ask these questions after the filter matches. Matching answers determine whether this rule’s action applies."
          : "No classifier is run. Matching the group scope and rule filter is enough for this rule to apply its action."}</p>
        {usesJev(rule) && (
          <>
            {rule.criteria.map((q, i) => (
              <CriterionEditor
                key={q.id}
                criterion={q}
                onChange={(next) =>
                  patch({
                    criteria: rule.criteria.map((x, n) => (n === i ? next : x)),
                  })
                }
                onRemove={() =>
                  patch({ criteria: rule.criteria.filter((_, n) => n !== i) })
                }
              />
            ))}
            <button
              className="mr-link"
              onClick={() =>
                patch({
                  criteria: [
                    ...rule.criteria,
                    {
                      id: unusedQuestionId(rule.criteria),
                      type: "choice",
                      instructions: "",
                      criteria: {
                        yes: "The condition is present.",
                        no: "The condition is absent.",
                      },
                      rejectChoices: ["yes"],
                      context: {
                        message: true,
                        senderHistory: 0,
                        destinationHistory: 0,
                        requireComplete: true,
                      },
                    },
                  ],
                })
              }
            >
              + Question
            </button>
            <label className="mr-field">
              <span>Questions match when</span>
              <select
                value={rule.reduction}
                onChange={(e) =>
                  patch({ reduction: e.target.value as Rule["reduction"] })
                }
              >
                <option value="any">Any question matches</option>
                <option value="all">All questions match</option>
              </select>
            </label>
          </>
        )}
      </section>
      <section
        className={
          "mr-form-card " + (actionOf(rule) === "reject" ? "mr-outcome-card" : "")
        }
        aria-label="Action when matched"
      >
        <h3>Action when matched</h3>
        <p className="mr-note">Apply this action after the filter and any classifier conditions match.</p>
        <ActionChoices
          id={`mr-action-${actionId}`}
          value={actionOf(rule)}
          onChange={(action) => patch({ action })}
        />
        {actionOf(rule) === "queue-batched" && (
          <p className="mr-note">
            Saved tests show intended membership. Native all-sender delivery
            remains unproved.
          </p>
        )}
        {actionOf(rule) === "reject" && (
          <label className="mr-field">
            <span>Reply to sender</span>
            <textarea
              rows={3}
              value={rule.advice}
              onChange={(e) => patch({ advice: e.target.value })}
            />
          </label>
        )}
        <div className="mr-field">
          <span>If uncertain</span>
          <span>Hold for review</span>
        </div>
      </section>
    </div>
  );
}
export function Predicates({
  value,
  onChange,
  scopeOnly = false,
  projects = [],
  projectLookup,
  onRemove,
}: {
  value: Predicate;
  scopeOnly?: boolean;
  projects?: { id: string; name: string }[];
  projectLookup?: LookupState;
  onRemove?: () => void;
  onChange: (p: Predicate) => void;
}) {
  const remove = onRemove ?? (() => onChange({ kind: "any", children: [] }));
  if (value.kind === "condition")
    return (
      <div className="mr-condition">
        <select
          aria-label="Condition field"
          value={value.field}
          onChange={(e) =>
            onChange({ ...value, field: e.target.value as typeof value.field })
          }
        >
          <option value="sender_title">Sender title</option>
          <option value="destination_title">Destination title</option>
          {!scopeOnly && <option value="message">Message</option>}
          <option value="project_id">Project ID</option>
          <option value="project_title">Project title</option>
          <option value="sender_thread_id">Sender thread ID</option>
          <option value="destination_thread_id">Destination thread ID</option>
        </select>
        <span
          className="mr-comparison-select"
          title={
            value.operator === "equals" ? "Equals exactly" : "Contains text"
          }
        >
          <span className="mr-comparison-face" aria-hidden="true">
            <span
              className={
                value.operator === "equals" ? "mr-comparison-equals" : ""
              }
            >
              {value.operator === "equals" ? "=" : "Contains"}
            </span>
            <span>⌄</span>
          </span>
          <select
            aria-label="Comparison"
            value={value.operator}
            onChange={(e) =>
              onChange({
                ...value,
                operator: e.target.value as typeof value.operator,
              })
            }
          >
            <option value="contains">Contains text</option>
            <option value="equals">= Equals exactly</option>
          </select>
        </span>
        {value.field === "project_id" || value.field === "project_title" ? (
          <SearchValue
            label="Condition text"
            lookupState={projectLookup}
            value={value.value}
            options={projects}
            titleValue={value.field === "project_title"}
            onChange={(text) => onChange({ ...value, value: text })}
          />
        ) : (
          <input
            aria-label="Condition text"
            value={value.value}
            onChange={(e) => onChange({ ...value, value: e.target.value })}
          />
        )}
        <label>
          <input
            type="checkbox"
            checked={value.insensitive}
            onChange={(e) =>
              onChange({ ...value, insensitive: e.target.checked })
            }
          />
          Ignore case
        </label>
        <button aria-label="Remove condition" onClick={remove}>
          ×
        </button>
      </div>
    );
  if (value.kind === "not")
    return (
      <div className="mr-predicate">
        <span>Not</span>
        <Predicates
          projects={projects}
          projectLookup={projectLookup}
          scopeOnly={scopeOnly}
          value={value.child}
          onRemove={remove}
          onChange={(child) => onChange({ ...value, child })}
        />
        <button onClick={() => onChange(value.child)}>Remove Not</button>
      </div>
    );
  const removeChild = (at: number) => {
    const children = value.children.filter((_, n) => n !== at);
    if (!children.length) remove();
    else onChange({ ...value, children });
  };
  return (
    <div className="mr-predicate">
      <select
        aria-label="Match conditions"
        value={value.kind}
        onChange={(e) =>
          onChange(
            e.target.value === "not"
              ? { kind: "not", child: value }
              : { ...value, kind: e.target.value as "all" | "any" },
          )
        }
      >
        <option value="all">All conditions</option>
        <option value="any">Any condition</option>
        <option value="not">Not these conditions</option>
      </select>
      {value.children.map((p, i) => (
        <div className="mr-condition-wrap" key={i}>
          <Predicates
            projects={projects}
            projectLookup={projectLookup}
            scopeOnly={scopeOnly}
            value={p}
            onRemove={() => removeChild(i)}
            onChange={(next) =>
              onChange({
                ...value,
                children: value.children.map((x, n) => (n === i ? next : x)),
              })
            }
          />
          {p.kind !== "condition" && (
            <button
              aria-label="Delete condition or group"
              onClick={() => removeChild(i)}
            >
              −
            </button>
          )}
        </div>
      ))}
      <div className="mr-inline">
        <button
          className="mr-link"
          onClick={() =>
            onChange({
              ...value,
              children: [
                ...value.children,
                {
                  kind: "condition",
                  field: scopeOnly ? "destination_thread_id" : "sender_title",
                  operator: "contains",
                  value: "",
                  insensitive: false,
                },
              ],
            })
          }
        >
          + Condition
        </button>
        <button
          className="mr-link"
          onClick={() =>
            onChange({
              ...value,
              children: [...value.children, newRule("group").match],
            })
          }
        >
          + Condition group
        </button>
      </div>
    </div>
  );
}
function CriterionEditor({
  criterion: q,
  onChange,
  onRemove,
}: {
  criterion: Criterion;
  onChange: (q: Criterion) => void;
  onRemove: () => void;
}) {
  return (
    <div className="mr-question">
      <label className="mr-field">
        <span>Question</span>
        <textarea
          rows={3}
          value={q.instructions}
          onChange={(e) => onChange({ ...q, instructions: e.target.value })}
        />
      </label>
      <div className="mr-field">
        <span>Context</span>
        <div className="mr-inline mr-context-controls">
          <label className="mr-context-message">
            <input
              type="checkbox"
              checked={q.context.message}
              onChange={(e) =>
                onChange({
                  ...q,
                  context: { ...q.context, message: e.target.checked },
                })
              }
            />
            Message
          </label>
          <label className="mr-context-history">
            <span>Sender history</span>
            <input
              type="number"
              min={0}
              max={100}
              value={q.context.senderHistory}
              onChange={(e) =>
                onChange({
                  ...q,
                  context: {
                    ...q.context,
                    senderHistory: Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <label className="mr-context-history">
            <span>Destination history</span>
            <input
              type="number"
              min={0}
              max={100}
              value={q.context.destinationHistory}
              onChange={(e) =>
                onChange({
                  ...q,
                  context: {
                    ...q.context,
                    destinationHistory: Number(e.target.value),
                  },
                })
              }
            />
          </label>
        </div>
      </div>
      <label className="mr-field">
        <span>Answer type</span>
        <select
          value={q.type}
          onChange={(e) =>
            onChange(
              e.target.value === "score"
                ? {
                    ...q,
                    type: "score",
                    criteria: ["Condition absent", "Condition present"],
                    rejectAt: 1,
                    comparison: "gte",
                  }
                : {
                    ...q,
                    type: "choice",
                    criteria: {
                      yes: "Condition present",
                      no: "Condition absent",
                    },
                    rejectChoices: ["yes"],
                  },
            )
          }
        >
          <option value="choice">Choice</option>
          <option value="score">Score</option>
        </select>
      </label>
      {q.type === "choice" ? (
        <>
          <label className="mr-field">
            <span>Choices</span>
            <textarea
              aria-label="Choice definitions"
              value={Object.entries(q.criteria)
                .map(([k, v]) => k + ": " + v)
                .join("\n")}
              onChange={(e) =>
                onChange({
                  ...q,
                  criteria: Object.fromEntries(
                    e.target.value.split("\n").map((line) => {
                      const at = line.indexOf(":");
                      return at < 0
                        ? [line, ""]
                        : [line.slice(0, at), line.slice(at + 1).trimStart()];
                    }),
                  ),
                })
              }
            />
          </label>
          <label className="mr-field">
            <span>Matching choices</span>
            <input
              value={q.rejectChoices.join(", ")}
              onChange={(e) =>
                onChange({
                  ...q,
                  rejectChoices: e.target.value.split(",").map((x) => x.trim()),
                })
              }
            />
          </label>
        </>
      ) : (
        <>
          <label className="mr-field">
            <span>Score levels</span>
            <textarea
              value={q.criteria.join("\n")}
              onChange={(e) =>
                onChange({ ...q, criteria: e.target.value.split("\n") })
              }
            />
          </label>
          <label className="mr-field">
            <span>Threshold</span>
            <div className="mr-inline mr-score-threshold">
              <select
                aria-label="Score comparison"
                value={q.comparison}
                onChange={(e) =>
                  onChange({
                    ...q,
                    comparison: e.target.value as "gte" | "lte",
                  })
                }
              >
                <option value="gte">At least</option>
                <option value="lte">At most</option>
              </select>
              <input
                type="number"
                aria-label="Score threshold"
                step="0.01"
                min={0}
                max={q.criteria.length - 1}
                value={q.rejectAt}
                onChange={(e) =>
                  onChange({ ...q, rejectAt: Number(e.target.value) })
                }
              />
            </div>
          </label>
        </>
      )}
      <label className="mr-field">
        <span>Coverage</span>
        <label>
          <input
            type="checkbox"
            checked={q.context.requireComplete}
            onChange={(e) =>
              onChange({
                ...q,
                context: { ...q.context, requireComplete: e.target.checked },
              })
            }
          />
          Require complete selected context
        </label>
      </label>
      <button className="mr-link" onClick={onRemove}>
        Remove question
      </button>
    </div>
  );
}

export function GroupEditor({
  group,
  onChange,
  projects = [],
  projectLookup,
}: {
  group: RuleGroup;
  projects?: { id: string; name: string }[];
  projectLookup?: LookupState;
  onChange: (g: RuleGroup) => void;
}) {
  return (
    <div className="mr-rule-form">
      <label className="mr-field">
        <span>Name</span>
        <input
          value={group.title}
          onChange={(e) => onChange({ ...group, title: e.target.value })}
        />
      </label>
      <section
        className="mr-form-card mr-scope-card"
        aria-label="Where rules apply"
      >
        <h3>Where rules apply</h3>
        {group.match.kind === "all" && !group.match.children.length && (
          <p className="mr-note">Any project</p>
        )}
        <div className="mr-field">
          <span>Scope</span>
          <Predicates
            scopeOnly
            projects={projects}
            projectLookup={projectLookup}
            value={group.match}
            onChange={(match) => onChange({ ...group, match })}
          />
        </div>
        <p className="mr-note">
          Every child rule uses this scope first. Outside-scope messages and
          unavailable metadata skip evaluation. Empty “All conditions” matches
          every project and thread.
        </p>
      </section>
      <aside className="mr-scope-flow" aria-label="Scope evaluation order">
        <span>Group scope</span>
        <span aria-hidden="true">→</span>
        <span>Child rule checks</span>
        <span aria-hidden="true">→</span>
        <span>Test results &amp; advice</span>
      </aside>
    </div>
  );
}

export function unusedQuestionId(criteria: { id: string }[]) {
  const used = new Set(criteria.map((q) => q.id));
  let n = 1;
  while (used.has("question-" + n)) n++;
  return "question-" + n;
}

const actions = [
  { value: "reject", title: "Reject", description: "Keep the sender's draft and return every identified cause and actionable advice.", path: "M8 3h8l5 5v8l-5 5H8l-5-5V8l5-5ZM9 9l6 6M15 9l-6 6" },
  { value: "proceed", title: "Proceed", description: "Preserve the requested delivery mode, schedule and execution choices.", path: "m5 12 4 4L19 6" },
  { value: "steer", title: "Steer", description: "Select steering delivery. Incompatible route preferences remain unresolved.", path: "M4 12h16m-6-6 6 6-6 6" },
  { value: "queue", title: "Queue", description: "Select a separate queued delivery, retaining the original request and execution choices.", path: "M4 6h16M4 12h16M4 18h16" },
  { value: "queue-batched", title: "Queue batched", description: "Join the next open ordinary queued delivery when compatible. Scheduled messages stay separate.", path: "M5 3h14M5 7h14M3 11h18v10H3V11Zm0 0 5 5h8l5-5" },
] as const;

function ActionChoices({
  id,
  value,
  onChange,
}: {
  id: string;
  value: Rule["action"];
  onChange: (action: Rule["action"]) => void;
}) {
  return (
    <fieldset className="mr-action-choices">
      <legend>Action</legend>
      <div className="mr-action-grid">
        {actions.map((action) => (
          <label className="mr-action-choice" key={action.value}>
            <input
              type="radio"
              name={id}
              value={action.value}
              checked={value === action.value}
              aria-labelledby={`${id}-${action.value}-title`}
              aria-describedby={`${id}-${action.value}-description`}
              onChange={() => onChange(action.value)}
            />
            <span className="mr-action-content">
              <svg
                className="mr-action-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d={action.path} />
              </svg>
              <strong id={`${id}-${action.value}-title`}>{action.title}</strong>
              <span id={`${id}-${action.value}-description`}>
                {action.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// IDs are values. Names remain searchable labels; raw values stay editable.
export function SearchValue({
  label,
  value,
  options,
  onChange,
  titleValue = false,
  lookupState = { status: "ready" },
  entity = "project",
}: {
  label: string;
  value: string;
  options: { id: string; name: string }[];
  onChange: (v: string) => void;
  titleValue?: boolean;
  lookupState?: LookupState;
  entity?: "project" | "group";
}) {
  const id = useId();
  const list = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false),
    [active, setActive] = useState(-1);
  useEffect(() => {
    const menu = list.current,
      option = menu?.children[active] as HTMLElement | undefined;
    if (!expanded || !menu || !option) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (
      option.offsetTop + option.offsetHeight >
      menu.scrollTop + menu.clientHeight
    )
      menu.scrollTop =
        option.offsetTop + option.offsetHeight - menu.clientHeight;
  }, [expanded, active]);
  const needle = value.toLowerCase();
  const matches = options.filter(
    (p) =>
      p.id.toLowerCase().includes(needle) ||
      p.name.toLowerCase().includes(needle),
  );
  const candidates = matches.slice(0, 20);
  const found = options.filter((p) =>
    titleValue ? p.name === value : p.id === value,
  );
  const listState =
    lookupState.status === "loading"
      ? options.length
        ? `Refreshing ${entity}s… Showing the last loaded list.`
        : `Loading ${entity}s… Raw values remain editable.`
      : lookupState.status === "error"
        ? `${entity === "project" ? "Project" : "Group"} list unavailable. ${lookupState.message ?? "Try again after reconnecting."}${options.length ? " Showing the last loaded list." : " Raw values remain editable."}`
        : null;
  const queryHint =
    listState ??
    (expanded
      ? !value
        ? options.length
          ? `Search ${options.length} ${entity}s by name or ID.`
          : `No ${entity}s available. Raw values remain valid.`
        : matches.length
          ? `${matches.length} matching ${entity}${matches.length === 1 ? "" : "s"}. Select a result.`
          : `No matching ${entity}s. Refine the search or keep this raw value.`
      : found.length === 1
        ? found[0]!.name + " · " + found[0]!.id
        : found.length > 1
          ? "Multiple projects share this name; use Project ID for exact scope."
          : value
            ? `Raw value · no known ${entity} ID`
            : "Search by name or ID; raw predicates remain valid.");
  const choose = (p: { id: string; name: string }) => {
    onChange(titleValue ? p.name : p.id);
    setExpanded(false);
    setActive(-1);
  };
  return (
    <span className="mr-search-value">
      <input
        role="combobox"
        aria-label={label}
        aria-describedby={id + "-hint"}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={id + "-options"}
        aria-activedescendant={
          expanded && active >= 0 && candidates[active]
            ? id + "-option-" + active
            : undefined
        }
        autoComplete="off"
        value={value}
        placeholder="Search name or ID"
        onClick={() => setExpanded(true)}
        onFocus={() => {
          setExpanded(true);
          setActive(-1);
        }}
        onBlur={() => setExpanded(false)}
        onChange={(e) => {
          onChange(e.target.value);
          setExpanded(true);
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && expanded) {
            e.preventDefault();
            e.stopPropagation();
            setExpanded(false);
            setActive(-1);
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setExpanded(true);
            if (candidates.length)
              setActive((n) =>
                e.key === "ArrowDown"
                  ? (n + 1) % candidates.length
                  : n <= 0
                    ? candidates.length - 1
                    : n - 1,
              );
          }
          if (
            e.key === "Enter" &&
            expanded &&
            active >= 0 &&
            candidates[active]
          ) {
            e.preventDefault();
            choose(candidates[active]!);
          }
        }}
      />
      <span
        ref={list}
        id={id + "-options"}
        role="listbox"
        aria-label={label + " suggestions"}
        hidden={!expanded}
        className="mr-search-options"
      >
        {candidates.map((p, i) => (
          <span
            role="option"
            id={id + "-option-" + i}
            key={p.id}
            aria-selected={i === active}
            data-value={titleValue ? p.name : p.id}
            className="mr-search-option"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(p)}
          >
            <strong>{p.name}</strong>
            <small>{p.id}</small>
          </span>
        ))}
        {listState && (
          <span className="mr-search-empty" role="status">
            {listState}
          </span>
        )}
        {!candidates.length && lookupState.status === "ready" && (
          <span className="mr-search-empty">
            No available match. Raw values remain valid.
          </span>
        )}
        {matches.length > 20 && (
          <span className="mr-search-empty">
            Showing 20 of {matches.length}. Refine your search.
          </span>
        )}
      </span>
      <small id={id + "-hint"}>{queryHint}</small>
    </span>
  );
}
