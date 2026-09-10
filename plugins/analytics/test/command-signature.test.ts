import assert from "node:assert/strict";
import test from "node:test";

import { describeCommandExecution } from "../command-signature.ts";

test("keeps quoted separators out of command composition", () => {
  assert.deepEqual(describeCommandExecution('rg "a|b" "src > docs"'), {
    binary: "rg",
    argument1: "<redacted>",
    argument2: "<redacted>",
    usesHelp: false,
    shape: "simple",
    shellWrapped: false,
    attributionEligible: true,
  });
});

test("recognizes shell wrappers, pipelines, joins, and help flags", () => {
  assert.deepEqual(describeCommandExecution('zsh -lc "git --help | head -20 && echo done"'), {
    binary: "git",
    argument1: "--help",
    argument2: null,
    usesHelp: true,
    shape: "pipeline_and_joined",
    shellWrapped: true,
    attributionEligible: false,
  });
});

test("does not treat a redirect target as a command argument", () => {
  assert.deepEqual(describeCommandExecution("rg -n needle > /tmp/out"), {
    binary: "rg",
    argument1: "-n",
    argument2: "<redacted>",
    usesHelp: false,
    shape: "simple",
    shellWrapped: false,
    attributionEligible: true,
  });
});

test("retains only safe flags and subcommands as arguments", () => {
  assert.deepEqual(describeCommandExecution("rg -n private-search-term /private/path"), {
    binary: "rg",
    argument1: "-n",
    argument2: "<redacted>",
    usesHelp: false,
    shape: "simple",
    shellWrapped: false,
    attributionEligible: true,
  });
});

test("retains allowlisted subcommands without retaining arbitrary values", () => {
  assert.deepEqual(describeCommandExecution("git status private-branch-name"), {
    binary: "git",
    argument1: "status",
    argument2: "<redacted>",
    usesHelp: false,
    shape: "simple",
    shellWrapped: false,
    attributionEligible: true,
  });
});
