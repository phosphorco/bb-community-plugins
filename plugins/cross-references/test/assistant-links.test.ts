import assert from "node:assert/strict";
import test from "node:test";
import { assistantLinkLabel, extractAssistantLinkCandidates, resolveAssistantLinks } from "../assistant-links.ts";

test("Markdown collection deduplicates by exact URL using the latest message time and excludes code/images", () => {
  const rows = extractAssistantLinkCandidates([
    { text: "[Earlier](https://example.test/a?x=1#one) `https://code.test` ![image](https://image.test/i)", createdAt: 10 },
    { text: "[Latest](https://example.test/a?x=1#one) <https://example.test/a?x=2#one>\n```\nhttps://fenced.test\n```", createdAt: 20 },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(row => row.url.includes("x=1")), { url: "https://example.test/a?x=1#one", label: "Latest", lastSeenAt: 20 });
  assert.ok(rows.every(row => row.lastSeenAt === 20));
});

test("collection strips authority credentials, rejects sensitive URL parameters and bounds Unicode labels", () => {
  const rows = extractAssistantLinkCandidates([{ text: "<https://user:secret@example.test/a> [token](https://example.test/a?access_token=secret) [mail](mailto:a@b.test)", createdAt: 10 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.url, "https://example.test/a");
  assert.equal(assistantLinkLabel(rows[0]!.label, "Link"), "link");
  assert.ok(new TextEncoder().encode(assistantLinkLabel("😀".repeat(200), "Link")).length <= 256);
  assert.ok(!assistantLinkLabel("a\nb", "Link").includes("\n"));
});

test("local BB targets require matching host and verified project/thread; newest aliases merge", async () => {
  const rows = extractAssistantLinkCandidates([
    { text: "[Older](https://bb.test/projects/proj_a/threads/thr_a) [Foreign](https://foreign.test/projects/proj_a/threads/thr_a)", createdAt: 10 },
    { text: "[Latest](/projects/proj_a/threads/thr_a) [Wrong project](/projects/proj_wrong/threads/thr_a)", createdAt: 20 },
  ]);
  const resolved = await resolveAssistantLinks(rows, async id => ({ id, projectId: "proj_a" }), "https://bb.test");
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0]?.target.provider, "bb");
  assert.equal(resolved[0]?.lastSeenAt, 20);
  assert.equal(resolved[0]?.target.presentation.label, "Latest");
  assert.equal(resolved[1]?.target.keys.href, "https://foreign.test/projects/proj_a/threads/thr_a");
});

test("unavailable verification preserves absolute URL fallback but drops unresolved relative links", async () => {
  const rows = extractAssistantLinkCandidates([{ text: "[Absolute](https://bb.test/projects/proj_a/threads/thr_a) [Relative](/projects/proj_a/threads/thr_b)", createdAt: 10 }]);
  const resolved = await resolveAssistantLinks(rows, async () => { throw new Error("offline"); }, "https://bb.test");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.target.provider, "url");
});
