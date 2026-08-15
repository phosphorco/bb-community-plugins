import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENTATION_THEME_STORAGE_KEY,
  oppositeTheme,
  seedAgentationThemeDefault,
} from "../lib/theme.ts";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set(AGENTATION_THEME_STORAGE_KEY, initial);
  }

  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    value() {
      return values.get(AGENTATION_THEME_STORAGE_KEY) ?? null;
    },
  };
}

test("the Agentation default is opposite the resolved bb theme", () => {
  assert.equal(oppositeTheme(true), "light");
  assert.equal(oppositeTheme(false), "dark");
});

test("a dark bb theme seeds a light Agentation default", () => {
  const storage = memoryStorage();

  assert.equal(seedAgentationThemeDefault(storage, true), "light");
  assert.equal(storage.value(), "light");
});

test("a light bb theme seeds a dark Agentation default", () => {
  const storage = memoryStorage();

  assert.equal(seedAgentationThemeDefault(storage, false), "dark");
  assert.equal(storage.value(), "dark");
});

test("an existing Agentation choice remains authoritative", () => {
  for (const existing of ["dark", "light"]) {
    for (const bbIsDark of [true, false]) {
      const storage = memoryStorage(existing);

      assert.equal(seedAgentationThemeDefault(storage, bbIsDark), null);
      assert.equal(storage.value(), existing);
    }
  }
});

test("storage failures leave Agentation free to use its built-in default", () => {
  const storage = {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      assert.fail("setItem must not run after a read failure");
    },
  };

  assert.equal(seedAgentationThemeDefault(storage, true), null);
});
