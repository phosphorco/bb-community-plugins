import assert from "node:assert/strict";
import test from "node:test";
import { displayLabel } from "../presentation.ts";

const text = (label: string, url?: string) => displayLabel(label, url).text;

test("generic link text falls back to the decoded URL path without the query", () => {
  assert.deepEqual(displayLabel("link", "https://h.test/docs/plan%20a.md?utm_source=x&sig=abc"), { text: "/docs/plan a.md", derived: true });
  assert.equal(text("Here", "/projects/p/threads/t"), "/projects/p/threads/t");
  assert.equal(text("link", "https://h.test/a/b#Section%202"), "/a/b#Section 2");
});

test("label normalization catches punctuated, spaced, empty, and URL- or host-equal text", () => {
  for (const label of ["link.", "[here]", "(this link)", "Read  more →", "  ", "", "h.test", "https://h.test/x"]) {
    assert.equal(text(label, "https://h.test/x"), "/x", label);
  }
});

test("authored labels and unusable URLs keep the original text", () => {
  assert.deepEqual(displayLabel("Design notes", "https://h.test/x"), { text: "Design notes", derived: false });
  assert.equal(text("Linkage", "https://h.test/x"), "Linkage");
  assert.equal(text("link", undefined), "link");
  assert.equal(text("link", "https://h.test/"), "link");
  assert.equal(text("link", "https://h.test/?utm=x"), "link");
  assert.equal(text("link", "#section"), "link");
  assert.equal(text("link", "mailto:a@b.test"), "link");
  assert.equal(text("link", "data:text/plain,hello"), "link");
});

test("decoding is per segment, keeps reserved delimiters encoded, and strips unsafe characters", () => {
  assert.equal(text("link", "https://h.test/ok%20one/bad%E0/100%"), "/ok one/bad%E0/100%");
  assert.equal(text("link", "https://h.test/a%2Fb/c%3Fd"), "/a%2Fb/c%3Fd");
  assert.equal(text("link", "https://h.test/evil%E2%80%AEtxt/line%0Abreak"), "/eviltxt/linebreak");
});

test("long paths keep their distinguishing tail", () => {
  const long = `https://h.test/${"segment/".repeat(10)}parent/0123456789abcdef.md`;
  assert.equal(text("link", long), "…/parent/0123456789abcdef.md");
});
