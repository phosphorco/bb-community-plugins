import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Predicates, RuleEditor as ProductRuleEditor } from "../../ui/rule-editor.tsx";
import { match, validateRule, type Predicate } from "../../contracts/model.ts";
import { captured, jevRule, answer, count } from "../helpers.ts";
import { evaluate } from "../../evaluation/evaluator.ts";
// Capture handler-bearing product elements inside a real React render so its
// mounted-instance hooks run under React, rather than calling hooks standalone.
function RuleEditor(props: Parameters<typeof ProductRuleEditor>[0]) {
  let tree: ReactNode;
  function Capture() { tree = ProductRuleEditor(props); return null; }
  renderToStaticMarkup(createElement(Capture));
  return tree!;
}
function nodes(node: ReactNode): any[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement(node)) return [];
  if (typeof node.type === "function" && node.type.name === "SearchValue") return []; // Hook-based completion is verified with the mounted global UI.
  if (typeof node.type === "function")
    return nodes((node.type as any)(node.props));
  return [node, ...nodes((node.props as any).children)];
}
const condition: Predicate = {
  kind: "condition",
  field: "destination_title",
  operator: "equals",
  value: "outside-marker",
  insensitive: false,
};
for (const value of [
  {
    kind: "any",
    children: [condition, { ...condition, value: "another" }],
  } as Predicate,
  {
    kind: "all",
    children: [condition, { ...condition, value: "another" }],
  } as Predicate,
  {
    kind: "not",
    child: { ...condition, value: captured.destinationTitle! },
  } as Predicate,
  {
    kind: "any",
    children: [{ kind: "all", children: [condition] }],
  } as Predicate,
])
  test(`actual remove-condition control remains fail-closed under ${JSON.stringify(value.kind)}`, () => {
    let next = value;
    const tree = Predicates({
      value,
      onChange: (p) => (next = p),
      scopeOnly: true,
    });
    const button = nodes(tree).find(
      (n) =>
        n.type === "button" && n.props["aria-label"] === "Remove condition",
    );
    assert.ok(button);
    button.props.onClick();
    assert.equal(match(next, captured), false);
  });
test("actual delete/add question control preserves unique IDs and exact surviving answer bindings", async () => {
  let r = jevRule();
  r.criteria = [1, 2, 3].map((i) => ({
    ...r.criteria[0]!,
    id: "question-" + i,
  }));
  const render = () =>
    nodes(RuleEditor({ rule: r, groups: [], onChange: (next) => (r = next) }));
  render()
    .filter(
      (n) => n.type === "button" && n.props.children === "Remove question",
    )[1]!
    .props.onClick();
  render()
    .find((n) => n.type === "button" && n.props.children === "+ Question")!
    .props.onClick();
  assert.deepEqual(
    r.criteria.map((q) => q.id),
    ["question-1", "question-3", "question-2"],
  );
  r.criteria[2]!.instructions = "New independent check";
  validateRule(r);
  const out = await evaluate(
    captured,
    [r],
    { ...(await import("../../contracts/model.ts")).defaultConnection },
    async (w) => {
      const a = answer(w);
      a.answers.q1!.choice = "no";
      a.answers.q1!.probabilities = { yes: 0, no: 1 };
      return a;
    },
    new AbortController().signal,
    count,
  );
  assert.equal((out.rules[0]!.observations["question-3"] as any).choice, "no");
  assert.equal((out.rules[0]!.observations["question-2"] as any).choice, "yes");
  const score = {
    ...r,
    criteria: [
      {
        ...r.criteria[0]!,
        type: "score" as const,
        criteria: ["no", "yes"],
        rejectAt: 1,
        comparison: "gte" as const,
      },
    ],
  };
  const input = nodes(
    RuleEditor({ rule: score, groups: [], onChange: () => {} }),
  ).find(
    (n) => n.type === "input" && n.props["aria-label"] === "Score threshold",
  );
  assert.ok(input);
});

test("action radios explain each choice and switch only action, retaining authored details", () => {
  let rule: import("../../contracts/model.ts").Rule = {
    ...jevRule(),
    advice: "Keep this authored reply",
    groupId: "authored-group",
    revision: 17,
  };
  const original = structuredClone(rule);
  for (const action of ["batch", "reject", "jev"] as const) {
    const tree = nodes(
      RuleEditor({
        rule,
        groups: [],
        onChange: (next) => {
          rule = next;
        },
      }),
    );
    const radios = tree.filter(
      (n) => n.type === "input" && n.props.type === "radio",
    );
    assert.deepEqual(
      radios.map((n) => n.props.value),
      ["jev", "reject", "batch"],
    );
    assert.equal(radios.filter((n) => n.props.checked).length, 1);
    for (const radio of radios) {
      assert.ok(
        tree.some(
          (n) =>
            n.props.id === radio.props["aria-labelledby"] && n.props.children,
        ),
      );
      assert.ok(
        tree.some(
          (n) =>
            n.props.id === radio.props["aria-describedby"] && n.props.children,
        ),
      );
    }
    radios.find((n) => n.props.value === action).props.onChange();
    assert.deepEqual(rule, { ...original, action });
    const updated = nodes(RuleEditor({ rule, groups: [], onChange: () => {} }));
    assert.equal(
      updated.some(
        (n) =>
          n.type === "textarea" &&
          n.props.value === original.criteria[0]!.instructions,
      ),
      action === "jev",
    );
    assert.equal(
      updated.some(
        (n) => n.type === "textarea" && n.props.value === original.advice,
      ),
      action !== "batch",
    );
  }
});
