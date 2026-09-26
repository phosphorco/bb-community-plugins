import assert from "node:assert/strict";
import { relative, resolve } from "node:path";
import { skillObservationSchema } from "../../../../../../../fork/upstream/packages/domain/src/skill-observation.ts";
// This fixture is executed as native ESM by the acceptance harness. Its values
// are validated below by the production schema rather than a parallel TS shape.
// @ts-expect-error executable .mjs fixture intentionally has no declaration file
import { catalogDelivery, claudeProvider, codexProvider, expectedCurrentSkill, revisions } from "./skill-observation-v1.mjs";

type Observation = Record<string, unknown>;

function accepts(label: string, value: Observation): void {
  assert.deepEqual(skillObservationSchema.parse(value), value, label);
}

function rejects(label: string, value: Observation): void {
  assert.equal(skillObservationSchema.safeParse(value).success, false, label);
}

function readPath(value: Observation): string {
  const metadata = value.rawProviderMetadata as Record<string, unknown>;
  const path = metadata.path;
  if (typeof path !== "string") throw new Error("Read fixture must retain a path");
  return path;
}

function pathWithin(skillMarkdownPath: string, path: string): boolean {
  const root = resolve(skillMarkdownPath, "..");
  const candidate = resolve(path);
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.includes("..\\"));
}

function selectCurrentSnapshots(snapshots: Observation[]): {
  admitted: string[];
  duplicate: string[];
  late: string[];
} {
  const admitted: string[] = [];
  const duplicate: string[] = [];
  const late: string[] = [];
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    const observedSkill = snapshot.skill as Record<string, unknown>;
    const current = observedSkill.catalogRevision === revisions.catalogCurrent
      && observedSkill.skillMarkdownRevision === revisions.markdownCurrent
      && observedSkill.treeRevision === revisions.treeCurrent;
    if (!current) {
      late.push(snapshot.observationId as string);
      continue;
    }
    const dedupeKey = snapshot.dedupeKey as string;
    if (seen.has(dedupeKey)) {
      duplicate.push(snapshot.observationId as string);
      continue;
    }
    seen.add(dedupeKey);
    admitted.push(snapshot.observationId as string);
  }
  return { admitted, duplicate, late };
}

function runCatalog(): string[] {
  accepts("initial resolved catalog", catalogDelivery.initialResolved);
  accepts("current resolved catalog", catalogDelivery.currentResolved);
  accepts("busy catalog deferral", catalogDelivery.busyDeferral);
  accepts("failed bridge configuration", catalogDelivery.failedConfiguration);
  accepts("same-name distinct-path catalog entry", catalogDelivery.sameNameDifferentPath);
  rejects("wrong revision negative control", catalogDelivery.wrongRevision);

  assert.equal(catalogDelivery.busyDeferral.status, "failure");
  assert.equal(catalogDelivery.busyDeferral.captureTrigger, "busy-runtime-deferral");
  assert.equal(catalogDelivery.failedConfiguration.status, "failure");
  assert.equal(catalogDelivery.failedConfiguration.captureTrigger, "bridge-configure-acknowledgement");
  assert.notEqual(catalogDelivery.initialResolved.dedupeKey, catalogDelivery.currentResolved.dedupeKey);
  assert.notEqual(catalogDelivery.initialResolved.skill.treeRevision, catalogDelivery.currentResolved.skill.treeRevision);
  assert.equal(catalogDelivery.currentResolved.skill.name, catalogDelivery.sameNameDifferentPath.skill.name);
  assert.notEqual(catalogDelivery.currentResolved.skill.skillMarkdownPath, catalogDelivery.sameNameDifferentPath.skill.skillMarkdownPath);
  assert.notEqual(catalogDelivery.currentResolved.skill.skillId, catalogDelivery.sameNameDifferentPath.skill.skillId);
  return [
    "busy-deferral-and-failed-config", "revision-and-path-name-collision", "wrong-revision-rejected",
  ];
}

function runCodex(): string[] {
  accepts("Codex bridge acknowledgement", codexProvider.bridgeAcknowledged);
  accepts("unsupported Codex native attribution", codexProvider.unsupportedNativeAttribution);
  accepts("unassigned aggregate usage", codexProvider.aggregateUsage);
  rejects("aggregate apportionment negative control", codexProvider.apportionedAggregate);

  assert.equal(codexProvider.unsupportedNativeAttribution.status, "unsupported");
  assert.equal(codexProvider.unsupportedNativeAttribution.measurement, null);
  assert.equal(codexProvider.aggregateUsage.skill, null);
  assert.equal(codexProvider.aggregateUsage.measurement.attribution, "aggregate-unassigned");
  return ["unsupported-native-attribution", "aggregate-unassigned", "aggregate-apportionment-rejected"];
}

function runClaude(): string[] {
  accepts("registered SKILL.md Read", claudeProvider.registeredSkillMarkdownRead);
  accepts("contained subtree Read", claudeProvider.containedSubtreeRead);
  accepts("outside-tree Read", claudeProvider.outsideTreeRead);
  accepts("current named frontmatter report", claudeProvider.currentFrontmatterSnapshot);
  accepts("duplicate named frontmatter report", claudeProvider.duplicateCurrentFrontmatterSnapshot);
  accepts("late named frontmatter report", claudeProvider.lateFrontmatterSnapshot);

  assert.equal(pathWithin(expectedCurrentSkill.skillMarkdownPath, readPath(claudeProvider.registeredSkillMarkdownRead)), true);
  assert.equal(pathWithin(expectedCurrentSkill.skillMarkdownPath, readPath(claudeProvider.containedSubtreeRead)), true);
  assert.equal(pathWithin(expectedCurrentSkill.skillMarkdownPath, readPath(claudeProvider.outsideTreeRead)), false, "an outside path is not attributed by name alone");
  assert.equal(claudeProvider.currentFrontmatterSnapshot.providerTurnId, null, "named frontmatter reports are session scoped");
  assert.equal(claudeProvider.currentFrontmatterSnapshot.measurement.estimated, true);
  assert.equal(claudeProvider.currentFrontmatterSnapshot.measurement.method, "provider-reported-named-context-estimate");
  assert.equal(claudeProvider.duplicateCurrentFrontmatterSnapshot.dedupeKey, claudeProvider.currentFrontmatterSnapshot.dedupeKey);
  assert.notEqual(claudeProvider.lateFrontmatterSnapshot.skill.treeRevision, revisions.treeCurrent);
  assert.notEqual(claudeProvider.lateFrontmatterSnapshot.skill.skillMarkdownRevision, revisions.markdownCurrent);
  const selected = selectCurrentSnapshots([
    claudeProvider.currentFrontmatterSnapshot,
    claudeProvider.duplicateCurrentFrontmatterSnapshot,
    claudeProvider.lateFrontmatterSnapshot,
  ]);
  assert.deepEqual(selected.admitted, [claudeProvider.currentFrontmatterSnapshot.observationId]);
  assert.deepEqual(selected.duplicate, [claudeProvider.duplicateCurrentFrontmatterSnapshot.observationId]);
  assert.deepEqual(selected.late, [claudeProvider.lateFrontmatterSnapshot.observationId]);
  return [
    "conservative-read-containment", "nullable-estimated-frontmatter", "duplicate-and-late-snapshot-rejection",
  ];
}

const scenario = process.argv[2];
let checks: string[];
if (scenario === "catalog-delivery") checks = runCatalog();
else if (scenario === "provider-codex") checks = runCodex();
else if (scenario === "provider-claude") checks = runClaude();
else throw new Error(`unknown provider instrument scenario ${String(scenario)}`);

process.stdout.write(JSON.stringify({ status: "pass", scenario, checks }));
