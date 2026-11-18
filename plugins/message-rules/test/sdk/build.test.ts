import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function build({ format = 1, code = 0, mismatch = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "message-rules-build-"));
  try {
    const compiler = join(root, "compiler.mjs");
    writeFileSync(compiler, `
      import { mkdirSync, writeFileSync } from "node:fs";
      writeFileSync("called.json", JSON.stringify({ args: process.argv.slice(2), liveCli: process.env.BB_CLI ?? null }));
      if (Number(process.env.FIXTURE_EXIT)) process.exit(Number(process.env.FIXTURE_EXIT));
      mkdirSync("dist");
      const metadata = { sdkVersion: "0.6.143", builtWith: { compiler: "selected" } };
      writeFileSync("dist/app.meta.json", JSON.stringify({ ...metadata, artifactFormatVersion: Number(process.env.FIXTURE_FORMAT) }));
      writeFileSync("dist/server.meta.json", JSON.stringify({ ...metadata, sdkVersion: process.env.FIXTURE_MISMATCH === "true" ? "other" : metadata.sdkVersion }));
    `);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../tools/build.mjs", import.meta.url))], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, BB_TOOLCHAIN_CLI: compiler, BB_CLI: "unselected-live-cli",
        FIXTURE_EXIT: String(code), FIXTURE_FORMAT: String(format), FIXTURE_MISMATCH: String(mismatch) },
    });
    return { ...result, called: JSON.parse(readFileSync(join(root, "called.json"), "utf8")) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("native build uses the selected compiler without forwarding a live CLI", () => {
  const result = build();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.called, { args: ["plugin", "build", "."], liveCli: null });
});
test("native format and matching app/server stamps remain required", () => {
  const format = build({ format: 2 });
  assert.notEqual(format.status, 0);
  assert.match(format.stderr, /Expected native plugin artifact format 1/);
  const stamps = build({ mismatch: true });
  assert.notEqual(stamps.status, 0);
  assert.match(stamps.stderr, /App\/server toolchain stamps differ/);
});
test("compiler failure propagates before reading metadata", () => {
  const result = build({ code: 42 });
  assert.equal(result.status, 42);
});
