import assert from "node:assert/strict";
import test from "node:test";

import { createLinkChecker, firstUniqueLinks } from "../link-status.ts";

test("bounds forward-reference probes to ten unique destinations", () => {
  function* links() {
    for (let index = 0; index < 10; index += 1) yield { url: `https://example.test/${index}` };
    throw new Error("Read beyond cap");
  }
  assert.equal(firstUniqueLinks(links()).length, 10);
});

test("checks once per URL, cancels its body, and distinguishes HTTP outcomes", async () => {
  let calls = 0;
  let cancelled = 0;
  const check = createLinkChecker((async (url, init) => {
    calls += 1;
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "omit");
    return new Response(new ReadableStream({ cancel() { cancelled += 1; } }), {
      status: String(url).endsWith("missing") ? 404 : 403,
    });
  }) as typeof fetch);

  const [first, second] = await Promise.all([check("https://example.test/missing"), check("https://example.test/missing")]);
  assert.deepEqual(first, second);
  assert.equal(first.label, "Not found or private");
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
  assert.equal((await check("https://example.test/private")).label, "Access restricted");
  assert.equal((await check("/projects/example")).status, null);
  assert.equal(calls, 2);
});

test("leaves network failures uncertain", async () => {
  const check = createLinkChecker((async () => { throw new Error("timeout"); }) as typeof fetch);
  assert.equal((await check("https://example.test")).label, "Could not reach");
});
