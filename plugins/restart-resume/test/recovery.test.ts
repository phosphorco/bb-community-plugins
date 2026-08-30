import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RESUME_MESSAGE,
  HOST_DAEMON_ERROR_CODE,
  HOST_DAEMON_ERROR_MESSAGE,
  HOST_DAEMON_RECOVERY_WINDOW_MS,
  INTERRUPTED_TURN_RESUME_MESSAGE,
  hasEventsAfter,
  hasInterruptedTurn,
  hasResumeRequestAfter,
  isRecoverableThread,
  isWithinRecoveryWindow,
  hostDaemonErrorAt,
  latestHostDaemonError,
  latestHostRestartInterruption,
  resumeMessageFor,
} from "../recovery.ts";

const interruption = {
  seq: 8,
  type: "system/thread/interrupted",
  data: { reason: "host-daemon-restarted" },
  scope: { kind: "thread" as const },
  createdAt: 100,
};

test("finds the latest restart interruption and exposes later events separately", () => {
  assert.deepEqual(
    latestHostRestartInterruption([
      interruption,
      { seq: 9, type: "system/error", data: { message: "later error" } },
    ]),
    interruption,
  );
  assert.equal(hasEventsAfter([interruption, { seq: 9, type: "system/error", data: {} }], 8), true);
  assert.deepEqual(latestHostRestartInterruption([interruption]), interruption);
  assert.deepEqual(
    latestHostRestartInterruption([
      { ...interruption, seq: 4 },
      { ...interruption, seq: 8 },
    ]),
    interruption,
  );
  assert.equal(
    latestHostRestartInterruption([
      { seq: 12, type: "system/thread/interrupted", data: { reason: "manual-stop" } },
      { ...interruption, seq: 11 },
    ])?.seq,
    11,
  );
});

test("anchors a restart cluster to the latest paired host-daemon error", () => {
  const events = [
    {
      seq: 12,
      type: "system/error",
      data: { code: HOST_DAEMON_ERROR_CODE, message: HOST_DAEMON_ERROR_MESSAGE },
      createdAt: 300,
    },
    {
      seq: 10,
      type: "system/error",
      data: { code: HOST_DAEMON_ERROR_CODE, message: HOST_DAEMON_ERROR_MESSAGE },
      createdAt: 100,
    },
    { ...interruption, seq: 13, createdAt: 350 },
  ];
  assert.equal(latestHostDaemonError(events, 13)?.seq, 12);
  assert.equal(hostDaemonErrorAt(events, 13), 300);
  assert.equal(
    hostDaemonErrorAt(
      [
        {
          seq: 10,
          type: "system/error",
          data: { code: "provider_failed", message: HOST_DAEMON_ERROR_MESSAGE },
          createdAt: 100,
        },
        { ...interruption, seq: 11 },
      ],
      11,
    ),
    null,
  );
});

test("uses inclusive one-minute recovery boundaries", () => {
  assert.equal(isWithinRecoveryWindow(10_000, 10_000 + HOST_DAEMON_RECOVERY_WINDOW_MS), true);
  assert.equal(isWithinRecoveryWindow(10_000, 10_000 - HOST_DAEMON_RECOVERY_WINDOW_MS), true);
  assert.equal(
    isWithinRecoveryWindow(10_000, 10_000 + HOST_DAEMON_RECOVERY_WINDOW_MS + 1),
    false,
  );
});

test("detects whether the interrupted restart had an active turn", () => {
  assert.equal(
    hasInterruptedTurn(
      [
        { seq: 6, type: "turn/completed", scope: { kind: "turn", turnId: "turn_1" }, data: { status: "interrupted" } },
        { seq: 7, type: "system/error", scope: { kind: "turn", turnId: "turn_1" }, data: {} },
        interruption,
      ],
      interruption.seq,
    ),
    true,
  );
  assert.equal(
    hasInterruptedTurn(
      [
        { seq: 6, type: "turn/completed", scope: { kind: "turn", turnId: "old" }, data: { status: "interrupted" } },
        { seq: 7, type: "system/error", scope: { kind: "thread" }, data: {} },
        interruption,
      ],
      interruption.seq,
    ),
    false,
  );
  assert.equal(hasInterruptedTurn([interruption], interruption.seq), false);
});

test("uses project overrides and concise defaults", () => {
  assert.equal(resumeMessageFor("Use our project recovery playbook.", true), "Use our project recovery playbook.");
  assert.equal(resumeMessageFor("   ", true), INTERRUPTED_TURN_RESUME_MESSAGE);
  assert.equal(resumeMessageFor(null, false), DEFAULT_RESUME_MESSAGE);
});

test("recognizes a request already accepted after the interruption", () => {
  assert.equal(
    hasResumeRequestAfter(
      [
        interruption,
        {
          seq: 10,
          type: "client/turn/requested",
          data: { input: [{ type: "text", text: ".", mentions: [] }] },
        },
      ],
      interruption.seq,
      ".",
    ),
    true,
  );
  assert.equal(
    hasResumeRequestAfter(
      [
        {
          seq: 7,
          type: "client/turn/requested",
          data: { input: [{ type: "text", text: ".", mentions: [] }] },
        },
        interruption,
        {
          seq: 10,
          type: "client/turn/requested",
          data: { input: [{ type: "image", url: "https://example.test/image" }] },
        },
      ],
      interruption.seq,
      ".",
    ),
    false,
  );
  assert.equal(
    hasResumeRequestAfter(
      [interruption, { seq: 9, type: "client/turn/requested", data: { input: [{ type: "text", text: "other", mentions: [] }] } }],
      interruption.seq,
      ".",
    ),
    false,
  );
});

test("only unarchived error threads are recoverable", () => {
  assert.equal(isRecoverableThread({ status: "error", archivedAt: null, deletedAt: null }), true);
  assert.equal(isRecoverableThread({ status: "idle", archivedAt: null, deletedAt: null }), false);
  assert.equal(isRecoverableThread({ status: "error", archivedAt: 1, deletedAt: null }), false);
  assert.equal(isRecoverableThread({ status: "error", archivedAt: null, deletedAt: 1 }), false);
});
