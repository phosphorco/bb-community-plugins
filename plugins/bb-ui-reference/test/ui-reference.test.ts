import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildThemeTokens,
  discoverThemeTokenVariables,
  frameSurfaceMap,
  groupThemeTokens,
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
