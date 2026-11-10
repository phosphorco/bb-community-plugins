import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { GroupEditor, RuleEditor } from "../../ui/rule-editor.tsx";
import { newGroup, newRule } from "../../contracts/model.ts";
test("project completion distinguishes duplicate names by IDs and retains unavailable raw predicates", () => {
  const group = {
    ...newGroup("scope"),
    match: {
      kind: "condition" as const,
      field: "project_id" as const,
      operator: "equals" as const,
      value: "unavailable-id",
      insensitive: false,
    },
  };
  const projects = [
    { id: "one", name: "Duplicate" },
    { id: "two", name: "Duplicate" },
  ];
  const html = renderToStaticMarkup(
    <GroupEditor group={group} projects={projects} onChange={() => {}} />,
  );
  assert.match(html, /value="one" label="Duplicate · one"/);
  assert.match(html, /value="two" label="Duplicate · two"/);
  assert.match(html, /value="unavailable-id"/);
  assert.match(html, /Raw value · no available match/);
  const title = renderToStaticMarkup(
    <GroupEditor
      group={{
        ...group,
        match: { ...group.match, field: "project_title", value: "Duplicate" },
      }}
      projects={projects}
      onChange={() => {}}
    />,
  );
  assert.match(title, /Multiple projects share this name; use Project ID/);
  const rules = renderToStaticMarkup(
    <RuleEditor
      rule={newRule("rule", "g-one")}
      groups={[
        { ...newGroup("g-one"), title: "Same" },
        { ...newGroup("g-two"), title: "Same" },
      ]}
      onChange={() => {}}
    />,
  );
  assert.match(rules, /value="g-one" label="Same · disabled · g-one"/);
  assert.match(rules, /value="g-two" label="Same · disabled · g-two"/);
});
