import assert from "node:assert/strict";
import test from "node:test";

import { collectTurnTimings, projectToolExecutionFact } from "../fact-projection.ts";

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
    turnStartedAtMs: null,
    turnCompletedAtMs: null,
    capabilityKind: "tool",
    capabilityKey: "bb:read_slack",
    status: "failed",
    durationMs: 1_250,
    failed: true,
    errorClass: "network",
    errorSignature: fact?.errorSignature,
    commandBinary: null,
    commandArgument1: null,
    commandArgument2: null,
    commandUsesHelp: false,
    commandShape: null,
    commandShellWrapped: false,
    commandAttributionEligible: false,
  });
  assert.match(fact?.errorSignature ?? "", /^[0-9a-f]{16}$/);
  assert.equal("arguments" in (fact ?? {}), false);
  assert.equal("error" in (fact ?? {}), false);
});

test("joins fully observed turn boundaries onto tool execution facts", () => {
  const timings = collectTurnTimings([
    { type: "turn/started", createdAt: 100, scope: { kind: "turn", turnId: "turn-1" } },
    { type: "turn/completed", createdAt: 550, scope: { kind: "turn", turnId: "turn-1" } },
    { type: "turn/started", createdAt: 200, scope: { kind: "turn", turnId: "incomplete" } },
  ]);
  const fact = projectToolExecutionFact({
    id: "event-timed",
    threadId: "thread-1",
    seq: 43,
    createdAt: 300,
    scope: { kind: "turn", turnId: "turn-1" },
    type: "item/completed",
    data: { item: { type: "toolCall", tool: "read", status: "completed" } },
  }, dimensions, timings);

  assert.equal(fact?.turnStartedAtMs, 100);
  assert.equal(fact?.turnCompletedAtMs, 550);
  assert.equal(timings.has("incomplete"), false);
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
  assert.equal(command?.commandShape, "simple");

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

test("captures a bounded command signature and marks composite help commands", () => {
  const command = projectToolExecutionFact({
    id: "event-command-signature",
    threadId: "thread-1",
    seq: 46,
    createdAt: 123_460,
    scope: { kind: "turn", turnId: "turn-1" },
    type: "item/completed",
    data: {
      item: {
        id: "command-2",
        type: "commandExecution",
        status: "failed",
        exitCode: 1,
        command: "bash -lc 'rg --help | head -20 && git status'",
      },
    },
  }, dimensions);

  assert.deepEqual({
    binary: command?.commandBinary,
    argument1: command?.commandArgument1,
    argument2: command?.commandArgument2,
    usesHelp: command?.commandUsesHelp,
    shape: command?.commandShape,
    shellWrapped: command?.commandShellWrapped,
    attributionEligible: command?.commandAttributionEligible,
  }, {
    binary: "rg",
    argument1: "--help",
    argument2: null,
    usesHelp: true,
    shape: "pipeline_and_joined",
    shellWrapped: true,
    attributionEligible: false,
  });
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
