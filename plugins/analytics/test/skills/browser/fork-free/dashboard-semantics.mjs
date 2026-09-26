import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const source = readFileSync(resolve(root, "skills-dashboard/skills-dashboard.tsx"), "utf8");

for (const label of ["BB-visible current revisions", "Prompt-mentioned", "Registered-path command candidates", "Provider-native use/access", "Avg current SKILL.md footprint", "Enclosing command outcomes", "Raw contributors"]) assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
assert.match(source, /Summary totals are exact\. Showing/u);
assert.match(source, /No matching retained command observed since snapshot\. This is incomplete provider-access coverage/u);
assert.match(source, /These are current content-footprint estimates, not injected or consumed tokens\./u);
assert.match(source, /Provider-neutral/u);
assert.doesNotMatch(source, /label="Resolved"|label="Active staged"|label="Bridge configured"|label="Provider observed"/u);
assert.doesNotMatch(source, /Registered-path command candidates"[^]*?Read observed/u);
process.stdout.write(JSON.stringify({ status: "pass", checks: ["minimal-summary", "coverage-empty-states", "footprint-labeling", "bounded-outcomes-and-contributors", "provider-neutral-filter"] }) + "\n");
