import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverUrl = new URL("../server.ts", import.meta.url);
const toolbarUrl = new URL("../lib/toolbar.ts", import.meta.url);

test("annotation admission gets attribution only from the public request boundary", async () => {
  const [server, toolbar] = await Promise.all([
    readFile(serverUrl, "utf8"),
    readFile(toolbarUrl, "utf8"),
  ]);

  assert.match(server, /bindBbIdentity\(bb\)/u);
  assert.match(server, /identity\.rpc\.register\(identityRpcContract/u);
  assert.match(server, /origin:\s*"interactive-user"/u);
  assert.match(server, /identity\.server\.session\(invocation\)/u);
  assert.match(server, /captureAnnotationAuthor\(session\.actor\)/u);
  assert.doesNotMatch(server, /identity-boundaries|current-profile|getIdentityProfile/u);
  assert.doesNotMatch(toolbar, /authorIdentityId|current-profile|identity-boundaries/u);
});
