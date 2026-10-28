import assert from "node:assert/strict";
import test from "node:test";
import { referenceRecency, displayLabel, mergeReferenceRows } from "../presentation.ts";

test("page merging uses exact identity and replaces coherent whole rows", () => {
  const initial = { resource: { provider: "bb", keys: { project: "p", thread: "t" } }, label: "First", producer: "one", revision: 1, position: 0 };
  const updated = { resource: { provider: "bb", keys: { thread: "t", project: "p" } }, label: "Updated", producer: "two", revision: 2, position: 3 };
  const otherProvider = { ...updated, resource: { ...updated.resource, provider: "custom" } };
  assert.deepEqual(mergeReferenceRows([initial], [updated, otherProvider], (row) => row.resource), [updated, otherProvider]);
  assert.equal(initial.label, "First", "merging must not mutate existing rows");
});

test("page merging preserves query and fragment distinctions even with identical labels", () => {
  const rows = ["https://h.test/p?v=1", "https://h.test/p?v=2", "https://h.test/p?v=2#section"].map((href) => ({
    resource: { provider: "url", keys: { href } }, label: "Same label",
  }));
  assert.deepEqual(mergeReferenceRows(rows.slice(0, 1), rows, (row) => row.resource), rows);
});

const text = (label: string, url?: string) => displayLabel(label, url).text;
const shown = (label: string, url?: string) => text(label, url) ?? "";
const unchanged = (label: string, url?: string) =>
  assert.deepEqual(displayLabel(label, url), { text: label, derived: false, title: undefined, note: undefined }, `${label} ${url}`);

test("generic link text falls back to the decoded URL path without the query", () => {
  assert.deepEqual(displayLabel("link", "https://h.test/docs/plan%20a.md?utm_source=x&sig=abc"), {
    text: "/docs/plan a.md",
    derived: true,
    title: 'Link text "link" — https://h.test/docs/plan%20a.md?utm_source=x&sig=abc',
    note: '(from URL; link text "link")',
  });
  assert.equal(text("Here", "/projects/p/threads/t"), "/projects/p/threads/t");
  assert.equal(text("link", "https://h.test/a/b#Section%202"), "/a/b#Section 2");
  assert.equal(text("link", "https://h.test/#intro"), "/#intro");
});

test("empty link text gets a plain tooltip", () => {
  assert.deepEqual(displayLabel(" ", "https://h.test/x"), { text: "/x", derived: true, title: "https://h.test/x", note: "(from URL)" });
});

test("label normalization catches punctuated and spaced generic text", () => {
  for (const label of ["link.", "[here]", "(this link)", "Read  more →", "the link", ""]) {
    assert.equal(text(label, "https://h.test/x"), "/x", label);
  }
});

test("labels restating the URL or host keep the host", () => {
  for (const label of ["h.test", "H.test", "www.h.test", "https://h.test/x", "h.test/x", "https://h.test/x/"]) {
    assert.equal(text(label, "https://h.test/x"), "h.test/x", label);
  }
  assert.equal(text("h.test", "https://h.test/"), "h.test");
  unchanged("bb.invalid", "/x");
});

test("protocol-relative links show their host", () => {
  assert.equal(text("link", "//other.test/p"), "other.test/p");
});

test("generic text with no path to show is dropped", () => {
  assert.deepEqual(displayLabel("link", "https://h.test/"), { text: null, derived: false, title: 'Link text "link" — https://h.test/', note: undefined });
  assert.equal(text("here", "https://h.test/?utm=x"), null);
  assert.equal(text("", "https://h.test/"), null);
});

test("authored labels and unusable URLs keep the original text", () => {
  unchanged("Design notes", "https://h.test/x");
  unchanged("Linkage", "https://h.test/x");
  unchanged("link", undefined);
  unchanged("link", "mailto:a@b.test");
  unchanged("link", "data:text/plain,hello");
});

test("decoding is per segment and keeps reserved delimiters and literal % encoded", () => {
  assert.equal(text("link", "https://h.test/ok%20one/bad%E0/100%"), "/ok one/bad%E0/100%");
  assert.equal(text("link", "https://h.test/a%2Fb/c%3Fd/e%23f"), "/a%2Fb/c%3Fd/e%23f");
  assert.notEqual(text("link", "https://h.test/a%252Fb"), text("link", "https://h.test/a%2Fb"));
  assert.equal(text("link", "https://h.test/a%ZZ"), "/a%ZZ");
});

test("unsafe characters are re-encoded, not deleted, and emoji joiners survive", () => {
  assert.equal(text("link", "https://h.test/evil%E2%80%AEtxt/line%0Abreak"), "/evil%E2%80%AEtxt/line%0Abreak");
  assert.notEqual(text("link", "https://h.test/a%E2%80%8Bb"), text("link", "https://h.test/ab"));
  assert.equal(text("link", "https://h.test/%F0%9F%91%A8%E2%80%8D%F0%9F%92%BB"), "/👨\u200d💻");
  assert.match(shown("li\u202enk", "https://h.test/x"), /li\u202enk/);
});

test("long labels keep their distinguishing tail within the length limit", () => {
  const long = `https://h.test/${"segment/".repeat(10)}parent/0123456789abcdef.md`;
  assert.equal(text("link", long), "…/parent/0123456789abcdef.md");
  const atLimit = `/${"a".repeat(59)}`;
  assert.equal(text("link", `https://h.test${atLimit}`), atLimit);
  assert.equal([...shown("link", `https://h.test/${"b".repeat(90)}#${"c".repeat(20)}`)].length, 60);
  assert.ok(shown("link", `https://h.test/${"b".repeat(90)}#tail`).endsWith("#tail"));
});

test("recency handles unknown, invalid, future and day-old source timestamps", () => {
  assert.equal(referenceRecency(null), null);
  assert.equal(referenceRecency(undefined), null);
  assert.equal(referenceRecency(NaN), null);
  assert.equal(referenceRecency(-1), null);
  assert.equal(referenceRecency(8_640_000_000_000_001), null);
  assert.equal(referenceRecency(100, 90)?.text, "just now");
  assert.equal(referenceRecency(0, 3 * 86_400_000)?.text, "3d ago");
});

import {
  mentionsSubPath, parseMentionsSubPath, mentionMessageHref, mentionExcerptParts,
  mentionClaimKey, mentionItemKey, type MentionItem,
} from "../presentation.ts";
import { listMentionsOutputV2Schema } from "@phosphorco/bb-cross-references";

const uiSource = { provider: "bb", keys: { project: "proj_ui", thread: "thr_ui" }, presentation: { label: "Source" } };
function uiItem(): MentionItem {
  const hash = "a".repeat(64);
  const output = listMentionsOutputV2Schema.parse({ version: 2, status: "page", snapshot: hash, nextCursor: null,
    coverage: { scope: "known-sources", collectionIncomplete: false, retentionLimited: false, capHistoryUnknown: false, legacyClaimsPresent: false, evidenceStateUnknown: false, authoredUrlCoverage: { state: "complete-for-known-locations", unknownLocations: 0, scope: "known-locations", watermark: hash }, reasons: [], reasonsClipped: false, checkedAt: null },
    counts: { retainedOccurrences: 1, confirmedOccurrences: 1, unconfirmedOccurrences: 0, producerClaims: 1, indexedSources: 1, claimsWithoutLocations: 0, excerptUnavailable: 0 },
    items: [{ kind: "occurrence", source: uiSource, target: uiSource, producerPluginId: "fixture", graphRevision: 1, evidenceRevision: 1, cap: { state: "uncapped", limit: 100, sourceHistoryUnknown: false }, occurrenceKey: hash, locator: { kind: "conversation", threadId: "thr_ui", messageId: "different_row_id", messageSeq: 41, anchorSeq: 99, role: "user" }, sourceContentRevision: hash, span: { start: 2, end: 7 }, excerpt: { state: "ready", text: "😀 hello after", sourceSpan: { start: 0, end: 14 }, matchSpan: { start: 3, end: 8 }, clippedBefore: false, clippedAfter: false, matchClippedBefore: false, matchClippedAfter: false, codecVersion: 1 }, messageCreatedAt: 0, observedAt: 0, confirmation: "observed", authoredUrlState: "not-url", provenance: { pluginId: "fixture", origin: "builtin", confidence: "high", recognition: { basis: "explicit", explanation: "Fixture" }, source: { provider: "bb.thread", id: "thr_ui", kind: "thread" } } }],
  });
  if (output.status !== "page") throw Error("Expected page");
  return output.items[0]!;
}
test("Mentions routes roundtrip Unicode, maximum admitted identity and literal URL without double-encoding", () => {
  const queries = [
    { kind: "authored-url" as const, href: "https://example.test/😀?q=one#two" },
    { kind: "resource" as const, target: { provider: "custom", keys: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "界".repeat(100)])) }, relation: "self" as const },
  ];
  for (const query of queries) {
    const route = { v: 1 as const, kind: "query" as const, input: { version: 2 as const, query } };
    const path = mentionsSubPath(route);
    assert.match(path, /^v1\/[A-Za-z0-9_-]+$/);
    assert.deepEqual(parseMentionsSubPath(path), route);
  }
  const route = { v: 1 as const, kind: "lookup" as const, href: "https://example.test/x", mode: "recognize" as const };
  assert.deepEqual(parseMentionsSubPath(mentionsSubPath(route)), route);
  assert.equal(parseMentionsSubPath(""), null);
});
test("Mentions route admission rejects unsafe, malformed, invalid UTF8, oversized and cursor-bearing inputs", () => {
  const enc = (raw: string) => `v1/${Buffer.from(raw).toString("base64url")}`;
  for (const path of ["v2/eA", "v1/%%%", "v1/a/b", "v1/" + "a".repeat(200000), "v1/_w", enc('{"v":1}'), enc('{"v":1,"kind":"lookup","href":"https://example.test/?token=secret","mode":"recognize"}'), enc('{"v":1,"kind":"query","input":{"version":2,"query":{"kind":"authored-url","href":"https://example.test/"},"cursor":"old"}}')]) assert.throws(() => parseMentionsSubPath(path));
  assert.throws(() => mentionsSubPath({ v: 1, kind: "lookup", href: "https://example.test/" + "x".repeat(4096), mode: "recognize" }));
});
test("original message links use exact messageSeq and highlight original UTF16 text", () => {
  const item = uiItem();
  assert.equal(mentionMessageHref(item), "/projects/proj_ui/threads/thr_ui#msg=41");
  assert.deepEqual(mentionExcerptParts(item), { before: "😀 ", match: "hello", after: " after" });
  assert.equal(mentionMessageHref({ ...item, source: { ...uiSource, keys: { ...uiSource.keys, thread: "thr_other" } } }), null);
  assert.equal(mentionMessageHref({ ...item, source: { provider: "custom", keys: {}, presentation: { label: "Other" } } }), null);
  const other = { ...item, producerPluginId: "another" };
  assert.notEqual(mentionClaimKey(item), mentionClaimKey(other));
  if (item.kind === "occurrence") assert.notEqual(mentionItemKey(item, 0), mentionItemKey({ ...item, occurrenceKey: "b".repeat(64) }, 0));
});

test("future/claim slots remain distinct while known occurrence identity survives page reorder", () => {
  const item = uiItem();
  if (item.kind !== "occurrence") throw Error("Expected known occurrence");
  assert.equal(mentionItemKey(item, 0), JSON.stringify([mentionClaimKey(item), "occurrence", item.occurrenceKey]));
  assert.equal(mentionItemKey(item, 0), mentionItemKey(item, 99));
  const future: MentionItem = { kind: "unsupported", reason: "unsupported-format", source: item.source, target: item.target, producerPluginId: item.producerPluginId, graphRevision: item.graphRevision, cap: item.cap };
  assert.notEqual(mentionItemKey(future, 0), mentionItemKey(future, 1));
  assert.equal(mentionItemKey(future, 0), mentionItemKey({ ...future, unknownMetadata: { rawId: "not-an-identity" } }, 0));
  assert.notEqual(mentionItemKey(future, 0), mentionItemKey({ ...future, producerPluginId: "another" }, 0));
  const claim: MentionItem = { ...future, kind: "claim-without-evidence", reason: "legacy", matchBasis: "primary-resource" };
  assert.notEqual(mentionItemKey(claim, 0), mentionItemKey(claim, 1));
  for (const slot of [-1, 100, NaN, 0.5]) assert.throws(() => mentionItemKey(future, slot));
});
