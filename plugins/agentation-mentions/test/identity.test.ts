import assert from "node:assert/strict";
import test from "node:test";

import {
  wrapAgentationContent,
  type IdentityProfile,
} from "../lib/identity.ts";

const cole: IdentityProfile = {
  id: "cole%40example.com",
  displayName: "Cole Lawrence",
  login: "cole@example.com",
  profilePicture: "https://example.test/cole.jpg",
  tag: "cole",
};

test("Agentation content uses the Identity Boundaries frame and sender marker", () => {
  const input = wrapAgentationContent("## Feedback\nFix this", cole);

  assert.deepEqual(input[0], {
    type: "text",
    text: "[from=cole]\n",
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
          pluginId: "identity-boundaries",
          itemId: "sender:cole%40example.com",
          label: "Cole Lawrence",
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
    text: "\n[/from=cole]",
    mentions: [],
    visibility: "agent-only",
  });
});
