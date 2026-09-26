import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const probeDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(probeDirectory, "../../../../../../");
const fixture = async (name) => JSON.parse(await readFile(resolve(probeDirectory, "fixtures", name), "utf8"));
const source = async (name) => await readFile(resolve(workspaceRoot, name), "utf8");
const has = (text, fragment, label) => assert.ok(text.includes(fragment), `${label}: expected ${JSON.stringify(fragment)}`);
const isWithin = (root, candidate) => {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith("..") && !path.includes("../");
};
const frontmatter = (skillMarkdown) => {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(skillMarkdown);
  assert.ok(match, "fixture SKILL.md must begin with YAML frontmatter");
  return match[0];
};

/**
 * These probes deliberately inspect the current bridge source and controlled raw
 * fixtures. They establish evidence boundaries; they do not simulate a provider
 * session or turn an aggregate report into a per-skill measurement.
 */
export async function runSuite() {
  const catalog = await fixture("controlled-skill-root.json");
  const events = await fixture("provider-events.json");
  const [adapter, runtimeProcess, runtime, codexBridge, codexTranslation, codexVisibility, claudeBridge, claudeClassification, claudeTranslation, claudeContextUsage] = await Promise.all([
    source("fork/upstream/packages/agent-runtime/src/bridge-protocol-adapter.ts"),
    source("fork/upstream/packages/agent-runtime/src/runtime-provider-process.ts"),
    source("fork/upstream/packages/agent-runtime/src/runtime.ts"),
    source("fork/upstream/plugins/provider-codex/src/bridge/bridge.ts"),
    source("fork/upstream/plugins/provider-codex/src/delta-translation.ts"),
    source("fork/upstream/plugins/provider-codex/src/visibility.ts"),
    source("fork/upstream/plugins/provider-claude-code/src/bridge/bridge.ts"),
    source("fork/upstream/plugins/provider-claude-code/src/tool-classification.ts"),
    source("fork/upstream/plugins/provider-claude-code/src/delta-translation.ts"),
    source("fork/upstream/plugins/provider-claude-code/src/bridge/context-usage.ts"),
  ]);

  const root = catalog.root;
  const expectedRequest = catalog.expectedBridgeRequest;
  assert.equal(expectedRequest.method, "skills/configure");
  assert.deepEqual(expectedRequest.params.roots, [root]);
  assert.equal(catalog.resolvedCatalog[0]?.skillRelativePath, "release-notes/SKILL.md");
  has(adapter, 'reason: "skills.configure not advertised"', "capability guard");
  has(adapter, "params: { roots: command.skillRoots }", "canonical configure serializer");
  has(runtimeProcess, 'type: "skills/configure"', "runtime startup request");
  has(runtimeProcess, "await sendJsonRpcRequest", "runtime bridge acknowledgement await");

  has(runtime, "Deferring the", "busy bridge restart diagnostic");
  has(runtime, "is mid-turn or has open background work", "busy bridge restart condition");

  has(codexBridge, "configuredSkillExtraRoots = params.roots.map((root) => root.path)", "Codex configure storage");
  has(codexBridge, 'method: "skills/extraRoots/set"', "Codex active-session update");
  has(codexBridge, "sendResult(id, { ok: true })", "Codex configure acknowledgement");
  has(codexTranslation, 'case "thread/tokenUsage/updated"', "Codex aggregate token source");
  has(codexTranslation, "kind: \"usage\"", "Codex usage translation");
  has(codexVisibility, '"skills/changed": "noise"', "Codex native skill signal classification");

  has(claudeBridge, "configuredSkillRoots = assembleSkillPlugins(request.params.roots)", "Claude configure assembly");
  has(claudeBridge, "sendResult(request.id, { ok: true })", "Claude configure acknowledgement");
  has(claudeClassification, 'case "Read"', "Claude Read classification");
  has(claudeClassification, 'shape: { type: "fileRead", path }', "Claude Read path preservation");
  has(claudeTranslation, "latestRequestContextTokens", "Claude request-context snapshot");
  has(claudeTranslation, "estimated: true", "Claude context snapshot qualification");
  has(claudeTranslation, "kind: \"usage\"", "Claude aggregate token translation");
  has(claudeContextUsage, "skillFrontmatter: z.array(namedTokens.extend({ source: z.string() }))", "Claude named frontmatter schema");
  has(claudeContextUsage, "entries = report.skills?.skillFrontmatter ?? []", "Claude Skills category entries");
  has(claudeContextUsage, "estimated: true", "Claude context report qualification");
  has(claudeContextUsage, "providerTurnId: null", "Claude context snapshot turn grain");
  has(claudeContextUsage, "timeout = setTimeout(() => resolve(null), 5_000)", "Claude context capture timeout");
  has(claudeContextUsage, "revision !== this.revision || !args.isCurrent()", "Claude stale capture suppression");
  has(claudeBridge, 'message.type === "result"', "Claude ContextUsage result trigger");
  has(claudeBridge, 'message.subtype === "compact_boundary"', "Claude ContextUsage compaction trigger");
  has(claudeBridge, "read: () => threadSession.session.getContextUsage()", "Claude ContextUsage provider read");

  const stagedRoot = root.path;
  const skillPath = `${stagedRoot}/release-notes/SKILL.md`;
  const subtreePath = `${stagedRoot}/release-notes/references/current.md`;
  const classifiedReads = events.claude.readEvents.map((event) => {
    const path = event.input.file_path ?? event.input.path;
    assert.equal(typeof path, "string", "controlled Claude Read has a path");
    assert.ok(isWithin(stagedRoot, path), `Read path escapes staged root: ${path}`);
    return { path, evidence: path === skillPath ? "registered-skill-md-read" : "skill-subtree-read" };
  });
  assert.deepEqual(classifiedReads, [
    { path: skillPath, evidence: "registered-skill-md-read" },
    { path: subtreePath, evidence: "skill-subtree-read" },
  ]);

  const skillMarkdown = catalog.files["release-notes/SKILL.md"];
  const serializedFrontmatter = frontmatter(skillMarkdown);
  const frontmatterBytes = Buffer.byteLength(serializedFrontmatter, "utf8");
  const frontmatterEstimate = Math.ceil(frontmatterBytes / 4);
  assert.ok(frontmatterEstimate > 0, "frontmatter local estimate must be positive");
  assert.equal(events.codex.tokenUsageEvent.params.tokenUsage.last.totalTokens, 151);
  assert.equal(events.claude.contextSnapshot.usage.input_tokens, 120);
  assert.equal(events.claude.resultUsage.usage.output_tokens, 31);
  const namedFrontmatter = events.claude.contextUsageReport.skills.skillFrontmatter;
  const skillsCategory = events.claude.contextUsageReport.categories.find((category) => category.name === "Skills");
  assert.deepEqual(namedFrontmatter, [{ name: "release-notes", source: "project", tokens: 22 }]);
  assert.equal(skillsCategory?.tokens, namedFrontmatter.reduce((total, entry) => total + entry.tokens, 0));
  assert.equal(events.claude.contextUsageCapture.providerTurnId, null);
  assert.equal(events.claude.contextUsageCapture.normalizedSemantics.estimated, true);
  assert.equal(events.claude.contextUsageCapture.collectorLimits.timeoutMs, 5_000);

  const fixtureDigest = createHash("sha256")
    .update(JSON.stringify({ catalog, events }))
    .digest("hex");
  return {
    suite: "observability-probe",
    status: "pass",
    checks: [
      { id: "resolved-catalog-and-configure-shape", status: "pass", details: "Controlled root serializes as canonical skills/configure roots and the current runtime awaits its bridge response." },
      { id: "busy-runtime-deferral-shape", status: "pass", details: "Current runtime emits a busy shared-process bridge-restart deferral; this is distinct from catalog resolution and does not claim a deferred provider catalog observation." },
      { id: "provider-configure-acknowledgement", status: "pass", details: "Both current bridges acknowledge skills/configure; Codex forwards extra roots to live connections while Claude stages local plugins for subsequent sessions." },
      { id: "claude-read-path-attribution", status: "pass", details: "Controlled Claude Read inputs preserve file_path/path; a registered SKILL.md and a contained subtree path map to separate read evidence classes." },
      { id: "claude-named-frontmatter-context-report", status: "pass", details: "Controlled Claude ContextUsage report preserves skills.skillFrontmatter name=release-notes, source=project, tokens=22 as a provider-reported estimated context snapshot with nullable providerTurnId." },
      { id: "qualified-context-and-token-reports", status: "pass", details: `Fixture ${fixtureDigest.slice(0, 12)} records aggregate Codex/Claude usage plus a local frontmatter byte estimate (${frontmatterBytes} UTF-8 bytes; ceil(bytes/4)=${frontmatterEstimate}).` },
      { id: "no-aggregate-apportionment", status: "pass", details: "Aggregate provider token reports remain session/turn scoped and are not assigned to release-notes or any other skill." },
    ],
    observations: [
      { id: "catalog-resolved", kind: "catalog", status: "observed", details: "Controlled resolved catalog names release-notes and its SKILL.md path before provider staging." },
      { id: "active-staged", kind: "catalog", status: "observed", details: "Canonical skills/configure transports the controlled root; it is separate from resolution." },
      { id: "bridge-acknowledged", kind: "bridge", status: "observed", details: "Codex and Claude bridge sources return { ok: true } for successful skills/configure." },
      { id: "busy-restart-deferral", kind: "runtime", status: "observed", details: "A bridge restart recommended for one thread is deferred when another hosted thread is busy." },
      { id: "codex-provider-catalog", kind: "provider", status: "unsupported", details: "skills/changed is classified as noise and no normalized per-skill catalog/activation/body event is exposed by the current Codex bridge." },
      { id: "codex-skill-attribution", kind: "provider", status: "unsupported", details: "Current Codex token usage is aggregate thread/turn usage; no native activation, SKILL.md read, subtree-read, or per-skill token attribution is present." },
      { id: "claude-read-skill-md", kind: "provider", status: "observed", details: "Claude Read preserves a file path; controlled registered SKILL.md input is attributable by containment to the staged skill tree." },
      { id: "claude-read-subtree", kind: "provider", status: "observed", details: "Claude Read preserves a file path; controlled references/current.md input is attributable by containment to the staged skill tree." },
      { id: "claude-activation", kind: "provider", status: "unsupported", details: "A Read path proves a read only, not native skill activation, body loading beyond that file, or instruction effect." },
      { id: "claude-context-snapshot", kind: "context", status: "observed", details: "Claude carries latest request context into an estimated context-window observation; fixture reports provider input_tokens=120 and contextWindow=200000." },
      { id: "claude-skill-frontmatter-report", kind: "context", status: "observed", details: "provider=claude-code; model=claude-sonnet-4-5-20250929; serializer=ClaudeContextUsageCollector skills.skillFrontmatter; method=provider-reported-context-usage-snapshot; name=release-notes; source=project; tokens=22; estimated=true; providerTurnId=null; capture=result|compact-boundary." },
      { id: "claude-context-capture-limit", kind: "context", status: "observed", details: "Collector suppresses superseded/non-current reads by revision, times out at 5000ms, and captures after result/compact-boundary; therefore snapshots can lag a turn and have no persistent cross-restart dedupe guarantee." },
      { id: "frontmatter-local-estimate", kind: "measurement", status: "observed", details: `Local only: serializer=utf8-frontmatter bytes=${frontmatterBytes}; tokenizer=none; method=ceil(bytes/4); estimate=${frontmatterEstimate}.` },
      { id: "codex-token-report", kind: "measurement", status: "observed", details: "provider=codex; model=unknown; tokenizer=provider-undisclosed; serializer=thread/tokenUsage/updated; method=provider-aggregate; tokens=151; skill attribution unsupported." },
      { id: "claude-token-report", kind: "measurement", status: "observed", details: "provider=claude-code; model=claude-sonnet-4-5-20250929; tokenizer=provider-undisclosed; serializer=SDK result usage; method=provider-aggregate; input=120 output=31; skill attribution unsupported." },
    ],
    limits: [
      "The probe is source- and fixture-bounded; it does not call a live provider or treat bridge acknowledgement as provider ingestion.",
      "Provider aggregate usage is never apportioned to a skill.",
      "Read-path containment is evidence of a file read, not activation or instruction effect.",
    ],
  };
}
