import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

const toolLabels = [
  ["agentation_mentions_list_sessions", "Listing annotation sessions", "Listed annotation sessions"],
  ["agentation_mentions_get_session", "Reading annotation session", "Read annotation session"],
  ["agentation_mentions_get_pending", "Reading pending annotations", "Read pending annotations"],
  ["agentation_mentions_get_all_pending", "Reading all pending annotations", "Read all pending annotations"],
  ["agentation_mentions_acknowledge", "Acknowledging annotation", "Acknowledged annotation"],
  ["agentation_mentions_resolve", "Resolving annotation", "Resolved annotation"],
  ["agentation_mentions_dismiss", "Dismissing annotation", "Dismissed annotation"],
  ["agentation_mentions_reply", "Replying to annotation", "Replied to annotation"],
  ["agentation_mentions_watch_annotations", "Watching for new annotations", "Collected new annotations"],
] as const;

test("agent tools retain their 0.4.47 presentation labels", () => {
  assert.doesNotMatch(source, /experimental_(?:statusLabels|presentation)/);

  for (const [name, pending, completed] of toolLabels) {
    const registration = new RegExp(
      `name: "${name}"[\\s\\S]*?presentation: \\{[\\s\\S]*?label: \\{[\\s\\S]*?pending: "${pending}",[\\s\\S]*?completed: "${completed}",`,
    );
    assert.match(source, registration);
  }
});
