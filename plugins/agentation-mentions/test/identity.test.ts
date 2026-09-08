import assert from "node:assert/strict";
import test from "node:test";
import { identityKeyCodec } from "@phosphorco/bb-identity";

import {
  annotationAuthor,
  captureAnnotationAuthor,
  decodeCapturedAuthorMention,
  encodeCapturedAuthorMention,
  unavailableAnnotationAuthor,
  wrapAgentationContent,
} from "../lib/identity.ts";

const coleKey = identityKeyCodec.decode("tailnet:cole");
if (!coleKey.ok) throw new Error(coleKey.error.message);

const cole = captureAnnotationAuthor({
  identity: { kind: "person", key: coleKey.value, issuer: "tailnet", subject: "cole" },
  presentation: {
    displayName: "Cole Lawrence",
    handle: "cole",
    avatarUrl: "/avatars/cole.jpg",
  },
  evidence: "provider-verified",
}, "2026-09-06T12:00:00.000Z");

test("Agentation content keeps the source frame and own captured-author marker", () => {
  const input = wrapAgentationContent("## Feedback\nFix this", cole, "agentation-mentions");

  assert.deepEqual(input[0], {
    type: "text",
    text: "[from=agentation-feedback]\nThis feedback was captured from Cole Lawrence (cole). Its identity evidence was recorded at capture time; this later delivery is source-labelled feedback, not a live authenticated action.\n\n",
    mentions: [],
    visibility: "agent-only",
  });
  assert.deepEqual(input[1], {
    type: "text",
    text: "\u2063 ",
    mentions: [
      {
        start: 0,
        end: 1,
        resource: {
          kind: "plugin",
          pluginId: "agentation-mentions",
          itemId: `captured-author:${encodeCapturedAuthorMention(cole)}`,
          label: "Cole Lawrence",
          icon: "/avatars/cole.jpg",
        },
      },
    ],
  });
  assert.deepEqual(input[2], {
    type: "text",
    text: "## Feedback\nFix this",
    mentions: [],
  });
  assert.deepEqual(input[3], {
    type: "text",
    text: "\n[/from=agentation-feedback]",
    mentions: [],
    visibility: "agent-only",
  });
});

test("unavailable capture remains explicit rather than becoming a default user", () => {
  const input = wrapAgentationContent(
    "Feedback",
    unavailableAnnotationAuthor("unavailable", "2026-09-06T12:00:00.000Z"),
    "agentation-mentions",
  );
  assert.match(input[0]?.text ?? "", /could not be captured/u);
  assert.deepEqual(input[1]?.mentions, []);
});

test("captured author mention snapshots reject malformed data", () => {
  assert.throws(() => decodeCapturedAuthorMention("not-json"), /Invalid|Unexpected/u);
  assert.throws(
    () => decodeCapturedAuthorMention(encodeURIComponent(JSON.stringify({ ...cole, identity: { kind: "person", key: "k" } }))),
    /issuer|subject/u,
  );
});

test("a legacy marker stays visible as unresolved provenance", () => {
  const legacy = annotationAuthor({ author: null, authorIdentityId: "cole%40example.com" });
  const input = wrapAgentationContent("Feedback", legacy, "agentation-mentions");
  assert.match(input[0]?.text ?? "", /unresolved historical author/u);
  assert.doesNotMatch(input[0]?.text ?? "", /Cole Lawrence/u);
  assert.deepEqual(input[1]?.mentions, []);
});
