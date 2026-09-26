import assert from "node:assert/strict";

import Database from "better-sqlite3";

import { ForkFreeSkillProjector, type ForkFreeSkillSdk } from "../../../../extraction/fork-free-skill-projector.ts";
import { analyticsMigrations, AnalyticsStore } from "../../../../store.ts";
import { catalogSnapshot, probeEvents } from "../../fixtures/fork-free/thr-tn5pxvdf7j.mjs";

const thread = { id: "thr_tn5pxvdf7j", projectId: "proj_t8x9yhwnvc", environmentId: "env_tqsfutmr8b", providerId: "codex" };
const threadB = { id: "thr_second_project", projectId: "proj_second", environmentId: "env_second", providerId: "claude-code" };
const catalogB = { ...catalogSnapshot, projectId: threadB.projectId, environmentId: threadB.environmentId, entries: [{ skillId: "skill_second_project", name: "second-project", provider: null, scope: "bb-project", pluginId: null, filePath: "/workspace-b/.agents/skills/second-project/SKILL.md", contentRevision: "b".repeat(64), contentBytes: 12, registeredPaths: ["/workspace-b/.agents/skills/second-project/SKILL.md"], filesTruncated: false }] };
const eventsB = [{ ...probeEvents[1]!, id: "evt_second_started", threadId: threadB.id, seq: 1, createdAt: 1_789_751_301_000, data: { ...probeEvents[1]!.data, item: { ...(probeEvents[1]!.data.item as object), id: "item_second", command: "/usr/bin/zsh -lc 'cat /home/ubuntu/bb/.agents/skills/bb-performant-react/SKILL.md'" } } }];
const unreadableEntries = [
  { skillId: "skill_bb_deployment", name: "bb-deployment", provider: null, scope: "bb-project", pluginId: null, filePath: "/home/ubuntu/bb/.agents/skills/bb-deployment/SKILL.md", contentRevision: "d".repeat(64), contentBytes: 0, registeredPaths: ["/home/ubuntu/bb/.agents/skills/bb-deployment/SKILL.md"], filesTruncated: false },
  { skillId: "skill_bb_on_this_machine", name: "bb-on-this-machine", provider: null, scope: "bb-project", pluginId: null, filePath: "/home/ubuntu/bb/.agents/skills/bb-on-this-machine/SKILL.md", contentRevision: "e".repeat(64), contentBytes: 0, registeredPaths: ["/home/ubuntu/bb/.agents/skills/bb-on-this-machine/SKILL.md"], filesTruncated: false },
];

function harness() {
  let events = structuredClone(probeEvents);
  let deleted = false;
  let failFiles = false;
  let failReadableContent = false;
  let dimensions = { ...thread };
  const sdk = {
    skills: {
      list: async ({ projectId }: { projectId: string }) => ({ skills: (projectId === threadB.projectId ? catalogB.entries : [...catalogSnapshot.entries, ...unreadableEntries]).map((entry) => ({ id: entry.skillId, name: entry.name, provider: entry.provider, scope: entry.scope, pluginId: entry.pluginId, filePath: entry.filePath, description: null, manageable: false, registrySkillId: null })) }),
      getContent: async ({ skillId, path }: { skillId: string; path: string }) => {
        assert.equal(path, "SKILL.md", "getContent accepts the relative main file, never an absolute path");
        if (unreadableEntries.some((entry) => entry.skillId === skillId)) throw new Error('HTTP 502: Path "SKILL.md" escapes read root');
        if (failReadableContent) throw new Error("HTTP 502: content service unavailable");
        const entry = [...catalogSnapshot.entries, ...catalogB.entries].find((candidate) => candidate.skillId === skillId)!;
        return { content: "x".repeat(entry.contentBytes!), revision: entry.contentRevision! };
      },
      listFiles: async ({ skillId }: { skillId: string }) => {
        if (failFiles) throw new Error("fixture listFiles failed");
        const entry = [...catalogSnapshot.entries, ...catalogB.entries, ...unreadableEntries].find((candidate) => candidate.skillId === skillId)!;
        const root = entry.filePath.slice(0, entry.filePath.lastIndexOf("/") + 1);
        return { files: unreadableEntries.some((candidate) => candidate.skillId === skillId) ? [] : entry.registeredPaths.map((path) => path.slice(root.length)), truncated: false };
      },
    },
    threads: {
      list: async ({ projectId }: { projectId?: string }) => deleted ? [] : projectId === threadB.projectId ? [threadB] : [dimensions],
      get: async ({ threadId }: { threadId: string }) => {
        if (deleted) throw { name: "BbHttpError", status: 404, code: "thread_not_found" };
        return threadId === threadB.id ? threadB : dimensions;
      },
      events: { list: async ({ threadId }: { threadId: string }) => threadId === threadB.id ? eventsB : events },
    },
  } as unknown as ForkFreeSkillSdk;
  return { sdk, setEvents: (next: readonly unknown[]) => { events = [...next] as typeof events; }, setDeleted: (next: boolean) => { deleted = next; }, setFailFiles: (next: boolean) => { failFiles = next; }, setFailReadableContent: (next: boolean) => { failReadableContent = next; }, setDimensions: (next: typeof dimensions) => { dimensions = next; } };
}

const db = new Database(":memory:");
for (const migration of analyticsMigrations) db.exec(migration);
const store = new AnalyticsStore(db);
const fixture = harness();
const projector = new ForkFreeSkillProjector(fixture.sdk, store, () => 1_789_751_300_000);
const row = <Result>(sql: string, ...parameters: unknown[]): Result => {
  const result = db.prepare<unknown[], Result>(sql).get(...parameters);
  if (result === undefined) throw new Error(`expected a row for: ${sql}`);
  return result;
};

const first = await projector.captureForThread(thread, "thread.active");
assert.equal(first.capture.completeness, "complete");
assert.equal(first.sourceEventCount, 3);
assert.equal(first.promptMentionCount, 1);
assert.equal(first.commandCandidateCount, 2);
assert.equal(first.capture.snapshot!.entries.length, catalogSnapshot.entries.length + unreadableEntries.length, "unreadable content does not remove exact list/listFiles catalog membership");
for (const name of ["bb-deployment", "bb-on-this-machine"]) {
  const entry = first.capture.snapshot!.entries.find((candidate) => candidate.name === name)!;
  assert.equal(entry.contentRevision, null, `${name} keeps an unmeasured revision after the public path guard rejects content`);
  assert.equal(entry.contentBytes, null, `${name} keeps an unmeasured footprint after the public path guard rejects content`);
}
const performant = first.capture.snapshot!.entries.find((candidate) => candidate.name === "bb-performant-react")!;
assert.equal(performant.contentRevision, "9f96984c438da69afea434f07f9a32e9e47c29b488ca33f9c0b2b58de378bc0d");
assert.equal(performant.contentBytes, 6379);
assert.equal(row<{ provider_id: string }>("SELECT provider_id FROM analytics_fork_free_catalog_entries_v1 WHERE skill_id=?", catalogSnapshot.entries[0]!.skillId).provider_id, "codex");
assert.equal(row<{ provider_id: string }>("SELECT provider_id,project_id,environment_id FROM analytics_fork_free_source_events_v1 WHERE source_event_id=?", probeEvents[0]!.id).provider_id, "codex");
assert.equal(row<{ output_bytes: number }>("SELECT command_shell_wrapped,command_joined,execution_status,output_bytes FROM analytics_fork_free_command_candidates_v1 WHERE active_generation>0 ORDER BY registered_path LIMIT 1").output_bytes, 17283);
assert.equal(row<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_fork_free_command_candidates_v1'").sql.includes("command TEXT"), false, "command body is never persisted");
assert.equal(row<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_fork_free_command_candidates_v1'").sql.includes("output TEXT"), false, "output body is never persisted");

const beforeUnexpectedContentFailure = row<{ count: number }>("SELECT COUNT(*) AS count FROM analytics_fork_free_command_candidates_v1 WHERE active_generation>0").count;
fixture.setFailReadableContent(true);
const unexpectedContentFailure = await projector.refresh(thread.projectId, thread.environmentId);
assert.equal(unexpectedContentFailure.capture.completeness, "failed", "only the exact read-root containment error is optional");
assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM analytics_fork_free_command_candidates_v1 WHERE active_generation>0").count, beforeUnexpectedContentFailure, "unexpected getContent failure preserves the last good generation");
fixture.setFailReadableContent(false);

await projector.captureForThread(thread, "thread.active");
assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM analytics_fork_free_source_events_v1").count, 3, "exact replay is idempotent");
assert.throws(() => db.prepare(`INSERT INTO analytics_fork_free_command_candidates_v1 (source_started_event_id,skill_id,registered_path,thread_id,start_sequence,item_id,command_shell_wrapped,command_joined,execution_status,output_bytes,historical_revision,active_generation) VALUES ('bad','skill','/path','thread',1,'item',0,0,'pending',1,'forbidden',1)`).run(), /CHECK constraint failed/, "output byte metadata cannot bypass unknown historical revision");

fixture.setEvents([{ ...probeEvents[0], data: { ...probeEvents[0]!.data, requestId: "conflicting" } }, ...probeEvents.slice(1)]);
await assert.rejects(() => projector.refresh(thread.projectId, thread.environmentId), /Conflicting fork-free source event/);
assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM analytics_fork_free_command_candidates_v1 WHERE active_generation>0").count, 2, "conflict rolls back partial publication");

fixture.setEvents(probeEvents);
fixture.setDimensions({ ...thread, environmentId: "env_conflict" });
await assert.rejects(() => projector.refresh(thread.projectId, thread.environmentId), /Conflicting fork-free source event/, "an event cannot silently migrate to another authoritative environment");
fixture.setDimensions(thread);

fixture.setEvents([probeEvents[1]!]);
const pending = await projector.refresh(thread.projectId, thread.environmentId);
assert.equal(pending.commandCandidateCount, 2);
assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM analytics_fork_free_command_candidates_v1 WHERE active_generation>0 AND execution_status='pending'").count, 2, "unmatched starts remain retained as pending candidates");

await projector.refresh(threadB.projectId, threadB.environmentId);
assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM analytics_fork_free_command_candidates_v1 WHERE active_generation>0 AND source_started_event_id=?", probeEvents[1]!.id).count, 2, "a second-project refresh neither retracts nor cross-matches the first project");
assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM analytics_fork_free_command_candidates_v1 WHERE active_generation>0 AND source_started_event_id='evt_second_started'").count, 0, "a project-B catalog cannot match a project-A path");

const beforeFailure = row<{ count: number }>("SELECT COUNT(*) AS count FROM analytics_fork_free_command_candidates_v1 WHERE active_generation>0 AND source_started_event_id=?", probeEvents[1]!.id).count;
fixture.setFailFiles(true);
const failed = await projector.refresh(thread.projectId, thread.environmentId);
assert.equal(failed.capture.completeness, "failed");
assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM analytics_fork_free_command_candidates_v1 WHERE active_generation>0 AND source_started_event_id=?", probeEvents[1]!.id).count, beforeFailure, "a failed catalog capture retains prior good evidence");
fixture.setFailFiles(false);

fixture.setDeleted(true);
await projector.refresh(thread.projectId, thread.environmentId);
assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM analytics_fork_free_source_events_v1 WHERE active_generation>0 AND project_id=? AND environment_id IS ?", thread.projectId, thread.environmentId).count, 0, "only an exact get(404/thread_not_found) reconciles deletion");

assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM analytics_fork_free_catalog_captures_v1 WHERE completeness='failed'").count, 1, "the latest failed capture is retained as bounded coverage while superseded failures are compacted");
assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM analytics_fork_free_catalog_captures_v1 WHERE completeness='complete' AND project_id=? AND environment_id IS ?", thread.projectId, thread.environmentId).count, 1, "the last-good complete catalog remains available beside the latest failure");

process.stdout.write(JSON.stringify({ status: "pass", checks: 31 }));
