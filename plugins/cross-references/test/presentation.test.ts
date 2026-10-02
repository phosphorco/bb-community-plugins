import assert from "node:assert/strict";
import test from "node:test";
import { displayLabel } from "../presentation.ts";

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
