import assert from "node:assert/strict";
import test from "node:test";

import {
  createLocationOverrides,
  decorateElementPath,
  replaceCopiedLocations,
} from "../lib/location.ts";

type FakeElement = {
  parentElement: FakeElement | null;
  attributes?: Record<string, string>;
};

function element(
  attributes: Record<string, string> = {},
  parentElement: FakeElement | null = null,
): FakeElement {
  return { parentElement, attributes };
}

function asElement(fake: FakeElement): Element {
  return {
    parentElement: fake.parentElement ? asElement(fake.parentElement) : null,
    hasAttribute: (name: string) => name in (fake.attributes ?? {}),
    getAttribute: (name: string) => fake.attributes?.[name] ?? null,
    getRootNode: () => ({}),
  } as unknown as Element;
}

test("decorates present special attributes on target and ancestors", () => {
  const panel = element({ "data-panel-id": "settings", "data-bb-plugin": "preferences" });
  const target = element({ "data-testid": "save-button" }, panel);

  assert.equal(
    decorateElementPath("div > button", asElement(target)),
    'div[data-panel-id="settings"][data-bb-plugin="preferences"] > button[data-testid="save-button"]',
  );
});

test("decoration is idempotent and leaves absent or partial attributes alone", () => {
  const target = asElement(element({ "data-bb-plugin": "notes" }));
  const once = decorateElementPath("button", target);
  assert.equal(once, 'button[data-bb-plugin="notes"]');
  assert.equal(decorateElementPath(once, target), once);
  assert.equal(decorateElementPath("button", asElement(element())), "button");
});

test("in-memory overrides survive Agentation overwriting storage after add", () => {
  const overrides = createLocationOverrides();
  const target = asElement(element({ "data-testid": "save" }));
  const added = overrides.capture(
    { id: "a", elementPath: "button", comment: "new" },
    target,
  );
  assert.equal(added.elementPath, 'button[data-testid="save"]');

  const overwritten = [{ id: "a", elementPath: "button", comment: "new" }];
  assert.deepEqual(overrides.applyAll(overwritten), [
    { id: "a", elementPath: 'button[data-testid="save"]', comment: "new" },
  ]);
});

test("overrides preserve order, unrelated fields, and partial location fields", () => {
  const overrides = createLocationOverrides();
  overrides.capture(
    { id: "second", fullPath: "body > section", value: 2 },
    asElement(element({ "data-panel-id": "panel" }, element())),
  );
  const input = [
    { id: "first", elementPath: "p", value: 1 },
    { id: "second", fullPath: "body > section", value: 3 },
  ];

  assert.deepEqual(overrides.applyAll(input), [
    input[0],
    { id: "second", fullPath: 'body > section[data-panel-id="panel"]', value: 3 },
  ]);
});

test("delete and clear remove stale overrides", () => {
  const overrides = createLocationOverrides();
  const target = asElement(element({ "data-testid": "target" }));
  overrides.capture({ id: "a", elementPath: "button" }, target);
  overrides.capture({ id: "b", elementPath: "button" }, target);
  overrides.delete("a");
  assert.equal(overrides.apply({ id: "a", elementPath: "button" }).elementPath, "button");
  overrides.clear();
  assert.equal(overrides.apply({ id: "b", elementPath: "button" }).elementPath, "button");
});

test("copied locations use the restored paths in annotation order", () => {
  const output = [
    "### 1. button",
    "**Location:** button",
    "### 2. div",
    "**Full DOM Path:** body > div",
  ].join("\n");

  assert.equal(
    replaceCopiedLocations(output, [
      { elementPath: 'button[data-testid="save"]' },
      { fullPath: 'body[data-bb-plugin="shell"] > div' },
    ]),
    [
      "### 1. button",
      '**Location:** button[data-testid="save"]',
      "### 2. div",
      '**Full DOM Path:** body[data-bb-plugin="shell"] > div',
    ].join("\n"),
  );
});
