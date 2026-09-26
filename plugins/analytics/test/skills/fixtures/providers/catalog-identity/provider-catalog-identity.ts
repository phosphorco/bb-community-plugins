import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageInjectedSkillSources } from "../../../../../../../../fork/upstream/apps/host-daemon/src/injected-skills.ts";
import { skillsConfigureParamsSchema } from "../../../../../../../../fork/upstream/packages/provider-bridge-protocol/src/requests.ts";
import { ClaudeSkillObservationCatalog } from "../../../../../../../../fork/upstream/plugins/provider-claude-code/src/bridge/skill-instrumentation.ts";

const catalogRevision = "a".repeat(64);
const markdownRevision = "b".repeat(64);
const treeRevision = "c".repeat(64);

const session = {
  threadId: "thread-catalog-identity",
  providerSessionId: "session-catalog-identity",
  providerThreadId: "session-catalog-identity",
  providerModel: "claude-test",
} as const;

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-provider-catalog-identity-"));
  const sourceRootPath = join(dataDir, "canonical-source", "release-notes");
  try {
    await mkdir(join(sourceRootPath, "references"), { recursive: true });
    await writeFile(
      join(sourceRootPath, "SKILL.md"),
      "---\nname: release-notes\ndescription: test\n---\n\nCanonical source.\n",
      "utf8",
    );
    await writeFile(join(sourceRootPath, "references", "current.md"), "current\n");

    const staged = await stageInjectedSkillSources({
      dataDir,
      injectedSkillSources: [
        {
          kind: "workspace-path",
          sourceType: "project",
          name: "release-notes",
          description: "test",
          sourceRootPath,
          skillFilePath: join(sourceRootPath, "SKILL.md"),
          observation: {
            actor: {
              actorId: "server:skill-catalog",
              principalId: "project-identity",
              kind: "service",
            },
            catalogRevision,
            providerId: "claude-code",
            providerModel: null,
            providerSessionId: "skillcatalog-identity",
            threadId: session.threadId,
            skill: {
              skillId: "skill-release-notes",
              name: "release-notes",
              skillMarkdownPath: "/canonical/project/release-notes/SKILL.md",
              sourceKind: "plugin",
              sourceId: "source-release-tools",
              pluginId: "release-tools",
              catalogRevision,
              skillMarkdownRevision: markdownRevision,
              treeRevision,
            },
            measurement: {
              method: "local-content-estimate",
              serializer: "utf8-frontmatter",
              tokenizer: "none",
              estimated: true,
              attribution: "per-skill",
              bytes: 32,
              tokens: 8,
            },
            serializedCatalogFragment: "{\"name\":\"release-notes\"}",
          },
        },
      ],
    });
    const configured = skillsConfigureParamsSchema.parse({ roots: staged.skillRoots });
    const root = configured.roots[0];
    const identity = root?.skills[0]?.identity;
    assert.equal(root?.catalogRevision, catalogRevision);
    assert.deepEqual(identity, {
      skillId: "skill-release-notes",
      skillMarkdownPath: "/canonical/project/release-notes/SKILL.md",
      sourceKind: "plugin",
      sourceId: "source-release-tools",
      pluginId: "release-tools",
      catalogRevision,
      skillMarkdownRevision: markdownRevision,
      treeRevision,
    });

    const catalog = ClaudeSkillObservationCatalog.fromRoots(configured.roots);
    const stagedReadPath = join(root?.path ?? "", "release-notes", "SKILL.md");
    const [read] = catalog.observeRead({
      session,
      path: stagedReadPath,
      providerEventId: "read-canonical",
      providerTurnId: "turn-identity",
    });
    assert.equal(read?.catalogRevision, catalogRevision);
    assert.deepEqual(read?.skill, { name: "release-notes", ...identity });
    assert.equal(read?.rawProviderMetadata.path, stagedReadPath);

    const collisionRoots = [
      ...configured.roots,
      {
        ...root!,
        id: "global-skills:collision",
        skills: [
          {
            ...root!.skills[0]!,
            identity: {
              ...identity!,
              skillId: "skill-release-notes-collision",
              sourceId: "source-release-tools-collision",
              skillMarkdownPath: "/canonical/other/release-notes/SKILL.md",
            },
          },
        ],
      },
    ];
    const collisions = ClaudeSkillObservationCatalog.fromRoots(collisionRoots);
    assert.deepEqual(
      collisions.observeNamedFrontmatter({
        session,
        entries: [{ name: "release-notes", source: "project", tokens: 12 }],
        providerEventId: "ambiguous-name",
      }),
      [],
    );
    assert.equal(
      collisions.observeNamedFrontmatter({
        session,
        entries: [
          {
            name: "release-notes",
            source: "source-release-tools-collision",
            tokens: 12,
          },
        ],
        providerEventId: "exact-source",
      })[0]?.skill.skillId,
      "skill-release-notes-collision",
    );

    process.stdout.write(
      JSON.stringify({
        status: "pass",
        checks: [
          "typed-canonical-root",
          "staged-read-canonical-attribution",
          "same-name-ambiguity",
        ],
      }),
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

await main();
