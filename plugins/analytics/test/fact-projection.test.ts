import assert from "node:assert/strict";
import test from "node:test";

import { projectToolExecutionFact } from "../fact-projection.ts";

const dimensions = { projectId: "project-1", providerId: "provider-1" };

test("projects a tool completion without arguments, output, or free-text error", () => {
  const fact = projectToolExecutionFact({
    id: "event-1",
    threadId: "thread-1",
    seq: 42,
    createdAt: 123_456,
    scope: { kind: "turn", turnId: "turn-1" },
    type: "item/completed",
    data: {
      providerThreadId: "provider-thread",
      item: {
        id: "tool-1",
        type: "toolCall",
        server: "bb",
        tool: "read_slack",
        status: "failed",
        durationMs: 1_250,
        arguments: { destination: "private-channel" },
        result: "private output",
        error: "Network connection ECONNRESET at 10.0.0.12 request 12345",
      },
    },
  }, dimensions);

  assert.deepEqual(fact, {
    sourceEventId: "event-1",
    threadId: "thread-1",
    turnId: "turn-1",
    sequence: 42,
    projectId: "project-1",
    providerId: "provider-1",
    createdAtMs: 123_456,
    capabilityKind: "tool",
    capabilityKey: "bb:read_slack",
    status: "failed",
    durationMs: 1_250,
    failed: true,
    errorClass: "network",
    errorSignature: fact?.errorSignature,
  });
  assert.match(fact?.errorSignature ?? "", /^[0-9a-f]{16}$/);
  assert.equal("arguments" in (fact ?? {}), false);
  assert.equal("error" in (fact ?? {}), false);
});

test("uses terminal status and exit code for native capabilities", () => {
  const command = projectToolExecutionFact({
    id: "event-command",
    threadId: "thread-1",
    seq: 43,
    createdAt: 123_457,
    scope: { kind: "thread" },
    type: "item/completed",
    data: { item: { id: "command-1", type: "commandExecution", status: "completed", exitCode: 2, command: "secret" } },
  }, dimensions);
  assert.equal(command?.capabilityKey, "native:command_execution");
  assert.equal(command?.failed, true);
  assert.equal(command?.turnId, null);

  const fileRead = projectToolExecutionFact({
    id: "event-read",
    threadId: "thread-1",
    seq: 44,
    createdAt: 123_458,
    scope: { kind: "turn", turnId: "turn-1" },
    type: "item/completed",
    data: { item: { id: "read-1", type: "fileRead", status: "completed", path: "/private/path" } },
  }, dimensions);
  assert.equal(fileRead?.capabilityKey, "native:file_read");
  assert.equal(fileRead?.durationMs, 0);
});

test("ignores non-capability and pending events", () => {
  assert.equal(projectToolExecutionFact({ type: "turn/completed" }, dimensions), null);
  assert.equal(projectToolExecutionFact({
    id: "event-pending",
    threadId: "thread-1",
    seq: 45,
    createdAt: 123_459,
    scope: { kind: "turn", turnId: "turn-1" },
    type: "item/completed",
    data: { item: { id: "tool-pending", type: "toolCall", tool: "wait", status: "pending" } },
  }, dimensions), null);
});
