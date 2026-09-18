import assert from "node:assert/strict";
import test from "node:test";

import {
  absoluteSnippetPath,
  escapeSqlLike,
  normalizeSnippetTitle,
  snippetMentionContext,
  snippetRelativePath,
  type StoredSnippet,
} from "../snippet-model.ts";

const now = Date.parse("2026-08-26T18:30:45.000Z");

test("normalizes an optional title without changing the pasted body", () => {
  assert.equal(normalizeSnippetTitle("  Release\n  notes  ", now), "Release notes");
  assert.equal(normalizeSnippetTitle("   ", now), "Snippet 2026-08-26 18:30:45 UTC");
});

test("creates a bounded thread-storage-relative text path", () => {
  assert.equal(
    snippetRelativePath("../../ Release notes (final)", "B8D39B62-DF91-4C54-9207-0D42B0104F65"),
    "attach-text-snippets/release-notes-final-b8d39b62df91.txt",
  );
});

test("mention context forwards only the durable native file reference", () => {
  const snippet: StoredSnippet = {
    id: "b8d39b62-df91-4c54-9207-0d42b0104f65",
    threadId: "thr_123",
    title: "Release notes",
    relativePath: "attach-text-snippets/release-notes-b8d39b62.txt",
    sizeBytes: 42,
    createdAt: now,
  };
  const path = absoluteSnippetPath("/thread storage/thr_123/", snippet.relativePath);
  const context = snippetMentionContext(snippet, path);

  assert.match(context, /Read the file at \/thread storage\/thr_123\/attach-text-snippets\/release-notes-b8d39b62\.txt/u);
  assert.match(context, /\[Release notes\]\(<\/thread storage\/thr_123\/attach-text-snippets\/release-notes-b8d39b62\.txt>\)/u);
  assert.doesNotMatch(context, /42/u);
});

test("mention context escapes file-link punctuation in user titles", () => {
  const snippet: StoredSnippet = {
    id: "b8d39b62-df91-4c54-9207-0d42b0104f65",
    threadId: "thr_123",
    title: "Release [final] \\ notes",
    relativePath: "attach-text-snippets/release-final-b8d39b62.txt",
    sizeBytes: 9,
    createdAt: now,
  };
  const context = snippetMentionContext(
    snippet,
    "/storage/attach-text-snippets/release-final-b8d39b62.txt",
  );

  assert.match(
    context,
    /\[Release \\\[final\\\] \\\\ notes\]\(\/storage\/attach-text-snippets\/release-final-b8d39b62\.txt\)/u,
  );
});

test("escapes wildcard characters in title search", () => {
  assert.equal(escapeSqlLike("50%_done\\later"), "50\\%\\_done\\\\later");
});
