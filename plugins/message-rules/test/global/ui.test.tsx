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
  const search = renderToStaticMarkup(
    <GroupEditor
      group={{ ...group, match: { ...group.match, value: "Duplicate" } }}
      projects={projects}
      onChange={() => {}}
    />,
  );
  assert.match(search, /data-value="one"/);
  assert.match(search, /data-value="two"/);
  assert.match(search, /role="combobox"/);
  assert.match(search, /aria-autocomplete="list"/);
  assert.match(html, /value="unavailable-id"/);
  assert.match(html, /Raw value · no known project ID/);
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
      rule={newRule("rule", "Same")}
      groups={[
        { ...newGroup("g-one"), title: "Same" },
        { ...newGroup("g-two"), title: "Same" },
      ]}
      onChange={() => {}}
    />,
  );
  assert.match(rules, /data-value="g-one"/);
  assert.match(rules, /data-value="g-two"/);
});

test("lookup loading/error/empty states never masquerade as zero query matches", () => {
  for (const status of ["loading", "error"] as const) {
    const html = renderToStaticMarkup(
      <GroupEditor
        group={{
          ...newGroup("raw"),
          match: {
            kind: "condition",
            field: "project_id",
            operator: "equals",
            value: "preview",
            insensitive: false,
          },
        }}
        projects={[]}
        projectLookup={{ status, message: "Project service unavailable" }}
        onChange={() => {}}
      />,
    );
    assert.match(
      html,
      status === "loading" ? /Loading projects/ : /Project list unavailable/,
    );
    assert.doesNotMatch(html, /No matching projects|No available match/);
    assert.match(html, /value="preview"/);
  }
});
