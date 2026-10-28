import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MACHINE_SECTIONS, machineInSection, machineSectionsError, MAX_EXPANDED_PATTERN_CHARS, orderMachinesBySections, parseMachineSections } from "../machine-sections.ts";

function machine(label: string, machineId = label) {
  return { label, machine: { machineId } };
}

test("parses globs, quoted titles, comments, and brace alternation", () => {
  const { sections, errors } = parseMachineSections([
    `* "All"`,
    `# builders`,
    ``,
    `b*-hel "Hetzner Builder"`,
    `{palani,cole,florien,adam}-* "Dev Machines"`,
    `rosetta`,
    `bb-? 'Single letter'`,
  ].join("\n"));
  assert.deepEqual(errors, []);
  assert.deepEqual(sections.map((section) => [section.slug, section.title, section.pattern]), [
    ["all", "All", "*"],
    ["hetzner-builder", "Hetzner Builder", "b*-hel"],
    ["dev-machines", "Dev Machines", "{palani,cole,florien,adam}-*"],
    ["rosetta", "rosetta", "rosetta"],
    ["single-letter", "Single letter", "bb-?"],
  ]);
  const [all, builders, dev] = sections;
  const fleet = ["bb-machine", "b3-hel", "palani-gort", "b4-hel", "palani", "rosetta", "BB server"].map((label) => machine(label));
  assert.equal(fleet.filter((entry) => machineInSection(all!, entry)).length, fleet.length);
  assert.deepEqual(fleet.filter((entry) => machineInSection(builders!, entry)).map((entry) => entry.label), ["b3-hel", "b4-hel"]);
  assert.deepEqual(fleet.filter((entry) => machineInSection(dev!, entry)).map((entry) => entry.label), ["palani-gort"]);
  assert.ok(machineInSection(builders!, machine("Builder one", "B1-HEL")), "machine IDs match case-insensitively");
});

test("treats regular-expression characters literally and rejects colliding titles", () => {
  const { sections, errors } = parseMachineSections(`a.b "Dots"\nx+y "Plus"\n(z)|w "Parens"`);
  assert.deepEqual(errors, []);
  assert.ok(machineInSection(sections[0]!, machine("a.b")));
  assert.ok(!machineInSection(sections[0]!, machine("axb")));
  assert.ok(machineInSection(sections[1]!, machine("x+y")));
  assert.ok(machineInSection(sections[2]!, machine("(z)|w")));
  assert.match(machineSectionsError(`a "Dev"\nb "Dev!"`) ?? "", /Line 2 title matches line 1's/);
});

test("matches adversarial wildcards and nested braces without backtracking blowup", () => {
  const { sections } = parseMachineSections(`${"*a".repeat(120)}b "Stress"\n{b{1,2},c}-* "Nested"`);
  const started = performance.now();
  assert.ok(!machineInSection(sections[0]!, machine("a".repeat(96))));
  assert.ok(performance.now() - started < 250);
  assert.deepEqual(sections[1]!.alternatives, ["b1-*", "b2-*", "c-*"]);
  assert.ok(machineInSection(sections[1]!, machine("B2-hel")));
  assert.ok(!machineInSection(sections[1]!, machine("b3-hel")));
  assert.match(machineSectionsError(`{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b} "Too many"`) ?? "", /more than 64 alternatives/);
});

test("reports line-numbered errors and accepts the default", () => {
  assert.equal(machineSectionsError(DEFAULT_MACHINE_SECTIONS), null);
  assert.match(machineSectionsError(`*\n{a,b "Broken"`) ?? "", /^Line 2 has an unclosed \{\.$/);
  assert.match(machineSectionsError(`a} "Broken"`) ?? "", /Line 1 has an unmatched \}/);
  assert.match(machineSectionsError(`a "Unterminated`) ?? "", /Line 1 has an unterminated quoted title/);
  assert.match(machineSectionsError(Array.from({ length: 33 }, (_, index) => `m${index}`).join("\n")) ?? "", /Line 33 exceeds the 32-section limit/);
});

test("orders machines by their most specific sections, then natural names", () => {
  const { sections } = parseMachineSections(`* "All"\nb*-hel "Hetzner Builder"\n{palani,cole,florien,adam}-* "Dev Machines"`);
  const fleet = ["bb-machine", "b3-hel", "palani-gort", "b4-hel", "palani", "b2-hel", "b10-hel", "rosetta", "bb-host", "BB server"].map((label) => machine(label));
  assert.deepEqual(orderMachinesBySections(fleet, sections).map((entry) => entry.label), [
    "palani-gort",
    "b2-hel", "b3-hel", "b4-hel", "b10-hel",
    "BB server", "bb-host", "bb-machine", "palani", "rosetta",
  ]);
  const unsectioned = parseMachineSections(`b*-hel "Hetzner Builder"`).sections;
  assert.deepEqual(orderMachinesBySections([machine("alpha"), machine("b1-hel")], unsectioned).map((entry) => entry.label), ["b1-hel", "alpha"]);
});

test("orders overlapping sections the same way for every input permutation", () => {
  const { sections } = parseMachineSections(`{m,z,a} "Common"\n{z,x1,x2} "X"\n{a,y1,y2} "Y"`);
  const labels = ["m", "z", "a", "x1", "x2", "y1", "y2"];
  const expected = orderMachinesBySections(labels.map((label) => machine(label)), sections).map((entry) => entry.label);
  for (let shift = 1; shift < labels.length; shift += 1) {
    const rotated = [...labels.slice(shift), ...labels.slice(0, shift)];
    assert.deepEqual(orderMachinesBySections(rotated.map((label) => machine(label)), sections).map((entry) => entry.label), expected);
    assert.deepEqual(orderMachinesBySections([...rotated].reverse().map((label) => machine(label)), sections).map((entry) => entry.label), expected);
  }
});

test("rejects empty and over-complex configurations in the shared validator", () => {
  for (const text of ["", "   \n\t", "# only a comment"]) assert.equal(machineSectionsError(text), "Add at least one section.");
  const heavy = Array.from({ length: 32 }, (_, index) => `*${"a".repeat(80)}${"{b,c}".repeat(6)} "S${index}"`).join("\n");
  assert.match(machineSectionsError(heavy) ?? "", new RegExp(`at most ${MAX_EXPANDED_PATTERN_CHARS}`));
  const fleet = Array.from({ length: 256 }, (_, index) => machine(`${"a".repeat(90)}${index}`));
  const started = performance.now();
  // Heaviest accepted shape: wildcard-dense lines filling the budget.
  const accepted = parseMachineSections(Array.from({ length: 4 }, (_, index) => `*${"a*".repeat(124)}b "Edge ${index}"`).join("\n"));
  assert.deepEqual(accepted.errors, []);
  orderMachinesBySections(fleet, accepted.sections);
  assert.ok(performance.now() - started < 1_000, "an accepted configuration orders 256 long names promptly");
});
