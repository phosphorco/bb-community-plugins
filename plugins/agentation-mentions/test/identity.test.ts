import assert from "node:assert/strict";
import test from "node:test";
import { idCodec, identityKeyCodec } from "@phosphorco/bb-identity";

import type { CapturedAnnotationAuthor } from "../lib/afs.ts";
import {
  annotationAuthor,
  captureAnnotationAuthor,
  decodeCapturedAuthorSnapshot,
  encodeCapturedAuthorSnapshot,
  unavailableAnnotationAuthor,
  wrapAgentationContent,
} from "../lib/identity.ts";

const coleKey = identityKeyCodec.decode("tailnet:cole");
if (!coleKey.ok) throw new Error(coleKey.error.message);
const machineKey = identityKeyCodec.decode("p6r-machine:v1:fixture-instance:server");
if (!machineKey.ok) throw new Error(machineKey.error.message);
const machineInstanceId = idCodec("instance").decode("fixture-instance");
if (!machineInstanceId.ok) throw new Error(machineInstanceId.error.message);


const cole = captureAnnotationAuthor({
  identity: { kind: "person", key: coleKey.value, issuer: "tailnet", subject: "cole" },
  presentation: {
    displayName: "Cole Lawrence",
    handle: "cole",
    avatarUrl: "/avatars/cole.jpg",
  },
  evidence: "provider-verified",
}, "2026-09-06T12:00:00.000Z");
const machine = captureAnnotationAuthor({
  identity: { kind: "machine", key: machineKey.value, instanceId: machineInstanceId.value, hostId: null },
  presentation: { displayName: "BB machine", handle: null, avatarUrl: null },
  evidence: "machine",
}, "2026-09-06T12:00:00.000Z");
const external: CapturedAnnotationAuthor = {
  kind: "captured",
  identity: { kind: "external", key: coleKey.value, pluginId: "agent-connect", subject: "connection" },
  presentation: { displayName: "Agent Connect", handle: "connection", avatarUrl: null },
  evidence: "integration-asserted",
  capturedAt: "2026-09-06T12:00:00.000Z",
};

test("external captured-author snapshots remain readable", () => {
  const decoded = decodeCapturedAuthorSnapshot(encodeCapturedAuthorSnapshot(external));
  assert.deepEqual(decoded, external);
  const input = wrapAgentationContent("Feedback", external);
  assert.deepEqual(input, [
    { type: "text", text: "[message posted via Agentation]\n[sender=connection]\n", mentions: [], visibility: "agent-only" },
    { type: "text", text: "Feedback", mentions: [] },
    { type: "text", text: "\n[/sender=connection]", mentions: [], visibility: "agent-only" },
  ]);
});
test("machine fallback attribution round-trips with machine evidence", () => {
  const decoded = decodeCapturedAuthorSnapshot(encodeCapturedAuthorSnapshot(machine));
  assert.deepEqual(decoded, machine);
  assert.equal(decoded.identity.kind, "machine");
  assert.equal(decoded.evidence, "machine");
  const input = wrapAgentationContent("Feedback", machine);
  assert.deepEqual(input, [
    { type: "text", text: "[message posted via Agentation]\n[sender=machine:BB machine]\n", mentions: [], visibility: "agent-only" },
    { type: "text", text: "Feedback", mentions: [] },
    { type: "text", text: "\n[/sender=machine:BB machine]", mentions: [], visibility: "agent-only" },
  ]);
});

test("Agentation content keeps only the sender frame and original content", () => {
  const input = wrapAgentationContent("## Feedback\nFix this", cole);

  assert.deepEqual(input[0], {
    type: "text",
    text: "[message posted via Agentation]\n[sender=cole]\n",
    mentions: [],
    visibility: "agent-only",
  });
  assert.deepEqual(input[1], {
    type: "text",
    text: "## Feedback\nFix this",
    mentions: [],
  });
  assert.deepEqual(input[2], {
    type: "text",
    text: "\n[/sender=cole]",
    mentions: [],
    visibility: "agent-only",
  });
});

test("attachments stay agent-only and are not a second sender envelope", () => {
  const input = wrapAgentationContent("Original feedback", cole, "### Annotation button — ann_1\n**Selector:** `body > button`");
  assert.equal(input.length, 4);
  assert.equal(input.filter((part) => part.type === "text" && part.text.includes("[sender=")).length, 1);
  assert.deepEqual(input[1], { type: "text", text: "Original feedback", mentions: [] });
  assert.deepEqual(input[2], {
    type: "text",
    text: "\n<attached>\n### Annotation button — ann_1\n**Selector:** `body > button`\n</attached>",
    mentions: [],
    visibility: "agent-only",
  });
});

test("unavailable capture stays unwrapped rather than inventing a sender", () => {
  const input = wrapAgentationContent(
    "Feedback",
    unavailableAnnotationAuthor("unavailable", "2026-09-06T12:00:00.000Z"),
  );
  assert.deepEqual(input, [{ type: "text", text: "Feedback", mentions: [] }]);
});

test("sender labels escape wrapper delimiters and line breaks", () => {
  const unsafe = captureAnnotationAuthor({
    identity: { kind: "person", key: coleKey.value, issuer: "tailnet", subject: "unsafe" },
    presentation: { displayName: ["A]", "[evil%<tag>"].join("\n"), handle: null, avatarUrl: null },
    evidence: "local-user",
  }, "2026-09-06T12:00:00.000Z");
  const input = wrapAgentationContent("Feedback", unsafe);
  const newline = "\n";
  const escapedLabel = "A%5D%0A%5Bevil%25%3Ctag%3E";
  assert.equal(input[0]?.text, "[message posted via Agentation]" + newline + "[sender=" + escapedLabel + "]" + newline);
  assert.equal(input[2]?.text, newline + "[/sender=" + escapedLabel + "]");
});
test("captured author mention snapshots reject malformed data", () => {
  assert.throws(() => decodeCapturedAuthorSnapshot("not-json"), /Invalid|Unexpected/u);
  assert.throws(
    () => decodeCapturedAuthorSnapshot(encodeURIComponent(JSON.stringify({ ...cole, identity: { kind: "person", key: "k" } }))),
    /issuer|subject/u,
  );
});

test("legacy marker remains unresolved and unwrapped", () => {
  const legacy = annotationAuthor({ author: null, authorIdentityId: "cole%40example.com" });
  const input = wrapAgentationContent("Feedback", legacy);
  assert.deepEqual(input, [{ type: "text", text: "Feedback", mentions: [] }]);
});
