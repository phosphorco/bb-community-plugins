import type {
  Rule,
  RuleGroup,
  Predicate,
  Criterion,
} from "../contracts/model.ts";
import { newRule } from "../contracts/model.ts";
export function RuleEditor({
  rule,
  onChange,
  groups,
}: {
  rule: Rule;
  groups: RuleGroup[];
  onChange: (r: Rule) => void;
}) {
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
        aria-label="When this rule applies"
      >
        <h3>When this rule applies</h3>
        <label className="mr-field">
          <span>Group</span>
          <select
            value={rule.groupId}
            onChange={(e) => patch({ groupId: e.target.value })}
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
                {!g.enabled ? " · disabled" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="mr-field">
          <span>Match</span>
          <Predicates
            value={rule.match}
            onChange={(match) => patch({ match })}
          />
        </div>
      </section>
      <section className="mr-form-card" aria-label="What this rule checks">
        <h3>What this rule checks</h3>
        <ActionChoices
          id={`mr-action-${rule.id}`}
          value={rule.action}
          onChange={(action) => patch({ action })}
        />
        {rule.action === "batch" && (
          <p className="mr-note">
            Saved tests show intended membership. Native all-sender delivery
            remains unproved.
          </p>
        )}
        {rule.action === "jev" && (
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
              <span>Reject when</span>
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
          "mr-form-card " + (rule.action === "batch" ? "" : "mr-outcome-card")
        }
        aria-label="Test outcome"
      >
        <h3>Test outcome</h3>
        {rule.action !== "batch" && (
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
  onRemove,
}: {
  value: Predicate;
  scopeOnly?: boolean;
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
          <option value="contains">contains</option>
          <option value="equals">equals</option>
        </select>
        <input
          aria-label="Condition text"
          value={value.value}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        />
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
        <div className="mr-inline">
          <label>
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
          <label>
            Sender history{" "}
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
          <label>
            Destination history{" "}
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
            <span>Reject choices</span>
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
            <div className="mr-inline">
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
}: {
  group: RuleGroup;
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
        <div className="mr-field">
          <span>Scope</span>
          <Predicates
            scopeOnly
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
  {
    value: "jev",
    title: "Check with JEV",
    description:
      "Ask your questions about the message and context. Reject when the answers match your criteria.",
    path: "M8 10h8M8 14h4M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z",
  },
  {
    value: "reject",
    title: "Reject with advice",
    description:
      "Reject matching messages directly, with your reply explaining what the sender should change.",
    path: "M8 3h8l5 5v8l-5 5H8l-5-5V8l5-5ZM9 9l6 6M15 9l-6 6",
  },
  {
    value: "batch",
    title: "Include in next batch",
    description:
      "Mark matching messages for the next batch. Saved tests preview intended membership.",
    path: "M5 3h14M5 7h14M3 11h18v10H3V11Zm0 0 5 5h8l5-5",
  },
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
