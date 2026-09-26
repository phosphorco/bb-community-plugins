import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConnection,
  createProject,
  createThread,
  appendStoredThreadEvent,
  listStoredEventRows,
  migrate,
  noopNotifier,
  upsertHost,
} from "../../../../../../fork/upstream/packages/db/src/index.ts";
import { createDeltaAssembler } from "../../../../../../fork/upstream/packages/provider-bridge-protocol/src/assembler/delta-assembler.ts";
import { hostDaemonSkillObservationEnvelopeSchema } from "../../../../../../fork/upstream/packages/host-daemon-contract/src/commands.ts";
import {
  appendSkillObservationEventInTransaction,
} from "../../../../../../fork/upstream/apps/server/src/services/threads/thread-events.ts";
import {
  listThreadEventRows,
  readSkillObservationPublicSource,
} from "../../../../../../fork/upstream/apps/server/src/services/threads/thread-data.ts";
import {
  getEventParentToolCallId,
  getEventProviderThreadId,
} from "../../../../../../fork/upstream/packages/thread-view/src/event-decode.ts";

const revision = "a".repeat(64);
const identifier = "b".repeat(64);
const dedupe = "c".repeat(64);

function observation(threadId: string, providerTurnId: string | null) {
  return {
    schemaVersion: 1 as const,
    observationId: `skillobs_v1_${identifier}`,
    dedupeKey: `skillobs_dedupe_v1_${dedupe}`,
    evidenceKind: "named-token-measurement" as const,
    status: "supported" as const,
    captureTrigger: "provider-context-report" as const,
    actor: { actorId: "actor-1", principalId: "principal-1", kind: "user" as const },
    threadId,
    providerThreadId: "provider-thread-1",
    providerSessionId: "provider-session-1",
    providerId: "claude-code",
    providerModel: "claude-sonnet-4-5-20250929",
    providerTurnId,
    providerEventId: "context-report-1",
    catalogRevision: revision,
    skill: {
      skillId: "skill-1",
      name: "release-notes",
      skillMarkdownPath: "/workspace/skills/release-notes/SKILL.md",
      sourceKind: "project" as const,
      sourceId: "project-1",
      pluginId: null,
      catalogRevision: revision,
      skillMarkdownRevision: revision,
      treeRevision: revision,
    },
    measurement: {
      method: "provider-reported-named-context-estimate" as const,
      serializer: "ClaudeContextUsageCollector skills.skillFrontmatter",
      tokenizer: "provider-undisclosed" as const,
      estimated: true as const,
      attribution: "per-skill" as const,
      bytes: null,
      tokens: 22,
    },
    failure: null,
    rawProviderMetadata: { category: "Skills", name: "release-notes" },
  };
}

const directory = await mkdtemp(join(tmpdir(), "bb-skill-observation-retention-"));
const databasePath = join(directory, "events.db");
try {
  const db = createConnection(databasePath);
  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: "skill-observation-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "skill-observation-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/skill-observation" },
  });
  const thread = createThread(db, noopNotifier, { projectId: project.id, providerId: "claude-code" });
  appendStoredThreadEvent(db, noopNotifier, {
    threadId: thread.id,
    type: "system/error",
    scope: { kind: "thread" },
    data: { message: "pre-observation legacy event" },
  });
  const payload = observation(thread.id, null);
  const assembler = createDeltaAssembler({ providerId: "claude-code", entropyPrefix: "skill-observation" });
  const events = assembler.assemble({
    threadId: thread.id,
    deltas: [{ kind: "extension.state", extensionKind: "bb/skill-observation", payload }],
  });
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event?.type, "skill/observed");
  if (event?.type !== "skill/observed") throw new Error("Expected a skill observation event");
  assert.equal(event.scope.kind, "thread");
  assert.equal(getEventProviderThreadId(event), "provider-thread-1");
  assert.equal(getEventParentToolCallId(event), undefined);
  assert.deepEqual(
    hostDaemonSkillObservationEnvelopeSchema.parse({ observation: event.observation, scope: event.scope }),
    { observation: payload, scope: { kind: "thread" } },
  );
  db.transaction(
    (tx) => {
      appendSkillObservationEventInTransaction(tx, {
        threadId: thread.id,
        observation: event.observation,
        scope: event.scope,
      });
      appendSkillObservationEventInTransaction(tx, {
        threadId: thread.id,
        observation: {
          ...payload,
          observationId: `skillobs_v1_${"d".repeat(64)}`,
          dedupeKey: `skillobs_dedupe_v1_${"e".repeat(64)}`,
          providerId: "codex",
          providerTurnId: null,
          evidenceKind: "provider-observed",
          status: "unsupported",
          measurement: null,
        },
        scope: { kind: "thread" },
      });
    },
    { behavior: "immediate" },
  );
  db.$client.close();

  const restarted = createConnection(databasePath);
  const source = readSkillObservationPublicSource(restarted, thread.id);
  assert.deepEqual(source.coverage, {
    epoch: "skill-observation-v1",
    preEpoch: "unknown",
    startsAtSequence: 2,
  });
  assert.equal(source.observations.length, 2);
  assert.equal(source.observations[0]?.observation.providerSessionId, "provider-session-1");
  assert.equal(source.observations[0]?.observation.providerTurnId, null);
  assert.equal(source.observations[1]?.observation.status, "unsupported");
  assert.equal(source.observations[1]?.observation.measurement, null);
  const allEvents = listThreadEventRows(restarted, { threadId: thread.id });
  assert.equal(allEvents.length, 3);
  assert.equal(allEvents[0]?.type, "system/error");

  const mismatched = assembler.assemble({
    threadId: thread.id,
    deltas: [{ kind: "extension.state", extensionKind: "bb/skill-observation", payload: observation("wrong-thread", null) }],
  });
  assert.deepEqual(mismatched, []);
  const oversized = assembler.assemble({
    threadId: thread.id,
    deltas: [{
      kind: "extension.state",
      extensionKind: "bb/skill-observation",
      payload: { ...payload, rawProviderMetadata: { evidence: "x".repeat(8193) } },
    }],
  });
  assert.deepEqual(oversized, []);
  restarted.$client.close();
  process.stdout.write(JSON.stringify({ status: "pass", checks: 7 }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
