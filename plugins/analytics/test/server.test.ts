import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_PAGE_SIZE,
  EVENTS_PER_THREAD_LIMIT,
  listRecentThreadEvents,
} from "../server.ts";

test("retains Analytics' newest-500 window through compliant descending event pages", async () => {
  const requests: Array<{ beforeSeq?: string; limit: string; order: string }> = [];
  const pages = Array.from({ length: 5 }, (_, page) => Array.from(
    { length: EVENT_PAGE_SIZE },
    (_, index) => ({ seq: EVENTS_PER_THREAD_LIMIT - page * EVENT_PAGE_SIZE - index }),
  ));
  const events = await listRecentThreadEvents({
    async list(request: { beforeSeq?: string; limit?: string; order?: string }) {
      requests.push({
        ...(request.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq }),
        limit: request.limit ?? "",
        order: request.order ?? "",
      });
      return pages.shift() as never;
    },
  } as never, { threadId: "thread-1", signal: new AbortController().signal });

  assert.equal(events.length, EVENTS_PER_THREAD_LIMIT);
  assert.deepEqual(
    requests,
    [undefined, "401", "301", "201", "101"].map((beforeSeq) => ({
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      limit: "100",
      order: "desc",
    })),
  );
});
