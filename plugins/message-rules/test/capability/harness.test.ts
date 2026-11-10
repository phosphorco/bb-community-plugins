import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
function nativeLimitation(trace: { status: number; body: unknown }[]) {
  const control = trace.some((x) => x.status === 200 && Array.isArray(x.body));
  const refused = trace.some(
    (x) =>
      x.status === 409 &&
      !!x.body &&
      typeof x.body === "object" &&
      "message" in x.body &&
      String(x.body.message).includes("different senders cannot be grouped"),
  );
  return control && refused;
}
test("capability diagnostic requires exercised control plus exact refusal, not infrastructure failure", () => {
  assert.equal(
    nativeLimitation([{ status: 500, body: { message: "failed" } }]),
    false,
  );
  assert.equal(nativeLimitation([{ status: 200, body: [] }]), false);
  assert.equal(
    nativeLimitation([
      { status: 200, body: [] },
      {
        status: 409,
        body: {
          message: "Queued messages from different senders cannot be grouped",
        },
      },
    ]),
    true,
  );
});
const file = process.env.MESSAGE_RULES_NATIVE_TRACE;
test(
  "actual isolated public grouping trace: control succeeds; mixed sender route fails and originals remain",
  { skip: !file },
  () => {
    const result = JSON.parse(readFileSync(file!, "utf8"));
    assert.equal(result.harness, "passed");
    assert.equal(result.fullDelivery, "failed");
    assert.ok(nativeLimitation(result.trace));
    const final = result.trace.at(-1);
    assert.equal(final.status, 200);
    assert.equal(final.body.length, 3);
    assert.equal(
      new Set(
        final.body.map((r: { senderThreadId: string }) => r.senderThreadId),
      ).size,
      2,
    );
    assert.ok(final.body.every((r: { state: string }) => r.state !== "failed"));
  },
);
