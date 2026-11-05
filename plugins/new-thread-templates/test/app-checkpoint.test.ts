import { afterAll, expect, test } from "bun:test";
import { emptyDefinition } from "../model.ts";
import {
  readEditorCheckpoint,
  matchesEditorBaseline,
  removeEditorCheckpoint,
  writeEditorCheckpoint,
} from "../ui/editor-checkpoint.ts";
const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const records = new Map<string, string>();
const storage = {
  getItem: (key: string) => records.get(key) ?? null,
  setItem: (key: string, value: string) => {
    records.set(key, value);
  },
  removeItem: (key: string) => {
    records.delete(key);
  },
  key: (i: number) => [...records.keys()][i] ?? null,
  get length() {
    return records.size;
  },
};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: storage,
});
afterAll(() => {
  if (previous) Object.defineProperty(globalThis, "localStorage", previous);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
function original(id = crypto.randomUUID()) {
  return {
    ...emptyDefinition(id),
    fields: [
      {
        key: "amount",
        label: "Amount",
        type: "number" as const,
        required: true,
        order: 0,
        validation: { max: 10, min: 0 },
      },
    ],
  };
}
test("owner exact property-order reproduction removes semantic-equal decoded checkpoint silently", () => {
  records.clear();
  const definition = original();
  expect(
    writeEditorCheckpoint("owner", definition, JSON.stringify(definition), 1),
  ).toBeNull();
  const decoded = readEditorCheckpoint("owner", definition.id).value!;
  expect(Object.keys(decoded.definition.fields[0]!)).not.toEqual(
    Object.keys(definition.fields[0]!),
  );
  expect(
    matchesEditorBaseline(decoded.definition, JSON.stringify(definition)),
  ).toBe(true);
  expect(removeEditorCheckpoint("owner", definition)).toBeNull();
  expect(readEditorCheckpoint("owner", definition.id).value).toBeNull();
});
test("numeric map insertion order is semantic while later raw text, array order and other owners are retained", () => {
  records.clear();
  const definition = original();
  const first = { "fields.0.default": "-", "fields.0.min": "1e" },
    reordered = { "fields.0.min": "1e", "fields.0.default": "-" };
  expect(
    writeEditorCheckpoint(
      "owner",
      definition,
      JSON.stringify(definition),
      1,
      first,
    ),
  ).toBeNull();
  expect(removeEditorCheckpoint("owner", definition, reordered)).toBeNull();
  const changed = { ...definition, name: "Newer authored name" };
  writeEditorCheckpoint("owner", changed, JSON.stringify(definition), 1, {
    ...first,
    "fields.0.default": "-.",
  });
  expect(removeEditorCheckpoint("owner", definition, first)).toBe(
    "A newer local editor checkpoint was retained.",
  );
  expect(
    readEditorCheckpoint("owner", definition.id).value?.definition.name,
  ).toBe("Newer authored name");
  expect(
    readEditorCheckpoint("owner", definition.id).value?.numericText?.[
      "fields.0.default"
    ],
  ).toBe("-.");
  expect(removeEditorCheckpoint("other-owner", changed)).toBeNull();
  expect(readEditorCheckpoint("owner", definition.id).value).toBeTruthy();
  const array = {
    ...definition,
    fields: [
      ...definition.fields,
      {
        key: "other",
        label: "Other",
        type: "text" as const,
        required: false,
        order: 1,
      },
    ],
  };
  writeEditorCheckpoint("array", array, JSON.stringify(array), 1);
  expect(
    removeEditorCheckpoint("array", {
      ...array,
      fields: [...array.fields].reverse(),
    }),
  ).toBe("A newer local editor checkpoint was retained.");
});
