import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildThemeTokens,
  discoverThemeTokenVariables,
  frameSurfaceMap,
  groupThemeTokens,
  NATIVE_UI_GROUPS,
  PUBLIC_THEME_TOKEN_VARIABLES,
  SURFACE_MAP_SECTIONS,
} from "../ui-reference.ts";

test("the pinned public bridge fallback is complete and unique", () => {
  const tokens = buildThemeTokens();
  assert.equal(PUBLIC_THEME_TOKEN_VARIABLES.length, 54);
  assert.equal(new Set(tokens.map((token) => token.variable)).size, tokens.length);
  assert.equal(new Set(tokens.map((token) => token.utility)).size, tokens.length);
  assert.ok(tokens.every((token) => token.variable.startsWith("--")));
});

test("runtime bridge discovery adds future semantic colors without duplicating the fallback", () => {
  const discovered = discoverThemeTokenVariables([
    ":root { --color-primary: var(--primary); --color-brand-new: var(--brand-new); }",
    ".ignored { color: var(--not-a-bridge); }",
  ]);
  assert.deepEqual(discovered, ["--primary", "--brand-new"]);
  const tokens = buildThemeTokens(discovered);
  assert.equal(tokens.filter((token) => token.variable === "--primary").length, 1);
  assert.ok(tokens.some((token) => token.variable === "--brand-new"));
});

test("teaching groups lead with colorful roles and enumerate every token once", () => {
  const tokens = buildThemeTokens(["--brand-new"]);
  const groups = groupThemeTokens(tokens);
  assert.deepEqual(groups.slice(0, 3).map((group) => group.title), [
    "Color & emphasis",
    "Status & change",
    "Interaction & selection",
  ]);
  assert.deepEqual(groups.at(-1)?.tokens.map((token) => token.variable), ["--brand-new"]);
  const groupedVariables = groups.flatMap((group) => group.tokens.map((token) => token.variable));
  assert.equal(groupedVariables.length, tokens.length);
  assert.equal(new Set(groupedVariables).size, tokens.length);
  assert.ok(tokens.every((token) => token.guidance.length > 0));
  assert.ok(buildThemeTokens().every((token) => token.guidance !== "A semantic color exposed by the current BB theme."));
});

test("the detailed surface map exposes one jump target per quadrant", () => {
  assert.deepEqual(SURFACE_MAP_SECTIONS.map((section) => section.id), [1, 2, 3, 4]);
  assert.ok(SURFACE_MAP_SECTIONS.every((section) => section.title.startsWith(`${section.id} · `)));
  assert.deepEqual(SURFACE_MAP_SECTIONS.map((section) => section.tabLabel), [
    "App Shell",
    "Thread Workspace",
    "Composer",
    "Plugin-owned layouts",
  ]);
  assert.deepEqual(SURFACE_MAP_SECTIONS.map((section) => section.viewBox), [
    "24 4 772 462",
    "804 4 772 462",
    "24 462 772 542",
    "804 462 772 542",
  ]);
});

test("the native UI catalog distinguishes host capabilities from registry source", () => {
  assert.deepEqual(NATIVE_UI_GROUPS.map((group) => group.title), [
    "Host-owned experiences",
    "Controls & fields",
    "Menus & overlays",
    "Layout & navigation",
    "Content & feedback",
  ]);
  const entries = NATIVE_UI_GROUPS.flatMap((group) => group.entries);
  assert.equal(entries.filter((entry) => entry.kind === "host").length, 9);
  assert.equal(entries.filter((entry) => entry.kind === "registry").length, 44);
  assert.ok(entries.some((entry) => entry.name === "experimental_NewThreadComposer" && entry.experimental));
  assert.ok(entries.some((entry) => entry.name === "DropdownMenu" && entry.target === "@bb/dropdown-menu"));
  assert.ok(entries.some((entry) => entry.name === "Button" && entry.target === "@bb/button"));
  assert.ok(entries.every((entry) => entry.description.length > 0));
});

test("each native UI entry has one 80 by 40 SVG illustration", () => {
  const entries = NATIVE_UI_GROUPS.flatMap((group) => group.entries);
  const sprite = readFileSync(new URL("../assets/bb-native-ui-icons.svg", import.meta.url), "utf8");
  assert.equal(new Set(entries.map((entry) => entry.icon)).size, entries.length);
  for (const entry of entries) {
    assert.match(sprite, new RegExp(`<symbol id="${entry.icon}" viewBox="0 0 80 40">`));
  }
});

test("surface-map framing replaces sprite dimensions with an independent view", () => {
  const framed = frameSurfaceMap('<svg width="1600" height="1000" viewBox="0 0 1600 1000" role="img"><g/></svg>', "24 4 772 462");
  assert.match(framed, /^<svg role="img" viewBox="24 4 772 462" preserveAspectRatio="xMidYMid meet">/);
  assert.doesNotMatch(framed, /width="1600"|height="1000"/);
});

test("the detailed map and reusable legend keep their separate documentation contracts", () => {
  const map = readFileSync(new URL("../assets/bb-plugin-ui-surfaces.svg", import.meta.url), "utf8");
  const legend = readFileSync(new URL("../assets/bb-plugin-ui-surfaces-legend.svg", import.meta.url), "utf8");
  for (const label of ["App shell view", "Thread workspace view", "Composer view", "Plugin-owned layouts view"]) {
    assert.match(map, new RegExp(`aria-label="${label}"`));
  }
  assert.doesNotMatch(map, /aria-label="Legend"/);
  for (const label of ["Native BB UI", "Additive plugin surface", "Replaceable region", "Trusted page code"]) {
    assert.match(legend, new RegExp(`>${label}<`));
  }
});
