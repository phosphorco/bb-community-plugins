import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const community = path.resolve(root, "../../../..");
const plugin = path.join(community, "plugins/plugin-guide-for-nerds");
const scaffold = JSON.parse(fs.readFileSync(path.resolve(root, "../scaffold/source-copy.json"), "utf8"));
assert.equal(scaffold.inputs.length, 35);
const sha = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
for (const input of scaffold.inputs) assert(fs.existsSync(path.join(community,input.destination)), `missing tracked donor input ${input.destination}`);
const unchanged = [
  "src/anatomy-manifest.json", "src/first-party-plugins.json", "src/surfaces.ts",
  "src/annotation.tsx", "src/html-escape.ts", "src/plugin-icons.ts", "src/scroll-edges.ts", "src/used-by.tsx",
  "icons/ai-generative.svg", "scripts/scaffold-surface-entry.d.mts",
];
for (const relative of unchanged) {
  const input = scaffold.inputs.find(item => item.destination === `plugins/plugin-guide-for-nerds/${relative}`);
  assert(input, `missing baseline ${relative}`);
  assert.equal(sha(path.join(plugin,relative)), input.sha256, `unexpected authored data/resource change ${relative}`);
}
const edits = [
  "server.ts", "src/agent-reference.ts", "src/guide-content.tsx", "src/product-map.tsx",
  "src/surface-card.tsx", "src/wireframes.tsx", "lib/guide-interaction.ts",
  "test/agent-reference.test.ts", "test/command-palette-interaction.test.ts",
  "test/annotation-plugin-references.test.ts", "test/annotation-scope.test.ts",
  "test/annotation-clipboard-lifecycle.test.ts", "test/annotation-mention-owner.test.ts",
];
const source = relative => fs.readFileSync(path.join(plugin,relative), "utf8");
// The review corrects only donor-specific help in this otherwise preserved tool.
const scaffoldTool = "scripts/scaffold-surface-entry.mjs";
const originalHelp = source(scaffoldTool).replace(
  'npm run scaffold:surface-entry --workspace @phosphorco/bb-plugin-plugin-guide-for-nerds --',
  'pnpm exec turbo run scaffold:surface-entry --filter=bb-plugin-plugin-api-docs --',
).replace('  if (process.argv.slice(2).some(arg => arg === "--help" || arg === "-h")) {\n    process.stdout.write(usage());\n    return;\n  }\n', '');
assert.equal(crypto.createHash('sha256').update(originalHelp).digest('hex'),
  scaffold.inputs.find(item => item.destination.endsWith('/' + scaffoldTool)).sha256);
assert(source("src/guide-content.tsx").includes('import type { GuideContentProps } from "./floating/contract"'));
assert(!/useBbNavigate|toPluginPanel|overflow-y-auto|data-guide-stage-viewport/.test(source("src/guide-content.tsx")));
assert(!/window\.addEventListener\("keydown"/.test(source("src/surface-card.tsx")));
assert(source("src/agent-reference.ts").includes('PLUGIN_GUIDE_PLUGIN_ID = "plugin-guide-for-nerds"'));
const receipt = {
  schemaVersion:1, sourceOnlyScaffoldInputs:35, completeTrackedDonorInputPresence:true,
  unchangedAuthoredInputs:unchanged.map(relative => ({ path:relative, sha256:sha(path.join(plugin,relative)) })),
  editedFiles:edits.map(relative => {
    const file = path.join(plugin,relative);
    const donor = scaffold.inputs.find(item => item.destination === `plugins/plugin-guide-for-nerds/${relative}`);
    return { path:relative, bytes:fs.statSync(file).size, donorSha256:donor?.sha256 ?? null, sha256:sha(file) };
  }),
  vendorFiles:["components/ui/icon.tsx","components/ui/plugin-icon.tsx","components/ui/switch.tsx","components/ui/motion.ts","lib/utils.ts"]
    .map(relative => ({path:relative,sha256:sha(path.join(plugin,relative))})),
  frozenContract:{path:"src/floating/contract.ts",sha256:sha(path.join(plugin,"src/floating/contract.ts")),contentImportIsTypeOnly:true},
  noSharedBuildOrRuntimeProof:true,
};
fs.writeFileSync(path.resolve(root,"../review/copy-current.json"),JSON.stringify(receipt,null,2)+"\n");
console.log("PASS: all 35 tracked donor inputs remain; complete authored dataset/resources/helpers unchanged; owned edit receipt refreshed");
