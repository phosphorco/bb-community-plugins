import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeAgentationAttachment,
  encodeAgentationAttachment,
} from "../lib/attachment.ts";

test("Agentation attachment ids round-trip an exact staged snapshot", () => {
  const attachment = {
    annotationIds: ["ann_one", "ann_two"],
  };

  assert.deepEqual(
    decodeAgentationAttachment(encodeAgentationAttachment(attachment)),
    attachment,
  );
});

test("Agentation attachment ids reject malformed input", () => {
  assert.throws(
    () => decodeAgentationAttachment(encodeURIComponent('{"threadId":""}')),
    /Invalid Agentation attachment/,
  );
});

test("Agentation attachment ids reject duplicate or oversized snapshots", () => {
  assert.throws(
    () =>
      decodeAgentationAttachment(
        encodeAgentationAttachment({ annotationIds: ["ann_one", "ann_one"] }),
      ),
    /Invalid Agentation attachment/,
  );
  assert.throws(
    () =>
      decodeAgentationAttachment(
        encodeAgentationAttachment({
          annotationIds: Array.from({ length: 51 }, (_, index) => `ann_${index}`),
        }),
      ),
    /Invalid Agentation attachment/,
  );
});
